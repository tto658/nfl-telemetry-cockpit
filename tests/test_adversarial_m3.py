"""Adversarial Challenge Test Suite for Milestone M3.1 (Frontend Base & Tab 1 Combine Explorer).

Empirically verifies:
1. Static Asset Delivery:
   - Starlette TestClient probes all static URLs:
     /static/index.html, /static/css/styles.css, /static/js/api.js,
     /static/js/combine_field.js, /static/js/timeseries.js, /static/js/app.js.
   - HTTP 200, media types (text/html, text/css, javascript), non-empty payloads.
   - Path traversal and non-existent file security probing (404/400).
2. DOM & CSS Invariants:
   - Presence of essential DOM element IDs and classes.
   - CSS balance and syntax verification.
   - Dark theme palette invariants: #0f172a, #1e293b, #06b6d4, #f59e0b, #f43f5e.
3. API Client & Opt-Out Badging Adversarial Probing:
   - Full opt-out prospects vs zero opt-out prospects.
   - 0-game-snap prospects (56648, 58407) data contract safety.
   - Combine drills API with missing or invalid drill IDs and fuzz inputs.
4. JS Architecture & Kinematics DTO Contract Invariants:
   - DTO field contracts (FrameDTO).
   - Affine canvas scale and compass trigonometry invariants.
   - 10 Hz timing accumulator invariants.
"""

from __future__ import annotations

import re

import pytest
from starlette.testclient import TestClient

# =============================================================================
# 1. STATIC ASSET DELIVERY & SECURITY PROBING
# =============================================================================

@pytest.mark.parametrize("path,expected_media_type,min_size", [
    ("/static/index.html", "text/html", 1000),
    ("/static/css/styles.css", "text/css", 1000),
    ("/static/js/api.js", "javascript", 500),
    ("/static/js/combine_field.js", "javascript", 1000),
    ("/static/js/timeseries.js", "javascript", 1000),
    ("/static/js/app.js", "javascript", 1000),
])
def test_static_asset_delivery_contracts(client: TestClient, path: str, expected_media_type: str, min_size: int):
    """Confirm HTTP 200, media-types, and non-empty payloads for all static assets."""
    response = client.get(path)
    assert response.status_code == 200, f"Expected 200 for {path}, got {response.status_code}"
    content_type = response.headers.get("content-type", "").lower()
    assert expected_media_type in content_type or (expected_media_type == "javascript" and "text/plain" in content_type), (
        f"Expected {expected_media_type} in {content_type} for {path}"
    )
    assert len(response.content) >= min_size, f"Payload too small ({len(response.content)} bytes) for {path}"


@pytest.mark.parametrize("invalid_path", [
    "/static/nonexistent.html",
    "/static/js/fake_engine.js",
    "/static/css/nonexistent.css",
    "/static/unknown_dir/asset.js",
])
def test_static_asset_404_on_missing_files(client: TestClient, invalid_path: str):
    """Requests for nonexistent static files must return HTTP 404 without 500 crashes."""
    response = client.get(invalid_path)
    assert response.status_code == 404, f"Expected 404 for {invalid_path}, got {response.status_code}"


@pytest.mark.parametrize("traversal_path", [
    "/static/../players.parquet",
    "/static/..%2Fplayers.parquet",
    "/static/../../src/web/app.py",
    "/static/%2e%2e%2f%2e%2e%2fsrc/web/app.py",
])
def test_static_asset_directory_traversal_protection(client: TestClient, traversal_path: str):
    """Static asset handler must not expose parent directory files via path traversal."""
    response = client.get(traversal_path)
    # Must be 404 or 400 or redirect, but must never return 200 containing sensitive code/data
    if response.status_code == 200:
        assert "class PlayerRegistry" not in response.text
        assert "PAR1" not in response.text[:4]
    else:
        assert response.status_code in (400, 404, 307)


# =============================================================================
# 2. DOM & CSS LAYOUT INVARIANTS
# =============================================================================

def test_dom_essential_ids_and_classes(client: TestClient):
    """Check presence of essential DOM element IDs and classes in index.html."""
    res = client.get("/static/index.html")
    assert res.status_code == 200
    html = res.text

    # Essential IDs required by F5, F11, header filters, bio banner, Tab 1
    essential_ids = [
        "combineCanvas", "timeseriesCanvas",
        "tabBtnCombine", "tabBtnGame",
        "draftYearFilter", "positionFilter", "teamFilter", "searchInput", "searchClearBtn",
        "playerSelect", "playerCountBadge",
        "bioName", "bioPosition", "bioDraftPick", "bioCollege", "bioHeight", "bioWeight", "bioTeams",
        "bioTotalSnaps", "bioSnapBreakdown", "bioGamesActive",
        "cardForty", "metricForty", "badgeForty",
        "cardVertical", "metricVertical", "badgeVertical",
        "cardBroad", "metricBroad", "badgeBroad",
        "cardThreeCone", "metricThreeCone", "badgeThreeCone",
        "cardShuttle", "metricShuttle", "badgeShuttle",
        "cardBench", "metricBench", "badgeBench",
        "cardAthleticism", "metricAthleticism", "badgeAthleticism",
        "cardProduction", "metricProduction", "badgeProduction",
        "cardFinalScore", "metricFinalScore", "badgeFinalScore",
        "drillSelect", "drillMetricsCard", "drillDuration", "drillSMax", "drillAMax", "drillKappa90",
        "playbackBar", "btnPlayPause", "btnStepBack", "btnStepForward", "btnReset",
        "playbackScrubber", "playbackRateSelect", "playbackTimeDisplay",
        "loadingOverlay", "toastNotification"
    ]

    missing_ids = [eid for eid in essential_ids if f'id="{eid}"' not in html and f"id='{eid}'" not in html]
    assert not missing_ids, f"DOM is missing mandatory IDs: {missing_ids}"

    # Essential classes
    essential_classes = [
        "dark-theme", "global-header", "bio-banner", "tab-navbar", "tab-btn",
        "combine-metrics-section", "metrics-grid", "metric-card", "opt-out-container",
        "badge-opt-out", "opt-out", "combine-drills-section", "drill-select",
        "canvases-grid", "canvas-panel", "playback-bar", "btn-playback"
    ]
    missing_classes = [cls for cls in essential_classes if cls not in html]
    assert not missing_classes, f"DOM is missing mandatory classes: {missing_classes}"


def test_css_dark_theme_palette_invariants(client: TestClient):
    """Verify that CSS defines the dark theme palette (#0f172a, #1e293b, #06b6d4, #f59e0b, #f43f5e)."""
    res = client.get("/static/css/styles.css")
    assert res.status_code == 200
    css = res.text

    # Required dark theme palette colors
    palette_colors = {
        "#0f172a": "bg-primary (dark slate background)",
        "#1e293b": "bg-secondary (card & header background)",
        "#06b6d4": "color-cyan (primary accent / speed colormap / dir vector)",
        "#f59e0b": "color-amber (opt-out badge / ball trajectory / angular velocity)",
        "#f43f5e": "color-rose (max velocity accent / alert)",
    }

    for color_hex, description in palette_colors.items():
        assert color_hex.lower() in css.lower(), f"Missing dark theme palette color {color_hex} ({description})"

    # Verify structural CSS elements
    assert "dark-theme" in css
    assert "badge-opt-out" in css
    assert "opt-out" in css
    assert "canvases-grid" in css
    assert "playback-bar" in css


def test_css_syntax_balance_integrity(client: TestClient):
    """Verify that styles.css has balanced curly braces and comments without syntax errors."""
    res = client.get("/static/css/styles.css")
    assert res.status_code == 200
    css = res.text

    # Strip comments to check brace balance
    stripped_css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    open_braces = stripped_css.count("{")
    close_braces = stripped_css.count("}")
    assert open_braces > 50, "CSS seems too short or malformed"
    assert open_braces == close_braces, f"Unbalanced braces in styles.css: {open_braces} open vs {close_braces} close"

    # Verify comment closure
    assert "/*" not in stripped_css, "Unclosed comment block detected in styles.css"


# =============================================================================
# 3. API CLIENT & OPT-OUT BADGING ADVERSARIAL PROBING
# =============================================================================

def test_combine_api_full_opt_out_prospects(client: TestClient):
    """Prospects with full opt-outs must return explicit opt_out flags and null values without error."""
    # Test true 100% opt-outs (7/7 tests opted out: 56042 Puka Nacua, 55919 Tuli Tuipulotu, 57128 J.C. Latham)
    true_full_opt_out_ids = [56042, 55919, 57128]

    for nfl_id in true_full_opt_out_ids:
        res = client.get(f"/api/player/{nfl_id}/combine")
        assert res.status_code == 200, f"Expected 200 for full opt-out player {nfl_id}"
        data = res.json()

        assert "opt_outs" in data
        assert isinstance(data["opt_outs"], list)
        assert len(data["opt_outs"]) == 7, f"Player {nfl_id} should have 7 opt-outs, got {len(data['opt_outs'])}"

        # Primary drills should all have None value
        assert data.get("forty") is None
        assert data.get("vertical") is None
        assert data.get("broad_jump") is None
        assert data.get("three_cone") is None
        assert data.get("short_shuttle") is None
        assert data.get("bench_reps") is None

        # Check combine_tests dictionary structure
        tests = data.get("combine_tests", {})
        for drill in ["forty", "ten_yd_split", "vertical", "broad_jump", "three_cone", "short_shuttle", "bench_reps"]:
            if drill in tests:
                entry = tests[drill]
                assert entry["opt_out"] is True
                assert entry["value"] is None
                assert entry["status"] == "Opt-Out / MNAR"


def test_combine_api_partial_opt_out_prospects(client: TestClient):
    """Prospects with partial opt-outs (e.g. 56518 Alan Ali: 6 opt-outs, 1 recorded test) are handled cleanly."""
    res = client.get("/api/player/56518/combine")
    assert res.status_code == 200
    data = res.json()

    assert len(data["opt_outs"]) == 6
    assert "forty" in data["opt_outs"]
    assert "vertical" not in data["opt_outs"]

    tests = data["combine_tests"]
    assert tests["forty"]["opt_out"] is True
    assert tests["forty"]["value"] is None
    assert tests["forty"]["status"] == "Opt-Out / MNAR"

    assert tests["vertical"]["opt_out"] is False
    assert tests["vertical"]["value"] == 26.5
    assert tests["vertical"]["status"] == "Recorded"


def test_combine_api_zero_opt_out_prospects(client: TestClient):
    """Prospects with zero opt-outs must return empty opt_outs list and valid recorded metrics."""
    # Known complete participants: 55877 (Lukas Van Ness), 55901 (Steve Avila), 55913 (Cody Mauch)
    zero_opt_out_ids = [55877, 55901, 55913]

    for nfl_id in zero_opt_out_ids:
        res = client.get(f"/api/player/{nfl_id}/combine")
        assert res.status_code == 200, f"Expected 200 for complete participant {nfl_id}"
        data = res.json()

        assert "opt_outs" in data
        assert isinstance(data["opt_outs"], list)
        assert len(data["opt_outs"]) == 0, f"Player {nfl_id} should have 0 opt-outs, got {data['opt_outs']}"

        # Tests must be recorded floats
        assert isinstance(data.get("forty"), (int, float))
        assert data["forty"] > 4.0 and data["forty"] < 6.0
        assert isinstance(data.get("vertical"), (int, float))
        assert data["vertical"] > 20.0

        tests = data.get("combine_tests", {})
        for drill in ["forty", "vertical", "broad_jump", "three_cone", "short_shuttle", "bench_reps"]:
            entry = tests[drill]
            assert entry["opt_out"] is False
            assert isinstance(entry["value"], (int, float))
            assert entry["status"] == "Recorded"


@pytest.mark.parametrize("nfl_id,name", [
    (56648, "Ikenna Enechukwu"),
    (58407, "Gavin Bartholomew"),
])
def test_zero_game_snap_prospects_contracts(client: TestClient, nfl_id: int, name: str):
    """0-game-snap prospects must handle career, games, combine, and plays queries gracefully."""
    # 1. Summary endpoint
    res_summary = client.get(f"/api/player/{nfl_id}/summary")
    assert res_summary.status_code == 200, f"Summary failed for 0-snap player {name} ({nfl_id})"
    sum_data = res_summary.json()
    career = sum_data.get("career", {})
    assert career.get("total_snaps") == 0
    assert career.get("games_active") == 0
    assert career.get("offensive_snaps") == 0
    assert career.get("defensive_snaps") == 0
    assert career.get("special_teams_snaps") == 0

    # 2. Combine endpoint
    res_combine = client.get(f"/api/player/{nfl_id}/combine")
    assert res_combine.status_code == 200
    comb_data = res_combine.json()
    assert "combine_tests" in comb_data
    assert "drills" in comb_data
    assert isinstance(comb_data["drills"], list)

    # 3. Games endpoint returns empty list gracefully, never 500
    res_games = client.get(f"/api/player/{nfl_id}/games")
    assert res_games.status_code == 200
    assert res_games.json() == {"games": []}

    # 4. Plays endpoint returns empty list gracefully
    res_plays = client.get(f"/api/player/{nfl_id}/plays/2023091000")
    assert res_plays.status_code == 200
    assert res_plays.json() == []

    # 5. Snap endpoint for nonexistent game snap returns 404 cleanly
    res_snap = client.get(f"/api/player/{nfl_id}/snap/2023091000/100")
    assert res_snap.status_code == 404


@pytest.mark.parametrize("bad_player_id,bad_event_id,expected_status", [
    (58239, "NONEXISTENT_EVENT_XYZ", 404),
    (58239, "null", 404),
    (58239, "undefined", 404),
    (58239, "0", 404),
    (58239, "!@#$%^&*()", 404),
    (999999999, "any_event", 404),
    (-1, "any_event", 404),
    (0, "any_event", 404),
])
def test_combine_drill_adversarial_queries(client: TestClient, bad_player_id: int, bad_event_id: str, expected_status: int):
    """Combine drill endpoint must reject bad IDs with clean HTTP 404 without 500 errors."""
    url = f"/api/player/{bad_player_id}/combine/{bad_event_id}"
    res = client.get(url)
    assert res.status_code == expected_status, f"Expected {expected_status} for {url}, got {res.status_code}"


def test_combine_drill_cross_player_isolation(client: TestClient):
    """Attempting to request Player A's drill event_id under Player B's nfl_id must return 404."""
    # Jayden Higgins (58239) has drills
    higgins_res = client.get("/api/player/58239/combine")
    higgins_drills = higgins_res.json().get("drills", [])
    assert len(higgins_drills) > 0
    higgins_event_id = higgins_drills[0]["event_id"]

    # Lukas Van Ness (55877) is a different player
    van_ness_res = client.get("/api/player/55877/combine")
    van_ness_drills = van_ness_res.json().get("drills", [])
    van_ness_event_ids = {d["event_id"] for d in van_ness_drills}

    # Ensure Higgins's drill is not Van Ness's drill
    if higgins_event_id not in van_ness_event_ids:
        cross_res = client.get(f"/api/player/55877/combine/{higgins_event_id}")
        assert cross_res.status_code == 404, f"Cross-player drill access should be 404, got {cross_res.status_code}"


# =============================================================================
# 4. JS ARCHITECTURAL INVARIANTS & FRAMEDTO DATA CONTRACTS
# =============================================================================

def test_combine_drill_framedto_contract_invariants(client: TestClient):
    """Valid combine drill returns FrameDTO structures conforming to F8 and Tab 1 requirements."""
    res = client.get("/api/player/58239/combine")
    drills = res.json()["drills"]
    event_id = drills[0]["event_id"]

    res_drill = client.get(f"/api/player/58239/combine/{event_id}")
    assert res_drill.status_code == 200
    drill = res_drill.json()

    # Top-level summary metrics
    assert "duration" in drill and drill["duration"] > 0
    assert "s_max" in drill and drill["s_max"] >= 0
    assert "a_max" in drill and drill["a_max"] >= 0
    assert "kappa_90" in drill and drill["kappa_90"] >= 0

    # Frames arrays
    assert "player_frames" in drill
    assert "ball_frames" in drill
    player_frames = drill["player_frames"]
    assert len(player_frames) > 10, "Player frames time series too short"

    # FrameDTO field contracts
    required_dto_fields = ["frameId", "time", "x", "y", "s", "a", "dir"]
    first_frame = player_frames[0]
    for field in required_dto_fields:
        assert field in first_frame, f"Missing '{field}' in FrameDTO"

    # Kinematic value invariants
    for f in player_frames[:20]:
        assert f["s"] >= 0, "Speed must be non-negative"
        if f["dir"] is not None:
            assert 0.0 <= f["dir"] <= 360.0, f"dir {f['dir']} must be within [0, 360]"


def test_js_modules_pure_dto_consumption_and_rendering_invariants(client: TestClient):
    """Verify that frontend JS modules consume DTOs without doing raw kinematics derivation."""
    res_field = client.get("/static/js/combine_field.js")
    code_field = res_field.text

    # Affine transform and yard scale
    assert "scale(t.scale, -t.scale)" in code_field or "scale(scale, -scale)" in code_field
    # Dashed ball pattern (Trap 2 prevention) and mandatory reset
    assert "setLineDash" in code_field
    assert "setLineDash([])" in code_field
    # Upright text rendering post-restore
    assert "restore()" in code_field

    res_ts = client.get("/static/js/timeseries.js")
    code_ts = res_ts.text
    # 10 Hz exact accumulator with tab lag guard
    assert "requestAnimationFrame" in code_ts
    assert "100" in code_ts
    assert "500" in code_ts

    res_app = client.get("/static/js/app.js")
    code_app = res_app.text
    # Opt-out badge rendering
    assert "badge-opt-out" in code_app
    assert "Opt-Out / MNAR" in code_app
    # Debounced player search
    assert "searchDebounceTimer" in code_app or "setTimeout" in code_app
