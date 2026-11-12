"""Kinematics calculation engine and Polars vectorization for tracking telemetry.

Canonical mathematical formulas for:
- Unwrapped angular velocity (omega) in deg/s
- Trajectory curvature (kappa) in 1/yd with singularity cutoff (s < 0.2 yd/s)
- Biomechanical slip angle (beta_slip) in degrees [-180, 180]
- Velocity vector decomposition into NGS compass coordinates
"""

from __future__ import annotations

from typing import Any

import math

import polars as pl


def unwrap_angle_diff(deg_t: float, deg_prev: float) -> float:
    """Compute minimal angular difference in degrees in [-180.0, 180.0]."""
    return ((deg_t - deg_prev + 180.0) % 360.0) - 180.0


def compute_angular_velocity(
    theta_curr_or_delta: float,
    theta_prev: float | None = None,
    dt: float = 0.1,
    *,
    delta_deg: float | None = None,
) -> float:
    """Compute angular velocity in degrees/second.

    Supports both:
    - compute_angular_velocity(theta_curr, theta_prev, dt=0.1)
    - compute_angular_velocity(delta_deg, dt=0.1)
    """
    if delta_deg is not None:
        return abs(delta_deg) / dt
    if theta_prev is not None:
        delta = unwrap_angle_diff(theta_curr_or_delta, theta_prev)
        return abs(delta) / dt
    return abs(theta_curr_or_delta) / dt


def compute_curvature(
    speed: float | None = None,
    omega_deg_s: float | None = None,
    singularity_threshold: float = 0.2,
    *,
    omega_deg: float | None = None,
    s: float | None = None,
    threshold: float | None = None,
    dt: float = 0.1,
) -> float:
    """Compute trajectory curvature kappa in 1/yd. Returns 0.0 if speed < singularity_threshold."""
    eff_threshold = threshold if threshold is not None else singularity_threshold
    eff_speed = speed if speed is not None else s
    eff_omega = omega_deg_s if omega_deg_s is not None else omega_deg

    if eff_speed is None or eff_omega is None:
        return 0.0
    if eff_speed < eff_threshold or abs(eff_speed) < 1e-9:
        return 0.0

    omega_rad_s = eff_omega * (math.pi / 180.0)
    return omega_rad_s / eff_speed


def compute_slip_angle(motion_dir: float, body_orientation: float) -> float:
    """Compute slip angle beta_slip = ((dir - o + 180) % 360) - 180 in [-180.0, 180.0]."""
    return ((motion_dir - body_orientation + 180.0) % 360.0) - 180.0


def compute_beta_rate(beta_curr: float | None, beta_prev: float | None, dt: float = 0.1) -> float:
    """Compute time derivative of sideslip angle dbeta/dt in degrees/second."""
    if beta_curr is None or beta_prev is None:
        return 0.0
    delta = unwrap_angle_diff(beta_curr, beta_prev)
    return delta / dt


def compute_jerk(a_curr: float | None, a_prev: float | None, dt: float = 0.1) -> float:
    """Compute 1D acceleration jerk da/dt in yards/second^3."""
    if a_curr is None or a_prev is None:
        return 0.0
    return (a_curr - a_prev) / dt


def detect_snap_oversteer(
    speed: float,
    beta_rate: float,
    jerk: float,
    speed_threshold: float = 1.0,
    beta_rate_threshold: float = 100.0,
    jerk_threshold: float = 6.0,
) -> bool:
    """Detect 'Snap Oversteer' (sudden loss of balance/cut displacement).

    Triggered when the player is moving at speed (speed >= 1.0 yd/s), and experiences
    a violent concurrent spike in sideslip angle rate (|beta_dot| >= 100 deg/s)
    and acceleration jerk (|j| >= 6.0 yd/s^3).
    """
    return (
        speed >= speed_threshold
        and abs(beta_rate) >= beta_rate_threshold
        and abs(jerk) >= jerk_threshold
    )


def classify_dynamics_state(
    speed: float,
    beta: float | None,
    beta_rate: float | None = None,
    jerk: float | None = None,
    is_snap: bool = False,
) -> str:
    """Classify biomechanical/vehicle-dynamics body state.

    Categories:
    - 'SNAP_OVERSTEER': Violent simultaneous spike in beta_dot and jerk (loss of balance).
    - 'STATIONARY': Speed < 0.5 yd/s.
    - 'ON_RAILS': Beta approx 0 deg (|beta| <= 10 deg) - heading aligned with body ('sínen fut').
    - 'CONTROLLED_DRIFT': Controlled lateral offset (|beta| 10..45 deg) with smooth slip rate.
    - 'LATERAL_BACKPEDAL': High slip angle (|beta| > 45 deg, e.g. backpedal or lateral shuffle).
    """
    if is_snap or (
        beta_rate is not None
        and jerk is not None
        and detect_snap_oversteer(speed, beta_rate, jerk)
    ):
        return "SNAP_OVERSTEER"
    if speed < 0.5:
        return "STATIONARY"
    if beta is None:
        return "ON_RAILS"
    abs_b = abs(beta)
    if abs_b <= 10.0:
        return "ON_RAILS"
    if abs_b <= 45.0:
        return "CONTROLLED_DRIFT"
    return "LATERAL_BACKPEDAL"


G_CONST_YD: float = 10.7247  # 1 g in yd/s^2 (9.80665 m/s^2 * 1.09361 yd/m)


def compute_combined_g_force(
    a_tangential: float | None,
    speed: float | None,
    omega_deg_s: float | None,
    g_const: float = G_CONST_YD,
) -> tuple[float, float]:
    """Compute Combined Acceleration (a_comb in yd/s^2) and G-Force (g_comb in g).

    Formula:
    a_lat = speed * (omega_deg_s * pi / 180.0)
    a_comb = sqrt(a_t^2 + a_lat^2) = sqrt(a_t^2 + (s * omega)^2)
    g_comb = a_comb / 10.7247
    """
    a_t = a_tangential if a_tangential is not None and not math.isnan(a_tangential) else 0.0
    s = speed if speed is not None and not math.isnan(speed) and speed > 0.0 else 0.0
    om = omega_deg_s if omega_deg_s is not None and not math.isnan(omega_deg_s) else 0.0

    omega_rad = om * (math.pi / 180.0)
    a_lat = s * omega_rad
    a_comb = math.sqrt(a_t**2 + a_lat**2)
    g_comb = a_comb / g_const
    return (round(a_comb, 4), round(g_comb, 4))


def compute_overlap_index(
    a_tangential: list[float] | Any,
    a_lateral: list[float] | Any,
    speeds: list[float] | Any | None = None,
    min_speed_threshold: float = 0.5,
    percentile: float = 70.0,
) -> float:
    """Compute Trail-Braking / Overlap Index (Fázis-átfedési Mutató).

    Definition:
    Fraction of active motion frames (speed >= min_speed_threshold) where both
    tangential acceleration |a_t| and lateral acceleration |a_lat| simultaneously
    exceed their respective 70th percentiles:
    |a_t| > P_70(|a|) AND |a_lat| > P_70(|a_lat|).

    Returns:
    Float in [0.0, 1.0] representing the phase overlap ratio.
    """
    import numpy as np

    a_t_arr = np.array(a_tangential, dtype=np.float64)
    a_lat_arr = np.array(a_lateral, dtype=np.float64)

    if len(a_t_arr) == 0 or len(a_lat_arr) == 0:
        return 0.0

    n_pts = min(len(a_t_arr), len(a_lat_arr))
    a_t_arr = a_t_arr[:n_pts]
    a_lat_arr = a_lat_arr[:n_pts]

    # Filter active motion frames if speeds provided
    if speeds is not None:
        s_arr = np.array(speeds, dtype=np.float64)[:n_pts]
        valid_mask = s_arr >= min_speed_threshold
        if np.sum(valid_mask) >= 5:
            a_t_arr = a_t_arr[valid_mask]
            a_lat_arr = a_lat_arr[valid_mask]

    if len(a_t_arr) < 3:
        return 0.0

    abs_a_t = np.abs(a_t_arr)
    abs_a_lat = np.abs(a_lat_arr)

    p_a = float(np.percentile(abs_a_t, percentile))
    p_lat = float(np.percentile(abs_a_lat, percentile))

    # Condition: |a_t| > P_70(|a|) AND |a_lat| > P_70(|a_lat|)
    overlap_count = int(np.sum((abs_a_t > p_a) & (abs_a_lat > p_lat)))
    return round(float(overlap_count / len(a_t_arr)), 4)


def compute_apex_metrics(
    speeds: list[float] | Any,
    curvatures: list[float] | Any,
    accelerations: list[float] | Any,
    dt: float = 0.1,
    min_curvature: float = 0.10,
    exit_window_sec: float = 0.5,
) -> list[dict[str, Any]]:
    """Compute Apex Speed (v_apex) and Corner Exit Traction across curvature peaks.

    - v_apex: Speed at the curvature maximum frame t*
    - Corner Exit Traction: Mean tangential acceleration over exit_window_sec (default 5 frames = 0.5s) after t*
    """
    import numpy as np

    s_arr = np.array(speeds, dtype=np.float64)
    k_arr = np.array(curvatures, dtype=np.float64)
    a_arr = np.array(accelerations, dtype=np.float64)

    n = min(len(s_arr), len(k_arr), len(a_arr))
    if n < 3:
        return []

    s_arr, k_arr, a_arr = s_arr[:n], k_arr[:n], a_arr[:n]
    exit_frames = max(1, int(round(exit_window_sec / dt)))

    apexes: list[dict[str, Any]] = []
    for i in range(1, n - 1):
        c = k_arr[i]
        if c >= min_curvature and c >= k_arr[i - 1] and c >= k_arr[i + 1]:
            v_apex = float(s_arr[i])
            # Corner exit traction: mean acceleration in the next exit_frames frames
            exit_slice = a_arr[i + 1 : min(n, i + 1 + exit_frames)]
            exit_traction = float(np.mean(exit_slice)) if len(exit_slice) > 0 else float(a_arr[i])

            apexes.append({
                "frame_index": i,
                "time": round(i * dt, 2),
                "curvature": round(float(c), 4),
                "v_apex": round(v_apex, 2),
                "apex_speed": round(v_apex, 2),
                "exit_traction": round(exit_traction, 2),
            })
    return apexes


def decompose_velocity(speed: float, motion_dir: float) -> tuple[float, float]:
    """Decompose speed and compass heading (0=N, 90=E) into (vx, vy)."""
    rad = motion_dir * (math.pi / 180.0)
    vx = speed * math.sin(rad)
    vy = speed * math.cos(rad)
    return (vx, vy)


def compute_tracking_kinematics(
    df: pl.DataFrame,
    is_combine: bool = False,
    dt: float = 0.1,
    singularity_threshold: float = 0.2,
) -> pl.DataFrame:
    """Vectorized calculation of beta_slip, omega, and curvature across a trajectory DataFrame.

    Conforms to the F8 / F10 kinematics specification in PROJECT.md and tests/test_kinematics.py.
    """
    if df.height == 0:
        return df.with_columns([
            pl.lit(None, dtype=pl.Float64).alias("omega"),
            pl.lit(None, dtype=pl.Float64).alias("kappa"),
            pl.lit(None, dtype=pl.Float64).alias("curvature"),
            pl.lit(None, dtype=pl.Float64).alias("beta_slip"),
            pl.lit(None, dtype=pl.Float64).alias("slip_angle"),
            pl.lit(None, dtype=pl.Float64).alias("beta_rate"),
            pl.lit(None, dtype=pl.Float64).alias("slip_rate"),
            pl.lit(None, dtype=pl.Float64).alias("jerk"),
            pl.lit(False, dtype=pl.Boolean).alias("snap_oversteer"),
            pl.lit(None, dtype=pl.Utf8).alias("dynamics_state"),
            pl.lit(None, dtype=pl.Float64).alias("a_lat"),
            pl.lit(None, dtype=pl.Float64).alias("a_comb"),
            pl.lit(None, dtype=pl.Float64).alias("g_comb"),
            pl.lit(None, dtype=pl.Float64).alias("g_lat"),
            pl.lit(None, dtype=pl.Float64).alias("g_t"),
        ])

    exprs: list[pl.Expr] = []

    # 1. Slip angle beta_slip
    if not is_combine and "o" in df.columns and "dir" in df.columns:
        exprs.append(
            pl.when(pl.col("o").is_not_null() & pl.col("dir").is_not_null())
            .then(((pl.col("dir") - pl.col("o") + 180.0) % 360.0) - 180.0)
            .otherwise(None)
            .alias("beta_slip")
        )
    else:
        exprs.append(pl.lit(None, dtype=pl.Float64).alias("beta_slip"))

    # 2. Unwrapped angular difference delta_dir
    if "dir" in df.columns:
        exprs.append(
            (((pl.col("dir") - pl.col("dir").shift(1) + 180.0) % 360.0) - 180.0).alias("_delta_dir")
        )
    else:
        exprs.append(pl.lit(None, dtype=pl.Float64).alias("_delta_dir"))

    res = df.with_columns(exprs)

    # 3. Unwrapped angular velocity omega in deg/s
    res = res.with_columns([
        pl.when(pl.col("_delta_dir").is_null())
        .then(0.0)
        .otherwise(pl.col("_delta_dir").abs() / dt)
        .alias("omega")
    ])

    # 4. Trajectory curvature kappa in 1/yd with singularity cutoff
    if "s" in res.columns:
        res = res.with_columns([
            pl.when((pl.col("s") >= singularity_threshold) & (pl.col("s").abs() > 1e-9))
            .then((pl.col("omega") * (math.pi / 180.0)) / pl.col("s"))
            .otherwise(0.0)
            .alias("kappa")
        ])
    else:
        res = res.with_columns([pl.lit(0.0).alias("kappa")])

    # Provide curvature and slip_angle aliases
    res = res.with_columns([
        pl.col("kappa").alias("curvature"),
        pl.col("beta_slip").alias("slip_angle"),
    ])

    # 5. Unwrapped sideslip angle rate beta_rate (dbeta/dt) in deg/s
    if "beta_slip" in res.columns:
        res = res.with_columns([
            (((pl.col("beta_slip") - pl.col("beta_slip").shift(1) + 180.0) % 360.0) - 180.0).alias("_delta_beta")
        ])
        res = res.with_columns([
            pl.when(pl.col("_delta_beta").is_null())
            .then(0.0)
            .otherwise(pl.col("_delta_beta") / dt)
            .alias("beta_rate"),
            pl.when(pl.col("_delta_beta").is_null())
            .then(0.0)
            .otherwise(pl.col("_delta_beta") / dt)
            .alias("slip_rate"),
        ]).drop("_delta_beta")
    else:
        res = res.with_columns([
            pl.lit(None, dtype=pl.Float64).alias("beta_rate"),
            pl.lit(None, dtype=pl.Float64).alias("slip_rate"),
        ])

    # 6. Jerk (da/dt) in yd/s^3
    if "a" in res.columns:
        res = res.with_columns([
            pl.when(pl.col("a").shift(1).is_null())
            .then(0.0)
            .otherwise((pl.col("a") - pl.col("a").shift(1)) / dt)
            .alias("jerk")
        ])
    else:
        res = res.with_columns([pl.lit(0.0).alias("jerk")])

    # 7. Snap Oversteer Detection & Vehicle Dynamics Classification
    if "s" in res.columns and "beta_rate" in res.columns and "jerk" in res.columns and "beta_slip" in res.columns:
        is_snap = (
            (pl.col("s") >= 1.0)
            & (pl.col("beta_rate").abs() >= 100.0)
            & (pl.col("jerk").abs() >= 6.0)
            & pl.col("beta_slip").is_not_null()
        )
        res = res.with_columns([
            is_snap.fill_null(False).alias("snap_oversteer")
        ])
        res = res.with_columns([
            pl.when(pl.col("snap_oversteer") == True)
            .then(pl.lit("SNAP_OVERSTEER"))
            .when(pl.col("s") < 0.5)
            .then(pl.lit("STATIONARY"))
            .when(pl.col("beta_slip").is_null())
            .then(pl.lit("ON_RAILS"))
            .when(pl.col("beta_slip").abs() <= 10.0)
            .then(pl.lit("ON_RAILS"))
            .when(pl.col("beta_slip").abs() <= 45.0)
            .then(pl.lit("CONTROLLED_DRIFT"))
            .otherwise(pl.lit("LATERAL_BACKPEDAL"))
            .alias("dynamics_state")
        ])
    else:
        res = res.with_columns([
            pl.lit(False).alias("snap_oversteer"),
            pl.lit("STATIONARY").alias("dynamics_state"),
        ])

    # 8. Combined Acceleration & G-Force (sqrt(a^2 + (s * omega)^2))
    G_CONST = 10.7247  # yd/s^2 (1 g = 9.80665 m/s^2 = 10.7247 yd/s^2)
    if "s" in res.columns and "_delta_dir" in res.columns:
        res = res.with_columns([
            pl.when(pl.col("_delta_dir").is_null())
            .then(0.0)
            .otherwise(pl.col("s").fill_null(0.0) * ((pl.col("_delta_dir") / dt) * (math.pi / 180.0)))
            .alias("a_lat")
        ])
    elif "s" in res.columns and "omega" in res.columns:
        res = res.with_columns([
            (pl.col("s").fill_null(0.0) * (pl.col("omega").fill_null(0.0) * (math.pi / 180.0))).alias("a_lat")
        ])
    else:
        res = res.with_columns([pl.lit(0.0).alias("a_lat")])

    if "a" in res.columns:
        if "s" in res.columns:
            signed_a = (
                pl.when(pl.col("s").shift(1).is_not_null() & (pl.col("s") < pl.col("s").shift(1)))
                .then(-pl.col("a").abs())
                .otherwise(pl.col("a"))
            )
        else:
            signed_a = pl.col("a")

        res = res.with_columns([
            (pl.col("a").fill_null(0.0).pow(2) + pl.col("a_lat").pow(2)).sqrt().alias("a_comb"),
            (signed_a.fill_null(0.0) / G_CONST).alias("g_t"),
        ])
    else:
        res = res.with_columns([
            pl.col("a_lat").abs().alias("a_comb"),
            pl.lit(0.0).alias("g_t"),
        ])

    res = res.with_columns([
        (pl.col("a_lat") / G_CONST).alias("g_lat"),
        (pl.col("a_comb") / G_CONST).alias("g_comb"),
    ])

    return res.drop("_delta_dir")
