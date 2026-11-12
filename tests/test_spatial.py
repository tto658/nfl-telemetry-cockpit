"""Comprehensive unit and mathematical validation tests for Spatial Resampling module.

Covers:
- Monotonicity and geometric exactness of curvilinear arc length
- Perfect 1D linear interpolation on uniform distance grids
- Formula 1 lap delta calculation (Delta t < 0 when faster, Delta t > 0 when slower)
- Telescoping mini-sector delta sum identity
- Unwrapped angular interpolation across 0/360 boundary (due North) and -180/180 slip angles
- Drill milestones (10yd, 20yd, 40yd splits)
- Turn corner apex detection via curvature peaks
- Edge cases: stationary frames, zero speed, single frame, differing lengths
- Input polymorphism (Polars, Pandas, dicts, FrameDTO)
"""

import math

import numpy as np
import pandas as pd
import polars as pl
import pytest

from src.web.schemas import FrameDTO
from src.web.spatial import (
    ApexPoint,
    MilestoneDelta,
    MiniSectorDelta,
    SpatialDeltaComparison,
    SpatialResampledPoint,
    SpatialTrajectory,
    compute_arc_length,
    compare_trajectories_spatial,
    compute_mini_sectors,
    detect_apex_points,
    evaluate_milestones,
    generate_distance_grid,
    resample_trajectory_spatial,
    unwrap_angles_deg,
    wrap_angle_180,
    wrap_angle_360,
)


# ==============================================================================
# 1. Arc Length & Monotonicity Tests
# ==============================================================================
def test_compute_arc_length_linear():
    """Check exact Euclidean arc length on straight line along x, y, and diagonal."""
    # X-axis straight line
    x = [0.0, 5.0, 10.0, 40.0]
    y = [0.0, 0.0, 0.0, 0.0]
    d = compute_arc_length(x, y)
    assert len(d) == 4
    assert d[0] == 0.0
    assert d.tolist() == pytest.approx([0.0, 5.0, 10.0, 40.0], abs=1e-6)

    # 3-4-5 Right Triangle diagonal
    x_diag = [0.0, 3.0]
    y_diag = [0.0, 4.0]
    d_diag = compute_arc_length(x_diag, y_diag)
    assert d_diag.tolist() == pytest.approx([0.0, 5.0], abs=1e-6)


def test_compute_arc_length_strictly_non_decreasing():
    """d_k must be non-decreasing even with stationary plateaus (Delta d = 0)."""
    x = [0.0, 0.0, 0.0, 2.0, 2.0, 5.0]
    y = [0.0, 0.0, 0.0, 0.0, 0.0, 4.0]
    d = compute_arc_length(x, y)

    diffs = np.diff(d)
    assert np.all(diffs >= 0.0)
    assert d[0] == 0.0
    assert d[1] == 0.0
    assert d[2] == 0.0
    assert d[3] == pytest.approx(2.0, abs=1e-6)
    assert d[4] == pytest.approx(2.0, abs=1e-6)
    assert d[5] == pytest.approx(7.0, abs=1e-6)  # 2.0 + sqrt(3^2 + 4^2) = 7.0


def test_compute_arc_length_random_walk_monotonicity():
    """Random 2D walk of 100 points must yield non-decreasing arc length."""
    rng = np.random.default_rng(42)
    x = np.cumsum(rng.normal(0, 1, 100))
    y = np.cumsum(rng.normal(0, 1, 100))
    d = compute_arc_length(x, y)

    assert len(d) == 100
    assert d[0] == 0.0
    assert np.all(np.diff(d) >= 0.0)


# ==============================================================================
# 2. Angular Unwrapping & Wrapping Tests
# ==============================================================================
def test_angular_unwrapping_crossing_north():
    """Turning clockwise across North (355 -> 5) unwraps without a 350 deg jump."""
    angles = [350.0, 355.0, 5.0, 10.0]
    unwrapped = unwrap_angles_deg(angles)
    assert unwrapped[1] - unwrapped[0] == pytest.approx(5.0, abs=1e-5)
    assert unwrapped[2] - unwrapped[1] == pytest.approx(10.0, abs=1e-5)
    assert unwrapped[3] - unwrapped[2] == pytest.approx(5.0, abs=1e-5)

    # Midpoint between 355 and 5 in unwrapped space is 360 = 0 deg
    d = [0.0, 10.0]
    two_angles = np.array([355.0, 5.0])
    traj = {"x": [0.0, 10.0], "y": [0.0, 0.0], "dir": two_angles, "s": [5.0, 5.0]}
    res = resample_trajectory_spatial(traj, step_yards=5.0)
    # At midpoint (d=5.0), heading must be 0.0 deg (North), NOT 180.0 deg (South)
    pt_mid = res.get_point_at_distance(5.0)
    assert pt_mid.dir == pytest.approx(0.0, abs=1e-2)


def test_angular_unwrapping_counter_clockwise():
    """Turning counter-clockwise across North (5 -> 355) unwraps to 0 deg at midpoint."""
    traj = {"x": [0.0, 10.0], "y": [0.0, 0.0], "dir": [5.0, 355.0], "s": [5.0, 5.0]}
    res = resample_trajectory_spatial(traj, step_yards=5.0)
    pt_mid = res.get_point_at_distance(5.0)
    assert pt_mid.dir == pytest.approx(0.0, abs=1e-2)


def test_angular_unwrapping_sideslip_boundary():
    """Sideslip angle beta in [-180, 180] wrapping smoothly across +/-180 boundary."""
    traj = {
        "x": [0.0, 10.0],
        "y": [0.0, 0.0],
        "s": [5.0, 5.0],
        "dir": [90.0, 90.0],
        "beta_slip": [170.0, -170.0],
    }
    res = resample_trajectory_spatial(traj, step_yards=5.0)
    pt_mid = res.get_point_at_distance(5.0)
    assert abs(pt_mid.beta_slip) == pytest.approx(180.0, abs=1e-2)


# ==============================================================================
# 3. Perfect 1D Interpolation Tests
# ==============================================================================
def test_perfect_interpolation_linear_sprint():
    """Constant velocity sprint (v=10 yd/s) over 40 yards matches analytical solution."""
    # 41 frames at 10 Hz from t=0.0 to 4.0
    times = [i * 0.1 for i in range(41)]
    xs = [10.0 * t for t in times]
    ys = [0.0 for _ in times]
    speeds = [10.0 for _ in times]
    accels = [0.0 for _ in times]
    dirs = [90.0 for _ in times]  # Heading East

    raw = {"time": times, "x": xs, "y": ys, "s": speeds, "a": accels, "dir": dirs}
    res = resample_trajectory_spatial(raw, step_yards=0.5)

    assert res.total_distance == pytest.approx(40.0, abs=1e-4)
    assert res.total_time == pytest.approx(4.0, abs=1e-4)
    assert len(res.points) == 81  # [0.0, 0.5, 1.0, ..., 40.0]

    for pt in res.points:
        expected_time = pt.distance / 10.0
        assert pt.time == pytest.approx(expected_time, abs=1e-4)
        assert pt.x == pytest.approx(pt.distance, abs=1e-4)
        assert pt.y == pytest.approx(0.0, abs=1e-4)
        assert pt.s == pytest.approx(10.0, abs=1e-4)
        assert pt.a == pytest.approx(0.0, abs=1e-4)
        assert pt.dir == pytest.approx(90.0, abs=1e-2)


def test_perfect_interpolation_constant_acceleration():
    """Athlete with constant acceleration a=4.0 yd/s^2 matches t = sqrt(2d/a)."""
    a_const = 4.0
    times = np.linspace(0.0, 3.0, 31)
    xs = 0.5 * a_const * (times ** 2)  # Max distance = 0.5 * 4 * 9 = 18.0 yd
    ys = np.zeros_like(xs)
    speeds = a_const * times
    accels = np.full_like(times, a_const)

    raw = {"time": times, "x": xs, "y": ys, "s": speeds, "a": accels, "dir": np.full_like(times, 90.0)}
    res = resample_trajectory_spatial(raw, step_yards=1.0)

    for pt in res.points:
        d = pt.distance
        expected_t = math.sqrt(2.0 * d / a_const)
        assert pt.time == pytest.approx(expected_t, abs=0.05)


# ==============================================================================
# 4. Formula 1-Style Delta Comparison Tests
# ==============================================================================
def test_f1_delta_time_calculation_a_faster():
    """Trajectory A faster than B: Delta t(d) = t_A(d) - t_B(d) must be strictly NEGATIVE."""
    # A: 40 yards in 4.40s (v = 9.09 yd/s)
    times_a = np.linspace(0.0, 4.40, 45)
    xs_a = np.linspace(0.0, 40.0, 45)
    traj_a = {"time": times_a, "x": xs_a, "y": np.zeros(45), "s": np.full(45, 9.09), "dir": np.full(45, 90.0)}

    # B: 40 yards in 4.60s (v = 8.70 yd/s)
    times_b = np.linspace(0.0, 4.60, 47)
    xs_b = np.linspace(0.0, 40.0, 47)
    traj_b = {"time": times_b, "x": xs_b, "y": np.zeros(47), "s": np.full(47, 8.70), "dir": np.full(47, 90.0)}

    comp = compare_trajectories_spatial(traj_a, traj_b, step_yards=0.5)

    assert comp.common_max_distance == pytest.approx(40.0, abs=1e-4)
    assert comp.faster_overall == "A"
    # At finish line: Delta t = 4.40 - 4.60 = -0.20s
    assert comp.total_time_delta == pytest.approx(-0.20, abs=1e-2)

    # All points for d > 0 must have Delta t < 0
    for d, dt in zip(comp.grid_distance[1:], comp.delta_time[1:]):
        assert dt < 0.0, f"Expected negative Delta t at distance {d}, got {dt}"


def test_f1_delta_time_calculation_b_faster():
    """Trajectory B faster than A: Delta t(d) must be strictly POSITIVE."""
    # A: 40 yd in 4.80s
    times_a = np.linspace(0.0, 4.80, 49)
    xs_a = np.linspace(0.0, 40.0, 49)
    traj_a = {"time": times_a, "x": xs_a, "y": np.zeros(49), "s": np.full(49, 8.33), "dir": np.full(49, 90.0)}

    # B: 40 yd in 4.40s
    times_b = np.linspace(0.0, 4.40, 45)
    xs_b = np.linspace(0.0, 40.0, 45)
    traj_b = {"time": times_b, "x": xs_b, "y": np.zeros(45), "s": np.full(45, 9.09), "dir": np.full(45, 90.0)}

    comp = compare_trajectories_spatial(traj_a, traj_b, step_yards=0.5)
    assert comp.faster_overall == "B"
    assert comp.total_time_delta == pytest.approx(0.40, abs=1e-2)


def test_f1_delta_time_tie():
    """Identical trajectories yield Delta t == 0.0 and 'TIE'."""
    times = np.linspace(0.0, 4.40, 45)
    xs = np.linspace(0.0, 40.0, 45)
    traj = {"time": times, "x": xs, "y": np.zeros(45), "s": np.full(45, 9.09), "dir": np.full(45, 90.0)}

    comp = compare_trajectories_spatial(traj, traj, step_yards=1.0)
    assert comp.faster_overall == "TIE"
    assert comp.total_time_delta == pytest.approx(0.0, abs=1e-4)


# ==============================================================================
# 5. Mini-Sectors & Telescoping Delta Identity
# ==============================================================================
def test_mini_sectors_telescoping_sum():
    """Sum of Delta T_k across all mini-sectors must equal total Delta t at finish."""
    times_a = np.linspace(0.0, 4.40, 45)
    xs_a = np.linspace(0.0, 40.0, 45)
    traj_a = {"time": times_a, "x": xs_a, "y": np.zeros(45), "s": np.full(45, 9.09), "dir": np.full(45, 90.0)}

    times_b = np.linspace(0.0, 4.60, 47)
    xs_b = np.linspace(0.0, 40.0, 47)
    traj_b = {"time": times_b, "x": xs_b, "y": np.zeros(47), "s": np.full(47, 8.70), "dir": np.full(47, 90.0)}

    comp = compare_trajectories_spatial(traj_a, traj_b, sector_size_yards=5.0)
    sum_sector_deltas = sum(sec.delta_time for sec in comp.mini_sectors)

    # Tolerates micro-rounding across 8 sectors
    assert sum_sector_deltas == pytest.approx(comp.total_time_delta, abs=1e-3)


def test_mini_sectors_alternating_leads():
    """A faster in sector 1, B faster in sector 2 correctly reports winners."""
    st_a = SpatialTrajectory(
        total_distance=10.0,
        total_time=2.0,
        step_yards=1.0,
        points=[
            SpatialResampledPoint(distance=0.0, time=0.0, x=0.0, y=0.0, s=10.0, a=0.0, dir=90.0),
            SpatialResampledPoint(distance=5.0, time=0.5, x=5.0, y=0.0, s=10.0, a=0.0, dir=90.0),   # 0.5s for 0-5
            SpatialResampledPoint(distance=10.0, time=2.0, x=10.0, y=0.0, s=3.33, a=0.0, dir=90.0), # 1.5s for 5-10
        ],
    )
    st_b = SpatialTrajectory(
        total_distance=10.0,
        total_time=2.0,
        step_yards=1.0,
        points=[
            SpatialResampledPoint(distance=0.0, time=0.0, x=0.0, y=0.0, s=5.0, a=0.0, dir=90.0),
            SpatialResampledPoint(distance=5.0, time=1.0, x=5.0, y=0.0, s=5.0, a=0.0, dir=90.0),   # 1.0s for 0-5
            SpatialResampledPoint(distance=10.0, time=1.8, x=10.0, y=0.0, s=6.25, a=0.0, dir=90.0),# 0.8s for 5-10
        ],
    )

    sectors = compute_mini_sectors(st_a, st_b, sector_size_yards=5.0)
    assert len(sectors) == 2

    # Sector 0: A took 0.5s, B took 1.0s -> Delta = -0.5s (A won)
    assert sectors[0].winner == "A"
    assert sectors[0].delta_time == pytest.approx(-0.5, abs=1e-3)

    # Sector 1: A took 1.5s, B took 0.8s -> Delta = +0.7s (B won)
    assert sectors[1].winner == "B"
    assert sectors[1].delta_time == pytest.approx(0.7, abs=1e-3)


# ==============================================================================
# 6. Milestone Evaluation Tests
# ==============================================================================
def test_milestone_evaluation_40_yard_dash():
    """Checks 10yd, 20yd, and 40yd combine splits."""
    # A runs 40yd with splits: 10yd in 1.45s, 20yd in 2.50s, 40yd in 4.35s
    # B runs 40yd with splits: 10yd in 1.52s, 20yd in 2.62s, 40yd in 4.50s
    times_a = [0.0, 1.45, 2.50, 4.35]
    xs_a = [0.0, 10.0, 20.0, 40.0]
    traj_a = {"time": times_a, "x": xs_a, "y": [0.0]*4, "s": [8.0, 10.0, 11.0, 11.5], "dir": [90.0]*4}

    times_b = [0.0, 1.52, 2.62, 4.50]
    xs_b = [0.0, 10.0, 20.0, 40.0]
    traj_b = {"time": times_b, "x": xs_b, "y": [0.0]*4, "s": [7.5, 9.5, 10.5, 11.0], "dir": [90.0]*4}

    comp = compare_trajectories_spatial(traj_a, traj_b, milestones="forty_yard_dash")
    ms = {m.name: m for m in comp.milestones}

    assert "10-Yard Split" in ms
    assert ms["10-Yard Split"].delta_time == pytest.approx(1.45 - 1.52, abs=1e-3)
    assert ms["10-Yard Split"].time_a == pytest.approx(1.45, abs=1e-3)
    assert ms["10-Yard Split"].time_b == pytest.approx(1.52, abs=1e-3)

    assert "40-Yard Finish" in ms
    assert ms["40-Yard Finish"].delta_time == pytest.approx(4.35 - 4.50, abs=1e-3)


# ==============================================================================
# 7. Corner Apex Detection Tests
# ==============================================================================
def test_apex_detection_in_90_degree_turn():
    """Corner with 90-degree circular arc (radius R=2 yd, kappa=0.5) detects apex."""
    # Straight (0-5 yd), Circular turn (radius 2 yd, curvature 0.5), Straight (5 yd)
    theta = np.linspace(0, np.pi / 2, 21)
    arc_x = 5.0 + 2.0 * np.sin(theta)
    arc_y = 2.0 - 2.0 * np.cos(theta)

    xs = np.concatenate([np.linspace(0.0, 5.0, 11), arc_x[1:], np.full(10, arc_x[-1])])
    ys = np.concatenate([np.zeros(11), arc_y[1:], arc_y[-1] + np.linspace(0.5, 5.0, 10)])
    times = np.linspace(0.0, 3.0, len(xs))
    speeds = np.full(len(xs), 5.0)

    # Curvature: 0.5 on arc, 0 elsewhere
    kappas = np.zeros(len(xs))
    kappas[11:31] = 0.5

    traj = {"time": times, "x": xs, "y": ys, "s": speeds, "dir": np.zeros(len(xs)), "curvature": kappas}
    apexes = detect_apex_points(traj, min_curvature=0.20, distance_window_yards=2.0)

    assert len(apexes) >= 1
    main_apex = apexes[0]
    assert main_apex.curvature == pytest.approx(0.5, abs=1e-2)
    assert main_apex.distance >= 5.0


# ==============================================================================
# 8. Boundary and Edge Cases Tests
# ==============================================================================
def test_edge_case_zero_speed_stationary_frames():
    """Player stands still at line of scrimmage for 5 frames, then accelerates."""
    xs = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 3.0, 6.0, 10.0]
    ys = [0.0] * 9
    times = [i * 0.1 for i in range(9)]
    speeds = [0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 5.0, 7.0, 9.0]
    dirs = [90.0] * 9

    raw = {"time": times, "x": xs, "y": ys, "s": speeds, "dir": dirs}
    res = resample_trajectory_spatial(raw, step_yards=1.0)

    assert res.total_distance == pytest.approx(10.0, abs=1e-4)
    assert res.points[0].distance == 0.0
    assert res.points[0].time == pytest.approx(0.0, abs=1e-4)
    assert res.points[-1].distance == pytest.approx(10.0, abs=1e-4)
    # Check no NaNs or Infs
    for p in res.points:
        assert not math.isnan(p.time)
        assert not math.isinf(p.time)


def test_edge_case_completely_stationary_trajectory():
    """Completely stationary athlete (all frames at s=0, d=0)."""
    raw = {
        "time": [0.0, 0.1, 0.2, 0.3],
        "x": [10.0, 10.0, 10.0, 10.0],
        "y": [20.0, 20.0, 20.0, 20.0],
        "s": [0.0, 0.0, 0.0, 0.0],
        "dir": [0.0, 0.0, 0.0, 0.0],
    }
    res = resample_trajectory_spatial(raw, step_yards=0.5)
    assert res.total_distance == 0.0
    assert len(res.points) == 1
    assert res.points[0].distance == 0.0

    comp = compare_trajectories_spatial(res, res)
    assert comp.common_max_distance == 0.0


def test_edge_case_single_frame():
    """Single frame trajectory executes without error."""
    raw = {"time": [0.0], "x": [15.0], "y": [25.0], "s": [4.0], "dir": [45.0]}
    res = resample_trajectory_spatial(raw, step_yards=0.5)
    assert len(res.points) == 1
    assert res.total_distance == 0.0


def test_edge_case_differing_trajectory_lengths():
    """A runs 40 yards, B runs 20 yards -> common grid stops at 20 yards."""
    traj_a = {"time": [0.0, 4.0], "x": [0.0, 40.0], "y": [0.0, 0.0], "s": [10.0, 10.0], "dir": [90.0, 90.0]}
    traj_b = {"time": [0.0, 2.0], "x": [0.0, 20.0], "y": [0.0, 0.0], "s": [10.0, 10.0], "dir": [90.0, 90.0]}

    comp = compare_trajectories_spatial(traj_a, traj_b, step_yards=1.0)
    assert comp.common_max_distance == pytest.approx(20.0, abs=1e-4)
    assert comp.grid_distance[-1] == pytest.approx(20.0, abs=1e-4)


# ==============================================================================
# 9. Input Polymorphism & Serialization Tests
# ==============================================================================
def test_input_polymorphism_polars_pandas_dicts_framedto():
    """resample_trajectory_spatial seamlessly accepts Polars, Pandas, dicts, and FrameDTO."""
    records = [
        {"frameId": 0, "time": 0.0, "x": 0.0, "y": 0.0, "s": 5.0, "a": 0.0, "dir": 90.0},
        {"frameId": 1, "time": 0.1, "x": 1.0, "y": 0.0, "s": 5.0, "a": 0.0, "dir": 90.0},
        {"frameId": 2, "time": 0.2, "x": 2.0, "y": 0.0, "s": 5.0, "a": 0.0, "dir": 90.0},
    ]

    # 1. List of dicts
    st_dict = resample_trajectory_spatial(records, step_yards=0.5)
    assert len(st_dict.points) == 5

    # 2. Polars DataFrame
    pl_df = pl.DataFrame(records)
    st_pl = resample_trajectory_spatial(pl_df, step_yards=0.5)
    assert len(st_pl.points) == 5

    # 3. Pandas DataFrame
    pd_df = pd.DataFrame(records)
    st_pd = resample_trajectory_spatial(pd_df, step_yards=0.5)
    assert len(st_pd.points) == 5

    # 4. List of FrameDTO
    dtos = [FrameDTO(**r) for r in records]
    st_dto = resample_trajectory_spatial(dtos, step_yards=0.5)
    assert len(st_dto.points) == 5

    # 5. Dict with 'frames' key (standard load_player_snap format)
    snap_dict = {"frames": records}
    st_snap = resample_trajectory_spatial(snap_dict, step_yards=0.5)
    assert len(st_snap.points) == 5


def test_pydantic_serialization():
    """Output models serialize to valid JSON dictionary via model_dump()."""
    traj = {"time": [0.0, 1.0], "x": [0.0, 10.0], "y": [0.0, 0.0], "s": [10.0, 10.0], "dir": [90.0, 90.0]}
    comp = compare_trajectories_spatial(traj, traj, step_yards=2.0)

    data = comp.model_dump()
    assert "common_max_distance" in data
    assert "delta_time" in data
    assert "mini_sectors" in data
    assert isinstance(comp.model_dump_json(), str)
