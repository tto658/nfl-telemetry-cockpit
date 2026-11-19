"""
Export full static site for GitHub Pages deployment.
Generates docs/ directory with HTML/CSS/JS, pre-computed lightweight metadata JSONs,
global games.json, and slimmed Float32 ZSTD Parquet telemetry for all 510 players
decoded directly in-browser via hyparquet.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path

import polars as pl
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.web.app import app
from src.web.data_loader import get_player_registry

DOCS_DIR = PROJECT_ROOT / "docs"
STATIC_SRC = PROJECT_ROOT / "src" / "web" / "static"

COMBINE_TRACKING_COLS = [
    "event_id",
    "entity_type",
    "time",
    "drill_name",
    "x",
    "y",
    "s",
    "a",
    "dis",
    "dir",
]

PLAYER_PLAY_COLS = [
    "game_id",
    "play_id",
    "team_abbr",
    "lined_up_position",
    "play_description",
    "quarter",
    "down",
    "yards_to_go",
    "possession_team",
    "yardline_side",
    "yardline_number",
    "game_clock",
    "play_direction",
    "expected_points_added",
    "pass_result",
    "dropback_duration",
    "run",
]

GAME_TRACKING_COLS = [
    "game_id",
    "play_id",
    "time",
    "x",
    "y",
    "s",
    "a",
    "dis",
    "o",
    "dir",
    "event",
]


def safe_id(val: str) -> str:
    """Sanitize identifier for file system storage."""
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", str(val))


def export_slim_parquet(src_path: Path, dst_path: Path, target_cols: list[str]) -> bool:
    """Read source parquet, select target columns, cast Float64->Float32, write ZSTD."""
    if not src_path.exists():
        return False

    schema = pl.read_parquet_schema(src_path)
    keep_cols = [c for c in target_cols if c in schema]
    if not keep_cols:
        return False

    df = pl.read_parquet(src_path, columns=keep_cols)
    cast_exprs = [
        pl.col(col).cast(pl.Float32)
        for col, dtype in zip(df.columns, df.dtypes)
        if dtype == pl.Float64
    ]
    if cast_exprs:
        df = df.with_columns(cast_exprs)

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(dst_path, compression="zstd", compression_level=9)
    return True


def copy_static_assets() -> None:
    """Copy frontend HTML, CSS, JavaScript modules, and vendor bundles into docs/."""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / "css").mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / "js").mkdir(parents=True, exist_ok=True)

    print("-> Copying frontend HTML, CSS, JavaScript modules, and vendor bundles...")
    for html_file in STATIC_SRC.glob("*.html"):
        shutil.copy2(html_file, DOCS_DIR / html_file.name)
    for css_file in (STATIC_SRC / "css").glob("*.css"):
        shutil.copy2(css_file, DOCS_DIR / "css" / css_file.name)
    shutil.copytree(STATIC_SRC / "js", DOCS_DIR / "js", dirs_exist_ok=True)
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")


def _compute_season_interactions(season: int, season_pairs: pl.DataFrame) -> pl.DataFrame:
    """Compute pre-snap assignment, OL/DL trench co-movement, and coverage mirroring for one season."""
    import math

    empty_schema = {
        "game_id": pl.Int64,
        "play_id": pl.Int64,
        "assign_min_dy": pl.Float32,
        "assign_dist": pl.Float32,
        "assign_off_id": pl.Int32,
        "assign_def_id": pl.Int32,
        "trench_comove_frames": pl.UInt16,
        "trench_off_id": pl.Int32,
        "trench_def_id": pl.Int32,
        "mirror_frames": pl.UInt16,
        "mirror_mean_cos": pl.Float32,
        "mirror_off_id": pl.Int32,
        "mirror_def_id": pl.Int32,
    }
    gt_path = PROJECT_ROOT / f"game_tracking_{season}.parquet"
    if not gt_path.exists() or len(season_pairs) == 0:
        return pl.DataFrame(schema=empty_schema)

    wr_db_pairs = season_pairs.filter(
        pl.col("lined_up_position").is_in(["WR", "SLOT_WR", "TE"])
        & pl.col("lined_up_position_def").is_in(["CB", "SLOT_CB", "BOX_SAFETY", "HIGH_SAFETY"])
    ).select(["game_id", "play_id", "nfl_id", "nfl_id_def"])

    ol_dl_pairs = season_pairs.filter(
        pl.col("lined_up_position").is_in(["C", "G", "T", "EXTRA_OL", "TE"])
        & pl.col("lined_up_position_def").is_in(["INTERIOR_LINE", "EDGE", "OLB"])
    ).select(["game_id", "play_id", "nfl_id", "nfl_id_def"])

    cov_pairs = season_pairs.filter(
        pl.col("route_ran").is_not_null()
        & pl.col("coverage_assignment_def").is_not_null()
        & (pl.col("coverage_assignment_def") != "NO_ASSIGNMENT")
    ).select(["game_id", "play_id", "nfl_id", "nfl_id_def"])

    needed_players = pl.concat([
        wr_db_pairs.select(["game_id", "play_id", "nfl_id"]),
        wr_db_pairs.select(["game_id", "play_id", pl.col("nfl_id_def").alias("nfl_id")]),
        ol_dl_pairs.select(["game_id", "play_id", "nfl_id"]),
        ol_dl_pairs.select(["game_id", "play_id", pl.col("nfl_id_def").alias("nfl_id")]),
        cov_pairs.select(["game_id", "play_id", "nfl_id"]),
        cov_pairs.select(["game_id", "play_id", pl.col("nfl_id_def").alias("nfl_id")]),
    ]).unique()

    if len(needed_players) == 0:
        return pl.DataFrame(schema=empty_schema)

    tr = (
        pl.scan_parquet(gt_path)
        .select(["game_id", "play_id", "nfl_id", "time", "x", "y", "s", "dir", "event"])
        .join(needed_players.lazy(), on=["game_id", "play_id", "nfl_id"], how="semi")
        .collect()
    )

    snap_times = (
        tr.filter(pl.col("event") == "ball_snap")
        .group_by(["game_id", "play_id"])
        .agg(pl.col("time").min().alias("snap_time"))
    )
    tr = tr.join(snap_times, on=["game_id", "play_id"], how="left")

    # Pre-snap position (at ball_snap, or earliest frame if ball_snap missing)
    snap_pos = (
        tr.filter(pl.col("snap_time").is_null() | (pl.col("time") == pl.col("snap_time")))
        .sort("time")
        .group_by(["game_id", "play_id", "nfl_id"], maintain_order=False)
        .first()
        .select(["game_id", "play_id", "nfl_id", "x", "y"])
    )

    # 1. WR/TE vs DB pre-snap Y-assignment (best pair per play)
    assign_best = (
        wr_db_pairs.join(snap_pos, on=["game_id", "play_id", "nfl_id"], how="inner")
        .join(
            snap_pos,
            left_on=["game_id", "play_id", "nfl_id_def"],
            right_on=["game_id", "play_id", "nfl_id"],
            how="inner",
            suffix="_def",
        )
        .with_columns([
            (pl.col("y") - pl.col("y_def")).abs().alias("dy"),
            ((pl.col("x") - pl.col("x_def")) ** 2 + (pl.col("y") - pl.col("y_def")) ** 2)
            .sqrt()
            .alias("dist"),
        ])
        .filter(pl.col("dist") <= 10.0)
        .sort(["game_id", "play_id", "dy", "dist"])
        .group_by(["game_id", "play_id"], maintain_order=False)
        .first()
        .select([
            "game_id",
            "play_id",
            pl.col("dy").cast(pl.Float32).alias("assign_min_dy"),
            pl.col("dist").cast(pl.Float32).alias("assign_dist"),
            pl.col("nfl_id").cast(pl.Int32).alias("assign_off_id"),
            pl.col("nfl_id_def").cast(pl.Int32).alias("assign_def_id"),
        ])
    )

    # Pre-snap spatial pruning before post-snap 10 Hz frame joins
    ol_dl_pruned = (
        ol_dl_pairs.join(snap_pos, on=["game_id", "play_id", "nfl_id"], how="inner")
        .join(
            snap_pos,
            left_on=["game_id", "play_id", "nfl_id_def"],
            right_on=["game_id", "play_id", "nfl_id"],
            how="inner",
            suffix="_def",
        )
        .filter(((pl.col("x") - pl.col("x_def")) ** 2 + (pl.col("y") - pl.col("y_def")) ** 2).sqrt() <= 10.0)
        .select(["game_id", "play_id", "nfl_id", "nfl_id_def"])
    )

    cov_pruned = (
        cov_pairs.join(snap_pos, on=["game_id", "play_id", "nfl_id"], how="inner")
        .join(
            snap_pos,
            left_on=["game_id", "play_id", "nfl_id_def"],
            right_on=["game_id", "play_id", "nfl_id"],
            how="inner",
            suffix="_def",
        )
        .filter(((pl.col("x") - pl.col("x_def")) ** 2 + (pl.col("y") - pl.col("y_def")) ** 2).sqrt() <= 15.0)
        .select(["game_id", "play_id", "nfl_id", "nfl_id_def"])
    )

    post = tr.filter(pl.col("snap_time").is_null() | (pl.col("time") >= pl.col("snap_time"))).select(
        ["game_id", "play_id", "nfl_id", "time", "x", "y", "s", "dir"]
    )

    def _pair_post_frames(pairs_df: pl.DataFrame) -> pl.DataFrame:
        return (
            pairs_df.join(post, on=["game_id", "play_id", "nfl_id"], how="inner")
            .join(
                post,
                left_on=["game_id", "play_id", "nfl_id_def", "time"],
                right_on=["game_id", "play_id", "nfl_id", "time"],
                how="inner",
                suffix="_def",
            )
            .with_columns([
                ((pl.col("x") - pl.col("x_def")) ** 2 + (pl.col("y") - pl.col("y_def")) ** 2)
                .sqrt()
                .alias("dist"),
                (pl.col("s") * (pl.col("dir") * math.pi / 180.0).sin()).alias("vx"),
                (pl.col("s") * (pl.col("dir") * math.pi / 180.0).cos()).alias("vy"),
                (pl.col("s_def") * (pl.col("dir_def") * math.pi / 180.0).sin()).alias("vx_def"),
                (pl.col("s_def") * (pl.col("dir_def") * math.pi / 180.0).cos()).alias("vy_def"),
            ])
            .with_columns(
                (
                    (pl.col("vx") * pl.col("vx_def") + pl.col("vy") * pl.col("vy_def"))
                    / (pl.col("s") * pl.col("s_def") + 1e-6)
                ).alias("vel_cos")
            )
            .sort(["game_id", "play_id", "nfl_id", "nfl_id_def", "time"])
        )

    # 2. OL vs DL sustained consecutive co-movement
    ol_dl_best = (
        _pair_post_frames(ol_dl_pruned)
        .with_columns(
            (
                (pl.col("dist") <= 2.5)
                & (pl.col("vel_cos") >= 0.50)
                & (pl.col("s") >= 0.5)
                & (pl.col("s_def") >= 0.5)
            ).alias("valid_frame")
        )
        .with_columns(
            (~pl.col("valid_frame"))
            .cum_sum()
            .over(["game_id", "play_id", "nfl_id", "nfl_id_def"])
            .alias("streak_id")
        )
        .filter(pl.col("valid_frame"))
        .group_by(["game_id", "play_id", "nfl_id", "nfl_id_def", "streak_id"])
        .agg(pl.len().alias("streak_len"))
        .group_by(["game_id", "play_id", "nfl_id", "nfl_id_def"])
        .agg(pl.col("streak_len").max().alias("max_streak"))
        .sort(["game_id", "play_id", "max_streak"], descending=[False, False, True])
        .group_by(["game_id", "play_id"], maintain_order=False)
        .first()
        .select([
            "game_id",
            "play_id",
            pl.col("max_streak").cast(pl.UInt16).alias("trench_comove_frames"),
            pl.col("nfl_id").cast(pl.Int32).alias("trench_off_id"),
            pl.col("nfl_id_def").cast(pl.Int32).alias("trench_def_id"),
        ])
    )

    # 3. Coverage mirroring (consecutive streak + mean_vel_cos)
    cov_frames = (
        _pair_post_frames(cov_pruned)
        .with_columns(
            (
                (pl.col("vel_cos") >= 0.75)
                & (pl.col("dist") <= 6.0)
                & (pl.col("s") >= 1.5)
                & (pl.col("s_def") >= 1.5)
            ).alias("valid_frame")
        )
        .with_columns(
            (~pl.col("valid_frame"))
            .cum_sum()
            .over(["game_id", "play_id", "nfl_id", "nfl_id_def"])
            .alias("streak_id")
        )
    )
    cov_best = (
        cov_frames.filter(pl.col("valid_frame"))
        .group_by(["game_id", "play_id", "nfl_id", "nfl_id_def", "streak_id"])
        .agg([
            pl.len().alias("streak_len"),
            pl.col("vel_cos").mean().alias("streak_cos"),
        ])
        .group_by(["game_id", "play_id", "nfl_id", "nfl_id_def"])
        .agg([
            pl.col("streak_len").max().alias("max_streak"),
            pl.col("streak_cos").mean().alias("mean_cos"),
        ])
        .sort(["game_id", "play_id", "max_streak", "mean_cos"], descending=[False, False, True, True])
        .group_by(["game_id", "play_id"], maintain_order=False)
        .first()
        .select([
            "game_id",
            "play_id",
            pl.col("max_streak").cast(pl.UInt16).alias("mirror_frames"),
            pl.col("mean_cos").cast(pl.Float32).alias("mirror_mean_cos"),
            pl.col("nfl_id").cast(pl.Int32).alias("mirror_off_id"),
            pl.col("nfl_id_def").cast(pl.Int32).alias("mirror_def_id"),
        ])
    )

    play_keys = season_pairs.select(["game_id", "play_id"]).unique()
    return (
        play_keys.join(assign_best, on=["game_id", "play_id"], how="left")
        .join(ol_dl_best, on=["game_id", "play_id"], how="left")
        .join(cov_best, on=["game_id", "play_id"], how="left")
        .with_columns([
            pl.col("trench_comove_frames").fill_null(0),
            pl.col("mirror_frames").fill_null(0),
        ])
    )


def export_multi_rookie_plays(data_dir: Path) -> Path:
    """Export all plays with >= 2 cohort rookies into docs/data/multi_rookie_plays.parquet."""
    print("-> Exporting multi_rookie_plays.parquet (>= 2 cohort rookies per play)...")
    t0 = time.time()
    pp = pl.scan_parquet(PROJECT_ROOT / "player_play.parquet")
    p = pl.scan_parquet(PROJECT_ROOT / "players.parquet").select(
        ["nfl_id", "display_name", "nfl_position", "draft_year"]
    )
    g = pl.scan_parquet(PROJECT_ROOT / "games.parquet").select(
        ["game_id", "season", "week", "home_team_abbr", "visitor_team_abbr"]
    )

    df = (
        pp.select([
            "game_id",
            "play_id",
            "nfl_id",
            "team_abbr",
            "lined_up_position",
            "quarter",
            "down",
            "yards_to_go",
            "possession_team",
            "yardline_side",
            "yardline_number",
            "game_clock",
            "play_direction",
            "expected_points_added",
            "pass_result",
            "run",
            "yards_gained",
            "offense_formation",
            "team_coverage_man_zone",
            "play_description",
        ])
        .join(p, on="nfl_id", how="inner")
        .with_columns(pl.len().over(["game_id", "play_id"]).alias("n_rookies"))
        .filter(pl.col("n_rookies") >= 2)
        .join(g, on="game_id", how="left")
        .with_columns(
            pl.when(pl.col("run").fill_null(False))
            .then(pl.lit("RUN"))
            .otherwise(pl.lit("PASS"))
            .alias("play_type")
        )
        .sort(["game_id", "play_id", "team_abbr", "nfl_id"])
        .group_by(["game_id", "play_id"], maintain_order=True)
        .agg([
            pl.first("season").cast(pl.Int16),
            pl.first("week").cast(pl.Int8),
            pl.first("home_team_abbr"),
            pl.first("visitor_team_abbr"),
            pl.first("possession_team"),
            pl.first("quarter").cast(pl.Int8),
            pl.first("down").cast(pl.Int8),
            pl.first("yards_to_go").cast(pl.Int16),
            pl.first("game_clock"),
            pl.first("yardline_side"),
            pl.first("yardline_number").cast(pl.Int16),
            pl.first("play_direction"),
            pl.first("play_type"),
            pl.first("expected_points_added").cast(pl.Float32),
            pl.first("yards_gained").cast(pl.Float32),
            pl.first("pass_result"),
            pl.first("offense_formation"),
            pl.first("team_coverage_man_zone"),
            pl.first("play_description"),
            pl.len().cast(pl.UInt8).alias("n_rookies"),
            pl.col("team_abbr").n_unique().cast(pl.UInt8).alias("n_teams"),
            pl.col("nfl_id").cast(pl.Utf8).str.join(",").alias("rookie_ids"),
            (
                pl.col("display_name")
                + pl.lit(" (")
                + pl.col("nfl_position")
                + pl.lit("•")
                + pl.col("team_abbr")
                + pl.lit(")")
            )
            .str.join(", ")
            .alias("rookie_summary"),
            pl.col("nfl_position").unique().sort().str.join(",").alias("rookie_positions"),
            pl.col("team_abbr").unique().sort().str.join(",").alias("rookie_teams"),
            pl.col("lined_up_position").fill_null("").str.join(",").alias("rookie_alignments"),
        ])
        .collect()
    )

    # Compute pairwise rookie interaction metrics season-by-season
    base_h2h = (
        pp.select([
            "game_id",
            "play_id",
            "nfl_id",
            "team_abbr",
            "possession_team",
            "lined_up_position",
            "coverage_assignment",
            "route_ran",
        ])
        .join(p.select(["nfl_id"]), on="nfl_id", how="inner")
        .join(g.select(["game_id", "season"]), on="game_id", how="left")
        .with_columns(pl.len().over(["game_id", "play_id"]).alias("n_rookies"))
        .filter(pl.col("n_rookies") >= 2)
        .with_columns((pl.col("team_abbr") == pl.col("possession_team")).alias("is_off"))
        .collect()
    )
    off_h2h = base_h2h.filter(pl.col("is_off"))
    def_h2h = base_h2h.filter(~pl.col("is_off"))
    all_pairs = off_h2h.join(def_h2h, on=["game_id", "play_id", "season"], suffix="_def")

    season_results = []
    for yr in (2023, 2024, 2025):
        yr_pairs = all_pairs.filter(pl.col("season") == yr)
        if len(yr_pairs) > 0:
            season_results.append(_compute_season_interactions(yr, yr_pairs))

    if season_results:
        interactions_df = pl.concat(season_results, how="vertical_relaxed")
        df = df.join(interactions_df, on=["game_id", "play_id"], how="left").with_columns([
            pl.col("trench_comove_frames").fill_null(0),
            pl.col("mirror_frames").fill_null(0),
        ])

    out_path = data_dir / "multi_rookie_plays.parquet"
    df.write_parquet(out_path, compression="zstd", compression_level=9)
    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"   Saved {len(df):,} multi-rookie plays to {out_path} ({size_mb:.2f} MB in {time.time() - t0:.2f}s)")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Build GitHub Pages bundle in docs/.")
    parser.add_argument(
        "--assets-only",
        action="store_true",
        help="Sync HTML/CSS/JS static assets to docs/ without regenerating data/ or parquets.",
    )
    parser.add_argument(
        "--multi-rookie-only",
        action="store_true",
        help="Sync static assets and regenerate docs/data/multi_rookie_plays.parquet without rebuilding all 510 player parquets.",
    )
    args = parser.parse_args()

    t_start = time.time()
    if args.assets_only:
        print("=== SYNCING STATIC FRONTEND ASSETS TO docs/ (--assets-only) ===")
        copy_static_assets()
        print(f"-> Static asset sync complete in {time.time() - t_start:.2f}s")
        return

    if args.multi_rookie_only:
        print("=== SYNCING ASSETS & EXPORTING MULTI-ROOKIE PLAYS (--multi-rookie-only) ===")
        copy_static_assets()
        data_dir = DOCS_DIR / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        export_multi_rookie_plays(data_dir)
        print(f"-> Multi-rookie build complete in {time.time() - t_start:.2f}s")
        return

    print("=== BUILDING GITHUB PAGES DEPLOYMENT BUNDLE (docs/) ===")

    # 1. Clean and initialize docs/ folder structure
    if DOCS_DIR.exists():
        shutil.rmtree(DOCS_DIR)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / "css").mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / "js").mkdir(parents=True, exist_ok=True)

    data_dir = DOCS_DIR / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "player").mkdir(parents=True, exist_ok=True)
    (data_dir / "parquet").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "position_avg").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "drills").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "compare_combine").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "compare_snap").mkdir(parents=True, exist_ok=True)

    # 2. Copy static web assets (including js/vendor/*.mjs) and .nojekyll
    copy_static_assets()
    print("-> Created docs/.nojekyll")

    # 4. Initialize registry and TestClient
    client = TestClient(app)
    registry = get_player_registry()

    # Export Metadata
    print("-> Exporting /api/metadata...")
    meta_resp = client.get("/api/metadata")
    meta_data = meta_resp.json()
    (data_dir / "metadata.json").write_text(json.dumps(meta_data, indent=2), encoding="utf-8")

    # Export Players
    print("-> Exporting /api/players...")
    players_resp = client.get("/api/players")
    players = players_resp.json()
    (data_dir / "players.json").write_text(json.dumps(players), encoding="utf-8")
    print(f"   Saved {len(players)} players in players.json")

    # Export Global Games Lookup Table (games.json)
    print("-> Exporting global games.json lookup table...")
    games_map: dict[str, dict] = {}
    for gid, ginfo in registry._games_by_id.items():
        games_map[str(gid)] = {
            "game_id": int(ginfo.get("game_id") or gid),
            "game_key": str(ginfo.get("game_key") or ""),
            "season": int(ginfo.get("season") or 0),
            "season_type": str(ginfo.get("season_type") or ""),
            "week": int(ginfo.get("week") or 0),
            "home_team_abbr": str(ginfo.get("home_team_abbr") or ""),
            "visitor_team_abbr": str(ginfo.get("visitor_team_abbr") or ""),
        }
    (data_dir / "games.json").write_text(
        json.dumps(games_map, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"   Saved {len(games_map)} games in data/games.json")

    export_multi_rookie_plays(data_dir)

    # 5. Export lightweight JSONs + slimmed ZSTD Parquets for ALL 510 players
    print(f"-> Exporting summaries, metadata, and ZSTD Parquet telemetry for all {len(players)} players...")
    t_players = time.time()
    parquet_dirs_created = 0
    parquet_files_written = 0

    for idx, p in enumerate(players):
        pid = p["nfl_id"]
        p_dir = data_dir / "player" / str(pid)
        p_dir.mkdir(parents=True, exist_ok=True)

        # Summary
        s_resp = client.get(f"/api/player/{pid}/summary")
        if s_resp.status_code == 200:
            (p_dir / "summary.json").write_text(s_resp.text, encoding="utf-8")

        # Combine scorecard + drill list
        c_resp = client.get(f"/api/player/{pid}/combine")
        if c_resp.status_code == 200:
            (p_dir / "combine.json").write_text(c_resp.text, encoding="utf-8")

        # Dynamics (already computed telemetry summary)
        d_resp = client.get(f"/api/player/{pid}/dynamics")
        if d_resp.status_code == 200:
            (p_dir / "dynamics.json").write_text(d_resp.text, encoding="utf-8")

        # Spatial Drills List
        sp_resp = client.get(f"/api/spatial/drills?nfl_id={pid}")
        if sp_resp.status_code == 200:
            (data_dir / "spatial" / "drills" / f"{pid}.json").write_text(sp_resp.text, encoding="utf-8")

        # Export slimmed ZSTD Parquets
        src_p_dir = registry.get_player_directory(pid)
        if src_p_dir and src_p_dir.exists():
            pq_out_dir = data_dir / "parquet" / str(pid)
            pq_out_dir.mkdir(parents=True, exist_ok=True)
            parquet_dirs_created += 1

            if export_slim_parquet(
                src_p_dir / "combine_tracking.parquet",
                pq_out_dir / "combine_tracking.parquet",
                COMBINE_TRACKING_COLS,
            ):
                parquet_files_written += 1

            if export_slim_parquet(
                src_p_dir / "player_play.parquet",
                pq_out_dir / "player_play.parquet",
                PLAYER_PLAY_COLS,
            ):
                parquet_files_written += 1

            for gt_src in sorted(src_p_dir.glob("game_tracking_*.parquet")):
                if export_slim_parquet(gt_src, pq_out_dir / gt_src.name, GAME_TRACKING_COLS):
                    parquet_files_written += 1

        if (idx + 1) % 100 == 0 or (idx + 1) == len(players):
            print(
                f"   Progress: {idx + 1}/{len(players)} players exported "
                f"({parquet_files_written} parquets, {time.time() - t_players:.1f}s)"
            )

    # 6. Export Spatial Position Averages
    print("-> Exporting spatial position averages across all positions...")
    for pos in meta_data.get("positions", []):
        for drill in ["FORTY_YARD_DASH", "THREE_CONE", "SHUTTLE"]:
            pa_resp = client.get(f"/api/spatial/position_avg?position={pos}&drill_name={drill}&step=0.5")
            if pa_resp.status_code == 200:
                pa_file = data_dir / "spatial" / "position_avg" / f"{pos}_{drill}_0.5.json"
                pa_file.write_text(pa_resp.text, encoding="utf-8")

    # 7. Export Baseline Spatial Comparisons
    print("-> Exporting sample spatial combine comparisons...")
    pA = 55884
    pB = 55887
    dA = "FORTY_YARD_DASH"
    dB = "FORTY_YARD_DASH"
    step = 0.5
    comp_resp = client.get(
        f"/api/spatial/compare/combine?player_a={pA}&drill_a={dA}&player_b={pB}&drill_b={dB}&step={step}"
    )
    if comp_resp.status_code == 200:
        c_file = data_dir / "spatial" / "compare_combine" / f"{pA}_{safe_id(dA)}_{pB}_{safe_id(dB)}_{step}.json"
        c_file.write_text(comp_resp.text, encoding="utf-8")

    comp_pos_resp = client.get(
        f"/api/spatial/compare/combine?player_a={pA}&drill_a={dA}&player_b=POS_AVG&drill_b={dA}&step={step}"
    )
    if comp_pos_resp.status_code == 200:
        c_file = data_dir / "spatial" / "compare_combine" / f"{pA}_{safe_id(dA)}_POS_AVG_{safe_id(dA)}_{step}.json"
        c_file.write_text(comp_pos_resp.text, encoding="utf-8")

    # Measure bundle size & largest single file
    all_files = [p for p in DOCS_DIR.rglob("*") if p.is_file()]
    total_files = len(all_files)
    total_size = sum(p.stat().st_size for p in all_files)
    max_file = max(all_files, key=lambda p: p.stat().st_size) if all_files else None
    max_mb = (max_file.stat().st_size / (1024 * 1024)) if max_file else 0.0

    print("\n=======================================================")
    print(f"GITHUB PAGES BUNDLE GENERATION COMPLETE in {time.time() - t_start:.2f}s")
    print(f"Total Files: {total_files}")
    print(f"Player Parquet Dirs: {parquet_dirs_created} ({parquet_files_written} files)")
    print(f"Total Bundle Size: {total_size / (1024 * 1024):.2f} MB")
    if max_file:
        print(f"Largest File: {max_file.relative_to(DOCS_DIR)} ({max_mb:.2f} MB)")
    print(f"Destination: {DOCS_DIR}")
    print("=======================================================")


if __name__ == "__main__":
    main()
