"""Mathematical Spatial Resampling and Trajectory Delta Comparison Module.

Canonical mathematical module for:
1. Cumulative curvilinear arc length computation:
   d_0 = 0.0
   d_k = d_{k-1} + sqrt((x_k - x_{k-1})^2 + (y_k - y_{k-1})^2)
   Guaranteed strictly non-decreasing.

2. Uniform distance grid resampling:
   d* = [0.0, Delta d, 2 Delta d, ..., d_max], default Delta d = 0.5 yd.
   1D linear/monotonic interpolation for:
   - time(d) (time elapsed to reach distance d)
   - s(d) (speed at distance d)
   - a(d) (acceleration at distance d)
   - x(d), y(d) (spatial position)
   - dir(d), o(d) (unwrapped angular interpolation in [0, 360))
   - curvature(d) / kappa(d)
   - beta_slip(d) (sideslip angle in [-180, 180])
   - beta_rate(d) (sideslip angle derivative)
   - jerk(d) (kinematic jerk da/dt)

3. Formula 1-style Spatial Delta Comparison:
   - Resample both trajectories on common grid up to min(d_max,A, d_max,B)
   - Delta t(d) = t_A(d) - t_B(d) (negative = A is faster/ahead, positive = B is faster)
   - Delta s(d) = s_A(d) - s_B(d) (speed delta)
   - Mini-sectors (e.g. 5-yard chunks) showing sector delta and time gained/lost
   - Corner apex points (local curvature peaks) and drill milestones (10yd, 20yd, 40yd)

4. Pydantic v2 data models for clean REST API serialization.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import polars as pl
from pydantic import BaseModel, Field, model_validator

# -----------------------------------------------------------------------------
# Canonical NFL Combine Drill Milestones
# -----------------------------------------------------------------------------
DRILL_MILESTONES: dict[str, dict[str, float]] = {
    "forty_yard_dash": {
        "10-Yard Split": 10.0,
        "20-Yard Split": 20.0,
        "40-Yard Finish": 40.0,
    },
    "three_cone": {
        "Turn 1 (5yd)": 5.0,
        "Return Line (10yd)": 10.0,
        "Cone 2 Cut (15yd)": 15.0,
        "Cone 3 Apex (18yd)": 18.0,
        "Cone 2 Figure-8 (23yd)": 23.0,
        "Finish (30yd)": 30.0,
    },
    "short_shuttle": {
        "First Cut (5yd)": 5.0,
        "Second Cut (15yd)": 15.0,
        "Finish Line (20yd)": 20.0,
    },
}


# -----------------------------------------------------------------------------
# Pydantic Schemas / Output DTOs
# -----------------------------------------------------------------------------
class SpatialResampledPoint(BaseModel):
    """Single resampled telemetry point on a uniform distance grid."""

    distance: float = Field(..., description="Curvilinear distance along trajectory in yards")
    time: float = Field(..., description="Elapsed time to reach distance in seconds")
    x: float = Field(..., description="Field X coordinate in yards")
    y: float = Field(..., description="Field Y coordinate in yards")
    s: float = Field(..., description="Speed in yards/second")
    a: float = Field(..., description="Acceleration in yards/second^2")
    dir: float = Field(..., description="Motion direction angle in degrees [0, 360)")
    o: float | None = Field(default=None, description="Body orientation angle in degrees [0, 360)")
    curvature: float = Field(default=0.0, description="Trajectory curvature kappa in 1/yard")
    kappa: float = Field(default=0.0, description="Curvature alias")
    beta_slip: float | None = Field(default=None, description="Sideslip angle in degrees [-180, 180]")
    beta_rate: float | None = Field(default=None, description="Sideslip angle rate in deg/s")
    jerk: float | None = Field(default=None, description="Kinematic jerk in yd/s^3")
    a_lat: float | None = Field(default=None, description="Lateral acceleration in yd/s^2")
    a_comb: float | None = Field(default=None, description="Combined horizontal acceleration in yd/s^2")
    g_comb: float | None = Field(default=None, description="Combined G-Force in g")
    g_lat: float | None = Field(default=None, description="Lateral acceleration in g")
    g_t: float | None = Field(default=None, description="Tangential acceleration in g")

    @model_validator(mode="before")
    @classmethod
    def sync_aliases(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if "curvature" in data and not data.get("kappa"):
                data["kappa"] = data["curvature"]
            elif "kappa" in data and not data.get("curvature"):
                data["curvature"] = data["kappa"]
            if "slip_angle" in data and not data.get("beta_slip"):
                data["beta_slip"] = data["slip_angle"]
            elif "beta_slip" in data and not data.get("slip_angle"):
                data["slip_angle"] = data["beta_slip"]
            if "slip_rate" in data and not data.get("beta_rate"):
                data["beta_rate"] = data["slip_rate"]
        return data


class SpatialTrajectory(BaseModel):
    """Full spatially resampled trajectory along a uniform distance grid."""

    total_distance: float = Field(..., description="Total cumulative distance in yards")
    total_time: float = Field(..., description="Total elapsed time in seconds")
    step_yards: float = Field(..., description="Spatial grid resolution in yards")
    point_count: int = Field(default=0, description="Number of resampled spatial points")
    points: list[SpatialResampledPoint] = Field(default_factory=list, description="Resampled points")

    @model_validator(mode="after")
    def set_point_count(self) -> SpatialTrajectory:
        self.point_count = len(self.points)
        return self

    @property
    def distances(self) -> list[float]:
        return [p.distance for p in self.points]

    @property
    def times(self) -> list[float]:
        return [p.time for p in self.points]

    @property
    def speeds(self) -> list[float]:
        return [p.s for p in self.points]

    @property
    def accelerations(self) -> list[float]:
        return [p.a for p in self.points]

    def to_dataframe(self) -> pl.DataFrame:
        """Convert resampled points to a Polars DataFrame."""
        if not self.points:
            return pl.DataFrame()
        return pl.DataFrame([p.model_dump() for p in self.points])

    def get_point_at_distance(self, distance: float) -> SpatialResampledPoint:
        """Find the nearest resampled point to a given distance."""
        if not self.points:
            raise ValueError("SpatialTrajectory has no points")
        return min(self.points, key=lambda p: abs(p.distance - distance))


class MiniSectorDelta(BaseModel):
    """Delta performance metrics across a fixed-length mini-sector (e.g. 5 yards)."""

    sector_index: int = Field(..., description="Sequential 0-indexed sector number")
    start_distance: float = Field(..., description="Start distance of sector in yards")
    end_distance: float = Field(..., description="End distance of sector in yards")
    sector_length: float = Field(..., description="Sector length in yards")
    time_a: float = Field(..., description="Time taken by Trajectory A through sector in seconds")
    time_b: float = Field(..., description="Time taken by Trajectory B through sector in seconds")
    delta_time: float = Field(..., description="t_A - t_B in seconds. Negative = A gained time / faster")
    speed_a_avg: float = Field(..., description="Average speed of Trajectory A in sector (yd/s)")
    speed_b_avg: float = Field(..., description="Average speed of Trajectory B in sector (yd/s)")
    delta_speed_avg: float = Field(..., description="s_A - s_B in yd/s. Positive = A had higher speed")
    winner: str = Field(..., description="'A', 'B', or 'TIE'")


class MilestoneDelta(BaseModel):
    """Split comparison at a specific drill distance milestone (e.g. 10yd split)."""

    name: str = Field(..., description="Milestone name, e.g. '10-Yard Split'")
    distance: float = Field(..., description="Milestone distance mark in yards")
    time_a: float = Field(..., description="Elapsed time for Trajectory A at milestone in seconds")
    time_b: float = Field(..., description="Elapsed time for Trajectory B at milestone in seconds")
    delta_time: float = Field(..., description="t_A - t_B in seconds. Negative = A is faster")
    speed_a: float = Field(..., description="Speed of Trajectory A at milestone in yd/s")
    speed_b: float = Field(..., description="Speed of Trajectory B at milestone in yd/s")
    delta_speed: float = Field(..., description="s_A - s_B in yd/s. Positive = A has higher speed")


class ApexPoint(BaseModel):
    """Corner apex identified at a local maximum in trajectory curvature."""

    trajectory_id: str = Field(..., description="'A' or 'B'")
    distance: float = Field(..., description="Distance along trajectory at apex in yards")
    x: float = Field(..., description="Field X coordinate at apex in yards")
    y: float = Field(..., description="Field Y coordinate at apex in yards")
    curvature: float = Field(..., description="Peak trajectory curvature kappa in 1/yard")
    speed: float = Field(..., description="Speed at apex in yd/s (corner minimum speed)")
    v_apex: float = Field(default=0.0, description="Apex speed alias in yd/s")
    apex_speed: float = Field(default=0.0, description="Apex speed alias in yd/s")
    time: float = Field(..., description="Elapsed time to reach apex in seconds")
    heading: float = Field(..., description="Motion direction angle in degrees [0, 360)")
    beta_slip: float | None = Field(default=None, description="Sideslip angle at apex in degrees")
    exit_traction: float | None = Field(default=None, description="Corner Exit Traction (mean acceleration in 0.5s after apex in yd/s^2)")
    g_comb: float | None = Field(default=None, description="Combined G-force at apex in g")


class SpatialDeltaComparison(BaseModel):
    """Formula 1-style spatial delta comparison between two trajectories."""

    common_max_distance: float = Field(..., description="Maximum common distance evaluated in yards")
    step_yards: float = Field(..., description="Spatial grid step in yards")
    grid_distance: list[float] = Field(..., description="Common distance grid points d* in yards")
    delta_time: list[float] = Field(..., description="t_A(d) - t_B(d) in seconds (negative = A is faster)")
    delta_speed: list[float] = Field(..., description="s_A(d) - s_B(d) in yd/s (positive = A is faster)")
    times_a: list[float] = Field(..., description="t_A(d) along common grid in seconds")
    times_b: list[float] = Field(..., description="t_B(d) along common grid in seconds")
    speeds_a: list[float] = Field(..., description="s_A(d) along common grid in yd/s")
    speeds_b: list[float] = Field(..., description="s_B(d) along common grid in yd/s")
    mini_sectors: list[MiniSectorDelta] = Field(default_factory=list, description="Mini-sector breakdown")
    milestones: list[MilestoneDelta] = Field(default_factory=list, description="Drill milestone split breakdown")
    apexes_a: list[ApexPoint] = Field(default_factory=list, description="Apex points in Trajectory A")
    apexes_b: list[ApexPoint] = Field(default_factory=list, description="Apex points in Trajectory B")
    resampled_a: SpatialTrajectory | None = Field(default=None, description="Resampled Trajectory A")
    resampled_b: SpatialTrajectory | None = Field(default=None, description="Resampled Trajectory B")
    overlap_index_a: float = Field(default=0.0, description="Trail-Braking / Overlap Index for Trajectory A")
    overlap_index_b: float = Field(default=0.0, description="Trail-Braking / Overlap Index for Trajectory B")
    g_comb_max_a: float = Field(default=0.0, description="Peak combined G-Force for Trajectory A in g")
    g_comb_max_b: float = Field(default=0.0, description="Peak combined G-Force for Trajectory B in g")
    exit_traction_a: float = Field(default=0.0, description="Primary Corner Exit Traction for Trajectory A in yd/s^2")
    exit_traction_b: float = Field(default=0.0, description="Primary Corner Exit Traction for Trajectory B in yd/s^2")
    key_apex_speed_a: float = Field(default=0.0, description="Primary apex speed for Trajectory A in yd/s")
    key_apex_speed_b: float = Field(default=0.0, description="Primary apex speed for Trajectory B in yd/s")

    @property
    def total_time_delta(self) -> float:
        """Delta time at the finish line / max common distance: t_A - t_B."""
        return self.delta_time[-1] if self.delta_time else 0.0

    @property
    def faster_overall(self) -> str:
        """Overall faster trajectory over common distance ('A', 'B', or 'TIE')."""
        dt = self.total_time_delta
        if dt < -1e-4:
            return "A"
        if dt > 1e-4:
            return "B"
        return "TIE"

    @property
    def max_lead_a(self) -> float:
        """Maximum time lead attained by Trajectory A in seconds."""
        if not self.delta_time:
            return 0.0
        min_dt = min(self.delta_time)
        return abs(min_dt) if min_dt < 0 else 0.0

    @property
    def max_lead_b(self) -> float:
        """Maximum time lead attained by Trajectory B in seconds."""
        if not self.delta_time:
            return 0.0
        max_dt = max(self.delta_time)
        return max_dt if max_dt > 0 else 0.0


# -----------------------------------------------------------------------------
# Core Mathematical Utility Functions
# -----------------------------------------------------------------------------
def compute_arc_length(
    x: np.ndarray | list[float] | Any,
    y: np.ndarray | list[float] | Any,
) -> np.ndarray:
    """Compute cumulative curvilinear arc length from consecutive (x, y) coordinates.

    Formula:
        d_0 = 0.0
        d_k = d_{k-1} + sqrt((x_k - x_{k-1})^2 + (y_k - y_{k-1})^2)

    Invariants guaranteed:
    - Return type is 1D float64 numpy array
    - d[0] == 0.0
    - Strictly non-decreasing: d[k] >= d[k-1] for all k >= 1
    """
    x_arr = np.asarray(x, dtype=np.float64)
    y_arr = np.asarray(y, dtype=np.float64)
    if len(x_arr) != len(y_arr):
        raise ValueError(f"x and y must have equal length, got {len(x_arr)} and {len(y_arr)}")
    if len(x_arr) == 0:
        return np.array([], dtype=np.float64)
    if len(x_arr) == 1:
        return np.array([0.0], dtype=np.float64)

    dx = np.diff(x_arr)
    dy = np.diff(y_arr)
    step_dist = np.sqrt(dx * dx + dy * dy)
    step_dist = np.nan_to_num(step_dist, nan=0.0)
    step_dist = np.maximum(step_dist, 0.0)

    cum_dist = np.empty(len(x_arr), dtype=np.float64)
    cum_dist[0] = 0.0
    cum_dist[1:] = np.cumsum(step_dist)
    return np.maximum.accumulate(cum_dist)


def wrap_angle_360(angles: np.ndarray | float) -> np.ndarray | float:
    """Wrap angles in degrees into the canonical interval [0.0, 360.0)."""
    return np.mod(angles, 360.0)


def wrap_angle_180(angles: np.ndarray | float) -> np.ndarray | float:
    """Wrap signed angles in degrees into the canonical interval [-180.0, 180.0]."""
    return ((angles + 180.0) % 360.0) - 180.0


def unwrap_angles_deg(angles: np.ndarray | list[float]) -> np.ndarray:
    """Continuous phase unwrapping of angles in degrees eliminating 360-degree jumps."""
    arr = np.asarray(angles, dtype=np.float64)
    if len(arr) <= 1:
        return arr.copy()
    rad = np.deg2rad(arr)
    unwrapped_rad = np.unwrap(rad)
    return np.rad2deg(unwrapped_rad)


def generate_distance_grid(
    d_max: float,
    step: float = 0.5,
    include_endpoint: bool = True,
) -> np.ndarray:
    """Generate uniform distance grid d* = [0.0, step, 2*step, ..., d_max]."""
    if d_max <= 0.0:
        return np.array([0.0], dtype=np.float64)
    steps = np.arange(0.0, d_max + 1e-9, step, dtype=np.float64)
    if include_endpoint and len(steps) > 0 and (d_max - steps[-1]) > 1e-5:
        steps = np.append(steps, float(d_max))
    return steps


def _prepare_strictly_increasing_d(d: np.ndarray, eps: float = 1e-11) -> np.ndarray:
    """Ensure distance array is strictly monotonically increasing for 1D interpolation.

    Adds a tiny ramp (eps * index) across plateau frames where athlete was stationary,
    preventing duplicate x-coordinates in linear interpolation while preserving sub-picometer
    spatial coordinates.
    """
    if len(d) <= 1:
        return d.copy()
    diffs = np.diff(d)
    if np.all(diffs > 0):
        return d.copy()
    ramp = np.arange(len(d), dtype=np.float64) * eps
    return d + ramp


def _interpolate_scalar(
    grid_d: np.ndarray,
    d: np.ndarray,
    values: np.ndarray,
) -> np.ndarray:
    """1D piecewise linear interpolation for continuous scalar variables."""
    if len(values) == 0:
        return np.array([], dtype=np.float64)
    if len(values) == 1:
        return np.full_like(grid_d, values[0])
    d_strict = _prepare_strictly_increasing_d(d)
    return np.interp(grid_d, d_strict, values)


def _interpolate_angles_360(
    grid_d: np.ndarray,
    d: np.ndarray,
    angles_deg: np.ndarray,
) -> np.ndarray:
    """Interpolate directional angles in [0, 360) via unwrapped continuous representation."""
    if len(angles_deg) == 0:
        return np.array([], dtype=np.float64)
    if len(angles_deg) == 1:
        return np.full_like(grid_d, wrap_angle_360(angles_deg[0]))
    unwrapped = unwrap_angles_deg(angles_deg)
    d_strict = _prepare_strictly_increasing_d(d)
    interp_unwrapped = np.interp(grid_d, d_strict, unwrapped)
    return wrap_angle_360(interp_unwrapped)


def _interpolate_angles_180(
    grid_d: np.ndarray,
    d: np.ndarray,
    angles_deg: np.ndarray,
) -> np.ndarray:
    """Interpolate signed sideslip angles in [-180, 180] via unwrapped representation."""
    if len(angles_deg) == 0:
        return np.array([], dtype=np.float64)
    if len(angles_deg) == 1:
        return np.full_like(grid_d, wrap_angle_180(angles_deg[0]))
    unwrapped = unwrap_angles_deg(angles_deg)
    d_strict = _prepare_strictly_increasing_d(d)
    interp_unwrapped = np.interp(grid_d, d_strict, unwrapped)
    return wrap_angle_180(interp_unwrapped)


# -----------------------------------------------------------------------------
# Input Normalization
# -----------------------------------------------------------------------------
def _extract_trajectory_arrays(trajectory: Any) -> dict[str, np.ndarray | None]:
    """Polymorphic extraction of trajectory columns into numpy arrays.

    Supports:
    - polars.DataFrame
    - pandas.DataFrame
    - list[dict]
    - list[FrameDTO]
    - dict with 'frames' or 'player_frames'
    - dict of column lists/arrays
    """
    raw_dict: dict[str, Any] = {}

    if hasattr(trajectory, "to_dict") and not hasattr(trajectory, "columns"):
        try:
            trajectory = trajectory.to_dict()
        except TypeError:
            pass

    if isinstance(trajectory, pl.DataFrame):
        for col in trajectory.columns:
            raw_dict[col] = trajectory[col].to_numpy()
    elif hasattr(trajectory, "__dataframe__") or hasattr(trajectory, "to_numpy") and hasattr(trajectory, "columns"):
        for col in trajectory.columns:
            raw_dict[col] = np.asarray(trajectory[col])
    elif isinstance(trajectory, dict):
        if "frames" in trajectory and isinstance(trajectory["frames"], list):
            return _extract_trajectory_arrays(trajectory["frames"])
        if "player_frames" in trajectory and isinstance(trajectory["player_frames"], list):
            return _extract_trajectory_arrays(trajectory["player_frames"])
        if "player_trajectory" in trajectory and isinstance(trajectory["player_trajectory"], list):
            return _extract_trajectory_arrays(trajectory["player_trajectory"])
        for k, v in trajectory.items():
            if isinstance(v, (list, tuple, np.ndarray)):
                raw_dict[k] = np.asarray(v)
    elif isinstance(trajectory, (list, tuple)):
        if not trajectory:
            raise ValueError("Input trajectory list is empty")
        first = trajectory[0]
        if hasattr(first, "model_dump"):
            dicts = [item.model_dump() for item in trajectory]
        elif isinstance(first, dict):
            dicts = trajectory
        else:
            raise TypeError(f"Unsupported trajectory element type: {type(first)}")

        keys = dicts[0].keys()
        for k in keys:
            raw_dict[k] = np.array([d.get(k) for d in dicts])
    else:
        raise TypeError(f"Unsupported trajectory input type: {type(trajectory)}")

    n = len(raw_dict.get("x", []))
    if n == 0:
        raise ValueError("Trajectory contains zero frames")

    def _get_arr(names: list[str], default_val: float = 0.0) -> np.ndarray:
        for name in names:
            if name in raw_dict and raw_dict[name] is not None:
                val = raw_dict[name]
                arr = np.asarray(val, dtype=np.float64)
                arr = np.nan_to_num(arr, nan=default_val)
                return arr
        return np.full(n, default_val, dtype=np.float64)

    def _get_optional_arr(names: list[str]) -> np.ndarray | None:
        for name in names:
            if name in raw_dict and raw_dict[name] is not None:
                val = raw_dict[name]
                if all(v is None for v in val):
                    return None
                arr = np.asarray(val, dtype=np.float64)
                if np.isnan(arr).all():
                    return None
                return np.nan_to_num(arr, nan=0.0)
        return None

    time_raw = raw_dict.get("time")
    if time_raw is not None:
        try:
            time_arr = np.asarray(time_raw, dtype=np.float64)
            time_arr = time_arr - time_arr[0]
        except (ValueError, TypeError):
            time_arr = np.arange(n, dtype=np.float64) * 0.1
    else:
        time_arr = np.arange(n, dtype=np.float64) * 0.1

    x_arr = _get_arr(["x"])
    y_arr = _get_arr(["y"])
    s_arr = _get_arr(["s", "speed"])
    a_arr = _get_arr(["a", "acceleration"])
    dir_arr = _get_arr(["dir", "direction", "heading"])
    o_arr = _get_optional_arr(["o", "orientation"])

    curvature_arr = _get_optional_arr(["curvature", "kappa"])
    beta_slip_arr = _get_optional_arr(["beta_slip", "slip_angle"])
    beta_rate_arr = _get_optional_arr(["beta_rate", "slip_rate"])
    jerk_arr = _get_optional_arr(["jerk"])

    # Synthesize curvature if missing but dir and s exist
    if curvature_arr is None and n > 1:
        dt = np.diff(time_arr)
        dt = np.where(dt <= 1e-6, 0.1, dt)
        delta_dir = unwrap_angles_deg(dir_arr)
        omega = np.zeros(n, dtype=np.float64)
        omega[1:] = np.abs(np.diff(delta_dir)) / dt
        kappa = np.zeros(n, dtype=np.float64)
        valid_s = s_arr >= 0.2
        kappa[valid_s] = (omega[valid_s] * (math.pi / 180.0)) / s_arr[valid_s]
        curvature_arr = kappa
    elif curvature_arr is None:
        curvature_arr = np.zeros(n, dtype=np.float64)

    # Synthesize beta_slip if missing but dir and o exist
    if beta_slip_arr is None and o_arr is not None:
        beta_slip_arr = wrap_angle_180(dir_arr - o_arr)

    # Synthesize beta_rate if missing
    if beta_rate_arr is None and beta_slip_arr is not None and n > 1:
        dt = np.diff(time_arr)
        dt = np.where(dt <= 1e-6, 0.1, dt)
        beta_unwrapped = unwrap_angles_deg(beta_slip_arr)
        br = np.zeros(n, dtype=np.float64)
        br[1:] = np.diff(beta_unwrapped) / dt
        beta_rate_arr = br

    # Synthesize jerk if missing
    if jerk_arr is None and n > 1:
        dt = np.diff(time_arr)
        dt = np.where(dt <= 1e-6, 0.1, dt)
        jk = np.zeros(n, dtype=np.float64)
        jk[1:] = np.diff(a_arr) / dt
        jerk_arr = jk

    return {
        "time": time_arr,
        "x": x_arr,
        "y": y_arr,
        "s": s_arr,
        "a": a_arr,
        "dir": dir_arr,
        "o": o_arr,
        "curvature": curvature_arr,
        "beta_slip": beta_slip_arr,
        "beta_rate": beta_rate_arr,
        "jerk": jerk_arr,
    }


# -----------------------------------------------------------------------------
# Spatial Resampling Core Function
# -----------------------------------------------------------------------------
def resample_trajectory_spatial(
    trajectory: Any,
    step_yards: float = 0.5,
    max_distance: float | None = None,
) -> SpatialTrajectory:
    """Resample a 10 Hz trajectory onto a uniform distance grid.

    Grid: d* = [0.0, step_yards, 2*step_yards, ..., d_max].

    Performs 1D piecewise linear/monotonic interpolation for:
    - time(d), s(d), a(d), x(d), y(d), curvature(d), beta_rate(d), jerk(d)
    - dir(d), o(d) using continuous unwrapped angular interpolation in [0, 360)
    - beta_slip(d) using continuous unwrapped angular interpolation in [-180, 180]
    """
    if step_yards <= 0.0:
        raise ValueError(f"step_yards must be strictly positive, got {step_yards}")

    arrays = _extract_trajectory_arrays(trajectory)
    x = arrays["x"]
    y = arrays["y"]
    t = arrays["time"]
    s = arrays["s"]
    a = arrays["a"]
    direction = arrays["dir"]
    orientation = arrays["o"]
    curvature = arrays["curvature"]
    beta_slip = arrays["beta_slip"]
    beta_rate = arrays["beta_rate"]
    jerk = arrays["jerk"]

    cum_d = compute_arc_length(x, y)
    d_total = float(cum_d[-1]) if len(cum_d) > 0 else 0.0
    effective_max = min(d_total, max_distance) if max_distance is not None else d_total

    grid_d = generate_distance_grid(effective_max, step=step_yards, include_endpoint=True)

    # 1. Scalar variables
    t_interp = _interpolate_scalar(grid_d, cum_d, t)
    x_interp = _interpolate_scalar(grid_d, cum_d, x)
    y_interp = _interpolate_scalar(grid_d, cum_d, y)
    s_interp = _interpolate_scalar(grid_d, cum_d, s)
    a_interp = _interpolate_scalar(grid_d, cum_d, a)
    k_interp = _interpolate_scalar(grid_d, cum_d, curvature) if curvature is not None else np.zeros_like(grid_d)

    # 2. Angles in [0, 360)
    dir_interp = _interpolate_angles_360(grid_d, cum_d, direction)
    o_interp = _interpolate_angles_360(grid_d, cum_d, orientation) if orientation is not None else None

    # 3. Sideslip angle in [-180, 180] and rates
    beta_interp = _interpolate_angles_180(grid_d, cum_d, beta_slip) if beta_slip is not None else None
    br_interp = _interpolate_scalar(grid_d, cum_d, beta_rate) if beta_rate is not None else None
    jerk_interp = _interpolate_scalar(grid_d, cum_d, jerk) if jerk is not None else None

    points: list[SpatialResampledPoint] = []
    for i in range(len(grid_d)):
        dist_val = round(float(grid_d[i]), 4)
        time_val = round(float(t_interp[i]), 4)
        x_val = round(float(x_interp[i]), 4)
        y_val = round(float(y_interp[i]), 4)
        s_val = round(float(s_interp[i]), 4)
        a_val = round(float(a_interp[i]), 4)
        dir_val = round(float(dir_interp[i]), 2)
        o_val = round(float(o_interp[i]), 2) if o_interp is not None else None
        curv_val = round(float(k_interp[i]), 4)
        beta_val = round(float(beta_interp[i]), 2) if beta_interp is not None else None
        br_val = round(float(br_interp[i]), 2) if br_interp is not None else None
        jerk_val = round(float(jerk_interp[i]), 3) if jerk_interp is not None else None

        # Combined G-Force & Lateral Acceleration
        s_pos = max(0.0, float(s_val))
        a_lat_val = float(curv_val) * (s_pos ** 2)
        a_comb_val = math.sqrt(float(a_val)**2 + a_lat_val**2)
        g_comb_val = a_comb_val / 10.7247

        pt = SpatialResampledPoint(
            distance=dist_val,
            time=time_val,
            x=x_val,
            y=y_val,
            s=s_val,
            a=a_val,
            dir=dir_val,
            o=o_val,
            curvature=curv_val,
            kappa=curv_val,
            beta_slip=beta_val,
            beta_rate=br_val,
            jerk=jerk_val,
            a_lat=round(a_lat_val, 2),
            a_comb=round(a_comb_val, 2),
            g_comb=round(g_comb_val, 2),
        )
        points.append(pt)

    total_time = points[-1].time if points else 0.0
    return SpatialTrajectory(
        total_distance=round(effective_max, 4),
        total_time=round(total_time, 4),
        step_yards=step_yards,
        points=points,
    )


# -----------------------------------------------------------------------------
# Mini-Sectors & Drill Milestones
# -----------------------------------------------------------------------------
def compute_mini_sectors(
    traj_a: SpatialTrajectory,
    traj_b: SpatialTrajectory,
    sector_size_yards: float = 5.0,
) -> list[MiniSectorDelta]:
    """Compute mini-sectors (e.g. 5 yard chunks) showing time gained/lost in each sector."""
    if sector_size_yards <= 0.0:
        raise ValueError(f"sector_size_yards must be positive, got {sector_size_yards}")

    d_common = min(traj_a.total_distance, traj_b.total_distance)
    if d_common <= 0.0:
        return []

    d_a = np.array(traj_a.distances, dtype=np.float64)
    t_a = np.array(traj_a.times, dtype=np.float64)
    d_b = np.array(traj_b.distances, dtype=np.float64)
    t_b = np.array(traj_b.times, dtype=np.float64)

    num_full = int(d_common // sector_size_yards)
    boundaries = [i * sector_size_yards for i in range(num_full + 1)]
    if (d_common - boundaries[-1]) > 0.5:
        boundaries.append(d_common)
    else:
        boundaries[-1] = d_common

    sectors: list[MiniSectorDelta] = []
    for idx in range(len(boundaries) - 1):
        s_start = boundaries[idx]
        s_end = boundaries[idx + 1]
        length = s_end - s_start
        if length <= 1e-6:
            continue

        ta_start = float(np.interp(s_start, _prepare_strictly_increasing_d(d_a), t_a))
        ta_end = float(np.interp(s_end, _prepare_strictly_increasing_d(d_a), t_a))
        dur_a = ta_end - ta_start

        tb_start = float(np.interp(s_start, _prepare_strictly_increasing_d(d_b), t_b))
        tb_end = float(np.interp(s_end, _prepare_strictly_increasing_d(d_b), t_b))
        dur_b = tb_end - tb_start

        delta_t = dur_a - dur_b
        speed_a_avg = length / dur_a if dur_a > 1e-6 else 0.0
        speed_b_avg = length / dur_b if dur_b > 1e-6 else 0.0
        delta_s_avg = speed_a_avg - speed_b_avg

        if delta_t < -1e-4:
            winner = "A"
        elif delta_t > 1e-4:
            winner = "B"
        else:
            winner = "TIE"

        sectors.append(
            MiniSectorDelta(
                sector_index=idx,
                start_distance=round(s_start, 2),
                end_distance=round(s_end, 2),
                sector_length=round(length, 2),
                time_a=round(dur_a, 4),
                time_b=round(dur_b, 4),
                delta_time=round(delta_t, 4),
                speed_a_avg=round(speed_a_avg, 2),
                speed_b_avg=round(speed_b_avg, 2),
                delta_speed_avg=round(delta_s_avg, 2),
                winner=winner,
            )
        )
    return sectors


def evaluate_milestones(
    traj_a: SpatialTrajectory,
    traj_b: SpatialTrajectory,
    milestones: list[float] | dict[str, float] | str | None = None,
) -> list[MilestoneDelta]:
    """Evaluate split times and speed deltas at key drill distance milestones."""
    d_common = min(traj_a.total_distance, traj_b.total_distance)
    if d_common <= 0.0:
        return []

    target_milestones: dict[str, float] = {}
    if isinstance(milestones, str):
        key = milestones.lower().strip().replace('-', '_').replace(' ', '_')
        if 'forty' in key or '40' in key:
            target_milestones = DRILL_MILESTONES.get('forty_yard_dash', {})
        elif 'cone' in key or '3_cone' in key:
            target_milestones = DRILL_MILESTONES.get('three_cone', {})
        elif 'shuttle' in key:
            target_milestones = DRILL_MILESTONES.get('short_shuttle', {})
        else:
            target_milestones = DRILL_MILESTONES.get(key, {})
    elif isinstance(milestones, dict):
        target_milestones = milestones
    elif isinstance(milestones, (list, tuple)):
        target_milestones = {f"{dist:.1f} yd Split": float(dist) for dist in milestones}
    elif milestones is None:
        if d_common >= 38.0:
            target_milestones = DRILL_MILESTONES["forty_yard_dash"]
        elif d_common >= 28.0:
            target_milestones = DRILL_MILESTONES["three_cone"]
        elif d_common >= 18.0:
            target_milestones = DRILL_MILESTONES["short_shuttle"]
        else:
            target_milestones = {
                f"{d} yd": float(d) for d in range(5, int(d_common) + 1, 5)
            }

    d_a = np.array(traj_a.distances, dtype=np.float64)
    t_a = np.array(traj_a.times, dtype=np.float64)
    s_a = np.array(traj_a.speeds, dtype=np.float64)

    d_b = np.array(traj_b.distances, dtype=np.float64)
    t_b = np.array(traj_b.times, dtype=np.float64)
    s_b = np.array(traj_b.speeds, dtype=np.float64)

    d_a_strict = _prepare_strictly_increasing_d(d_a)
    d_b_strict = _prepare_strictly_increasing_d(d_b)

    results: list[MilestoneDelta] = []
    for name, mark in sorted(target_milestones.items(), key=lambda item: item[1]):
        # Allow 0.25 yd numerical tolerance for track finish line sampling (e.g. 39.95 yd for 40 yd)
        effective_mark = min(mark, d_common) if mark <= d_common + 0.25 else mark
        if effective_mark <= d_common:
            time_a = float(np.interp(effective_mark, d_a_strict, t_a))
            time_b = float(np.interp(effective_mark, d_b_strict, t_b))
            speed_a = float(np.interp(effective_mark, d_a_strict, s_a))
            speed_b = float(np.interp(effective_mark, d_b_strict, s_b))
            dt = time_a - time_b
            ds = speed_a - speed_b

            results.append(
                MilestoneDelta(
                    name=name,
                    distance=round(effective_mark, 2),
                    time_a=round(time_a, 4),
                    time_b=round(time_b, 4),
                    delta_time=round(dt, 4),
                    speed_a=round(speed_a, 2),
                    speed_b=round(speed_b, 2),
                    delta_speed=round(ds, 2),
                )
            )
    return results


def detect_apex_points(
    trajectory: Any,
    min_curvature: float = 0.10,
    distance_window_yards: float = 2.0,
    trajectory_id: str = "A",
) -> list[ApexPoint]:
    """Identify corner apex points (local maxima in curvature kappa)."""
    if isinstance(trajectory, SpatialTrajectory):
        st = trajectory
    else:
        st = resample_trajectory_spatial(trajectory, step_yards=0.25)

    if len(st.points) < 3:
        return []

    pts = st.points
    curvatures = np.array([p.curvature for p in pts], dtype=np.float64)
    distances = np.array([p.distance for p in pts], dtype=np.float64)

    candidate_indices: list[int] = []
    for i in range(1, len(curvatures) - 1):
        c = curvatures[i]
        if c >= min_curvature and c >= curvatures[i - 1] and c >= curvatures[i + 1]:
            candidate_indices.append(i)

    if not candidate_indices:
        return []

    candidate_indices.sort(key=lambda idx: curvatures[idx], reverse=True)
    filtered_indices: list[int] = []

    for idx in candidate_indices:
        d_val = distances[idx]
        too_close = False
        for chosen in filtered_indices:
            if abs(distances[chosen] - d_val) < distance_window_yards:
                too_close = True
                break
        if not too_close:
            filtered_indices.append(idx)

    filtered_indices.sort(key=lambda idx: distances[idx])

    apexes: list[ApexPoint] = []
    for idx in filtered_indices:
        p = pts[idx]
        exit_pts = [pt.a for pt in pts[idx + 1 : min(len(pts), idx + 6)]]
        exit_tr = float(np.mean(exit_pts)) if exit_pts else float(p.a)
        g_c = p.g_comb if getattr(p, "g_comb", None) is not None else float(math.sqrt(p.a**2 + (p.s**2 * p.curvature)**2) / 10.7247)
        apexes.append(
            ApexPoint(
                trajectory_id=trajectory_id,
                distance=round(p.distance, 2),
                x=round(p.x, 2),
                y=round(p.y, 2),
                curvature=round(p.curvature, 4),
                speed=round(p.s, 2),
                v_apex=round(p.s, 2),
                apex_speed=round(p.s, 2),
                time=round(p.time, 4),
                heading=round(p.dir, 2),
                beta_slip=round(p.beta_slip, 2) if p.beta_slip is not None else None,
                exit_traction=round(exit_tr, 2),
                g_comb=round(g_c, 2),
            )
        )
    return apexes


# -----------------------------------------------------------------------------
# Full Delta Comparison Orchestrator
# -----------------------------------------------------------------------------
def compare_trajectories_spatial(
    traj_a: Any,
    traj_b: Any,
    step_yards: float = 0.5,
    sector_size_yards: float = 5.0,
    milestones: list[float] | dict[str, float] | str | None = None,
    include_trajectories: bool = True,
) -> SpatialDeltaComparison:
    """Perform Formula 1-style spatial resampling and delta comparison between Trajectories A and B.

    - Resamples both on common grid up to min(d_max,A, d_max,B)
    - Computes Delta t(d) = t_A(d) - t_B(d) (negative = A is faster, positive = B is faster)
    - Computes Delta s(d) = s_A(d) - s_B(d)
    - Mini-sectors breakdown with sector winners and speed differentials
    - Drill milestone evaluations (10yd, 20yd, 40yd splits)
    - Apex detection on turn corners
    """
    st_a = traj_a if isinstance(traj_a, SpatialTrajectory) else resample_trajectory_spatial(traj_a, step_yards=step_yards)
    st_b = traj_b if isinstance(traj_b, SpatialTrajectory) else resample_trajectory_spatial(traj_b, step_yards=step_yards)

    d_common = min(st_a.total_distance, st_b.total_distance)
    if d_common <= 0.0:
        return SpatialDeltaComparison(
            common_max_distance=0.0,
            step_yards=step_yards,
            grid_distance=[0.0],
            delta_time=[0.0],
            delta_speed=[0.0],
            times_a=[0.0],
            times_b=[0.0],
            speeds_a=[0.0],
            speeds_b=[0.0],
        )

    grid_d = generate_distance_grid(d_common, step=step_yards, include_endpoint=True)

    d_a = np.array(st_a.distances, dtype=np.float64)
    t_a = np.array(st_a.times, dtype=np.float64)
    s_a = np.array(st_a.speeds, dtype=np.float64)

    d_b = np.array(st_b.distances, dtype=np.float64)
    t_b = np.array(st_b.times, dtype=np.float64)
    s_b = np.array(st_b.speeds, dtype=np.float64)

    d_a_strict = _prepare_strictly_increasing_d(d_a)
    d_b_strict = _prepare_strictly_increasing_d(d_b)

    times_a_grid = np.interp(grid_d, d_a_strict, t_a)
    times_b_grid = np.interp(grid_d, d_b_strict, t_b)
    speeds_a_grid = np.interp(grid_d, d_a_strict, s_a)
    speeds_b_grid = np.interp(grid_d, d_b_strict, s_b)

    delta_t = times_a_grid - times_b_grid
    delta_s = speeds_a_grid - speeds_b_grid

    sectors = compute_mini_sectors(st_a, st_b, sector_size_yards=sector_size_yards)
    ms_deltas = evaluate_milestones(st_a, st_b, milestones=milestones)

    apexes_a = detect_apex_points(st_a, trajectory_id="A")
    apexes_b = detect_apex_points(st_b, trajectory_id="B")

    from src.web.kinematics import compute_overlap_index

    # Compute Trajectory A metrics
    a_t_a = [p.a for p in st_a.points]
    a_lat_a = [p.a_lat or 0.0 for p in st_a.points]
    s_a_list = [p.s for p in st_a.points]
    overlap_a = compute_overlap_index(a_t_a, a_lat_a, s_a_list)
    g_max_a = max((p.g_comb or 0.0 for p in st_a.points), default=0.0)
    exit_a = float(np.mean([a.exit_traction for a in apexes_a if a.exit_traction is not None])) if apexes_a else 0.0
    key_v_a = max((a.speed for a in apexes_a), default=0.0)

    # Compute Trajectory B metrics
    a_t_b = [p.a for p in st_b.points]
    a_lat_b = [p.a_lat or 0.0 for p in st_b.points]
    s_b_list = [p.s for p in st_b.points]
    overlap_b = compute_overlap_index(a_t_b, a_lat_b, s_b_list)
    g_max_b = max((p.g_comb or 0.0 for p in st_b.points), default=0.0)
    exit_b = float(np.mean([a.exit_traction for a in apexes_b if a.exit_traction is not None])) if apexes_b else 0.0
    key_v_b = max((a.speed for a in apexes_b), default=0.0)

    return SpatialDeltaComparison(
        common_max_distance=round(d_common, 4),
        step_yards=step_yards,
        grid_distance=[round(float(d), 4) for d in grid_d],
        delta_time=[round(float(dt), 4) for dt in delta_t],
        delta_speed=[round(float(ds), 4) for ds in delta_s],
        times_a=[round(float(t), 4) for t in times_a_grid],
        times_b=[round(float(t), 4) for t in times_b_grid],
        speeds_a=[round(float(s), 4) for s in speeds_a_grid],
        speeds_b=[round(float(s), 4) for s in speeds_b_grid],
        mini_sectors=sectors,
        milestones=ms_deltas,
        apexes_a=apexes_a,
        apexes_b=apexes_b,
        resampled_a=st_a if include_trajectories else None,
        resampled_b=st_b if include_trajectories else None,
        overlap_index_a=round(overlap_a, 4),
        overlap_index_b=round(overlap_b, 4),
        g_comb_max_a=round(g_max_a, 2),
        g_comb_max_b=round(g_max_b, 2),
        exit_traction_a=round(exit_a, 2),
        exit_traction_b=round(exit_b, 2),
        key_apex_speed_a=round(key_v_a, 2),
        key_apex_speed_b=round(key_v_b, 2),
    )

# -----------------------------------------------------------------------------
# Module-level Cache for Position Average Trajectories
# -----------------------------------------------------------------------------
_POS_AVG_CACHE: dict[tuple[str, str, float], dict[str, Any]] = {}


# -----------------------------------------------------------------------------
# Position Average Trajectory Helper
# -----------------------------------------------------------------------------
def compute_position_average_trajectory(
    registry: Any,
    pos: str,
    drill_name: str,
    step: float = 0.5,
) -> dict[str, Any]:
    """Compute synthetic position-average trajectory for a combine drill.

    Encapsulates position-average spatial resampling logic:
    - Filters players by position (if specified)
    - Locates matching combine drills for `drill_name`
    - Spatially resamples matching trajectories on uniform grid `step`
    - Evaluates minimum common distance
    - Linearly interpolates times, speeds, accelerations, lateral accelerations,
      and combined accelerations onto common distance grid
    - Ensures each SpatialResampledPoint in the averaged trajectory populates
      a_lat, a_comb, and g_comb = round(float(a_comb / 10.7247), 3)
    - Computes speeds_std, times_std, speeds_p25, speeds_p75
    - Caches results in _POS_AVG_CACHE
    - Raises LookupError if matching_trajectories is empty.
    """
    pos_clean = (pos or "").strip().upper()
    drill_clean = (drill_name or "FORTY_YARD_DASH").strip().upper()
    step_val = float(step) if step > 0 else 0.5

    cache_key = (pos_clean, drill_clean, round(float(step_val), 4))
    if cache_key in _POS_AVG_CACHE:
        return _POS_AVG_CACHE[cache_key]

    players = getattr(registry, "_players_list", None)
    if players is None and hasattr(registry, "get_players"):
        players = registry.get_players()
    if players is None:
        players = []

    matching_trajectories: list[SpatialTrajectory] = []
    sample_players: list[str] = []

    for p in players:
        p_pos = getattr(p, "position", "") or getattr(p, "nfl_position", "") or ""
        if pos_clean and p_pos.upper() != pos_clean:
            continue
        drills = registry.get_combine_drills_list(p.nfl_id)
        matching = [d for d in drills if drill_clean in d.get("drill_name", "").upper()]
        if matching:
            try:
                data = registry.load_combine_drill(p.nfl_id, matching[0]["event_id"])
                frames = data.get("player_frames", [])
                if len(frames) > 5:
                    st = resample_trajectory_spatial(frames, step_yards=step_val)
                    if st.total_distance > 5.0:
                        matching_trajectories.append(st)
                        sample_players.append(getattr(p, "display_name", str(p.nfl_id)))
            except Exception:
                continue

    if not matching_trajectories:
        raise LookupError(f"No combine data found for position {pos} and drill {drill_name}")

    min_dist = min(t.total_distance for t in matching_trajectories)
    grid_d = generate_distance_grid(min_dist, step=step_val, include_endpoint=True)

    times_matrix: list[np.ndarray] = []
    speeds_matrix: list[np.ndarray] = []
    accels_matrix: list[np.ndarray] = []
    a_lats_matrix: list[np.ndarray] = []
    a_combs_matrix: list[np.ndarray] = []

    for t in matching_trajectories:
        d_arr = np.array(t.distances, dtype=np.float64)
        d_strict = _prepare_strictly_increasing_d(d_arr)
        times_matrix.append(np.interp(grid_d, d_strict, t.times))
        speeds_matrix.append(np.interp(grid_d, d_strict, t.speeds))
        accel_arr = np.array([pt.a for pt in t.points], dtype=np.float64)
        accels_matrix.append(np.interp(grid_d, d_strict, accel_arr))
        a_lat_arr = np.array([pt.a_lat if pt.a_lat is not None else 0.0 for pt in t.points], dtype=np.float64)
        a_lats_matrix.append(np.interp(grid_d, d_strict, a_lat_arr))
        a_comb_arr = np.array([pt.a_comb if pt.a_comb is not None else abs(pt.a) for pt in t.points], dtype=np.float64)
        a_combs_matrix.append(np.interp(grid_d, d_strict, a_comb_arr))

    avg_times = np.mean(times_matrix, axis=0)
    avg_speeds = np.mean(speeds_matrix, axis=0)
    avg_accels = np.mean(accels_matrix, axis=0)
    avg_a_lats = np.mean(a_lats_matrix, axis=0)
    avg_a_combs = np.mean(a_combs_matrix, axis=0)

    points: list[SpatialResampledPoint] = []
    for d, t_val, s_val, a_val, al_val, ac_val in zip(
        grid_d, avg_times, avg_speeds, avg_accels, avg_a_lats, avg_a_combs
    ):
        a_round = round(float(a_val), 2)
        a_lat_round = round(float(al_val), 2)
        a_comb_round = round(float(ac_val), 2)
        if a_comb_round == 0.0 and a_round != 0.0:
            a_comb_round = round(abs(a_round), 2)
        g_comb_val = round(float(a_comb_round / 10.7247), 3)

        pt = SpatialResampledPoint(
            distance=round(float(d), 4),
            time=round(float(t_val), 4),
            x=round(float(d), 2),
            y=0.0,
            s=round(float(s_val), 2),
            a=a_round,
            dir=0.0,
            o=0.0,
            curvature=0.0,
            kappa=0.0,
            beta_slip=0.0,
            beta_rate=0.0,
            jerk=0.0,
            a_lat=a_lat_round,
            a_comb=a_comb_round,
            g_comb=g_comb_val,
        )
        points.append(pt)

    avg_traj = SpatialTrajectory(
        total_distance=round(float(min_dist), 4),
        total_time=round(float(avg_times[-1]), 4),
        step_yards=step_val,
        point_count=len(points),
        points=points,
    )

    result: dict[str, Any] = {
        "position": pos_clean or "ALL",
        "drill_name": drill_clean,
        "sample_size": len(matching_trajectories),
        "trajectory": avg_traj.model_dump(),
        "speeds_std": [round(float(x), 3) for x in np.std(speeds_matrix, axis=0)],
        "times_std": [round(float(x), 4) for x in np.std(times_matrix, axis=0)],
        "speeds_p25": [round(float(x), 2) for x in np.percentile(speeds_matrix, 25, axis=0)],
        "speeds_p75": [round(float(x), 2) for x in np.percentile(speeds_matrix, 75, axis=0)],
    }

    players_list = getattr(registry, "_players_list", None)
    if players_list and len(players_list) > 0:
        _POS_AVG_CACHE[cache_key] = result

    return result

