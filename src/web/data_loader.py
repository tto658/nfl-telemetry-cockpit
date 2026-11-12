"""High-performance Polars data loader and in-memory PlayerRegistry."""

from __future__ import annotations

import base64
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from src.web.kinematics import compute_tracking_kinematics, compute_combined_g_force, compute_overlap_index, compute_apex_metrics
from src.web.schemas import (
    FrameDTO,
    MetadataResponse,
    PlayerBio,
    PlayerListItem,
    format_draft_pick,
    format_height,
    serialize_player_list,
)

# Global in-memory cache for precomputed binary G-G telemetry clouds
_GG_CLOUD_CACHE: dict[tuple[int, str, int | None, int | None], dict[str, Any]] = {}


class PlayerRegistry:
    """In-memory player registry providing sub-millisecond filtering and lookups."""

    def __init__(self, project_root: Path | str | None = None) -> None:
        self.project_root = Path(project_root).resolve() if project_root else Path(__file__).resolve().parent.parent.parent
        self.tracking_dir = self.project_root / "tracking_by_position"
        self._is_loaded = False

        self._players_by_id: dict[int, PlayerListItem] = {}
        self._players_list: list[PlayerListItem] = []
        self._bio_by_id: dict[int, PlayerBio] = {}
        self._dir_by_id: dict[int, Path] = {}
        self._raw_player_data: dict[int, dict[str, Any]] = {}
        self._unique_draft_years: list[int] = []
        self._unique_positions: list[str] = []
        self._unique_teams: list[str] = []
        self._games_by_id: dict[int, dict[str, Any]] = {}
        self._cached_all_players_bytes: bytes = b"[]"

    @property
    def cached_all_players_bytes(self) -> bytes:
        return self._cached_all_players_bytes

    def load(self) -> PlayerRegistry:
        """Scan player directories, join master tables, and build registry."""
        if self._is_loaded:
            return self

        # 1. Fast 2-level directory scan over tracking_by_position/ (~13 ms)
        player_dirs: dict[int, Path] = {}
        if self.tracking_dir.exists():
            with os.scandir(self.tracking_dir) as pos_entries:
                for pos_entry in pos_entries:
                    if not pos_entry.is_dir():
                        continue
                    with os.scandir(pos_entry.path) as player_entries:
                        for player_entry in player_entries:
                            if player_entry.is_dir():
                                folder_name = player_entry.name
                                parts = folder_name.split("_", 1)
                                if parts[0].isdigit():
                                    nfl_id = int(parts[0])
                                    player_dirs[nfl_id] = Path(player_entry.path).resolve()

        self._dir_by_id = player_dirs

        # 2. Polars scan on root player_play.parquet to group unique team_abbr (~30 ms)
        team_map: dict[int, list[str]] = {}
        player_play_path = self.project_root / "player_play.parquet"
        if player_play_path.exists():
            teams_agg = (
                pl.scan_parquet(player_play_path)
                .select(["nfl_id", "team_abbr"])
                .filter(pl.col("team_abbr").is_not_null())
                .group_by("nfl_id")
                .agg(pl.col("team_abbr").unique().sort())
                .collect()
            )
            for row in teams_agg.iter_rows(named=True):
                team_map[int(row["nfl_id"])] = list(row["team_abbr"])
        else:
            # Fallback to reading per-player player_play.parquet slices
            for nfl_id, p_dir in player_dirs.items():
                slice_path = p_dir / "player_play.parquet"
                if slice_path.exists():
                    try:
                        s_df = pl.read_parquet(slice_path)
                        if "team_abbr" in s_df.columns:
                            u_teams = s_df["team_abbr"].drop_nulls().unique().to_list()
                            if u_teams:
                                team_map[nfl_id] = sorted(u_teams)
                    except (OSError, pl.exceptions.PolarsError):
                        continue

        # Ingest games.parquet (1,002 games) for metadata enrichment
        games_path = self.project_root / "games.parquet"
        games_by_id: dict[int, dict[str, Any]] = {}
        if games_path.exists():
            games_df = pl.read_parquet(games_path)
            for g_row in games_df.iter_rows(named=True):
                gid = int(g_row["game_id"])
                games_by_id[gid] = {
                    "game_id": gid,
                    "game_key": int(g_row["game_key"]) if g_row.get("game_key") is not None else None,
                    "season": int(g_row["season"]),
                    "season_type": str(g_row.get("season_type") or "REG"),
                    "week": int(g_row["week"]) if g_row.get("week") is not None else 1,
                    "home_team_abbr": str(g_row["home_team_abbr"]),
                    "visitor_team_abbr": str(g_row["visitor_team_abbr"]),
                    "home_team": str(g_row["home_team_abbr"]),
                    "visitor_team": str(g_row["visitor_team_abbr"]),
                }
        self._games_by_id = games_by_id

        # 3. Read and join players.parquet, combine_results.parquet, player_career_successes.parquet
        players_path = self.project_root / "players.parquet"
        combine_path = self.project_root / "combine_results.parquet"
        career_path = self.project_root / "player_career_successes.parquet"

        players_df = pl.read_parquet(players_path) if players_path.exists() else pl.DataFrame()
        combine_df = pl.read_parquet(combine_path) if combine_path.exists() else pl.DataFrame()
        career_df = pl.read_parquet(career_path) if career_path.exists() else pl.DataFrame()

        # Drop duplicate draft_year in combine_df
        if "draft_year" in combine_df.columns:
            combine_df = combine_df.drop(["draft_year"])

        joined_df = players_df
        if combine_df.height > 0:
            joined_df = joined_df.join(combine_df, on="nfl_id", how="left")
        if career_df.height > 0:
            joined_df = joined_df.join(career_df, on="nfl_id", how="left")

        # 4. Construct in-memory data structures
        players_list: list[PlayerListItem] = []
        players_by_id: dict[int, PlayerListItem] = {}
        bio_by_id: dict[int, PlayerBio] = {}
        raw_data: dict[int, dict[str, Any]] = {}
        all_teams_set: set[str] = set()
        all_pos_set: set[str] = set()
        all_years_set: set[int] = set()

        for row in joined_df.iter_rows(named=True):
            nfl_id = int(row["nfl_id"])
            disp_name = row.get("display_name") or ""
            pos = row.get("nfl_position") or row.get("combine_position") or "ATH"
            comb_pos = row.get("combine_position") or pos
            year = int(row.get("draft_year") or 0)
            d_round = row.get("draft_round")
            d_pick_in_r = row.get("draft_pick_within_round")
            d_overall = row.get("draft_overall_pick")
            height_in = row.get("combine_height")
            weight_lbs = row.get("combine_weight")
            college = row.get("college_name") or ""
            conference = row.get("college_conference") or ""
            birth_date = row.get("birth_date") or ""

            # Teams: 13 zero-snap players get [] and FA
            teams = team_map.get(nfl_id, [])
            if not teams:
                all_teams_set.add("FA")
            else:
                for t in teams:
                    all_teams_set.add(t)
            all_pos_set.add(pos)
            if year > 0:
                all_years_set.add(year)

            # PlayerListItem
            item = PlayerListItem.from_raw(
                nfl_id=nfl_id,
                display_name=disp_name,
                nfl_position=pos,
                draft_year=year,
                draft_round=d_round,
                draft_pick_within_round=d_pick_in_r,
                draft_overall_pick=d_overall,
                combine_position=comb_pos,
                combine_height=height_in,
                combine_weight=weight_lbs,
                teams=teams,
                college_name=college,
            )
            players_list.append(item)
            players_by_id[nfl_id] = item

            # PlayerBio
            h_str = format_height(height_in)
            h_num = round(float(height_in), 3) if height_in and not math.isnan(height_in) else 0.0
            w_num = int(weight_lbs) if weight_lbs and not math.isnan(weight_lbs) else 0

            off_snaps = int(row.get("career_offensive_snaps") or 0)
            def_snaps = int(row.get("career_defensive_snaps") or 0)
            st_snaps = int(row.get("career_special_teams_snaps") or 0)
            tot_snaps = off_snaps + def_snaps + st_snaps
            active_games = int(row.get("career_games_active") or 0)
            started_games = int(row.get("career_games_started") or 0)
            ap1 = int(row.get("ap_all_pro_1st_team") or 0)
            ap2 = int(row.get("ap_all_pro_2nd_team") or 0)
            pb = int(row.get("pro_bowl_original_ballot") or 0)

            pick_str = format_draft_pick(d_round, d_pick_in_r, d_overall)
            team_label = "/".join(teams) if teams else "FA"
            label = f"{disp_name} [{pos} • {team_label}] ({year} • {pick_str})"

            bio = PlayerBio(
                nfl_id=nfl_id,
                display_name=disp_name,
                name=disp_name,
                nfl_position=pos,
                position=pos,
                draft_year=year,
                draft_round=float(d_round) if d_round and not math.isnan(d_round) else None,
                draft_overall_pick=float(d_overall) if d_overall and not math.isnan(d_overall) else None,
                draft_pick_formatted=pick_str,
                birth_date=birth_date,
                college_name=college,
                college=college,
                college_conference=conference,
                conference=conference,
                height_in=h_num,
                height_formatted=h_str,
                height_display=h_str,
                weight_lbs=w_num,
                weight=w_num,
                hand_size=float(row["hand_size"]) if row.get("hand_size") is not None and not math.isnan(row["hand_size"]) else None,
                arm_length=float(row["arm_length"]) if row.get("arm_length") is not None and not math.isnan(row["arm_length"]) else None,
                wing_span=float(row["wing_span"]) if row.get("wing_span") is not None and not math.isnan(row["wing_span"]) else None,
                teams=teams,
                team=teams[0] if teams else "FA",
                display_label=label,
                career_offensive_snaps=off_snaps,
                career_defensive_snaps=def_snaps,
                career_special_teams_snaps=st_snaps,
                career_total_snaps=tot_snaps,
                career_games_active=active_games,
                career_games_started=started_games,
                ap_all_pro_1st_team=ap1,
                ap_all_pro_2nd_team=ap2,
                all_pro_total=ap1 + ap2,
                pro_bowl_original_ballot=pb,
                pro_bowl_count=pb,
            )
            bio_by_id[nfl_id] = bio

            # Save full raw data for combine tests & summary endpoints
            raw_data[nfl_id] = row

        self._players_list = players_list
        self._players_by_id = players_by_id
        self._bio_by_id = bio_by_id
        self._raw_player_data = raw_data
        self._unique_draft_years = sorted(all_years_set)
        self._unique_positions = sorted(all_pos_set)
        self._unique_teams = sorted(all_teams_set)

        # Pre-serialize full player list for sub-microsecond responses on initial page load
        self._cached_all_players_bytes = serialize_player_list(self._players_list)
        self._is_loaded = True
        return self

    def filter_players(
        self,
        draft_year: int | None = None,
        position: str | None = None,
        team_abbr: str | None = None,
        query: str | None = None,
    ) -> list[PlayerListItem]:
        """Filter players by draft year, position, team, and query."""
        results: list[PlayerListItem] = []
        q_clean = query.strip().lower() if query else None
        pos_clean = position.strip().upper() if position else None
        team_clean = team_abbr.strip().upper() if team_abbr else None

        for p in self._players_list:
            # 1. Draft Year
            if draft_year is not None and p.draft_year != draft_year:
                continue

            # 2. Position
            if pos_clean and p.nfl_position != pos_clean:
                continue

            # 3. Team (with Rams LA/LAR normalization and FA handling)
            if team_clean:
                if team_clean in ("LA", "LAR"):
                    if "LA" not in p.teams and "LAR" not in p.teams:
                        continue
                elif team_clean == "FA":
                    if len(p.teams) > 0:
                        continue
                elif team_clean not in p.teams:
                    continue

            # 4. Search Query (display_name, college, str(nfl_id))
            if q_clean:
                name_match = q_clean in p.display_name.lower()
                college_match = bool(p.college and q_clean in p.college.lower())
                id_match = q_clean in str(p.nfl_id)
                if not (name_match or college_match or id_match):
                    continue

            results.append(p)
        return results

    def get_player(self, nfl_id: int) -> PlayerListItem | None:
        """O(1) player lookup."""
        return self._players_by_id.get(nfl_id)

    def get_bio(self, nfl_id: int) -> PlayerBio | None:
        """O(1) bio card lookup."""
        return self._bio_by_id.get(nfl_id)

    def get_player_directory(self, nfl_id: int) -> Path | None:
        """O(1) player directory lookup."""
        return self._dir_by_id.get(nfl_id)

    def get_game(self, game_id: int) -> dict[str, Any] | None:
        """O(1) game metadata lookup."""
        return self._games_by_id.get(game_id)

    def get_metadata(self) -> MetadataResponse:
        """System metadata for frontend dropdown facets."""
        return MetadataResponse(
            draft_years=self._unique_draft_years,
            positions=self._unique_positions,
            teams=self._unique_teams,
            total_players=len(self._players_list),
        )

    def get_player_summary(self, nfl_id: int) -> dict[str, Any]:
        """Generate comprehensive summary payload for GET /api/player/{nfl_id}/summary."""
        player = self._players_by_id.get(nfl_id)
        if not player:
            raise KeyError(f"Player {nfl_id} not found in registry")

        bio = self._bio_by_id[nfl_id]
        raw = self._raw_player_data[nfl_id]

        tests = ["forty", "ten_yd_split", "vertical", "broad_jump", "three_cone", "short_shuttle", "bench_reps"]
        combine_tests: dict[str, Any] = {}
        opt_outs: list[str] = []

        for test in tests:
            val = raw.get(test)
            if val is None or (isinstance(val, float) and math.isnan(val)):
                combine_tests[test] = {"value": None, "opt_out": True, "status": "Opt-Out / MNAR"}
                opt_outs.append(test)
            else:
                combine_tests[test] = {"value": float(val), "opt_out": False, "status": "Recorded"}

        ngs_athleticism = raw.get("ngs_athleticism_score")
        if ngs_athleticism is not None and not math.isnan(ngs_athleticism):
            ngs_athleticism = int(ngs_athleticism)
        else:
            ngs_athleticism = None

        ngs_prod = raw.get("ngs_college_production_score")
        if ngs_prod is not None and not math.isnan(ngs_prod):
            ngs_prod = float(ngs_prod)
        else:
            ngs_prod = None

        ngs_fin = raw.get("ngs_final_score")
        if ngs_fin is not None and not math.isnan(ngs_fin):
            ngs_fin = float(ngs_fin)
        else:
            ngs_fin = None

        combine_block = {
            "combine_tests": combine_tests,
            "opt_outs": opt_outs,
            "ngs_scores": {
                "athleticism_score": ngs_athleticism,
                "ngs_athleticism_score": ngs_athleticism,
                "college_production_score": ngs_prod,
                "final_score": ngs_fin,
            },
            # Convenience flattened entries
            "forty": combine_tests["forty"]["value"],
            "vertical": combine_tests["vertical"]["value"],
            "three_cone": combine_tests["three_cone"]["value"],
            "short_shuttle": combine_tests["short_shuttle"]["value"],
            "broad_jump": combine_tests["broad_jump"]["value"],
            "bench_reps": combine_tests["bench_reps"]["value"],
            "athleticism_score": ngs_athleticism,
            "drills": self.get_combine_drills_list(nfl_id),
        }

        career_stats = {
            "offensive_snaps": bio.career_offensive_snaps,
            "career_offensive_snaps": bio.career_offensive_snaps,
            "defensive_snaps": bio.career_defensive_snaps,
            "career_defensive_snaps": bio.career_defensive_snaps,
            "special_teams_snaps": bio.career_special_teams_snaps,
            "career_special_teams_snaps": bio.career_special_teams_snaps,
            "total_snaps": bio.career_total_snaps,
            "games_active": bio.career_games_active,
            "career_games_active": bio.career_games_active,
            "games_started": bio.career_games_started,
            "career_games_started": bio.career_games_started,
            "all_pro_1st": bio.ap_all_pro_1st_team,
            "all_pro_2nd": bio.ap_all_pro_2nd_team,
            "all_pro": bio.all_pro_total,
            "pro_bowl": bio.pro_bowl_original_ballot,
        }

        return {
            "nfl_id": player.nfl_id,
            "name": player.display_name,
            "display_name": player.display_name,
            "position": player.nfl_position,
            "nfl_position": player.nfl_position,
            "combine_position": player.combine_position,
            "draft_year": player.draft_year,
            "draft_round": player.draft_round,
            "draft_overall_pick": player.draft_overall_pick,
            "draft_pick_formatted": player.draft_pick_formatted,
            "teams": player.teams,
            "team": player.team,
            "bio": bio.model_dump(),
            "combine": combine_block,
            "career": career_stats,
            "career_stats": career_stats,
        }

    # =========================================================================
    # Auxiliary Per-Player Tracking Slices & Data Methods
    # =========================================================================

    def load_combine_tracking(self, nfl_id: int) -> pl.DataFrame:
        """Read {player_dir}/combine_tracking.parquet."""
        p_dir = self.get_player_directory(nfl_id)
        if not p_dir:
            raise KeyError(f"Player {nfl_id} directory not found")
        fpath = p_dir / "combine_tracking.parquet"
        if not fpath.exists():
            return pl.DataFrame()
        return pl.read_parquet(fpath)

    def get_combine_drills_list(self, nfl_id: int) -> list[dict[str, Any]]:
        """Extract list of distinct combine drill events for dropdown selection."""
        try:
            df = self.load_combine_tracking(nfl_id)
        except (KeyError, FileNotFoundError):
            return []

        if df.height == 0 or "event_id" not in df.columns:
            return []

        cols = ["event_id"]
        if "drill_name" in df.columns:
            cols.append("drill_name")
        subset = df.select(cols).unique()
        drills: list[dict[str, Any]] = []
        for row in subset.iter_rows(named=True):
            drills.append({
                "event_id": str(row["event_id"]),
                "drill_name": str(row.get("drill_name") or "COMBINE_DRILL"),
            })
        drills.sort(key=lambda d: d["drill_name"])
        return drills

    def load_player_plays(self, nfl_id: int) -> pl.DataFrame:
        """Read {player_dir}/player_play.parquet (empty DataFrame for 0-snap players)."""
        p_dir = self.get_player_directory(nfl_id)
        if not p_dir:
            raise KeyError(f"Player {nfl_id} directory not found")
        fpath = p_dir / "player_play.parquet"
        if not fpath.exists():
            return pl.DataFrame()
        return pl.read_parquet(fpath)

    def load_snap_tracking(self, nfl_id: int, season: int) -> pl.DataFrame:
        """Read {player_dir}/game_tracking_{season}.parquet."""
        p_dir = self.get_player_directory(nfl_id)
        if not p_dir:
            raise KeyError(f"Player {nfl_id} directory not found")
        fpath = p_dir / f"game_tracking_{season}.parquet"
        if not fpath.exists():
            raise FileNotFoundError(f"Tracking file {fpath.name} not found for player {nfl_id}")
        return pl.read_parquet(fpath)

    def load_combine_drill(self, nfl_id: int, event_id: str) -> dict[str, Any]:
        """Load 10 Hz tracked combine drill for player and ball."""
        df = self.load_combine_tracking(nfl_id)
        if df.height == 0:
            raise KeyError(f"No combine tracking data for player {nfl_id}")

        filtered = df.filter(pl.col("event_id") == event_id)
        if filtered.height == 0:
            raise KeyError(f"Combine event {event_id} not found for player {nfl_id}")

        drill_name = filtered["drill_name"][0] if "drill_name" in filtered.columns else "DRILL"
        p_df = filtered.filter(pl.col("entity_type") == "PLAYER").sort("time")
        b_df = filtered.filter(pl.col("entity_type") == "BALL").sort("time")

        p_df = compute_tracking_kinematics(p_df, is_combine=True)

        p_frames: list[dict[str, Any]] = []
        b_frames: list[dict[str, Any]] = []

        curvatures: list[float] = []
        for i, row in enumerate(p_df.iter_rows(named=True)):
            s = float(row.get("s") or 0.0)
            a = float(row.get("a") or 0.0)
            d = float(row.get("dir") or 0.0)
            x = float(row.get("x") or 0.0)
            y = float(row.get("y") or 0.0)
            omega = float(row.get("omega") or 0.0)
            kappa = float(row.get("kappa") or 0.0)
            a_lat = float(row.get("a_lat") or 0.0)
            a_comb = float(row.get("a_comb") or 0.0)
            g_comb = float(row.get("g_comb") or 0.0)
            g_lat = float(row.get("g_lat") or 0.0)
            g_t = float(row.get("g_t") or 0.0)
            if kappa > 0.0:
                curvatures.append(kappa)

            frame = FrameDTO(
                frameId=i,
                time=round(i * 0.1, 2),
                x=round(x, 2),
                y=round(y, 2),
                s=round(s, 2),
                a=round(a, 2),
                dir=round(d, 2),
                o=None,
                omega=round(omega, 2),
                curvature=round(kappa, 4),
                slip_angle=None,
                a_lat=round(a_lat, 2),
                a_comb=round(a_comb, 2),
                g_comb=round(g_comb, 2),
                g_lat=round(g_lat, 3),
                g_t=round(g_t, 3),
                event=None,
            )
            p_frames.append(frame.model_dump())

        for i, row in enumerate(b_df.iter_rows(named=True)):
            s = float(row.get("s") or 0.0)
            a = float(row.get("a") or 0.0)
            d = float(row.get("dir") or 0.0)
            x = float(row.get("x") or 0.0)
            y = float(row.get("y") or 0.0)
            frame = FrameDTO(
                frameId=i,
                time=round(i * 0.1, 2),
                x=round(x, 2),
                y=round(y, 2),
                s=round(s, 2),
                a=round(a, 2),
                dir=round(d, 2),
                o=None,
                omega=None,
                curvature=None,
                slip_angle=None,
                event=None,
            )
            b_frames.append(frame.model_dump())

        s_max = max((f["s"] for f in p_frames), default=0.0)
        a_max = max((f["a"] for f in p_frames), default=0.0)
        duration = len(p_frames) * 0.1
        kappa_90 = float(np.percentile(curvatures, 90)) if curvatures else 0.0

        g_comb_max = max((f.get("g_comb") or 0.0 for f in p_frames), default=0.0)
        a_t_list = [f["a"] for f in p_frames]
        a_lat_list = [f.get("a_lat") or 0.0 for f in p_frames]
        s_list = [f["s"] for f in p_frames]
        k_list = [f.get("curvature") or 0.0 for f in p_frames]

        overlap_index = compute_overlap_index(a_t_list, a_lat_list, s_list)
        apex_metrics = compute_apex_metrics(s_list, k_list, a_t_list)
        v_apex = max((m["v_apex"] for m in apex_metrics), default=0.0) if apex_metrics else 0.0
        corner_exit_traction = float(np.mean([m["exit_traction"] for m in apex_metrics])) if apex_metrics else 0.0

        metrics = {
            "s_max": round(s_max, 2),
            "a_max": round(a_max, 2),
            "g_comb_max": round(g_comb_max, 2),
            "overlap_index": round(overlap_index, 4),
            "overlap_pct": round(overlap_index * 100, 1),
            "v_apex": round(v_apex, 2),
            "apex_speed": round(v_apex, 2),
            "corner_exit_traction": round(corner_exit_traction, 2),
            "apex_metrics": apex_metrics,
            "duration": round(duration, 2),
            "duration_sec": round(duration, 2),
            "kappa_90": round(kappa_90, 4),
        }

        return {
            "drill_name": drill_name,
            "metrics": metrics,
            "s_max": metrics["s_max"],
            "a_max": metrics["a_max"],
            "g_comb_max": metrics["g_comb_max"],
            "overlap_index": metrics["overlap_index"],
            "overlap_pct": metrics["overlap_pct"],
            "v_apex": metrics["v_apex"],
            "apex_speed": metrics["apex_speed"],
            "corner_exit_traction": metrics["corner_exit_traction"],
            "duration": metrics["duration"],
            "kappa_90": metrics["kappa_90"],
            "player_frames": p_frames,
            "player_trajectory": p_frames,
            "ball_frames": b_frames,
            "ball_trajectory": b_frames,
        }

    def load_player_games(
        self,
        nfl_id: int,
        season: int | None = None,
        play_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """Extract games and play lists for player joined with games.parquet metadata."""
        df = self.load_player_plays(nfl_id)
        if df.height == 0:
            return []

        # Derive play_type: check if 'run' column exists, otherwise fallback to pass_result/dropback_duration logic
        if "run" in df.columns:
            pt_expr = (
                pl.when(pl.col("run") == True)
                .then(pl.lit("RUN"))
                .otherwise(pl.lit("PASS"))
                .alias("derived_play_type")
            )
        else:
            pt_expr = (
                pl.when(pl.col("pass_result").is_null() & pl.col("dropback_duration").is_null())
                .then(pl.lit("RUN"))
                .otherwise(pl.lit("PASS"))
                .alias("derived_play_type")
            )
        df = df.with_columns(pt_expr)

        if play_type:
            df = df.filter(pl.col("derived_play_type") == play_type.upper())

        if df.height == 0:
            return []

        # Group plays by game_id and track player's team for each game
        games_dict: dict[int, list[dict[str, Any]]] = {}
        game_player_teams: dict[int, str] = {}
        for row in df.iter_rows(named=True):
            g_id = int(row["game_id"])
            g_meta = self._games_by_id.get(g_id)
            g_season = g_meta["season"] if g_meta else int(str(g_id)[:4])
            if season is not None and g_season != season:
                continue

            if g_id not in games_dict:
                games_dict[g_id] = []

            p_team = row.get("team_abbr")
            if p_team and g_id not in game_player_teams:
                game_player_teams[g_id] = str(p_team)

            epa = float(row.get("expected_points_added") or 0.0)
            desc = row.get("play_description") or ""
            clock = row.get("game_clock") or ""
            quarter = int(row.get("quarter") or 1)
            p_type = row.get("derived_play_type") or "PASS"
            pos = row.get("lined_up_position") or ""

            games_dict[g_id].append({
                "play_id": int(row["play_id"]),
                "quarter": quarter,
                "game_clock": clock,
                "play_type": p_type,
                "epa": epa,
                "expected_points_added": epa,
                "description": desc,
                "play_description": desc,
                "lined_up_position": pos,
            })

        # Helper for franchise alias normalization (e.g. Rams LA vs LAR)
        def _teams_match(t1: str | None, t2: str | None) -> bool:
            if not t1 or not t2:
                return False
            if t1 == t2:
                return True
            return {t1, t2} <= {"LA", "LAR"}

        result: list[dict[str, Any]] = []
        for g_id, plays in games_dict.items():
            g_meta = self._games_by_id.get(g_id)
            gid_str = str(g_id)
            date_str = (
                f"{gid_str[:4]}-{gid_str[4:6]}-{gid_str[6:8]}"
                if len(gid_str) >= 8
                else None
            )

            if g_meta:
                g_season = g_meta["season"]
                week = g_meta["week"]
                season_type = g_meta["season_type"]
                home_team = g_meta["home_team_abbr"]
                visitor_team = g_meta["visitor_team_abbr"]
                game_key = g_meta.get("game_key")
            else:
                g_season = int(gid_str[:4])
                week = None
                season_type = "REG"
                home_team = None
                visitor_team = None
                game_key = None

            # Resolve home_away and opponent based on player's team in this game
            player_team = game_player_teams.get(g_id)
            if not player_team:
                p_item = self.get_player(nfl_id)
                player_team = p_item.team if p_item else None

            home_away = None
            opponent = None
            if home_team and visitor_team and player_team:
                if _teams_match(player_team, home_team):
                    home_away = "home"
                    opponent = visitor_team
                elif _teams_match(player_team, visitor_team):
                    home_away = "away"
                    opponent = home_team
                else:
                    home_away = "home"
                    opponent = visitor_team

            result.append({
                "game_id": g_id,
                "game_key": game_key,
                "season": g_season,
                "season_type": season_type,
                "week": week,
                "date": date_str,
                "home_team": home_team,
                "home_team_abbr": home_team,
                "visitor_team": visitor_team,
                "visitor_team_abbr": visitor_team,
                "opponent": opponent,
                "home_away": home_away,
                "total_plays": len(plays),
                "plays": plays,
            })

        # Sort games chronologically by game_id
        result.sort(key=lambda g: g["game_id"])
        return result

    def load_player_snap(self, nfl_id: int, game_id: int, play_id: int) -> dict[str, Any]:
        """Extract 10 Hz game snap telemetry frames and event markers."""
        g_meta = self._games_by_id.get(game_id)
        season = g_meta["season"] if g_meta else int(str(game_id)[:4])
        try:
            df = self.load_snap_tracking(nfl_id, season)
        except FileNotFoundError:
            raise KeyError(f"Snap {play_id} in game {game_id} not found")

        snap_df = df.filter((pl.col("game_id") == game_id) & (pl.col("play_id") == play_id)).sort("time")
        if snap_df.height == 0:
            raise KeyError(f"Snap {play_id} in game {game_id} not found")

        # Vectorized kinematics calculation via shared kinematics engine
        snap_df = compute_tracking_kinematics(snap_df, is_combine=False)

        frames: list[dict[str, Any]] = []
        events: list[dict[str, Any]] = []

        for i, row in enumerate(snap_df.iter_rows(named=True)):
            d = float(row.get("dir") or 0.0)
            o = float(row.get("o") or 0.0)
            s = float(row.get("s") or 0.0)
            a = float(row.get("a") or 0.0)
            x = float(row.get("x") or 0.0)
            y = float(row.get("y") or 0.0)
            ev = row.get("event")
            t_rel = round(i * 0.1, 2)

            omega = float(row.get("omega") or 0.0)
            kappa = float(row.get("kappa") or 0.0)
            beta = float(row.get("beta_slip") if row.get("beta_slip") is not None else 0.0)
            beta_rate = float(row.get("beta_rate") if row.get("beta_rate") is not None else 0.0)
            jerk = float(row.get("jerk") if row.get("jerk") is not None else 0.0)
            is_snap = bool(row.get("snap_oversteer") or False)
            dyn_state = row.get("dynamics_state") or "ON_RAILS"
            a_lat = float(row.get("a_lat") or 0.0)
            a_comb = float(row.get("a_comb") or 0.0)
            g_comb = float(row.get("g_comb") or 0.0)
            g_lat = float(row.get("g_lat") or 0.0)
            g_t = float(row.get("g_t") or 0.0)

            frame = FrameDTO(
                frameId=i,
                time=t_rel,
                x=round(x, 2),
                y=round(y, 2),
                s=round(s, 2),
                a=round(a, 2),
                dir=round(d, 2),
                o=round(o, 2),
                omega=round(omega, 2),
                curvature=round(kappa, 4),
                slip_angle=round(beta, 2),
                beta_rate=round(beta_rate, 2),
                jerk=round(jerk, 2),
                snap_oversteer=is_snap,
                dynamics_state=dyn_state,
                a_lat=round(a_lat, 2),
                a_comb=round(a_comb, 2),
                g_comb=round(g_comb, 2),
                g_lat=round(g_lat, 3),
                g_t=round(g_t, 3),
                event=ev,
            )
            frames.append(frame.model_dump())
            if ev:
                events.append({"event": ev, "frameId": i, "time": t_rel})

        snap_oversteer_frames = [
            {
                "frameId": f["frameId"],
                "time": f["time"],
                "beta": f.get("slip_angle", 0.0),
                "beta_rate": f.get("beta_rate", 0.0),
                "jerk": f.get("jerk", 0.0),
            }
            for f in frames if f.get("snap_oversteer")
        ]

        g_comb_max = max((f.get("g_comb") or 0.0 for f in frames), default=0.0)
        a_t_list = [f["a"] for f in frames]
        a_lat_list = [f.get("a_lat") or 0.0 for f in frames]
        s_list = [f["s"] for f in frames]
        k_list = [f.get("curvature") or 0.0 for f in frames]

        overlap_index = compute_overlap_index(a_t_list, a_lat_list, s_list)
        apex_metrics = compute_apex_metrics(s_list, k_list, a_t_list)
        v_apex = max((m["v_apex"] for m in apex_metrics), default=0.0) if apex_metrics else 0.0
        corner_exit_traction = float(np.mean([m["exit_traction"] for m in apex_metrics])) if apex_metrics else 0.0

        return {
            "game_id": game_id,
            "play_id": play_id,
            "frames": frames,
            "events": events,
            "snap_oversteer_incidents": len(snap_oversteer_frames),
            "snap_oversteer_frames": snap_oversteer_frames,
            "g_comb_max": round(g_comb_max, 2),
            "overlap_index": round(overlap_index, 4),
            "overlap_pct": round(overlap_index * 100, 1),
            "v_apex": round(v_apex, 2),
            "apex_speed": round(v_apex, 2),
            "corner_exit_traction": round(corner_exit_traction, 2),
            "apex_metrics": apex_metrics,
        }

    def load_player_gg_cloud_binary(
        self,
        nfl_id: int,
        scope: str = "season",
        season: int | None = None,
        game_id: int | None = None,
    ) -> dict[str, Any]:
        """Extract multi-frame or season-wide G-G telemetry cloud as Base64 Float32 binary buffers.

        Applies the Combined Dynamic Energy Gate:
        (s > 0.3 yd/s) | (g_comb >= 0.12 g)
        to strip stationary pre-snap frames while preserving zero-velocity plant-and-cut impulses.
        """
        cache_key = (nfl_id, scope, season, game_id)
        if cache_key in _GG_CLOUD_CACHE:
            return _GG_CLOUD_CACHE[cache_key]

        if nfl_id not in self._players_by_id:
            raise KeyError(f"Player {nfl_id} not found")

        full_df = pl.DataFrame()

        if scope == "combine":
            c_df = self.load_combine_tracking(nfl_id)
            if c_df.height > 0:
                p_c = c_df.filter(pl.col("entity_type") == "PLAYER")
                if p_c.height > 0:
                    partitions = p_c.partition_by(["event_id"], as_dict=False)
                    kin_dfs = [compute_tracking_kinematics(s, is_combine=True) for s in partitions]
                    full_df = pl.concat(kin_dfs) if kin_dfs else pl.DataFrame()
        else:
            p_dir = self.get_player_directory(nfl_id)
            parquet_files: list[Path] = []
            if p_dir and p_dir.exists():
                if season is not None:
                    sf = p_dir / f"game_tracking_{season}.parquet"
                    if sf.exists():
                        parquet_files.append(sf)
                else:
                    parquet_files = sorted(list(p_dir.glob("game_tracking_*.parquet")))

            if parquet_files:
                dfs = [pl.read_parquet(pf) for pf in parquet_files]
                raw_df = pl.concat(dfs) if dfs else pl.DataFrame()
                if game_id is not None and "game_id" in raw_df.columns:
                    raw_df = raw_df.filter(pl.col("game_id") == game_id)

                if raw_df.height > 0:
                    part_cols = [c for c in ["game_id", "play_id"] if c in raw_df.columns]
                    if part_cols:
                        partitions = raw_df.partition_by(part_cols, as_dict=False)
                        kin_dfs = [compute_tracking_kinematics(s, is_combine=False) for s in partitions]
                        full_df = pl.concat(kin_dfs) if kin_dfs else pl.DataFrame()
                    else:
                        full_df = compute_tracking_kinematics(raw_df, is_combine=False)
            else:
                # Fallback to combine tracking for zero-snap rookies
                c_df = self.load_combine_tracking(nfl_id)
                if c_df.height > 0:
                    p_c = c_df.filter(pl.col("entity_type") == "PLAYER")
                    if p_c.height > 0:
                        partitions = p_c.partition_by(["event_id"], as_dict=False)
                        kin_dfs = [compute_tracking_kinematics(s, is_combine=True) for s in partitions]
                        full_df = pl.concat(kin_dfs) if kin_dfs else pl.DataFrame()

        # Apply Combined Dynamic Energy Gate: (s > 0.3) | (g_comb >= 0.12)
        if full_df.height > 0 and "g_comb" in full_df.columns and "s" in full_df.columns:
            gate = (pl.col("s").fill_null(0.0) > 0.3) | (pl.col("g_comb").fill_null(0.0) >= 0.12)
            gated_df = full_df.filter(gate)
        else:
            gated_df = full_df

        if gated_df.height > 0:
            g_lat_col = gated_df["g_lat"] if "g_lat" in gated_df.columns else (gated_df["a_lat"] / 10.7247)
            g_t_col = gated_df["g_t"] if "g_t" in gated_df.columns else (gated_df["a"] / 10.7247)
            s_col = gated_df["s"] if "s" in gated_df.columns else pl.lit(0.0)
            beta_col = gated_df["beta_slip"] if "beta_slip" in gated_df.columns else pl.lit(0.0)

            g_lat_arr = np.ascontiguousarray(g_lat_col.fill_null(0.0).to_numpy(), dtype=np.float32)
            g_t_arr = np.ascontiguousarray(g_t_col.fill_null(0.0).to_numpy(), dtype=np.float32)
            s_arr = np.ascontiguousarray(s_col.fill_null(0.0).to_numpy(), dtype=np.float32)
            beta_arr = np.ascontiguousarray(beta_col.fill_null(0.0).to_numpy(), dtype=np.float32)
        else:
            g_lat_arr = np.array([], dtype=np.float32)
            g_t_arr = np.array([], dtype=np.float32)
            s_arr = np.array([], dtype=np.float32)
            beta_arr = np.array([], dtype=np.float32)

        b64_g_lat = base64.b64encode(g_lat_arr.tobytes()).decode("ascii")
        b64_g_t = base64.b64encode(g_t_arr.tobytes()).decode("ascii")
        b64_s = base64.b64encode(s_arr.tobytes()).decode("ascii")
        b64_beta = base64.b64encode(beta_arr.tobytes()).decode("ascii")

        payload = {
            "nfl_id": nfl_id,
            "scope": scope,
            "season": season,
            "game_id": game_id,
            "count": len(g_lat_arr),
            "b64_g_lat": b64_g_lat,
            "b64_g_t": b64_g_t,
            "b64_s": b64_s,
            "b64_beta": b64_beta,
            "bounds": {
                "g_lat_min": round(float(np.min(g_lat_arr)), 3) if len(g_lat_arr) > 0 else 0.0,
                "g_lat_max": round(float(np.max(g_lat_arr)), 3) if len(g_lat_arr) > 0 else 0.0,
                "g_t_min": round(float(np.min(g_t_arr)), 3) if len(g_t_arr) > 0 else 0.0,
                "g_t_max": round(float(np.max(g_t_arr)), 3) if len(g_t_arr) > 0 else 0.0,
            },
        }
        _GG_CLOUD_CACHE[cache_key] = payload
        return payload


# Global singleton instance
_GLOBAL_REGISTRY: PlayerRegistry | None = None


def get_player_registry(project_root: Path | str | None = None) -> PlayerRegistry:
    """Retrieve or initialize the global PlayerRegistry singleton."""
    global _GLOBAL_REGISTRY
    if _GLOBAL_REGISTRY is None or not _GLOBAL_REGISTRY._is_loaded:
        _GLOBAL_REGISTRY = PlayerRegistry(project_root)
        _GLOBAL_REGISTRY.load()
    return _GLOBAL_REGISTRY


def get_player_directory(nfl_id: int, project_root: Path | str | None = None) -> Path:
    """Resolve absolute directory path for an nfl_id or raise KeyError."""
    registry = get_player_registry(project_root)
    p_dir = registry.get_player_directory(nfl_id)
    if not p_dir:
        raise KeyError(f"Player directory for nfl_id={nfl_id} not found")
    return p_dir
