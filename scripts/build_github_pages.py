"""
Export full static site for GitHub Pages deployment.
Generates docs/ directory with HTML/CSS/JS and pre-computed JSON data endpoints.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient
from src.web.app import app

DOCS_DIR = PROJECT_ROOT / "docs"
STATIC_SRC = PROJECT_ROOT / "src" / "web" / "static"


def safe_id(val: str) -> str:
    """Sanitize identifier for file system storage."""
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", str(val))


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
    (data_dir / "spatial").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "position_avg").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "drills").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "compare_combine").mkdir(parents=True, exist_ok=True)
    (data_dir / "spatial" / "compare_snap").mkdir(parents=True, exist_ok=True)

    # 2. Copy static web assets
    print("-> Copying frontend HTML, CSS, and JavaScript modules...")
    shutil.copy2(STATIC_SRC / "index.html", DOCS_DIR / "index.html")
    shutil.copy2(STATIC_SRC / "css" / "styles.css", DOCS_DIR / "css" / "styles.css")
    for js_file in (STATIC_SRC / "js").glob("*.js"):
        shutil.copy2(js_file, DOCS_DIR / "js" / js_file.name)

    # 3. Create .nojekyll marker to bypass Jekyll processing on GitHub Pages
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")
    print("-> Created docs/.nojekyll")

    # 4. Use TestClient to export API responses
    client = TestClient(app)

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

    # Export Bio Summary, Combine Scorecard, and Dynamics for all 510 players
    print(f"-> Exporting summaries, combine scorecards, and dynamics for all {len(players)} players...")
    t_players = time.time()
    for idx, p in enumerate(players):
        pid = p["nfl_id"]
        p_dir = data_dir / "player" / str(pid)
        p_dir.mkdir(parents=True, exist_ok=True)

        # Summary
        s_resp = client.get(f"/api/player/{pid}/summary")
        if s_resp.status_code == 200:
            (p_dir / "summary.json").write_text(s_resp.text, encoding="utf-8")

        # Combine
        c_resp = client.get(f"/api/player/{pid}/combine")
        if c_resp.status_code == 200:
            (p_dir / "combine.json").write_text(c_resp.text, encoding="utf-8")

        # Dynamics
        d_resp = client.get(f"/api/player/{pid}/dynamics")
        if d_resp.status_code == 200:
            (p_dir / "dynamics.json").write_text(d_resp.text, encoding="utf-8")

        # Spatial Drills List (Exported for ALL 510 players)
        sp_resp = client.get(f"/api/spatial/drills?nfl_id={pid}")
        if sp_resp.status_code == 200:
            (data_dir / "spatial" / "drills" / f"{pid}.json").write_text(sp_resp.text, encoding="utf-8")

        # Key combine tracking drills (FORTY_YARD_DASH, THREE_CONE, SHUTTLE) for all players
        comb_file = p_dir / "combine.json"
        if comb_file.exists():
            comb_data = json.loads(comb_file.read_text(encoding="utf-8"))
            for drill in comb_data.get("drills", []):
                d_name = drill.get("drill_name", "")
                if any(k in d_name for k in ["FORTY", "THREE_CONE", "SHUTTLE"]):
                    eid = drill["event_id"]
                    drills_dir = p_dir / "drills"
                    drills_dir.mkdir(parents=True, exist_ok=True)
                    drill_file = drills_dir / f"{safe_id(eid)}.json"
                    if not drill_file.exists():
                        d_resp = client.get(f"/api/player/{pid}/combine/{eid}")
                        if d_resp.status_code == 200:
                            drill_file.write_text(d_resp.text, encoding="utf-8")

        if (idx + 1) % 100 == 0 or (idx + 1) == len(players):
            print(f"   Progress: {idx + 1}/{len(players)} players exported ({time.time() - t_players:.1f}s)")

    # Select Featured Players for In-Depth Telemetry Export (Drills, GG-KDE, Games, Snaps)
    # Guarantee at least 2 featured players for every position in the NFL dataset
    featured_set: set[int] = set()
    for pos in meta_data.get("positions", []):
        pos_players = [p for p in players if p.get("position") == pos]
        for p in pos_players[:2]:
            featured_set.add(p["nfl_id"])

    # Add notable draft stars
    star_ids = [
        55867, 55870, 55874, 55875, 55877, 55878, 55879,
        55884, 55885, 55887, 55888, 55891, 55900, 55901,
        55903, 56042, 57126
    ]
    for sid in star_ids:
        if any(p["nfl_id"] == sid for p in players):
            featured_set.add(sid)

    featured_list = sorted(list(featured_set))
    print(f"-> Exporting high-frequency 10 Hz telemetry for {len(featured_list)} featured prospects...")

    for idx, pid in enumerate(featured_list):
        p_dir = data_dir / "player" / str(pid)
        drills_dir = p_dir / "drills"
        drills_dir.mkdir(parents=True, exist_ok=True)
        gg_dir = p_dir / "gg_kde"
        gg_dir.mkdir(parents=True, exist_ok=True)
        plays_dir = p_dir / "plays"
        plays_dir.mkdir(parents=True, exist_ok=True)
        snap_dir = p_dir / "snap"
        snap_dir.mkdir(parents=True, exist_ok=True)

        # 1. Combine Drills
        comb_file = p_dir / "combine.json"
        if comb_file.exists():
            comb_data = json.loads(comb_file.read_text(encoding="utf-8"))
            for drill in comb_data.get("drills", []):
                eid = drill["event_id"]
                d_resp = client.get(f"/api/player/{pid}/combine/{eid}")
                if d_resp.status_code == 200:
                    (drills_dir / f"{safe_id(eid)}.json").write_text(d_resp.text, encoding="utf-8")

        # 2. G-G KDE Clouds (Season & Combine)
        for scope in ["combine", "season"]:
            gg_resp = client.get(f"/api/player/{pid}/gg-kde?scope={scope}")
            if gg_resp.status_code == 200:
                (gg_dir / f"{scope}.json").write_text(gg_resp.text, encoding="utf-8")

        # 3. Games & Snaps
        games_resp = client.get(f"/api/player/{pid}/games")
        if games_resp.status_code == 200:
            (p_dir / "games.json").write_text(games_resp.text, encoding="utf-8")
            g_data = games_resp.json()
            games_list = g_data.get("games", [])
            for g in games_list[:3]:  # Top 3 games
                gid = g["game_id"]
                plays_resp = client.get(f"/api/player/{pid}/plays/{gid}")
                if plays_resp.status_code == 200:
                    (plays_dir / f"{gid}.json").write_text(plays_resp.text, encoding="utf-8")
                for pl in g.get("plays", [])[:3]:  # Top 3 snaps per game
                    plid = pl["play_id"]
                    snap_resp = client.get(f"/api/player/{pid}/snap/{gid}/{plid}")
                    if snap_resp.status_code == 200:
                        (snap_dir / f"{gid}_{plid}.json").write_text(snap_resp.text, encoding="utf-8")

        # 4. Spatial Drills List (Already exported in pass 1 above)
        print(f"   [{idx + 1}/{len(featured_list)}] Player {pid} telemetry exported")

    # 5. Export Spatial Position Averages
    print("-> Exporting spatial position averages across all positions...")
    for pos in meta_data.get("positions", []):
        for drill in ["FORTY_YARD_DASH", "THREE_CONE", "SHUTTLE"]:
            pa_resp = client.get(f"/api/spatial/position_avg?position={pos}&drill_name={drill}&step=0.5")
            if pa_resp.status_code == 200:
                pa_file = data_dir / "spatial" / "position_avg" / f"{pos}_{drill}_0.5.json"
                pa_file.write_text(pa_resp.text, encoding="utf-8")

    # 6. Export Baseline Spatial Comparisons
    print("-> Exporting sample spatial combine comparisons...")
    pA = 55884
    pB = 55887
    dA = "FORTY_YARD_DASH"
    dB = "FORTY_YARD_DASH"
    step = 0.5
    comp_resp = client.get(f"/api/spatial/compare/combine?player_a={pA}&drill_a={dA}&player_b={pB}&drill_b={dB}&step={step}")
    if comp_resp.status_code == 200:
        c_file = data_dir / "spatial" / "compare_combine" / f"{pA}_{safe_id(dA)}_{pB}_{safe_id(dB)}_{step}.json"
        c_file.write_text(comp_resp.text, encoding="utf-8")

    comp_pos_resp = client.get(f"/api/spatial/compare/combine?player_a={pA}&drill_a={dA}&player_b=POS_AVG&drill_b={dA}&step={step}")
    if comp_pos_resp.status_code == 200:
        c_file = data_dir / "spatial" / "compare_combine" / f"{pA}_{safe_id(dA)}_POS_AVG_{safe_id(dA)}_{step}.json"
        c_file.write_text(comp_pos_resp.text, encoding="utf-8")

    # Measure bundle size
    total_files = sum(1 for _ in DOCS_DIR.rglob("*") if _.is_file())
    total_size = sum(_.stat().st_size for _ in DOCS_DIR.rglob("*") if _.is_file())
    print("\n=======================================================")
    print(f"GITHUB PAGES BUNDLE GENERATION COMPLETE in {time.time() - t_start:.2f}s")
    print(f"Total Files: {total_files}")
    print(f"Total Bundle Size: {total_size / (1024 * 1024):.2f} MB")
    print(f"Destination: {DOCS_DIR}")
    print("=======================================================")


if __name__ == "__main__":
    main()
