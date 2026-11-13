"""
Export full static site for GitHub Pages deployment.
Generates docs/ directory with HTML/CSS/JS, pre-computed lightweight metadata JSONs,
global games.json, and slimmed Float32 ZSTD Parquet telemetry for all 510 players
decoded directly in-browser via hyparquet.
"""

from __future__ import annotations

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


def main() -> None:
    t_start = time.time()
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

    # 2. Copy static web assets (including js/vendor/*.mjs)
    print("-> Copying frontend HTML, CSS, JavaScript modules, and vendor bundles...")
    for html_file in STATIC_SRC.glob("*.html"):
        shutil.copy2(html_file, DOCS_DIR / html_file.name)
    shutil.copy2(STATIC_SRC / "css" / "styles.css", DOCS_DIR / "css" / "styles.css")
    shutil.copytree(STATIC_SRC / "js", DOCS_DIR / "js", dirs_exist_ok=True)

    # 3. Create .nojekyll marker to bypass Jekyll processing on GitHub Pages
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")
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
