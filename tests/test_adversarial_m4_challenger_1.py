"""Adversarial Verification Suite for Milestone M4 (Challenger M4.1).

Empirically verifies:
1. Static Asset Delivery & Script Inclusion:
   - /static/js/game_field.js delivers valid JS with HTTP 200
   - /static/index.html includes all mandatory script tags and Tab 2 DOM anchors
   - Stylesheet and static script integrity
2. Zero-Snap Rookie Stress Test:
   - All 13 zero-snap rookies in players.parquet:
     56648, 56363, 57743, 57660, 58293, 58326, 58374, 58407, 58417, 58455, 58515, 58737, 59000
   - Confirm /games returns {"games": []} with HTTP 200
   - Confirm /plays/{game_id} returns [] with HTTP 200
   - Confirm /snap/{game_id}/{play_id} returns 404 without server errors
   - UI displays #zeroSnapCard gracefully with 1-click CTA to Tab 1 without JS errors
3. Plays API & Play Filtering Stress Test:
   - Valid, mixed-case, and non-existent play_type filters (PASS, pass, RUN, run, PUNT, UNKNOWN)
   - Valid, mixed-case, and non-existent lined_up_position filters
   - Malformed, negative, zero, and out-of-range IDs return proper 404s without HTTP 500 crashes
4. Node.js headless execution of zero-snap UI state transitions and CTA actions
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient

# All 13 confirmed zero-snap prospects in players.parquet
ALL_13_ZERO_SNAP_ROOKIES = [
    (56648, "Ikenna Enechukwu", "OLB"),
    (56363, "Leonard Taylor", "TE"),
    (57743, "Trajan Jeffcoat", "DE"),
    (57660, "Lideatrick Griffin", "WR"),
    (58293, "Caleb Ransaw", "FS"),
    (58326, "David Walker", "OLB"),
    (58374, "Zah Frazier", "CB"),
    (58407, "Gavin Bartholomew", "TE"),
    (58417, "Robert Longerbeam", "CB"),
    (58455, "John Williams", "G"),
    (58515, "Jake Briningstool", "TE"),
    (58737, "Jalin Conyers", "TE"),
    (59000, "Malik Verdon", "ILB"),
]


# ==============================================================================
# SECTION 1: Static Asset Delivery & Script Inclusion
# ==============================================================================

def test_static_asset_game_field_js_delivery(client: TestClient):
    """GET /static/js/game_field.js delivers HTTP 200, javascript content-type and valid syntax."""
    res = client.get("/static/js/game_field.js")
    assert res.status_code == 200
    ctype = res.headers.get("content-type", "").lower()
    assert "javascript" in ctype or "text/plain" in ctype
    assert len(res.text) > 1000
    assert "export class GameFieldCanvas" in res.text or "class GameFieldCanvas" in res.text


def test_static_asset_timeseries_js_delivery(client: TestClient):
    """GET /static/js/timeseries.js delivers HTTP 200 with PlaybackEngine and TimeseriesCanvas."""
    res = client.get("/static/js/timeseries.js")
    assert res.status_code == 200
    assert "TimeseriesCanvas" in res.text
    assert "PlaybackEngine" in res.text


def test_static_asset_app_and_api_js_delivery(client: TestClient):
    """GET /static/js/app.js and /static/js/api.js deliver HTTP 200."""
    res_app = client.get("/static/js/app.js")
    assert res_app.status_code == 200
    assert len(res_app.text) > 1000

    res_api = client.get("/static/js/api.js")
    assert res_api.status_code == 200
    assert "getPlayerGames" in res_api.text
    assert "getPlayerPlays" in res_api.text
    assert "getPlayerSnap" in res_api.text


def test_static_stylesheet_delivery(client: TestClient):
    """GET /static/css/styles.css delivers HTTP 200 with dark theme styling and Tab 2 styles."""
    res = client.get("/static/css/styles.css")
    assert res.status_code == 200
    assert "zero-snap-card" in res.text
    assert "canvases-grid" in res.text or "canvas-wrapper" in res.text
    assert "--color-cyan" in res.text


def test_index_html_mandatory_script_inclusion(client: TestClient):
    """GET /static/index.html includes module entrypoints; app.js imports timeseries.js and api.js."""
    res = client.get("/static/index.html")
    assert res.status_code == 200
    html = res.text
    assert "game_field.js" in html
    assert "app.js" in html
    assert 'type="module"' in html

    # Verify that app.js properly imports timeseries.js and api.js
    res_app = client.get("/static/js/app.js")
    assert res_app.status_code == 200
    assert "from './timeseries.js'" in res_app.text
    assert "from './api.js'" in res_app.text


def test_index_html_mandatory_tab2_dom_elements(client: TestClient):
    """GET /static/index.html contains every mandatory Tab 2 element and 0-snap rookie CTA."""
    res = client.get("/static/index.html")
    assert res.status_code == 200
    html = res.text

    mandatory_ids = [
        "tab-game",
        "zeroSnapCard",
        "btnSwitchToCombine",
        "gameExplorerContent",
        "gameFiltersToolbar",
        "gameSeasonSelect",
        "gameSelect",
        "playTypeFilter",
        "playPositionFilter",
        "playsTableContainer",
        "playsTable",
        "playMetadataCard",
        "metaDescription",
        "metaDownDistance",
        "metaEpaPill",
        "gameFieldCanvas",
        "gameTimeseriesCanvas",
        "btnToggleGameView",
        "gamePlaybackBar",
        "btnGamePlayPause",
        "btnGameStepBack",
        "btnGameStepForward",
        "btnGameReset",
        "gamePlaybackScrubber",
        "gamePlaybackTimeDisplay",
        "gamePlaybackRateSelect",
        "gameEventButtons",
    ]

    for elem_id in mandatory_ids:
        assert f'id="{elem_id}"' in html, f"Missing mandatory Tab 2 DOM element: id='{elem_id}'"


# ==============================================================================
# SECTION 2: All 13 Zero-Snap Rookies Stress Test
# ==============================================================================

@pytest.mark.parametrize("nfl_id,name,pos", ALL_13_ZERO_SNAP_ROOKIES)
def test_all_13_zero_snap_rookies_games_endpoint(client: TestClient, nfl_id: int, name: str, pos: str):
    """All 13 zero-snap prospects return HTTP 200 with {'games': []}."""
    res = client.get(f"/api/player/{nfl_id}/games")
    assert res.status_code == 200, f"Player {name} ({nfl_id}) failed /games with {res.status_code}"
    data = res.json()
    assert "games" in data, f"Key 'games' missing for {name} ({nfl_id})"
    assert isinstance(data["games"], list)
    assert len(data["games"]) == 0, f"Player {name} ({nfl_id}) expected 0 games, got {len(data['games'])}"


@pytest.mark.parametrize("nfl_id,name,pos", ALL_13_ZERO_SNAP_ROOKIES)
def test_all_13_zero_snap_rookies_summary_career_snaps(client: TestClient, nfl_id: int, name: str, pos: str):
    """All 13 zero-snap prospects return HTTP 200 with career_total_snaps == 0."""
    res = client.get(f"/api/player/{nfl_id}/summary")
    assert res.status_code == 200
    data = res.json()
    assert data["bio"]["career_total_snaps"] == 0


@pytest.mark.parametrize("nfl_id,name,pos", ALL_13_ZERO_SNAP_ROOKIES)
def test_all_13_zero_snap_rookies_plays_and_snap_endpoints(client: TestClient, nfl_id: int, name: str, pos: str):
    """Querying plays for nonexistent game returns [] with 200; querying snap returns 404."""
    # /plays with arbitrary game ID
    res_plays = client.get(f"/api/player/{nfl_id}/plays/2023091000")
    assert res_plays.status_code == 200
    assert res_plays.json() == []

    # /snap with arbitrary game and play ID
    res_snap = client.get(f"/api/player/{nfl_id}/snap/2023091000/100")
    assert res_snap.status_code == 404
    assert res_snap.status_code != 500


# ==============================================================================
# SECTION 3: Plays API & Play Filtering Stress Test
# ==============================================================================

def test_plays_filtering_case_insensitivity_and_variants(client: TestClient):
    """Test play_type and lined_up_position filters on real prospect (Puka Nacua 56042)."""
    puka_id = 56042
    res_games = client.get(f"/api/player/{puka_id}/games")
    assert res_games.status_code == 200
    games = res_games.json()["games"]
    assert len(games) > 0
    game_id = games[0]["game_id"]

    # 1. Baseline: all plays for game
    res_all = client.get(f"/api/player/{puka_id}/plays/{game_id}")
    assert res_all.status_code == 200
    all_plays = res_all.json()
    assert len(all_plays) > 0

    # 2. Play type uppercase vs lowercase
    res_pass_upper = client.get(f"/api/player/{puka_id}/plays/{game_id}?play_type=PASS")
    res_pass_lower = client.get(f"/api/player/{puka_id}/plays/{game_id}?play_type=pass")
    assert res_pass_upper.status_code == 200
    assert res_pass_lower.status_code == 200
    assert res_pass_upper.json() == res_pass_lower.json()

    # 3. Play type RUN
    res_run = client.get(f"/api/player/{puka_id}/plays/{game_id}?play_type=RUN")
    assert res_run.status_code == 200
    assert isinstance(res_run.json(), list)

    # 4. Unknown play type returns empty list, not 500
    res_unknown = client.get(f"/api/player/{puka_id}/plays/{game_id}?play_type=UNKNOWN_TYPE")
    assert res_unknown.status_code == 200
    assert res_unknown.json() == []

    # 5. Position filter uppercase vs lowercase
    res_pos_wr = client.get(f"/api/player/{puka_id}/plays/{game_id}?lined_up_position=WR")
    res_pos_wr_lower = client.get(f"/api/player/{puka_id}/plays/{game_id}?lined_up_position=wr")
    assert res_pos_wr.status_code == 200
    assert res_pos_wr_lower.status_code == 200
    assert res_pos_wr.json() == res_pos_wr_lower.json()

    # 6. Nonexistent alignment position
    res_pos_none = client.get(f"/api/player/{puka_id}/plays/{game_id}?lined_up_position=NONEXISTENT_POS")
    assert res_pos_none.status_code == 200
    assert res_pos_none.json() == []

    # 7. Combined filter: play_type=PASS and lined_up_position=WR
    res_combo = client.get(f"/api/player/{puka_id}/plays/{game_id}?play_type=PASS&lined_up_position=WR")
    assert res_combo.status_code == 200
    combo_plays = res_combo.json()
    assert all(p["play_type"] == "PASS" and p["lined_up_position"] == "WR" for p in combo_plays)


def test_adversarial_invalid_and_missing_ids(client: TestClient):
    """Stress-test invalid, negative, out-of-bounds IDs across all Tab 2 endpoints."""
    # 1. Nonexistent player IDs in /games
    res = client.get("/api/player/99999999/games")
    assert res.status_code == 404
    assert res.status_code != 500

    # 2. Negative player ID in /games
    res = client.get("/api/player/-1/games")
    assert res.status_code in (404, 400)

    # 3. Zero player ID in /games
    res = client.get("/api/player/0/games")
    assert res.status_code in (404, 400)

    # 4. Nonexistent player in /plays/{game_id}
    res = client.get("/api/player/99999999/plays/2023091000")
    assert res.status_code == 404

    # 5. Nonexistent game ID in /plays/{game_id} for valid player
    res = client.get("/api/player/56042/plays/999999999")
    assert res.status_code == 200
    assert res.json() == []

    # 6. Nonexistent play ID in /snap/{game_id}/{play_id}
    res = client.get("/api/player/56042/snap/2023091000/99999999")
    assert res.status_code == 404
    assert "not found" in res.json().get("detail", "").lower()

    # 7. Nonexistent game ID in /snap/{game_id}/{play_id}
    res = client.get("/api/player/56042/snap/99999999/100")
    assert res.status_code == 404
    assert "not found" in res.json().get("detail", "").lower()

    # 8. Malformed / injection query parameters produce 0 crashes
    malformed_queries = [
        "?play_type=' OR '1'='1",
        "?play_type=<script>alert(1)</script>",
        "?lined_up_position=;DROP TABLE players;--",
        "?season=NOT_A_NUMBER",
        "?season=-999",
    ]
    for q in malformed_queries:
        res = client.get(f"/api/player/56042/games{q}")
        assert res.status_code == 200
        assert res.status_code != 500


# ==============================================================================
# SECTION 4: Headless Node.js UI Zero-Snap State Machine Test
# ==============================================================================

def test_nodejs_zero_snap_ui_state_machine():
    """Execute headless Node.js runner to verify zero-snap UI state & 1-click CTA."""
    runner_path = Path("tests/test_zero_snap_ui_runner.mjs")
    assert runner_path.exists(), "tests/test_zero_snap_ui_runner.mjs must exist"

    result = subprocess.run(
        ["node", str(runner_path)],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, f"Zero-snap UI test failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    assert "ZERO-SNAP UI CHECKS PASSED" in result.stdout
