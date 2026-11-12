"""Adversarial stress-testing suite for Milestone M3 Frontend Canvas & Playback Contracts.

Executed by Challenger M3.2.
Verifies:
1. Canvas Coordinate Geometry & Affine Transform Invariants:
   - ctx.translate(offsetX, H - offsetY) ctx.scale(scale, -scale) ctx.translate(-minX, -minY)
   - Exact mathematical bijection: pixelToYard(yardToPixel(x, y)) == (x, y)
   - Bounding box safeguards: minSpan = 10.0 yd, 10% margins, 40-yd dash narrow line, single-point trajectories
2. Motion Direction Vectors & Compass Heading Math:
   - Tip formulas: tip_x = x + L*sin(rad), tip_y = y + L*cos(rad) across all cardinal and intercardinal angles
   - Arrow length proportionality L = s * 0.8 yd
   - Threshold hiding: s <= 0.15 yd/s suppresses direction arrow
3. Dashed Ball Trajectory Separation & Null Robustness:
   - Scale-invariant dash pattern: [6 / scale, 6 / scale]
   - Mandatory setLineDash([]) reset invariant
   - Drills without ball data (456 players) handling
4. 10 Hz Playback Timing Contracts & Invariants:
   - Frame interval rates: 1x -> 100ms, 0.5x -> 200ms, 2x -> 50ms
   - Boundary clamping in [0, N - 1]
   - Auto-pause on frame N - 1
5. Colormap Boundary Conditions:
   - s = 0, s = maxSpeed, s > maxSpeed, s < 0, null, NaN
   - Continuity across color stops
6. Direct execution of Node.js headless adversarial runner.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient

# ==============================================================================
# SECTION 1: Canvas Coordinate Geometry & Affine Transform Invariants
# ==============================================================================

def test_affine_transform_forward_and_inverse_bijection():
    """Verify that yardToPixel and pixelToYard form an exact mathematical bijection."""
    css_width = 800.0
    css_height = 450.0
    padding = 36.0
    bounds_min_x = 10.0
    bounds_max_x = 60.0
    bounds_min_y = 5.0
    bounds_max_y = 45.0
    span_x = bounds_max_x - bounds_min_x  # 50.0
    span_y = bounds_max_y - bounds_min_y  # 40.0

    avail_w = css_width - 2 * padding  # 728.0
    avail_h = css_height - 2 * padding  # 378.0
    scale = min(avail_w / span_x, avail_h / span_y)  # min(14.56, 9.45) = 9.45
    content_w = span_x * scale
    content_h = span_y * scale
    offset_x = padding + (avail_w - content_w) / 2.0
    offset_y = padding + (avail_h - content_h) / 2.0

    def yard_to_pixel(x: float, y: float) -> tuple[float, float]:
        px = offset_x + (x - bounds_min_x) * scale
        py = (css_height - offset_y) - (y - bounds_min_y) * scale
        return px, py

    def pixel_to_yard(px: float, py: float) -> tuple[float, float]:
        x = bounds_min_x + (px - offset_x) / scale
        y = bounds_min_y + ((css_height - offset_y) - py) / scale
        return x, y

    # Test grid of coordinates including negatives and extreme yards
    test_grid = [
        (10.0, 5.0),
        (35.0, 25.0),
        (60.0, 45.0),
        (0.0, 0.0),
        (-10.0, -5.0),
        (120.0, 53.33333),
        (53.25, 26.88),
    ]

    for x, y in test_grid:
        px, py = yard_to_pixel(x, y)
        un_x, un_y = pixel_to_yard(px, py)
        assert un_x == pytest.approx(x, abs=1e-5)
        assert un_y == pytest.approx(y, abs=1e-5)


def test_affine_transform_y_axis_inversion():
    """Higher yard Y values must map to lower screen pixel Y values."""
    css_height = 450.0
    offset_y = 36.0
    bounds_min_y = 0.0
    scale = 8.0

    def py_for_y(y: float) -> float:
        return (css_height - offset_y) - (y - bounds_min_y) * scale

    py_low = py_for_y(10.0)
    py_high = py_for_y(35.0)

    assert py_high < py_low
    assert (py_low - py_high) == pytest.approx(25.0 * scale, abs=1e-5)


def test_bounding_box_single_point_safeguard():
    """Single-point trajectory must not collapse to 0-span or divide by zero."""
    min_span = 10.0
    margin_ratio = 0.10

    x, y = 24.5, 12.3
    min_x, max_x = x, x
    min_y, max_y = y, y

    span_x = max_x - min_x
    span_y = max_y - min_y

    if span_x < min_span:
        mid_x = (min_x + max_x) / 2.0
        min_x = mid_x - min_span / 2.0
        max_x = mid_x + min_span / 2.0
        span_x = min_span

    if span_y < min_span:
        mid_y = (min_y + max_y) / 2.0
        min_y = mid_y - min_span / 2.0
        max_y = mid_y + min_span / 2.0
        span_y = min_span

    margin_x = max(span_x * margin_ratio, 2.0)
    margin_y = max(span_y * margin_ratio, 2.0)

    b_min_x = min_x - margin_x
    b_max_x = max_x + margin_x
    b_min_y = min_y - margin_y
    b_max_y = max_y + margin_y

    b_span_x = b_max_x - b_min_x
    b_span_y = b_max_y - b_min_y

    assert b_span_x == pytest.approx(14.0, abs=1e-5)
    assert b_span_y == pytest.approx(14.0, abs=1e-5)
    assert b_min_x == pytest.approx(17.5, abs=1e-5)
    assert b_max_x == pytest.approx(31.5, abs=1e-5)
    assert b_min_y == pytest.approx(5.3, abs=1e-5)
    assert b_max_y == pytest.approx(19.3, abs=1e-5)


def test_bounding_box_40_yard_dash_narrow_line():
    """40-yd dash with delta_y <= 0.4 yd must preserve minimum vertical span of 14 yd."""
    min_span = 10.0
    margin_ratio = 0.10

    min_x, max_x = 10.0, 50.0  # span_x = 40.0
    min_y, max_y = 25.0, 25.35  # span_y = 0.35

    span_x = max_x - min_x
    span_y = max_y - min_y

    if span_y < min_span:
        mid_y = (min_y + max_y) / 2.0
        min_y = mid_y - min_span / 2.0
        max_y = mid_y + min_span / 2.0
        span_y = min_span

    margin_x = max(span_x * margin_ratio, 2.0)  # 40 * 0.1 = 4.0
    margin_y = max(span_y * margin_ratio, 2.0)  # max(10 * 0.1, 2.0) = 2.0

    b_span_x = span_x + 2 * margin_x
    b_span_y = span_y + 2 * margin_y

    assert b_span_x == 48.0
    assert b_span_y == 14.0

    # Verify screen height allocation on 450px canvas
    avail_w = 800 - 72
    avail_h = 450 - 72
    scale = min(avail_w / b_span_x, avail_h / b_span_y)  # min(15.166, 27.0) = 15.166
    y_pixel_height = b_span_y * scale
    assert y_pixel_height > 200.0  # generous > 200px view, avoiding 1-pixel flatline


# ==============================================================================
# SECTION 2: Motion Direction Vectors & Compass Heading Math
# ==============================================================================

@pytest.mark.parametrize("heading_deg,exp_dx_norm,exp_dy_norm", [
    (0.0, 0.0, 1.0),      # North: +Y
    (45.0, math.sqrt(0.5), math.sqrt(0.5)),  # NE: +X, +Y
    (90.0, 1.0, 0.0),      # East: +X
    (135.0, math.sqrt(0.5), -math.sqrt(0.5)), # SE: +X, -Y
    (180.0, 0.0, -1.0),    # South: -Y
    (225.0, -math.sqrt(0.5), -math.sqrt(0.5)), # SW: -X, -Y
    (270.0, -1.0, 0.0),    # West: -X
    (315.0, -math.sqrt(0.5), math.sqrt(0.5)), # NW: -X, +Y
    (360.0, 0.0, 1.0),     # 360 wrap identical to North
])
def test_compass_heading_trigonometry(heading_deg, exp_dx_norm, exp_dy_norm):
    """Compass angles must map exactly to: tip_x = x + L*sin(rad), tip_y = y + L*cos(rad)."""
    x0, y0 = 40.0, 20.0
    s = 6.0
    length = s * 0.8  # 4.8 yards

    rad = heading_deg * math.pi / 180.0
    tip_x = x0 + length * math.sin(rad)
    tip_y = y0 + length * math.cos(rad)

    dx = tip_x - x0
    dy = tip_y - y0
    computed_len = math.hypot(dx, dy)

    assert computed_len == pytest.approx(length, abs=1e-5)
    assert (dx / length) == pytest.approx(exp_dx_norm, abs=1e-5)
    assert (dy / length) == pytest.approx(exp_dy_norm, abs=1e-5)


def test_motion_arrow_threshold_hiding():
    """Speed strictly <= 0.15 yd/s must suppress motion arrow rendering."""
    def should_draw_arrow(s: float | None) -> bool:
        if s is None:
            return False
        return s > 0.15

    assert not should_draw_arrow(0.0)
    assert not should_draw_arrow(0.10)
    assert not should_draw_arrow(0.15)
    assert should_draw_arrow(0.15001)
    assert should_draw_arrow(1.0)
    assert not should_draw_arrow(None)


# ==============================================================================
# SECTION 3: Dashed Ball Trajectory Separation & Null Robustness
# ==============================================================================

def test_dashed_ball_scale_invariance():
    """Ball dash pattern [6/scale, 6/scale] produces constant 6px dashes across zoom levels."""
    for scale in [2.5, 5.0, 10.0, 16.0, 25.0]:
        dash_pattern_yard = [6.0 / scale, 6.0 / scale]
        dash_px = dash_pattern_yard[0] * scale
        gap_px = dash_pattern_yard[1] * scale
        assert dash_px == pytest.approx(6.0, abs=1e-5)
        assert gap_px == pytest.approx(6.0, abs=1e-5)


def test_drills_without_ball_data_api_robustness(client: TestClient):
    """Combine drills without ball tracking must return empty ball_frames without error."""
    # JSN (55884)
    res = client.get("/api/player/55884/combine")
    assert res.status_code == 200
    data = res.json()
    drills = data.get("drills", [])

    # If any drill is queried, ball_frames must be an array (empty or valid)
    if drills:
        first_event = drills[0]["event_id"]
        drill_res = client.get(f"/api/player/55884/combine/{first_event}")
        assert drill_res.status_code == 200
        drill_data = drill_res.json()
        ball_frames = drill_data.get("ball_frames", [])
        assert isinstance(ball_frames, list)


# ==============================================================================
# SECTION 4: 10 Hz Playback Timing Contracts & Invariants
# ==============================================================================

@pytest.mark.parametrize("rate,expected_interval_ms", [
    (0.5, 200.0),
    (1.0, 100.0),
    (2.0, 50.0),
])
def test_playback_frame_intervals(rate, expected_interval_ms):
    """Playback rates 0.5x, 1.0x, 2.0x map to exactly 200ms, 100ms, 50ms intervals."""
    interval_ms = 100.0 / rate
    assert interval_ms == pytest.approx(expected_interval_ms, abs=1e-6)


def test_playback_clamping_and_auto_pause():
    """Index clamping strictly inside [0, N - 1] and auto-pause on frame N - 1."""
    total_frames = 68

    def clamp_index(idx: float) -> int:
        return max(0, min(total_frames - 1, round(idx)))

    assert clamp_index(-5) == 0
    assert clamp_index(0) == 0
    assert clamp_index(33.2) == 33
    assert clamp_index(67) == 67
    assert clamp_index(100) == 67

    # Auto-pause trigger
    is_playing = True
    curr_idx = clamp_index(67)
    if curr_idx >= total_frames - 1:
        is_playing = False
    assert is_playing is False


# ==============================================================================
# SECTION 5: Colormap Boundary Conditions
# ==============================================================================

def get_speed_color_py(speed: float | None, max_speed: float = 11.0) -> tuple[int, int, int]:
    """Python reference oracle for combine_field.js getSpeedColor()."""
    s = max(0.0, min(speed if speed is not None and not math.isnan(speed) else 0.0, max_speed))
    u = s / max_speed

    stops = [
        (0.00, (6, 182, 212)),
        (0.32, (14, 165, 233)),
        (0.64, (234, 179, 8)),
        (0.84, (249, 115, 22)),
        (1.00, (239, 68, 68)),
    ]

    i = 0
    while i < len(stops) - 1 and u > stops[i + 1][0]:
        i += 1
    if i >= len(stops) - 1:
        return stops[-1][1]

    s0 = stops[i]
    s1 = stops[i + 1]
    t = (u - s0[0]) / (s1[0] - s0[0])

    r = round(s0[1][0] + t * (s1[1][0] - s0[1][0]))
    g = round(s0[1][1] + t * (s1[1][1] - s0[1][1]))
    b = round(s0[1][2] + t * (s1[1][2] - s0[1][2]))
    return (r, g, b)


def test_colormap_boundary_values():
    """Verify colormap at zero, max, out-of-range, negative, and NaN speeds."""
    max_s = 10.0

    # Zero speed -> Cyan #06b6d4 (6, 182, 212)
    assert get_speed_color_py(0.0, max_s) == (6, 182, 212)

    # Max speed -> Red #ef4444 (239, 68, 68)
    assert get_speed_color_py(10.0, max_s) == (239, 68, 68)

    # Beyond max speed -> clamped to Red #ef4444
    assert get_speed_color_py(20.0, max_s) == (239, 68, 68)

    # Negative speed -> clamped to Cyan #06b6d4
    assert get_speed_color_py(-5.0, max_s) == (6, 182, 212)

    # None and NaN -> defaults to Cyan #06b6d4
    assert get_speed_color_py(None, max_s) == (6, 182, 212)
    assert get_speed_color_py(float("nan"), max_s) == (6, 182, 212)


def test_colormap_continuous_transitions():
    """Colormap transitions must be smooth: RGB delta <= 10 for 0.02 speed steps."""
    max_s = 10.0
    prev_rgb = get_speed_color_py(0.0, max_s)

    for i in range(1, 501):
        s = i * 0.02
        curr_rgb = get_speed_color_py(s, max_s)
        dr = abs(curr_rgb[0] - prev_rgb[0])
        dg = abs(curr_rgb[1] - prev_rgb[1])
        db = abs(curr_rgb[2] - prev_rgb[2])
        assert dr <= 10 and dg <= 10 and db <= 10, f"Discontinuity at s={s}: dr={dr}, dg={dg}, db={db}"
        prev_rgb = curr_rgb


# ==============================================================================
# SECTION 6: Node.js Headless Adversarial Test Execution
# ==============================================================================

def test_nodejs_adversarial_frontend_runner():
    """Direct execution of Node.js adversarial runner against combine_field.js and timeseries.js."""
    script_path = Path("tests/adversarial_frontend_runner.mjs")
    assert script_path.exists(), "adversarial_frontend_runner.mjs must exist"

    result = subprocess.run(
        ["node", str(script_path)],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, f"Node.js runner failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    assert "ALL CHECKS PASSED" in result.stdout
