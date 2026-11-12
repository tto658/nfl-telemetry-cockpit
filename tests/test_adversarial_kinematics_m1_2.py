"""Adversarial stress-testing suite for kinematics engine, FrameDTO, and API endpoints (M1_2 Gate).

Covers:
1. Mathematical properties of `src/web/kinematics.py`:
   - Circular wrap continuity across 0/360 degrees
   - Singularity threshold strictly at speed < 0.2 yd/s
   - Slip angle bounds strictly in [-180, 180]
   - Velocity decomposition Pythagorean invariance (vx^2 + vy^2 = s^2)
2. FrameDTO serialization and schema validation:
   - Missing orientation handling (combine drills)
   - Alias synchronization and zero-falsy edge cases
   - Float NaN serialization vulnerability detection
3. API endpoints stress and boundary testing:
   - `/api/player/{nfl_id}/combine/{event_id}`
   - `/api/player/{nfl_id}/snap/{game_id}/{play_id}`
"""

from __future__ import annotations

import math
import random

import polars as pl
import pytest
from starlette.responses import JSONResponse
from starlette.testclient import TestClient

from src.web.app import app
from src.web.kinematics import (
    compute_angular_velocity,
    compute_curvature,
    compute_slip_angle,
    compute_tracking_kinematics,
    decompose_velocity,
    unwrap_angle_diff,
)
from src.web.schemas import FrameDTO

# ==============================================================================
# SECTION 1: Mathematical Properties of src/web/kinematics.py
# ==============================================================================


def test_circular_wrap_continuity_step_sweep():
    """Sweeping across the 0/360 degree boundary in small increments must yield continuous deltas."""
    # Step from 350.0 to 370.0 in 0.1-deg increments (wrapped mod 360)
    prev_angle = 350.0
    for i in range(1, 201):
        raw_angle = 350.0 + i * 0.1
        curr_angle = raw_angle % 360.0
        delta = unwrap_angle_diff(curr_angle, prev_angle)
        assert delta == pytest.approx(0.1, abs=1e-5), f"Discontinuity at {raw_angle}: delta={delta}"
        prev_angle = curr_angle


def test_circular_wrap_random_fuzzing():
    """Any pair of angles must unwrap to delta in [-180.0, 180.0]."""
    rng = random.Random(42)
    for _ in range(2000):
        t1 = rng.uniform(-720.0, 720.0)
        t2 = rng.uniform(-720.0, 720.0)
        delta = unwrap_angle_diff(t1, t2)
        assert -180.0 <= delta <= 180.0, f"Delta {delta} out of bounds for ({t1}, {t2})"


def test_circular_wrap_exact_boundary_reversals():
    """Exact 180 reversals and boundary wraps."""
    # 0 -> 360 is 0 deg difference
    assert unwrap_angle_diff(360.0, 0.0) == pytest.approx(0.0, abs=1e-6)
    assert unwrap_angle_diff(0.0, 360.0) == pytest.approx(0.0, abs=1e-6)

    # 359 -> 1 is +2 deg
    assert unwrap_angle_diff(1.0, 359.0) == pytest.approx(2.0, abs=1e-6)
    # 1 -> 359 is -2 deg
    assert unwrap_angle_diff(359.0, 1.0) == pytest.approx(-2.0, abs=1e-6)

    # Direct 180 reversals
    assert abs(unwrap_angle_diff(180.0, 0.0)) == pytest.approx(180.0, abs=1e-6)
    assert abs(unwrap_angle_diff(0.0, 180.0)) == pytest.approx(180.0, abs=1e-6)

    # Angular velocity with reversal
    omega = compute_angular_velocity(180.0, 0.0, dt=0.1)
    assert omega == pytest.approx(1800.0, abs=1e-6)


def test_singularity_threshold_strictly_below_0_2():
    """Singularity cutoff must strictly return 0.0 for speed < 0.2 yd/s, and compute for >= 0.2."""
    omega_deg_s = 60.0  # arbitrary non-zero angular velocity

    # Speeds strictly below 0.2
    assert compute_curvature(speed=0.0, omega_deg_s=omega_deg_s) == 0.0
    assert compute_curvature(speed=0.05, omega_deg_s=omega_deg_s) == 0.0
    assert compute_curvature(speed=0.199999999, omega_deg_s=omega_deg_s) == 0.0

    # Speeds at or above 0.2
    kappa_at_0_2 = compute_curvature(speed=0.2, omega_deg_s=omega_deg_s)
    expected_at_0_2 = (omega_deg_s * math.pi / 180.0) / 0.2
    assert kappa_at_0_2 == pytest.approx(expected_at_0_2, rel=1e-5)

    kappa_at_0_20001 = compute_curvature(speed=0.20001, omega_deg_s=omega_deg_s)
    assert kappa_at_0_20001 > 0.0
    assert kappa_at_0_20001 < kappa_at_0_2


def test_singularity_threshold_polars_vectorized():
    """Polars vectorized compute_tracking_kinematics must strictly enforce 0.2 singularity cutoff."""
    speeds = [0.0, 0.05, 0.15, 0.1999, 0.2000, 0.2001, 1.0, 5.0]
    dirs = [10.0 * i for i in range(len(speeds))]  # omega = 100 deg/s for steps >= 1

    df = pl.DataFrame({
        "s": speeds,
        "dir": dirs,
        "o": [0.0] * len(speeds),
    })

    res = compute_tracking_kinematics(df, is_combine=False)
    kappas = res["kappa"].to_list()

    for idx, (s, k) in enumerate(zip(speeds, kappas)):
        if s < 0.2:
            assert k == pytest.approx(0.0, abs=1e-9), f"Row {idx} speed {s} had non-zero kappa {k}"
        elif idx > 0:  # idx 0 has omega=0 because of shift(1)
            assert k > 0.0, f"Row {idx} speed {s} had zero kappa despite omega > 0"


def test_slip_angle_bounds_strictly_in_minus_180_to_180():
    """Slip angle must be strictly bounded in [-180.0, 180.0] for arbitrary real inputs."""
    rng = random.Random(12345)
    for _ in range(5000):
        d = rng.uniform(-1000.0, 1000.0)
        o = rng.uniform(-1000.0, 1000.0)
        beta = compute_slip_angle(d, o)
        assert -180.0 <= beta <= 180.0, f"Slip angle {beta} out of bounds for dir={d}, o={o}"

    # Specific alignment cases
    # Facing east (90), moving east (90) -> slip = 0
    assert compute_slip_angle(90.0, 90.0) == pytest.approx(0.0, abs=1e-6)
    # Facing north (0), moving east (90) -> slip = 90
    assert compute_slip_angle(90.0, 0.0) == pytest.approx(90.0, abs=1e-6)
    # Facing east (90), moving north (0) -> slip = -90
    assert compute_slip_angle(0.0, 90.0) == pytest.approx(-90.0, abs=1e-6)
    # Moving opposite direction (180 reversal)
    assert abs(compute_slip_angle(180.0, 0.0)) == pytest.approx(180.0, abs=1e-6)


def test_velocity_decomposition_pythagorean_invariance():
    """Velocity decomposition must satisfy vx^2 + vy^2 = s^2 for all headings and speeds."""
    rng = random.Random(999)
    for _ in range(5000):
        s = rng.uniform(0.0, 25.0)
        heading = rng.uniform(-720.0, 720.0)
        vx, vy = decompose_velocity(s, heading)
        reconstructed_s = math.hypot(vx, vy)
        assert reconstructed_s == pytest.approx(s, abs=1e-11)

    # NGS Compass Coordinate Convention Check:
    # 0 deg = North (+Y): vx = 0, vy = +s
    vx, vy = decompose_velocity(10.0, 0.0)
    assert vx == pytest.approx(0.0, abs=1e-6)
    assert vy == pytest.approx(10.0, abs=1e-6)

    # 90 deg = East (+X): vx = +s, vy = 0
    vx, vy = decompose_velocity(10.0, 90.0)
    assert vx == pytest.approx(10.0, abs=1e-6)
    assert vy == pytest.approx(0.0, abs=1e-6)

    # 180 deg = South (-Y): vx = 0, vy = -s
    vx, vy = decompose_velocity(10.0, 180.0)
    assert vx == pytest.approx(0.0, abs=1e-6)
    assert vy == pytest.approx(-10.0, abs=1e-6)

    # 270 deg = West (-X): vx = -s, vy = 0
    vx, vy = decompose_velocity(10.0, 270.0)
    assert vx == pytest.approx(-10.0, abs=1e-6)
    assert vy == pytest.approx(0.0, abs=1e-6)


def test_adversarial_fuzzing_compute_slip_angle():
    """Adversarial Fuzzing: compute_slip_angle across 10,000 random inputs and exact edge boundaries."""
    rng = random.Random(777)
    for _ in range(10000):
        d = rng.uniform(-1e6, 1e6)
        o = rng.uniform(-1e6, 1e6)
        beta = compute_slip_angle(d, o)
        assert -180.0 <= beta <= 180.0, f"Slip angle {beta} out of bounds for dir={d}, o={o}"

    # Exact boundary quadrants
    assert compute_slip_angle(0.0, 0.0) == pytest.approx(0.0, abs=1e-6)
    assert compute_slip_angle(90.0, 0.0) == pytest.approx(90.0, abs=1e-6)
    assert compute_slip_angle(0.0, 90.0) == pytest.approx(-90.0, abs=1e-6)
    assert compute_slip_angle(270.0, 0.0) == pytest.approx(-90.0, abs=1e-6)
    assert compute_slip_angle(0.0, 270.0) == pytest.approx(90.0, abs=1e-6)
    assert compute_slip_angle(360.0, 0.0) == pytest.approx(0.0, abs=1e-6)
    assert compute_slip_angle(0.0, 360.0) == pytest.approx(0.0, abs=1e-6)
    assert abs(compute_slip_angle(180.0, 0.0)) == pytest.approx(180.0, abs=1e-6)
    assert abs(compute_slip_angle(0.0, 180.0)) == pytest.approx(180.0, abs=1e-6)

    # Sub-degree boundary sweeps around 180 degrees
    assert compute_slip_angle(179.9999, 0.0) == pytest.approx(179.9999, abs=1e-4)
    assert compute_slip_angle(180.0001, 0.0) == pytest.approx(-179.9999, abs=1e-4)

    # Rotational invariance under full 360-degree cycles
    for k in (-10, -2, -1, 1, 2, 10):
        for m in (-10, -2, -1, 1, 2, 10):
            assert compute_slip_angle(45.0 + 360.0 * k, 15.0 + 360.0 * m) == pytest.approx(30.0, abs=1e-6)


def test_adversarial_fuzzing_compute_curvature():
    """Adversarial Fuzzing: compute_curvature across extreme speeds, omegas, and boundary cutoffs."""
    rng = random.Random(888)
    for _ in range(10000):
        s = rng.uniform(0.0, 50.0)
        omega = rng.uniform(0.0, 720.0)
        k = compute_curvature(speed=s, omega_deg_s=omega)
        if s < 0.2:
            assert k == 0.0
        else:
            expected = (omega * math.pi / 180.0) / s
            assert k == pytest.approx(expected, rel=1e-5)

    # Exact threshold boundary sweeps
    assert compute_curvature(speed=0.1999999999, omega_deg_s=100.0) == 0.0
    assert compute_curvature(speed=0.2000000000, omega_deg_s=100.0) > 0.0
    assert compute_curvature(speed=0.2000000001, omega_deg_s=100.0) > 0.0

    # Negative and zero speeds must strictly return 0.0 without division by zero
    assert compute_curvature(speed=-10.0, omega_deg_s=50.0) == 0.0
    assert compute_curvature(speed=-0.0001, omega_deg_s=50.0) == 0.0
    assert compute_curvature(speed=0.0, omega_deg_s=0.0) == 0.0
    assert compute_curvature(speed=1e-12, omega_deg_s=50.0) == 0.0

    # None handling
    assert compute_curvature(speed=None, omega_deg_s=50.0) == 0.0
    assert compute_curvature(speed=5.0, omega_deg_s=None) == 0.0

    # Custom threshold keyword arguments
    assert compute_curvature(s=0.49, omega_deg=50.0, threshold=0.5) == 0.0
    assert compute_curvature(s=0.51, omega_deg=50.0, threshold=0.5) > 0.0


def test_adversarial_fuzzing_unwrap_angle_diff():
    """Adversarial Fuzzing: unwrap_angle_diff across 10,000 extreme angle pairs."""
    rng = random.Random(999)
    for _ in range(10000):
        t1 = rng.uniform(-1e7, 1e7)
        t2 = rng.uniform(-1e7, 1e7)
        d = unwrap_angle_diff(t1, t2)
        assert -180.0 <= d <= 180.0, f"Unwrapped diff {d} out of range for ({t1}, {t2})"

    # Identity property
    for angle in (-720.0, -360.0, -180.0, 0.0, 180.0, 360.0, 720.0):
        assert unwrap_angle_diff(angle, angle) == pytest.approx(0.0, abs=1e-6)

    # Modulo-360 periodicity
    for k in (-5, -1, 1, 5):
        for m in (-5, -1, 1, 5):
            assert unwrap_angle_diff(30.0 + 360.0 * k, 10.0 + 360.0 * m) == pytest.approx(20.0, abs=1e-6)


# ==============================================================================
# SECTION 2: FrameDTO Serialization & Schema Validation
# ==============================================================================


def test_framedto_combine_missing_orientation():
    """In combine drills, orientation and slip angle are None, which FrameDTO must accept."""
    player_frame = FrameDTO(
        frameId=0,
        time=0.0,
        x=20.5,
        y=15.2,
        s=4.5,
        a=1.2,
        dir=45.0,
        o=None,
        omega=12.0,
        curvature=0.05,
        slip_angle=None,
    )
    assert player_frame.o is None
    assert player_frame.slip_angle is None
    assert player_frame.beta_slip is None

    # Ball frame has None for omega and curvature as well
    ball_frame = FrameDTO(
        frameId=0,
        time=0.0,
        x=22.0,
        y=16.0,
        s=8.0,
        a=0.0,
        dir=45.0,
        o=None,
        omega=None,
        curvature=None,
        slip_angle=None,
    )
    assert ball_frame.omega is None
    assert ball_frame.curvature is None
    assert ball_frame.kappa is None


def test_framedto_alias_synchronization():
    """Alias pairs (slip_angle/beta_slip and curvature/kappa) must synchronize correctly."""
    # slip_angle provided -> sets beta_slip
    f1 = FrameDTO(frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, slip_angle=25.0)
    assert f1.slip_angle == 25.0
    assert f1.beta_slip == 25.0

    # beta_slip provided -> sets slip_angle
    f2 = FrameDTO(frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, beta_slip=-15.0)
    assert f2.slip_angle == -15.0
    assert f2.beta_slip == -15.0

    # curvature provided -> sets kappa
    f3 = FrameDTO(frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, curvature=0.08)
    assert f3.curvature == 0.08
    assert f3.kappa == 0.08

    # kappa provided -> sets curvature
    f4 = FrameDTO(frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, kappa=0.12)
    assert f4.curvature == 0.12
    assert f4.kappa == 0.12


def test_framedto_adversarial_zero_falsy_vulnerability():
    """Adversarial Challenge: When beta_slip=0.0 or kappa=0.0 is passed with slip_angle=None or curvature=None,

    checks whether the validator erases valid 0.0 due to 'not data.get(...)'.
    A robust model must strictly preserve 0.0 without erasing.
    """
    # 1. Passing beta_slip=0.0 explicitly with slip_angle=None
    f_beta_zero = FrameDTO(
        frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, slip_angle=None, beta_slip=0.0
    )
    assert f_beta_zero.beta_slip == 0.0, "beta_slip=0.0 was erased to None!"
    assert f_beta_zero.slip_angle == 0.0, "slip_angle alias was not synchronized to 0.0!"

    # 2. Passing slip_angle=0.0 explicitly with beta_slip=None
    f_slip_zero = FrameDTO(
        frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, slip_angle=0.0, beta_slip=None
    )
    assert f_slip_zero.slip_angle == 0.0, "slip_angle=0.0 was erased to None!"
    assert f_slip_zero.beta_slip == 0.0, "beta_slip alias was not synchronized to 0.0!"

    # 3. Passing kappa=0.0 explicitly with curvature=None
    f_kappa_zero = FrameDTO(
        frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, curvature=None, kappa=0.0
    )
    assert f_kappa_zero.kappa == 0.0, "kappa=0.0 was erased to None!"
    assert f_kappa_zero.curvature == 0.0, "curvature alias was not synchronized to 0.0!"

    # 4. Passing curvature=0.0 explicitly with kappa=None
    f_curv_zero = FrameDTO(
        frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, curvature=0.0, kappa=None
    )
    assert f_curv_zero.curvature == 0.0, "curvature=0.0 was erased to None!"
    assert f_curv_zero.kappa == 0.0, "kappa alias was not synchronized to 0.0!"

    # 5. Passing only one alias with the other omitted (default None)
    f_beta_only = FrameDTO(frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, beta_slip=0.0)
    assert f_beta_only.beta_slip == 0.0
    assert f_beta_only.slip_angle == 0.0

    f_kappa_only = FrameDTO(frameId=0, time=0.0, x=1.0, y=1.0, s=1.0, a=0.0, dir=0.0, kappa=0.0)
    assert f_kappa_only.kappa == 0.0
    assert f_kappa_only.curvature == 0.0


def test_framedto_float_nan_serialization_challenge():
    """Adversarial Challenge: FrameDTO instantiated with float NaN / Inf must be safely serialized via Starlette JSONResponse."""
    frame_with_nan = FrameDTO(
        frameId=0,
        time=float("nan"),
        x=float("inf"),
        y=float("-inf"),
        s=float("nan"),
        a=float("inf"),
        dir=float("-inf"),
        o=float("nan"),
        omega=float("inf"),
        curvature=float("-inf"),
        kappa=float("nan"),
        slip_angle=float("inf"),
        beta_slip=float("-inf"),
    )

    # 1. Assert field-level sanitization: optionals coerced to None, required floats coerced to 0.0
    assert frame_with_nan.o is None
    assert frame_with_nan.omega is None
    assert frame_with_nan.curvature is None
    assert frame_with_nan.kappa is None
    assert frame_with_nan.slip_angle is None
    assert frame_with_nan.beta_slip is None
    assert frame_with_nan.time == 0.0
    assert frame_with_nan.x == 0.0
    assert frame_with_nan.y == 0.0
    assert frame_with_nan.s == 0.0
    assert frame_with_nan.a == 0.0
    assert frame_with_nan.dir == 0.0

    # 2. Test serialization via Starlette JSONResponse without ValueError
    dumped = frame_with_nan.model_dump()
    resp = JSONResponse(dumped)
    assert resp.status_code == 200
    assert b"NaN" not in resp.body, "Non-compliant NaN emitted into JSON bytes!"
    assert b"Infinity" not in resp.body, "Non-compliant Infinity emitted into JSON bytes!"


# ==============================================================================
# SECTION 3: API Endpoints Stress & Boundary Testing
# ==============================================================================


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_api_combine_drill_nominal(client: TestClient):
    """GET /api/player/{nfl_id}/combine/{event_id}: Nominal path on real player."""
    resp = client.get("/api/player/55867/combine/64065f33e3d8e72dcd3114b4-2023")
    assert resp.status_code == 200
    data = resp.json()

    assert "player_frames" in data
    assert "ball_frames" in data
    assert len(data["player_frames"]) > 0

    # Validate first frame conforms to FrameDTO
    first_f = data["player_frames"][0]
    frame_dto = FrameDTO.model_validate(first_f)
    assert frame_dto.o is None
    assert frame_dto.slip_angle is None


def test_api_combine_drill_with_ball_frames(client: TestClient):
    """GET /api/player/{nfl_id}/combine/{event_id}: Nominal path on drill with BALL tracking."""
    resp = client.get("/api/player/58239/combine/20250301100700_1740863730000_000")
    assert resp.status_code == 200
    data = resp.json()

    assert len(data["ball_frames"]) > 0
    first_ball = data["ball_frames"][0]
    ball_dto = FrameDTO.model_validate(first_ball)
    assert ball_dto.o is None
    assert ball_dto.omega is None
    assert ball_dto.curvature is None


def test_api_combine_drill_adversarial_inputs(client: TestClient):
    """GET /api/player/{nfl_id}/combine/{event_id}: Extreme, non-existent, and malformed inputs."""
    # Non-existent event
    r1 = client.get("/api/player/55867/combine/non_existent_event_99999")
    assert r1.status_code == 404

    # Non-existent player
    r2 = client.get("/api/player/999999999/combine/64065f33e3d8e72dcd3114b4-2023")
    assert r2.status_code == 404

    # Invalid player ID (0 and negative)
    r3 = client.get("/api/player/0/combine/some_event")
    assert r3.status_code == 404

    # Path traversal attack pattern
    r4 = client.get("/api/player/55867/combine/..%2F..%2Fetc%2Fpasswd")
    assert r4.status_code in (404, 400)

    # SQL injection pattern
    r5 = client.get("/api/player/55867/combine/'%20OR%201=1%20--")
    assert r5.status_code == 404

    # Extremely long event string (1000 chars)
    r6 = client.get(f"/api/player/55867/combine/{'A' * 1000}")
    assert r6.status_code == 404


def test_api_snap_nominal(client: TestClient):
    """GET /api/player/{nfl_id}/snap/{game_id}/{play_id}: Nominal path with full kinematics."""
    resp = client.get("/api/player/55867/snap/2025121402/3051")
    assert resp.status_code == 200
    data = resp.json()

    assert data["game_id"] == 2025121402
    assert data["play_id"] == 3051
    assert "frames" in data
    assert len(data["frames"]) > 0

    # Validate mathematical properties on returned frames
    for f in data["frames"]:
        dto = FrameDTO.model_validate(f)

        # 1. Slip angle bounds
        if dto.slip_angle is not None:
            assert -180.0 <= dto.slip_angle <= 180.0

        # 2. Angular velocity non-negative
        if dto.omega is not None:
            assert dto.omega >= 0.0

        # 3. Curvature singularity cutoff strictly at s < 0.2
        if dto.s < 0.2:
            assert dto.curvature == 0.0 or dto.curvature is None
            assert dto.kappa == 0.0 or dto.kappa is None
        elif dto.curvature is not None:
            assert dto.curvature >= 0.0


def test_api_snap_adversarial_inputs(client: TestClient):
    """GET /api/player/{nfl_id}/snap/{game_id}/{play_id}: Boundary conditions and invalid IDs."""
    # Zero-snap rookie player (56648)
    r1 = client.get("/api/player/56648/snap/2025121402/3051")
    assert r1.status_code == 404

    # Non-existent game ID
    r2 = client.get("/api/player/55867/snap/9999999999/3051")
    assert r2.status_code == 404

    # Non-existent play ID
    r3 = client.get("/api/player/55867/snap/2025121402/999999999")
    assert r3.status_code == 404

    # Non-existent player
    r4 = client.get("/api/player/999999999/snap/2025121402/3051")
    assert r4.status_code == 404

    # Zero IDs
    r5 = client.get("/api/player/0/snap/2025121402/3051")
    assert r5.status_code == 404

    r6 = client.get("/api/player/55867/snap/0/3051")
    assert r6.status_code == 404

    r7 = client.get("/api/player/55867/snap/2025121402/0")
    assert r7.status_code == 404

    # Extremely large integers (overflow testing)
    r8 = client.get("/api/player/55867/snap/99999999999999999999999999999999/100")
    assert r8.status_code == 404


def test_api_stress_sequential_throughput(client: TestClient):
    """Execute 50 rapid requests across combine and snap endpoints to detect resource leaks."""
    endpoints = [
        "/api/player/55867/combine/64065f33e3d8e72dcd3114b4-2023",
        "/api/player/58239/combine/20250301100700_1740863730000_000",
        "/api/player/55867/snap/2025121402/3051",
        "/api/player/56648/snap/2025121402/3051",  # 404 path
        "/api/player/999999999/combine/non_existent",  # 404 path
    ]

    for i in range(50):
        url = endpoints[i % len(endpoints)]
        resp = client.get(url)
        assert resp.status_code in (200, 404)
