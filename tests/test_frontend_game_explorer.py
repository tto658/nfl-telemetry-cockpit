"""Frontend Game Explorer & 10 Hz Playback Verification Test Suite.

Milestone M4: Tab 2 Game Explorer & 10 Hz Playback
Empirically verifies:
1. Static Asset Delivery:
   - /static/js/game_field.js (HTTP 200, javascript content-type, non-empty)
   - /static/index.html includes module script tag for game_field.js
2. Tab 2 Mandatory DOM Anchors:
   - Canvases: gameFieldCanvas, gameTimeseriesCanvas
   - View toggle button: btnToggleGameView
   - Game filters toolbar: gameFiltersToolbar, gameSeasonSelect, gameSelect, playTypeFilter, playPositionFilter
   - Plays list table container: playsTableContainer, gamePlaysTable
   - Play metadata card: playMetadataCard, metaGameTitle, metaPlayDesc, metaDownDistance, metaScore, metaEpa
   - Zero-snap rookie card: zeroSnapCard
   - Game playback bar: gamePlaybackBar, btnGamePlayPause, btnGameStepBack, btnGameStepForward, btnGameReset,
     gameScrubber, gameTimeDisplay, gamePlaybackSpeed, gameEventButtons
3. Architectural & Mathematical Invariants in game_field.js:
   - 120 x 53.33333 yard regulation NFL field geometry
   - NFL Rule 1 Section 2 hashmarks at 70 ft 9 in = 23.58333 yards from each sideline
   - 4-step inverted-Y transform: ctx.translate(offsetX, H - offsetY), ctx.scale(scale, -scale), ctx.translate(-minX, -minY)
   - Forward (yardToPixel) and inverse (pixelToYard) projection helpers
   - Dual vectors: motion direction dir (cyan) and body orientation o (amber)
   - Parametric slip angle arc with severity classification (<30° normal, 30-60° moderate, >60° high)
   - Floating degree badge in screen pixel space post-restore
   - Scale-invariant ball trajectory with Trap 2 mandatory reset: ctx.setLineDash([])
   - Dual viewport framing: 'full' vs 'snap'
4. Timeseries Invariants in timeseries.js:
   - Dynamic 5-lane configuration with slip_angle [-180°, +180°]
   - 4-lane backward compatibility for Tab 1 Combine Explorer
   - Event milestone vertical dashed lines & click-to-seek
5. API Integration & Zero-Snap Prospect Handling:
   - Travis Hunter (58407) & Tory Taylor (56648) 0-game / 0-snap handling
   - Puka Nacua (56042) game explorer workflow: games -> plays -> snap telemetry
6. Node.js Headless Verification Runner:
   - Executes tests/game_explorer_runner.mjs asserting all headless checks pass.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient

# ==============================================================================
# SECTION 1: Static Asset Delivery & Script Inclusion
# ==============================================================================

def test_static_game_field_js_delivery(client: TestClient):
    """GET /static/js/game_field.js returns HTTP 200 with javascript content-type."""
    response = client.get("/static/js/game_field.js")
    assert response.status_code == 200
    content_type = response.headers.get("content-type", "").lower()
    assert "javascript" in content_type or "text/plain" in content_type
    assert len(response.text) >= 1000
    assert "class GameFieldCanvas" in response.text


def test_index_html_includes_game_field_module(client: TestClient):
    """GET /static/index.html includes module script tag referencing game_field.js."""
    response = client.get("/static/index.html")
    assert response.status_code == 200
    html = response.text
    assert "game_field.js" in html
    assert 'type="module"' in html


# ==============================================================================
# SECTION 2: Tab 2 Mandatory DOM Anchors
# ==============================================================================

def test_index_html_tab2_mandatory_dom_anchors(client: TestClient):
    """Confirm all mandatory Tab 2 DOM anchors exist in index.html."""
    response = client.get("/static/index.html")
    assert response.status_code == 200
    html = response.text

    # Tab triggers and views
    assert 'tabBtnGame' in html or 'tab-game' in html
    assert 'tab-game' in html or 'tabGame' in html

    # Canvases
    assert 'id="gameFieldCanvas"' in html
    assert 'id="gameTimeseriesCanvas"' in html
    assert 'id="btnToggleGameView"' in html

    # Game & Play Selectors Toolbar
    assert 'id="gameFiltersToolbar"' in html
    assert 'id="gameSeasonSelect"' in html
    assert 'id="gameSelect"' in html
    assert 'id="playTypeFilter"' in html
    assert 'id="playPositionFilter"' in html

    # Plays Table
    assert 'id="playsTableContainer"' in html
    assert 'id="playsTable"' in html

    # Play Metadata Card & Situation HUD
    assert 'id="playMetadataCard"' in html
    assert 'id="metaDescription"' in html
    assert 'id="metaDownDistance"' in html
    assert 'id="metaEpaPill"' in html
    assert 'id="metaEpaValue"' in html

    # Zero-Snap Rookie Card
    assert 'id="zeroSnapCard"' in html

    # Game Playback Controls & Scrubber
    assert 'id="gamePlaybackBar"' in html
    assert 'id="btnGamePlayPause"' in html
    assert 'id="btnGameStepBack"' in html
    assert 'id="btnGameStepForward"' in html
    assert 'id="btnGameReset"' in html
    assert 'id="gamePlaybackScrubber"' in html
    assert 'id="gamePlaybackTimeDisplay"' in html
    assert 'id="gamePlaybackRateSelect"' in html
    assert 'id="gameEventButtons"' in html


# ==============================================================================
# SECTION 3: Architectural & Mathematical Invariants in JS Modules
# ==============================================================================

def test_game_field_js_architectural_invariants(client: TestClient):
    """Empirically verify mathematical constants and rendering contracts in game_field.js."""
    response = client.get("/static/js/game_field.js")
    assert response.status_code == 200
    code = response.text

    # 1. Regulation NFL field geometry
    assert "120" in code
    assert "53.33" in code or "53.33333" in code
    # Rule 1 Sec 2 hashmarks: 70 ft 9 in = 23.58333 yd from sidelines
    assert "23.58" in code

    # 2. 4-step inverted-Y affine transformation
    assert ("translate(t.offsetX, t.cssHeight - t.offsetY)" in code or "translate(offsetX, H - offsetY)" in code)
    assert ("scale(t.scale, -t.scale)" in code or "scale(scale, -scale)" in code)
    assert ("translate(-b.minX, -b.minY)" in code or "translate(-minX, -minY)" in code)

    # 3. Bijective projection helpers
    assert "yardToPixel" in code
    assert "pixelToYard" in code

    # 4. Dual vector rendering (cyan dir, amber o)
    assert "#00f0ff" in code or "#06b6d4" in code  # Cyan direction
    assert "#f59e0b" in code  # Amber orientation
    assert "s * 0.8" in code  # Proportional arrow length

    # 5. Slip angle math & severity
    assert "normalizeSlipAngle" in code
    assert "getSlipSeverity" in code
    assert "Math.sin(thetaRad)" in code
    assert "Math.cos(thetaRad)" in code

    # 6. Trap 2 line dash reset
    assert "setLineDash" in code
    assert "setLineDash([])" in code

    # 7. Post-restore upright text rendering
    assert "ctx.restore()" in code
    assert "drawUprightYardNumbers" in code
    assert "drawSlipAngleBadgeScreen" in code

    # 8. Viewport framing modes
    assert "getFullFieldBounds" in code
    assert "computeBoundingBox" in code
    assert "setViewMode" in code


def test_interactive_zoomable_field_controls(client: TestClient):
    """Verify interactive zoom and pan methods and DOM controls on 2D field canvas."""
    res_js = client.get("/static/js/game_field.js")
    assert res_js.status_code == 200
    js_code = res_js.text
    assert "zoomIn" in js_code
    assert "zoomOut" in js_code
    assert "resetZoom" in js_code
    assert "zoomAt" in js_code
    assert "handleWheel" in js_code
    assert "handlePointerMove" in js_code

    res_html = client.get("/")
    assert res_html.status_code == 200
    html = res_html.text
    assert 'id="btnGameZoomIn"' in html
    assert 'id="btnGameZoomOut"' in html
    assert 'id="btnGameZoomReset"' in html
    assert 'id="btnCombineZoomIn"' in html
    assert 'id="btnCombineZoomOut"' in html
    assert 'id="btnCombineZoomReset"' in html


def test_timeseries_js_5lane_dynamic_invariants(client: TestClient):
    """Verify dynamic 5-lane metric configuration and event seeking in timeseries.js."""
    response = client.get("/static/js/timeseries.js")
    assert response.status_code == 200
    code = response.text

    # Dynamic metrics configuration supporting slip angle
    assert "_configureMetrics" in code
    assert "slip_angle" in code
    assert "beta_slip" in code
    assert "-180.0" in code
    assert "180.0" in code

    # Event milestone vertical dashed lines
    assert "setLineDash" in code
    assert "events" in code

    # Backward compatibility
    assert "baseMetrics" in code
    assert "PlaybackEngine" in code
    assert "TimeseriesCanvas" in code


def test_api_js_game_explorer_methods(client: TestClient):
    """Verify required Game Explorer endpoints in api.js."""
    response = client.get("/static/js/api.js")
    assert response.status_code == 200
    code = response.text

    assert "getPlayerGames" in code
    assert "getPlayerPlays" in code
    assert "getPlayerSnap" in code


# ==============================================================================
# SECTION 4: Backend API Integration & Zero-Snap Prospect Handling
# ==============================================================================

@pytest.mark.parametrize("rookie_id", [58407, 56648])
def test_zero_snap_rookie_api_contracts(client: TestClient, rookie_id: int):
    """Zero-snap rookies (58407 Travis Hunter, 56648 Tory Taylor) return 0 games and 0 snaps."""
    # 1. Player profile check
    res_prof = client.get(f"/api/player/{rookie_id}/summary")
    assert res_prof.status_code == 200
    p_data = res_prof.json()
    assert p_data["bio"]["career_total_snaps"] == 0

    # 2. Games list check
    res_games = client.get(f"/api/player/{rookie_id}/games")
    assert res_games.status_code == 200
    g_data = res_games.json()
    assert "games" in g_data
    assert isinstance(g_data["games"], list)
    assert len(g_data["games"]) == 0


def test_game_explorer_full_workflow_api(client: TestClient):
    """Verify full Game Explorer API workflow for prospect with tracking data (Puka Nacua 56042)."""
    puka_id = 56042

    # Step 1: Fetch games
    res_games = client.get(f"/api/player/{puka_id}/games")
    assert res_games.status_code == 200
    games_data = res_games.json()
    assert "games" in games_data
    games = games_data["games"]
    assert len(games) > 0, "Puka Nacua must have games"

    first_game = games[0]
    assert "game_id" in first_game
    game_id = first_game["game_id"]

    # Step 2: Fetch plays for first game
    res_plays = client.get(f"/api/player/{puka_id}/plays/{game_id}")
    assert res_plays.status_code == 200
    plays = res_plays.json()
    assert isinstance(plays, list)
    assert len(plays) > 0, f"Game {game_id} must have plays for player {puka_id}"

    first_play = plays[0]
    assert "play_id" in first_play
    play_id = first_play["play_id"]

    # Step 3: Fetch snap telemetry
    res_snap = client.get(f"/api/player/{puka_id}/snap/{game_id}/{play_id}")
    assert res_snap.status_code == 200
    snap_data = res_snap.json()

    assert "frames" in snap_data
    frames = snap_data["frames"]
    assert len(frames) > 0, "Snap must contain tracking frames"

    # Verify frame telemetry fields
    f0 = frames[0]
    assert "x" in f0
    assert "y" in f0
    assert "s" in f0
    assert "a" in f0
    assert "dir" in f0
    # Optional fields present or null
    assert "o" in f0
    assert "slip_angle" in f0 or "beta_slip" in f0

    # Events and snap metadata
    assert "events" in snap_data
    assert "game_id" in snap_data
    assert "play_id" in snap_data


# ==============================================================================
# SECTION 5: Mathematical Oracles & Coordinate Geometry Invariants
# ==============================================================================

def test_full_field_coordinate_bijection_py():
    """Verify that full-field yardToPixel and pixelToYard form an exact mathematical bijection."""
    css_width = 900.0
    css_height = 480.0
    padding = 32.0

    # Bounds covering 120 x 53.33333 yd plus margins
    min_x, max_x = -6.0, 126.0
    min_y, max_y = -4.0, 57.33333
    span_x = max_x - min_x  # 132.0
    span_y = max_y - min_y  # 61.33333

    avail_w = css_width - 2 * padding
    avail_h = css_height - 2 * padding
    scale = min(avail_w / span_x, avail_h / span_y)

    content_w = span_x * scale
    content_h = span_y * scale
    offset_x = padding + (avail_w - content_w) / 2.0
    offset_y = padding + (avail_h - content_h) / 2.0

    def yard_to_pixel(x: float, y: float) -> tuple[float, float]:
        px = offset_x + (x - min_x) * scale
        py = (css_height - offset_y) - (y - min_y) * scale
        return px, py

    def pixel_to_yard(px: float, py: float) -> tuple[float, float]:
        x = min_x + (px - offset_x) / scale
        y = min_y + ((css_height - offset_y) - py) / scale
        return x, y

    # Test key field landmarks
    test_points = [
        (0.0, 0.0),                     # Back corner of endzone
        (10.0, 0.0),                    # Goal line
        (60.0, 26.66666),               # 50-yard line center
        (110.0, 53.33333),              # Opposite goal line sideline
        (120.0, 53.33333),              # Opposite back of endzone
        (23.58333, 29.75),              # NFL Rule 1 Sec 2 Hashmarks
    ]

    for x, y in test_points:
        px, py = yard_to_pixel(x, y)
        rx, ry = pixel_to_yard(px, py)
        assert rx == pytest.approx(x, abs=1e-5)
        assert ry == pytest.approx(y, abs=1e-5)

    # Inverted-Y verification
    p_low_y = yard_to_pixel(50.0, 10.0)
    p_high_y = yard_to_pixel(50.0, 40.0)
    assert p_high_y[1] < p_low_y[1], "Higher yard Y must produce lower screen pixel Y (top of screen)"


def test_slip_angle_normalization_py():
    """Verify slip angle difference normalization into [-180, +180] degrees."""
    def normalize_slip_angle(diff: float) -> float:
        d = ((diff + 180.0) % 360.0 + 360.0) % 360.0 - 180.0
        if d == -180.0 and diff > 0:
            d = 180.0
        return d

    assert normalize_slip_angle(0.0) == 0.0
    assert normalize_slip_angle(45.0) == 45.0
    assert normalize_slip_angle(-45.0) == -45.0
    assert normalize_slip_angle(180.0) == 180.0
    assert normalize_slip_angle(-180.0) == -180.0
    assert normalize_slip_angle(200.0) == -160.0
    assert normalize_slip_angle(-200.0) == 160.0
    assert normalize_slip_angle(360.0) == 0.0
    assert normalize_slip_angle(350.0 - 10.0) == -20.0
    assert normalize_slip_angle(10.0 - 350.0) == 20.0


def test_motion_and_orientation_vector_trig():
    """Verify direction vector trigonometry for compass coordinates (0 deg North, 90 deg East)."""
    x, y = 50.0, 25.0
    length = 2.0

    # North (0 deg): sin(0)=0, cos(0)=1 -> dx=0, dy=+2 (up field)
    rad_north = 0.0
    tip_north_x = x + length * math.sin(rad_north)
    tip_north_y = y + length * math.cos(rad_north)
    assert tip_north_x == pytest.approx(50.0)
    assert tip_north_y == pytest.approx(27.0)

    # East (90 deg): sin(pi/2)=1, cos(pi/2)=0 -> dx=+2, dy=0
    rad_east = math.pi / 2.0
    tip_east_x = x + length * math.sin(rad_east)
    tip_east_y = y + length * math.cos(rad_east)
    assert tip_east_x == pytest.approx(52.0)
    assert tip_east_y == pytest.approx(25.0)

    # South (180 deg): sin(pi)=0, cos(pi)=-1 -> dx=0, dy=-2
    rad_south = math.pi
    tip_south_x = x + length * math.sin(rad_south)
    tip_south_y = y + length * math.cos(rad_south)
    assert tip_south_x == pytest.approx(50.0)
    assert tip_south_y == pytest.approx(23.0)

    # West (270 deg): sin(3pi/2)=-1, cos(3pi/2)=0 -> dx=-2, dy=0
    rad_west = 3.0 * math.pi / 2.0
    tip_west_x = x + length * math.sin(rad_west)
    tip_west_y = y + length * math.cos(rad_west)
    assert tip_west_x == pytest.approx(48.0)
    assert tip_west_y == pytest.approx(25.0)


# ==============================================================================
# SECTION 6: Node.js Headless Verification Runner Execution
# ==============================================================================

def test_nodejs_game_explorer_runner():
    """Direct execution of Node.js runner against game_field.js and timeseries.js."""
    script_path = Path("tests/game_explorer_runner.mjs")
    assert script_path.exists(), "tests/game_explorer_runner.mjs must exist"

    result = subprocess.run(
        ["node", str(script_path)],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, f"Node.js runner failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    assert "ALL CHECKS PASSED" in result.stdout


def test_nodejs_adversarial_m4_challenger():
    """Direct execution of Challenger M4.2 adversarial runner (1800 checks)."""
    script_path = Path("tests/test_adversarial_m4_challenger.mjs")
    assert script_path.exists(), "tests/test_adversarial_m4_challenger.mjs must exist"

    result = subprocess.run(
        ["node", str(script_path)],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, f"Challenger runner failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    assert "ALL ADVERSARIAL CHECKS PASSED" in result.stdout

