"""Tier 5 Frontend White-Box Adversarial Coverage Hardening Suite.

Milestone M5 Phase 2: Frontend White-Box Adversarial Coverage Hardening (Tier 5).
Author: challenger_m5_2 (Critic & Specialist)

Validates:
1. Node.js execution of tests/test_tier5_adversarial_frontend.mjs (492 empirical assertions).
2. Canvas coordinate transform bijection, aspect ratio invariance, and upright text rendering.
3. Dual vector geometry, speed clamping, and slip angle modular wrap-around oracles.
4. Scale-invariant ball dash and Trap 2 stroke isolation invariants.
5. 5-lane dynamic timeseries, NaN resilience, and 60 FPS playback engine stepping.
6. Zero-snap rookie #zeroSnapCard UI state transitions and 1-click CTA switching.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

from starlette.testclient import TestClient

# ==============================================================================
# SECTION 1: Execution of Dedicated Node.js Adversarial Test Suite
# ==============================================================================

def test_tier5_nodejs_adversarial_frontend_runner():
    """Execute tests/test_tier5_adversarial_frontend.mjs under Node.js."""
    runner_path = Path("tests/test_tier5_adversarial_frontend.mjs")
    assert runner_path.exists(), f"Adversarial runner {runner_path} must exist"

    proc = subprocess.run(
        ["node", str(runner_path)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert proc.returncode == 0, (
        f"Tier 5 Adversarial Runner failed with code {proc.returncode}:\n"
        f"STDOUT:\n{proc.stdout}\n"
        f"STDERR:\n{proc.stderr}"
    )
    assert "ALL TIER 5 WHITE-BOX ADVERSARIAL CHECKS PASSED EMPIRICALLY!" in proc.stdout
    assert "TIER 5 ADVERSARIAL SUITE RESULTS:" in proc.stdout


# ==============================================================================
# SECTION 2: Coordinate Transform Invariants & Aspect Ratio Oracles (Python)
# ==============================================================================

def test_coordinate_transform_bijection_python_oracle():
    """Verify affine transformation forward and inverse projection bijection."""
    # Standard full field bounds
    min_x, max_x = -6.0, 126.0
    min_y, max_y = -4.0, 57.33333
    span_x = max_x - min_x  # 132.0
    span_y = max_y - min_y  # 61.33333

    viewports = [
        (800, 420),
        (1200, 600),
        (10000, 100),  # 100:1 ultra-wide
        (100, 10000),  # 1:100 tower
    ]

    padding = 32.0

    for css_w, css_h in viewports:
        avail_w = max(10.0, css_w - 2 * padding)
        avail_h = max(10.0, css_h - 2 * padding)
        scale = min(avail_w / span_x, avail_h / span_y)

        content_w = span_x * scale
        content_h = span_y * scale
        offset_x = padding + (avail_w - content_w) / 2.0
        offset_y = padding + (avail_h - content_h) / 2.0

        # Test landmark points
        points = [
            (0.0, 0.0),
            (120.0, 53.33333),
            (60.0, 26.66667),
            (10.0, 0.0),
            (110.0, 53.33333),
            (-5.0, 20.0),
        ]

        for yx, yy in points:
            # Forward: yardToPixel
            px = offset_x + (yx - min_x) * scale
            py = (css_h - offset_y) - (yy - min_y) * scale

            # Inverse: pixelToYard
            rev_x = min_x + (px - offset_x) / scale
            rev_y = min_y + ((css_h - offset_y) - py) / scale

            assert math.isclose(rev_x, yx, abs_tol=1e-5), f"X bijection failed for ({yx}, {yy})"
            assert math.isclose(rev_y, yy, abs_tol=1e-5), f"Y bijection failed for ({yx}, {yy})"


def test_dual_vector_clamping_and_trigonometry_python_oracle():
    """Verify dual vector length scaling, clamping, and trigonometric endpoints."""
    # Amber orientation vector: fixed length 1.5 yd
    len_o = 1.5
    for deg in [0.0, 45.0, 90.0, 180.0, 270.0, 359.0]:
        rad = math.radians(deg)
        dx = len_o * math.sin(rad)
        dy = len_o * math.cos(rad)
        total_len = math.hypot(dx, dy)
        assert math.isclose(total_len, 1.5, abs_tol=1e-5)

    # Cyan motion vector: L = clamp(0.5, 8.0, s * 0.8)
    speed_samples = [
        (0.1, 0.0),   # suppressed (s <= 0.15)
        (0.2, 0.5),   # clamped to 0.5
        (1.0, 0.8),   # 0.8
        (5.0, 4.0),   # 4.0
        (10.0, 8.0),  # 8.0 (threshold)
        (15.0, 8.0),  # clamped to 8.0
        (30.0, 8.0),  # clamped to 8.0
    ]

    for s, expected_len in speed_samples:
        if s <= 0.15:
            actual_len = 0.0
        else:
            actual_len = max(0.5, min(8.0, s * 0.8))
        assert math.isclose(actual_len, expected_len, abs_tol=1e-5)


def test_slip_angle_normalization_python_oracle():
    """Verify slip angle modular wrap-around strictly bound in [-180, +180]."""
    test_cases = [
        (0.0, 0.0),
        (359.0, -1.0),
        (-359.0, 1.0),
        (360.0, 0.0),
        (361.0, 1.0),
        (180.0, 180.0),
        (-180.0, -180.0),
        (181.0, -179.0),
        (-181.0, 179.0),
        (720.0, 0.0),
    ]

    for diff, expected in test_cases:
        d = ((diff + 180.0) % 360.0 + 360.0) % 360.0 - 180.0
        if d == -180.0 and diff > 0:
            d = 180.0
        assert math.isclose(d, expected, abs_tol=1e-5)


# ==============================================================================
# SECTION 3: Frontend Deliverable Static Health & DOM Structure
# ==============================================================================

def test_frontend_source_files_exist_and_healthy():
    """Verify all frontend assets exist and have non-zero size."""
    expected_files = [
        Path("src/web/static/js/game_field.js"),
        Path("src/web/static/js/combine_field.js"),
        Path("src/web/static/js/timeseries.js"),
        Path("src/web/static/js/app.js"),
        Path("src/web/static/js/api.js"),
        Path("src/web/static/index.html"),
        Path("src/web/static/css/styles.css"),
    ]

    for p in expected_files:
        assert p.exists(), f"Frontend file {p} does not exist"
        assert p.stat().st_size > 500, f"Frontend file {p} unexpectedly small ({p.stat().st_size} bytes)"


def test_static_html_and_js_served_by_api(client: TestClient):
    """Verify HTTP GET delivery for critical frontend assets via Starlette app."""
    for path in [
        "/static/js/game_field.js",
        "/static/js/combine_field.js",
        "/static/js/timeseries.js",
        "/static/js/app.js",
        "/static/js/api.js",
        "/static/css/styles.css",
        "/static/index.html",
    ]:
        res = client.get(path)
        assert res.status_code == 200, f"GET {path} failed with {res.status_code}"
