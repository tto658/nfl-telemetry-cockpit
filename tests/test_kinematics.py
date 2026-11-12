"""Tests for kinematics calculation engine (F8, F10).

Covers:
- Unwrapped angular velocity (omega) calculation and 360-degree boundary wrap
- Curvature (kappa) calculation with singularity cutoff (s < 0.2 yd/s)
- Slip angle (beta_slip) computation and biomechanical orientation
- Velocity vector decomposition in NGS compass coordinates
- Polars vectorized expressions and edge cases
"""

import math
from pathlib import Path

import numpy as np
import polars as pl
import pytest

# ==============================================================================
# Canonical Mathematical Reference Functions (Authoritative Formulas)
# Derived from ORIGINAL_REQUEST.md §2, §4 & PROJECT.md F8
# ==============================================================================

def unwrap_angle_diff(theta_curr: float, theta_prev: float) -> float:
    """Computes minimal angular difference in degrees in [-180, 180]."""
    diff = ((theta_curr - theta_prev + 180.0) % 360.0) - 180.0
    return diff


def compute_angular_velocity(theta_curr: float, theta_prev: float, dt: float = 0.1) -> float:
    """Computes angular velocity in deg/s."""
    delta = unwrap_angle_diff(theta_curr, theta_prev)
    return abs(delta) / dt


def compute_curvature(speed: float, omega_deg_s: float, singularity_threshold: float = 0.2) -> float:
    """Computes curvature kappa in 1/yd. Returns 0.0 if speed < singularity_threshold."""
    if speed < singularity_threshold or abs(speed) < 1e-9:
        return 0.0
    omega_rad_s = omega_deg_s * (math.pi / 180.0)
    return omega_rad_s / speed


def compute_slip_angle(motion_dir: float, body_orientation: float) -> float:
    """Computes slip angle beta_slip = ((dir - o + 180) % 360) - 180 in [-180, 180]."""
    return ((motion_dir - body_orientation + 180.0) % 360.0) - 180.0


def decompose_velocity(speed: float, motion_dir: float) -> tuple[float, float]:
    """Decomposes NGS speed and compass direction (0=N, 90=E) into (vx, vy)."""
    rad = motion_dir * (math.pi / 180.0)
    vx = speed * math.sin(rad)
    vy = speed * math.cos(rad)
    return (vx, vy)


# ==============================================================================
# Tier 1: Feature Coverage Tests (F8 & F10)
# ==============================================================================

def test_f8_angular_velocity_straight_ahead():
    """Unwrapped delta of constant heading is 0, omega is 0 deg/s."""
    omega = compute_angular_velocity(90.0, 90.0, dt=0.1)
    assert omega == pytest.approx(0.0, abs=1e-6)


def test_f8_angular_velocity_clockwise_turn():
    """Turning 10 degrees clockwise in 0.1s yields 100 deg/s."""
    omega = compute_angular_velocity(55.0, 45.0, dt=0.1)
    assert omega == pytest.approx(100.0, abs=1e-6)


def test_f8_angular_velocity_boundary_wrap_positive():
    """Turning through 0 degrees (355 -> 5) unwraps to +10 deg, not -350 deg."""
    delta = unwrap_angle_diff(5.0, 355.0)
    assert delta == pytest.approx(10.0, abs=1e-6)
    omega = compute_angular_velocity(5.0, 355.0, dt=0.1)
    assert omega == pytest.approx(100.0, abs=1e-6)


def test_f8_angular_velocity_boundary_wrap_negative():
    """Turning counter-clockwise through 0 (5 -> 355) unwraps to -10 deg."""
    delta = unwrap_angle_diff(355.0, 5.0)
    assert delta == pytest.approx(-10.0, abs=1e-6)
    omega = compute_angular_velocity(355.0, 5.0, dt=0.1)
    assert omega == pytest.approx(100.0, abs=1e-6)


def test_f8_angular_velocity_180_reversal():
    """A direct reversal (0 -> 180) unwraps to +/-180 deg, omega is 1800 deg/s."""
    omega = compute_angular_velocity(180.0, 0.0, dt=0.1)
    assert omega == pytest.approx(1800.0, abs=1e-6)


def test_f8_curvature_formula_normal_speed():
    """At 5.0 yd/s with omega = 57.2958 deg/s (1.0 rad/s), kappa = 0.2 yd^-1."""
    omega_deg = 180.0 / math.pi  # exactly 1.0 rad/s
    kappa = compute_curvature(speed=5.0, omega_deg_s=omega_deg)
    assert kappa == pytest.approx(0.2, abs=1e-4)


def test_f8_curvature_singularity_cutoff():
    """When speed < 0.2 yd/s, curvature is clamped to 0.0 to prevent infinity."""
    omega_deg = 90.0
    kappa_stopped = compute_curvature(speed=0.0, omega_deg_s=omega_deg)
    assert kappa_stopped == 0.0

    kappa_slow = compute_curvature(speed=0.19, omega_deg_s=omega_deg)
    assert kappa_slow == 0.0


def test_f8_slip_angle_forward_sprint():
    """Sprint where dir == o yields slip angle = 0."""
    beta = compute_slip_angle(motion_dir=45.0, body_orientation=45.0)
    assert beta == pytest.approx(0.0, abs=1e-6)


def test_f8_slip_angle_pure_backpedal():
    """Backpedal where dir = 0 (North) and o = 180 (South) yields |beta| = 180."""
    beta = compute_slip_angle(motion_dir=0.0, body_orientation=180.0)
    assert abs(beta) == pytest.approx(180.0, abs=1e-6)


def test_f8_slip_angle_lateral_cuts():
    """Side-step where dir = 90 (East) and o = 0 (North) yields beta = +90."""
    beta_right = compute_slip_angle(motion_dir=90.0, body_orientation=0.0)
    assert beta_right == pytest.approx(90.0, abs=1e-6)

    beta_left = compute_slip_angle(motion_dir=270.0, body_orientation=0.0)
    assert beta_left == pytest.approx(-90.0, abs=1e-6)


def test_f8_velocity_vector_decomposition_cardinal():
    """Verify NGS compass decomposition: 0=North(+Y), 90=East(+X), 180=South(-Y), 270=West(-X)."""
    s = 10.0
    # North
    vx, vy = decompose_velocity(s, 0.0)
    assert vx == pytest.approx(0.0, abs=1e-6)
    assert vy == pytest.approx(10.0, abs=1e-6)

    # East
    vx, vy = decompose_velocity(s, 90.0)
    assert vx == pytest.approx(10.0, abs=1e-6)
    assert vy == pytest.approx(0.0, abs=1e-6)

    # South
    vx, vy = decompose_velocity(s, 180.0)
    assert vx == pytest.approx(0.0, abs=1e-6)
    assert vy == pytest.approx(-10.0, abs=1e-6)

    # West
    vx, vy = decompose_velocity(s, 270.0)
    assert vx == pytest.approx(-10.0, abs=1e-6)
    assert vy == pytest.approx(0.0, abs=1e-6)


def test_f8_velocity_vector_pythagorean_invariance():
    """Decomposed vx^2 + vy^2 must equal s^2 for any heading."""
    s = 7.5
    for heading in [15.0, 45.0, 123.4, 210.0, 315.8]:
        vx, vy = decompose_velocity(s, heading)
        assert (vx**2 + vy**2) == pytest.approx(s**2, rel=1e-5)


# ==============================================================================
# Tier 2: Boundary & Corner Cases (F8 & F10)
# ==============================================================================

def test_f8_boundary_curvature_at_exact_threshold():
    """Check behavior right at the 0.2 yd/s threshold."""
    omega_deg = 180.0 / math.pi  # 1.0 rad/s
    kappa_at_threshold = compute_curvature(speed=0.20, omega_deg_s=omega_deg)
    assert kappa_at_threshold == pytest.approx(5.0, abs=1e-4)

    kappa_just_below = compute_curvature(speed=0.1999999, omega_deg_s=omega_deg)
    assert kappa_just_below == 0.0


def test_f8_boundary_curvature_zero_speed_zero_omega():
    """Completely stationary athlete (s=0, omega=0) has zero curvature."""
    kappa = compute_curvature(speed=0.0, omega_deg_s=0.0)
    assert kappa == 0.0


def test_f8_boundary_slip_angle_wrap_359_to_1():
    """dir = 359.5, o = 0.5 -> slip angle is -1.0 deg."""
    beta = compute_slip_angle(motion_dir=359.5, body_orientation=0.5)
    assert beta == pytest.approx(-1.0, abs=1e-5)


def test_f8_boundary_slip_angle_wrap_1_to_359():
    """dir = 0.5, o = 359.5 -> slip angle is +1.0 deg."""
    beta = compute_slip_angle(motion_dir=0.5, body_orientation=359.5)
    assert beta == pytest.approx(1.0, abs=1e-5)


def test_f8_boundary_slip_angle_exact_180():
    """dir = 90.0, o = 270.0 -> slip angle is +/-180.0 deg."""
    beta = compute_slip_angle(motion_dir=90.0, body_orientation=270.0)
    assert abs(beta) == pytest.approx(180.0, abs=1e-5)


def test_f8_boundary_turning_radius_formula():
    """Turning radius R = 1 / |kappa| for a known circular arc."""
    kappa = 0.1  # 1/yd
    radius = 1.0 / kappa
    assert radius == pytest.approx(10.0, abs=1e-5)


def test_f8_boundary_kappa_90_percentile():
    """Verify 90th percentile calculation across a trajectory sequence."""
    kappas = [0.0, 0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.35]
    p90 = np.percentile(kappas, 90)
    assert p90 >= 0.20


def test_f8_boundary_duration_from_frame_count():
    """At 10 Hz, 51 frames span (51 - 1) * 0.1 = 5.0 seconds."""
    frames_count = 51
    duration = (frames_count - 1) * 0.1
    assert duration == pytest.approx(5.0, abs=1e-6)


def test_f8_boundary_heading_outside_360():
    """Angles outside [0, 360) must normalize correctly before calculations."""
    beta_over = compute_slip_angle(motion_dir=370.0, body_orientation=10.0)
    assert beta_over == pytest.approx(0.0, abs=1e-5)

    beta_under = compute_slip_angle(motion_dir=-10.0, body_orientation=350.0)
    assert beta_under == pytest.approx(0.0, abs=1e-5)


def test_f8_boundary_single_frame_trajectory():
    """A single frame trajectory cannot have differential omega or kappa."""
    df_single = pl.DataFrame({
        "time": ["2023-01-01T00:00:00.000"],
        "x": [20.0],
        "y": [30.0],
        "s": [5.0],
        "dir": [45.0],
    })
    df_diff = df_single.with_columns(
        pl.col("dir").shift(1).alias("prev_dir")
    )
    assert df_diff["prev_dir"][0] is None


def test_f8_property_slip_angle_skew_symmetry():
    """For any headings with non-180 diff, beta_slip(dir, o) == -beta_slip(o, dir)."""
    for (d, o) in [(10.0, 50.0), (350.0, 20.0), (120.0, 80.0), (45.0, 90.0)]:
        b1 = compute_slip_angle(d, o)
        b2 = compute_slip_angle(o, d)
        assert b1 == pytest.approx(-b2, abs=1e-5)


def test_f8_property_curvature_scaling_with_speed():
    """Doubling speed while maintaining turn rate halves curvature."""
    omega = 60.0
    k1 = compute_curvature(speed=2.0, omega_deg_s=omega)
    k2 = compute_curvature(speed=4.0, omega_deg_s=omega)
    assert k1 == pytest.approx(2.0 * k2, rel=1e-5)


def test_f8_boundary_negative_speed_clamped():
    """Negative speeds (e.g. sensor noise) must trigger singularity clamp."""
    kappa = compute_curvature(speed=-1.0, omega_deg_s=50.0)
    assert kappa == 0.0


def test_f8_tangential_acceleration_from_speed_diff():
    """Tangential acceleration a_parallel = delta_s / delta_t."""
    s_curr, s_prev, dt = 6.0, 5.0, 0.1
    a_par = (s_curr - s_prev) / dt
    assert a_par == pytest.approx(10.0, abs=1e-5)


def test_f8_boundary_infinite_omega_protection():
    """Excessive angular velocity values compute without overflow."""
    omega_extreme = 36000.0  # 100 rotations per sec
    kappa = compute_curvature(speed=5.0, omega_deg_s=omega_extreme)
    assert not math.isinf(kappa)
    assert not math.isnan(kappa)


def test_f8_boundary_quadrant_transition_continuity():
    """Sweeping angle continuously across all 4 quadrants gives continuous slip angles."""
    o = 0.0
    for d in range(0, 360, 15):
        beta = compute_slip_angle(float(d), o)
        assert -180.0 <= beta <= 180.0


# ==============================================================================
# Vectorized Polars Kinematics Tests
# ==============================================================================

def test_f8_polars_vectorized_kinematics():
    """Vectorized calculation matching Polars implementation contract."""
    df = pl.DataFrame({
        "time": [f"2023-09-10T12:00:0{i}.000" for i in range(5)],
        "x": [10.0, 10.5, 11.2, 11.8, 12.0],
        "y": [20.0, 20.8, 21.5, 21.9, 22.0],
        "s": [8.0, 7.5, 5.0, 0.15, 0.05],
        "dir": [0.0, 10.0, 25.0, 355.0, 350.0],
        "o": [0.0, 5.0, 15.0, 180.0, 180.0],
    })

    dt = 0.1
    df_result = df.with_columns([
        (((pl.col("dir") - pl.col("o") + 180.0) % 360.0) - 180.0).alias("beta_slip"),
        (((pl.col("dir") - pl.col("dir").shift(1) + 180.0) % 360.0) - 180.0).alias("delta_dir"),
    ]).with_columns([
        (pl.col("delta_dir").abs() / dt).alias("omega"),
    ]).with_columns([
        pl.when(pl.col("s") >= 0.2)
        .then((pl.col("omega") * (math.pi / 180.0)) / pl.col("s"))
        .otherwise(0.0)
        .alias("kappa")
    ])

    assert df_result["delta_dir"][0] is None
    assert df_result["omega"][1] == pytest.approx(100.0, abs=1e-5)
    assert df_result["kappa"][1] == pytest.approx(0.2327, abs=1e-3)
    assert df_result["kappa"][3] == 0.0
    assert df_result["kappa"][4] == 0.0
    assert df_result["beta_slip"][3] == pytest.approx(175.0, abs=1e-5)


def test_f8_real_combine_tracking_slice_kinematics():
    """Verify kinematics computation on a real player combine tracking parquet."""
    path = Path("tracking_by_position/WR/55884_Jaxon_Smith-Njigba_2023/combine_tracking.parquet")
    if not path.exists():
        pytest.skip(f"Combine tracking slice not found at {path}")

    df = pl.read_parquet(path)
    event_id = df["event_id"][0]
    drill = df.filter(pl.col("event_id") == event_id)

    dt = 0.1
    drill_k = drill.with_columns([
        (((pl.col("dir") - pl.col("dir").shift(1) + 180.0) % 360.0) - 180.0).alias("delta_dir"),
    ]).with_columns([
        (pl.col("delta_dir").abs() / dt).alias("omega"),
    ]).with_columns([
        pl.when(pl.col("s") >= 0.2)
        .then((pl.col("omega") * (math.pi / 180.0)) / pl.col("s"))
        .otherwise(0.0)
        .alias("kappa")
    ])

    assert "omega" in drill_k.columns
    assert "kappa" in drill_k.columns
    assert (drill_k["s"].drop_nulls() >= 0.0).all()
    valid_kappa = drill_k["kappa"].drop_nulls()
    assert (valid_kappa >= 0.0).all()
    assert not valid_kappa.is_infinite().any()
    assert not valid_kappa.is_nan().any()


def test_f8_real_game_tracking_slice_kinematics():
    """Verify slip angle and kinematics computation on a real game tracking parquet."""
    path = Path("tracking_by_position/WR/55884_Jaxon_Smith-Njigba_2023/game_tracking_2023.parquet")
    if not path.exists():
        pytest.skip(f"Game tracking slice not found at {path}")

    df = pl.read_parquet(path).filter(
        (pl.col("game_id") == 2023081052) & (pl.col("play_id") == 202)
    )
    assert len(df) == 77

    df_slip = df.with_columns([
        (((pl.col("dir") - pl.col("o") + 180.0) % 360.0) - 180.0).alias("beta_slip")
    ])

    betas = df_slip["beta_slip"].drop_nulls()
    assert (betas >= -180.0).all()
    assert (betas <= 180.0).all()


# ==============================================================================
# Optional Integration with src.web.kinematics (If Implemented)
# ==============================================================================

def test_f8_contract_compute_tracking_kinematics_import():
    """Verifies interface contract function compute_tracking_kinematics if module exists."""
    try:
        from src.web.kinematics import compute_tracking_kinematics
    except (ImportError, ModuleNotFoundError):
        pytest.skip("src.web.kinematics not yet implemented by worker (Milestone M2)")

    df = pl.DataFrame({
        "time": ["2023-09-10T12:00:00.000", "2023-09-10T12:00:00.100"],
        "x": [10.0, 10.5],
        "y": [20.0, 20.8],
        "s": [5.0, 5.0],
        "dir": [45.0, 55.0],
        "o": [45.0, 45.0],
    })

    res = compute_tracking_kinematics(df, is_combine=False)
    assert "omega" in res.columns
    assert "kappa" in res.columns
    assert "beta_slip" in res.columns
    assert res["beta_slip"][1] == pytest.approx(10.0, abs=1e-5)
    assert "beta_rate" in res.columns
    assert "jerk" in res.columns
    assert "snap_oversteer" in res.columns
    assert "dynamics_state" in res.columns


def test_vehicle_dynamics_snap_oversteer():
    """Verify sideslip angle rate, jerk, snap oversteer detection, and dynamics classification."""
    from src.web.kinematics import (
        classify_dynamics_state,
        compute_beta_rate,
        compute_jerk,
        detect_snap_oversteer,
    )

    # 1. Sideslip angle rate dbeta/dt
    assert compute_beta_rate(10.0, 0.0, dt=0.1) == pytest.approx(100.0, abs=1e-5)
    assert compute_beta_rate(-10.0, 10.0, dt=0.1) == pytest.approx(-200.0, abs=1e-5)
    # Minimal angular difference around wrap boundary (e.g. 179 to -179)
    assert compute_beta_rate(-179.0, 179.0, dt=0.1) == pytest.approx(20.0, abs=1e-5)

    # 2. Jerk da/dt
    assert compute_jerk(4.0, 2.0, dt=0.1) == pytest.approx(20.0, abs=1e-5)
    assert compute_jerk(1.5, 2.5, dt=0.1) == pytest.approx(-10.0, abs=1e-5)

    # 3. Snap oversteer detection
    assert detect_snap_oversteer(speed=4.5, beta_rate=120.0, jerk=8.0) is True
    assert detect_snap_oversteer(speed=0.3, beta_rate=120.0, jerk=8.0) is False  # low speed
    assert detect_snap_oversteer(speed=4.5, beta_rate=20.0, jerk=8.0) is False   # smooth slip rate
    assert detect_snap_oversteer(speed=4.5, beta_rate=140.0, jerk=1.0) is False  # low jerk

    # 4. Dynamics state classification
    assert classify_dynamics_state(speed=0.2, beta=0.0) == "STATIONARY"
    assert classify_dynamics_state(speed=5.0, beta=2.0) == "ON_RAILS"
    assert classify_dynamics_state(speed=5.0, beta=25.0, beta_rate=20.0, jerk=2.0) == "CONTROLLED_DRIFT"
    assert classify_dynamics_state(speed=5.0, beta=80.0, beta_rate=30.0, jerk=2.0) == "LATERAL_BACKPEDAL"
    assert classify_dynamics_state(speed=5.0, beta=35.0, beta_rate=150.0, jerk=9.0) == "SNAP_OVERSTEER"

