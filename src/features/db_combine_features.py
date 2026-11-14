"""Phase 6A: Lab Combine Biomechanical Feature Engineering for Defensive Backs.

Extracts mathematically documented 10 Hz optical tracking features across all 122
Defensive Back (`combine_position == 'DB'`) prospects from `combine_tracking.parquet`,
`combine_results.parquet`, and `players.parquet`.

Every feature transformation adheres to AGENT.md Phase 6 documentation requirements:
- Mathematical definition
- Input columns
- Units
- Temporal window
- Edge handling
- Missing-value behavior
- Leakage risk

Outputs:
- `data/interim/db_combine_drill_episodes.parquet`: Episode-level (`event_id`) kinematics
- `data/processed/db_combine_features.parquet`: Subject-level (`nfl_id`, N=122) features
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import polars as pl
from sklearn.preprocessing import StandardScaler

from src.web.kinematics import (
    G_CONST_YD,
    compute_apex_metrics,
    compute_overlap_index,
)

# Drill category sets for DB position skill drills
BACKPEDAL_BREAK_DRILLS: frozenset[str] = frozenset({
    "BACK_PEDAL_AND_TRANSITION_45_DEGREE_REACTION",
    "BACK_PEDAL_AND_90_DEGREE_BREAK_TO_BALL",
})

MULTICUT_AGILITY_DRILLS: frozenset[str] = frozenset({
    "W_DRILL",
    "BOX_DRILL",
})

PURSUIT_BALLHAWKING_DRILLS: frozenset[str] = frozenset({
    "GAUNTLET_DRILL",
    "TERYL_AUSTIN_DRILL_1",
    "TERYL_AUSTIN_DRILL_2",
    "LINE_DRILL",
    "LINE",
})

HFBI_COMPONENT_COLS: tuple[str, ...] = (
    "omega_break",
    "tau_trans",
    "a_exit",
    "asr_w_box",
    "overlap_70",
    "g_comb_95",
)


def compute_combine_frame_kinematics(
    df: pl.DataFrame | pl.LazyFrame,
    dt: float = 0.1,
    singularity_threshold: float = 0.2,
    g_const: float = G_CONST_YD,
) -> pl.DataFrame:
    """Compute frame-level trajectory kinematics across Combine drill events.

    Mathematical Definition:
        - Unwrapped heading difference:
          $\\Delta \\theta_t = ((\\text{dir}_t - \\text{dir}_{t-1} + 180^\\circ) \\bmod 360^\\circ) - 180^\\circ$
        - Unwrapped angular velocity:
          $\\omega_t = |\\Delta \\theta_t| / \\Delta t$
        - Trajectory curvature (with singularity cutoff $s_t \\ge 0.2\\text{ yd/s}$):
          $\\kappa_t = \\frac{\\omega_t \\cdot (\\pi / 180^\\circ)}{s_t}$ if $s_t \\ge 0.2$, else $0.0$
        - Signed tangential acceleration:
          $a_{t,\\parallel} = -|a_t|$ if $s_t < s_{t-1}$ else $a_t$ (with fallback $\\Delta s_t / \\Delta t$)
        - Centripetal (lateral) acceleration:
          $a_{\\text{lat}, t} = s_t \\cdot \\left(\\omega_t \\cdot \\frac{\\pi}{180^\\circ}\\right)$
        - Combined G-force:
          $g_{\\text{comb}, t} = \\frac{\\sqrt{a_{t,\\parallel}^2 + a_{\\text{lat}, t}^2}}{10.7247}$
        - Tangential jerk:
          $j_t = (a_{t,\\parallel} - a_{t-1,\\parallel}) / \\Delta t$

    Input Columns:
        `event_id` (String), `time` (String/Float), `s` (Float64), `a` (Float64), `dir` (Float64).
    Units:
        `omega_t`: deg/s; `kappa_t`: 1/yd; `a_t`, `a_lat`: yd/s^2; `g_comb`: g; `j_t`: yd/s^3.
    Temporal Window:
        First-order backward finite difference ($\\Delta t = 0.1\\text{ s}$ at 10 Hz) partitioned by `event_id`.
    Edge Handling:
        First frame of each `event_id` has $\\Delta \\theta_0 = 0, \\omega_0 = 0, j_0 = 0$.
        Curvature $\\kappa_t$ is clamped to $0.0$ whenever $s_t < 0.2\\text{ yd/s}$.
    Missing-Value Behavior:
        Null speeds or directions are filled with $0.0$ on derived rate columns without dropping frames.
    Leakage Risk:
        None. Strictly within-episode (`event_id`) causal backward differences.
    """
    lf = df.lazy() if isinstance(df, pl.DataFrame) else df
    schema_names = set(lf.collect_schema().names())

    part_col = "event_id" if "event_id" in schema_names else None
    if part_col is not None and "time" in schema_names:
        lf = lf.sort([part_col, "time"])
    elif "time" in schema_names:
        lf = lf.sort("time")

    dir_shift = pl.col("dir").shift(1).over(part_col) if part_col else pl.col("dir").shift(1)
    s_shift = pl.col("s").shift(1).over(part_col) if part_col else pl.col("s").shift(1)

    delta_dir_expr = (
        pl.when(pl.col("dir").is_not_null() & dir_shift.is_not_null())
        .then(((pl.col("dir") - dir_shift + 180.0) % 360.0) - 180.0)
        .otherwise(0.0)
        .alias("delta_dir")
    )

    ds_dt_expr = (
        pl.when(pl.col("s").is_not_null() & s_shift.is_not_null())
        .then((pl.col("s") - s_shift) / dt)
        .otherwise(0.0)
        .alias("ds_dt")
    )

    lf = lf.with_columns([delta_dir_expr, ds_dt_expr])

    if "a" in schema_names:
        a_t_expr = (
            pl.when(pl.col("a") < 0.0)
            .then(pl.col("a"))
            .when(s_shift.is_not_null() & (pl.col("s") < s_shift))
            .then(-pl.col("a").abs())
            .otherwise(pl.col("a").fill_null(0.0))
            .alias("a_t")
        )
    else:
        a_t_expr = pl.col("ds_dt").alias("a_t")

    omega_expr = (pl.col("delta_dir").abs() / dt).alias("omega_t")
    lf = lf.with_columns([omega_expr, a_t_expr])

    at_shift = pl.col("a_t").shift(1).over(part_col) if part_col else pl.col("a_t").shift(1)

    lf = lf.with_columns([
        pl.col("omega_t").alias("omega"),
        pl.when(pl.col("s") >= singularity_threshold)
        .then((pl.col("omega_t") * (math.pi / 180.0)) / pl.col("s"))
        .otherwise(0.0)
        .alias("kappa_t"),
        (pl.col("s").fill_null(0.0) * (pl.col("omega_t") * (math.pi / 180.0))).alias("a_lat"),
        pl.when(at_shift.is_not_null())
        .then((pl.col("a_t") - at_shift) / dt)
        .otherwise(0.0)
        .alias("j_t"),
    ])

    lf = lf.with_columns([
        pl.col("kappa_t").alias("kappa"),
        pl.col("j_t").alias("jerk"),
        (pl.col("a_t").pow(2) + pl.col("a_lat").pow(2)).sqrt().alias("a_comb"),
    ])

    lf = lf.with_columns([
        (pl.col("a_comb") / g_const).alias("g_comb"),
    ])

    return lf.collect()


def compute_plant_to_drive_latency(
    accelerations: list[float] | np.ndarray,
    speeds: list[float] | np.ndarray | None = None,
    curvatures: list[float] | np.ndarray | None = None,
    dt: float = 0.1,
) -> dict[str, float | int]:
    """Compute Plant-to-Drive Transition Latency (tau_trans) from a break trajectory.

    Mathematical Definition:
        Let $t_{\\text{plant}} = \\arg\\min_t a_{t,\\parallel}$ be the frame of peak braking
        deceleration during the plant phase (or the braking minimum preceding the primary
        curvature apex). Let $t_{\\text{drive}} = \\min\\{t > t_{\\text{plant}} : a_{t,\\parallel} > 0\\}$
        be the first subsequent frame of positive forward re-acceleration. Then:
        $$\\tau_{\\text{trans}} = (t_{\\text{drive}} - t_{\\text{plant}}) \\cdot \\Delta t$$

    Input Columns:
        `accelerations` ($a_{t,\\parallel}$ in yd/s^2), optional `speeds` ($s_t$ in yd/s)
        and `curvatures` ($\\kappa_t$ in 1/yd).
    Units:
        `tau_trans`: seconds (s); `a_plant`: yd/s^2; `plant_idx`, `drive_idx`: frame indices.
    Temporal Window:
        Break transition window within a single drill episode ($\\Delta t = 0.1\\text{ s}$).
    Edge Handling:
        If the trajectory has $< 2$ frames or never transitions to $a_t > 0$ after $t_{\\text{plant}}$,
        falls back to the first local speed minimum or returns a bounded latency $\\ge \\Delta t$.
    Missing-Value Behavior:
        Non-finite values are replaced with $0.0$ prior to extremum search.
    Leakage Risk:
        None. Computed strictly within a single drill attempt (`event_id`).
    """
    a_arr = np.nan_to_num(np.asarray(accelerations, dtype=np.float64), nan=0.0)
    n = len(a_arr)
    if n < 2:
        return {
            "plant_idx": 0,
            "drive_idx": 0,
            "tau_trans": float(dt),
            "a_plant": float(a_arr[0]) if n == 1 else 0.0,
        }

    # Restrict plant search to the first 85% of the trajectory so end-of-drill stopping
    # deceleration after the finish line does not masquerade as the mid-drill break plant.
    search_end = max(2, round(0.85 * n)) if n > 20 else n
    plant_idx = int(np.argmin(a_arr[:search_end]))
    a_plant = float(a_arr[plant_idx])

    drive_candidates = [i for i in range(plant_idx + 1, n) if a_arr[i] > 0.0]
    if drive_candidates:
        drive_idx = int(drive_candidates[0])
    elif speeds is not None and len(speeds) == n:
        s_arr = np.nan_to_num(np.asarray(speeds, dtype=np.float64), nan=0.0)
        inc_candidates = [i for i in range(plant_idx + 1, n) if s_arr[i] > s_arr[i - 1]]
        drive_idx = int(inc_candidates[0]) if inc_candidates else min(n - 1, plant_idx + 1)
    else:
        drive_idx = min(n - 1, plant_idx + 1)

    tau_trans = max(dt, float((drive_idx - plant_idx) * dt))
    return {
        "plant_idx": plant_idx,
        "drive_idx": drive_idx,
        "tau_trans": round(tau_trans, 4),
        "a_plant": round(a_plant, 4),
    }


def extract_episode_kinematic_metrics(
    ep_df: pl.DataFrame,
    dt: float = 0.1,
) -> dict[str, Any]:
    """Extract comprehensive biomechanical transition metrics from a single Combine drill episode.

    Mathematical Definition:
        Extracts episode-level realizations of:
        - `v_bp`: Mean speed during the initial backpedal phase ($t \\in [0.15 T, 0.45 T], s_t \\ge 0.5$)
        - `a_plant`: Minimum tangential acceleration $\\min_t a_{t,\\parallel}$ during the break plant
        - `j_plant`: Peak jerk magnitude $\\max |j_t|$ within $\\pm 0.3\\text{ s}$ of $t_{\\text{plant}}$
        - `omega_break`: 95th-percentile / peak unwrapped angular turn rate ($\\text{deg/s}$) at $s_t \\ge 1.0\\text{ yd/s}$
        - `kappa_break`: 95th-percentile / peak curvature ($\\text{yd}^{-1}$) at $s_t \\ge 1.0\\text{ yd/s}$
        - `tau_trans`: Plant-to-drive transition latency ($s$)
        - `v_apex`: Speed at curvature apex ($\\text{yd/s}$)
        - `a_exit`: Mean tangential acceleration over $0.5\\text{ s}$ ($5$ frames) post-apex ($\\text{yd/s}^2$)
        - `asr_w_box`: Multi-apex speed retention ratio $v_{\\text{apex}} / v_{\\max}$
        - `overlap_70`: Trail-braking phase overlap fraction ($s_t \\ge 0.5, |a_t| > P_{70}, |a_{\\text{lat}}| > P_{70}$)
        - `g_comb_95`: 95th-percentile combined G-force ($g$) across active frames ($s_t \\ge 0.5$)
        - `v_max_drill`: Peak speed $\\max_t s_t$ ($\\text{yd/s}$)
        - `kappa_rms`: Root-mean-square path curvature $\\sqrt{\\frac{1}{N}\\sum \\kappa_t^2}$ at $s_t \\ge 1.0\\text{ yd/s}$

    Input Columns:
        Frame-level output of `compute_combine_frame_kinematics`.
    Units:
        Speeds in yd/s, accelerations in yd/s^2, jerk in yd/s^3, angular velocity in deg/s,
        curvature in 1/yd, latency in s, G-force in g, ratios unitless in [0, 1].
    Temporal Window:
        Full drill attempt (`event_id`, typically 3.5s to 10.0s at 10 Hz).
    Edge Handling:
        Gracefully handles short episodes or low-curvature drills by evaluating the global
        active curvature peak when no local peak exceeds `0.10 1/yd`.
    Missing-Value Behavior:
        Guaranteed finite float outputs for every non-empty drill episode.
    Leakage Risk:
        None. Computed strictly within a single drill episode (`event_id`).
    """
    s_arr = ep_df["s"].to_numpy()
    a_t_arr = ep_df["a_t"].to_numpy()
    a_raw_arr = ep_df["a"].to_numpy() if "a" in ep_df.columns else np.abs(a_t_arr)
    omega_arr = ep_df["omega_t"].to_numpy()
    kappa_arr = ep_df["kappa_t"].to_numpy()
    a_lat_arr = ep_df["a_lat"].to_numpy()
    g_comb_arr = ep_df["g_comb"].to_numpy()
    j_arr = ep_df["j_t"].to_numpy()

    n = len(s_arr)
    v_max = float(np.max(s_arr)) if n > 0 else 0.0
    v_p95 = float(np.percentile(s_arr, 95)) if n > 0 else 0.0

    active_05 = s_arr >= 0.5
    active_10 = s_arr >= 1.0
    active_15 = s_arr >= 1.5

    # 1. Backpedal speed v_bp (initial 15%..45% window of active frames prior to break)
    bp_start = max(1, int(0.10 * n))
    bp_end = max(bp_start + 2, int(0.45 * n))
    bp_slice = s_arr[bp_start:bp_end]
    bp_active = bp_slice[bp_slice >= 0.5]
    v_bp = float(np.mean(bp_active)) if len(bp_active) > 0 else float(np.mean(s_arr[active_05])) if np.any(active_05) else v_max

    # 2. Plant deceleration, plant jerk, and plant-to-drive latency
    # Use active mid-drill window (15%..85% of frames) so final drill slowdown after finish is excluded
    w_start = max(1, int(0.12 * n)) if n >= 15 else 0
    w_end = min(n, max(w_start + 5, int(0.85 * n))) if n >= 15 else n
    lat_info = compute_plant_to_drive_latency(
        accelerations=a_t_arr[w_start:w_end],
        speeds=s_arr[w_start:w_end],
        curvatures=kappa_arr[w_start:w_end],
        dt=dt,
    )
    plant_idx = int(lat_info["plant_idx"]) + w_start
    a_plant = float(lat_info["a_plant"])
    tau_trans = float(lat_info["tau_trans"])

    j_win_start = max(0, plant_idx - 3)
    j_win_end = min(n, plant_idx + 4)
    j_plant = float(np.max(np.abs(j_arr[j_win_start:j_win_end]))) if j_win_end > j_win_start else 0.0

    # 3. Break angular velocity omega_break & break curvature kappa_break on active cuts (s >= 1.2 yd/s)
    cut_mask = active_15 if np.sum(active_15) >= 5 else (active_10 if np.sum(active_10) >= 3 else active_05)
    if np.any(cut_mask):
        omega_break = float(np.percentile(omega_arr[cut_mask], 95))
        kappa_break = float(np.percentile(kappa_arr[cut_mask], 95))
        kappa_rms = float(np.sqrt(np.mean(np.square(kappa_arr[cut_mask]))))
    else:
        omega_break = float(np.max(omega_arr)) if n > 0 else 0.0
        kappa_break = float(np.max(kappa_arr)) if n > 0 else 0.0
        kappa_rms = 0.0

    # 4. Apex speed v_apex and corner exit traction a_exit
    # Pass raw acceleration magnitude during forward drive exit or signed a_t when positive
    drive_accels = np.where(a_t_arr > 0.0, a_t_arr, a_raw_arr)
    apexes = compute_apex_metrics(
        speeds=s_arr,
        curvatures=kappa_arr,
        accelerations=drive_accels,
        dt=dt,
        min_curvature=0.10,
        exit_window_sec=0.5,
    )
    # Filter apexes to active mid-drill cuts (s >= 1.0 yd/s)
    active_apexes = [ap for ap in apexes if ap["v_apex"] >= 1.0]
    if not active_apexes and apexes:
        active_apexes = apexes

    if active_apexes:
        v_apex = float(np.mean([ap["v_apex"] for ap in active_apexes]))
        a_exit = float(np.mean([ap["exit_traction"] for ap in active_apexes]))
    else:
        # Fallback to maximum curvature frame during active motion
        valid_indices = np.where(cut_mask)[0] if np.any(cut_mask) else np.arange(n)
        peak_i = int(valid_indices[np.argmax(kappa_arr[valid_indices])]) if len(valid_indices) > 0 else 0
        v_apex = float(s_arr[peak_i]) if n > 0 else 0.0
        exit_slice = drive_accels[peak_i + 1 : min(n, peak_i + 6)]
        a_exit = float(np.mean(exit_slice)) if len(exit_slice) > 0 else float(drive_accels[peak_i]) if n > 0 else 0.0

    asr_ratio = float(np.clip(v_apex / max(v_max, 0.5), 0.0, 1.0))

    # 5. Trail-braking phase overlap (overlap_70) and 95th-percentile combined G-force (g_comb_95)
    overlap_70 = compute_overlap_index(
        a_tangential=a_t_arr,
        a_lateral=a_lat_arr,
        speeds=s_arr,
        min_speed_threshold=0.5,
        percentile=70.0,
    )
    g_comb_95 = float(np.percentile(g_comb_arr[active_05], 95)) if np.any(active_05) else float(np.max(g_comb_arr))

    return {
        "n_frames": int(n),
        "duration_sec": round((n - 1) * dt, 2) if n > 1 else 0.0,
        "v_max_drill": round(v_max, 4),
        "v_p95_drill": round(v_p95, 4),
        "v_bp": round(v_bp, 4),
        "a_plant": round(a_plant, 4),
        "j_plant": round(j_plant, 4),
        "omega_break": round(omega_break, 4),
        "kappa_break": round(kappa_break, 4),
        "tau_trans": round(tau_trans, 4),
        "v_apex": round(v_apex, 4),
        "a_exit": round(a_exit, 4),
        "asr_ratio": round(asr_ratio, 4),
        "overlap_70": round(overlap_70, 4),
        "g_comb_95": round(g_comb_95, 4),
        "kappa_rms": round(kappa_rms, 4),
    }


def compute_fold_safe_hfbi(
    train_df: pd.DataFrame | pl.DataFrame,
    eval_df: pd.DataFrame | pl.DataFrame | None = None,
    feature_cols: list[str] | tuple[str, ...] = HFBI_COMPONENT_COLS,
    return_eval_only: bool = False,
) -> tuple[pd.DataFrame, pd.DataFrame] | pd.DataFrame:
    """Fit StandardScaler strictly on train_df and compute the DB Hip Fluidity & Break Index (HFBI).

    Mathematical Definition:
        For subject $i$, let the 6 directional skill-drill kinematic components be:
        $$\\mathbf{z}_i = \\left( z(\\omega_{\\text{break}, i}),\\; z(-\\tau_{\\text{trans}, i}),\\; z(a_{\\text{exit}, i}),\\; z(\\text{ASR}_{\\text{W/Box}, i}),\\; z(\\text{Overlap}_{70, i}),\\; z(G_{\\text{comb}, 95, i}) \\right)$$
        where each component $z(x_{i,k}) = \\frac{x_{i,k} - \\hat{\\mu}_{k,\\text{train}}}{\\hat{\\sigma}_{k,\\text{train}}}$
        is standardized using **strictly** the training fold mean $\\hat{\\mu}_{k,\\text{train}}$ and
        standard deviation $\\hat{\\sigma}_{k,\\text{train}}$.
        - Raw composite average: $\\text{ hfbi\\_raw}_i = \\frac{1}{6} \\sum_{k=1}^6 z_{i,k}$
        - Standardized index: $\\text{hfbi\\_z}_i = \\frac{\\text{hfbi\\_raw}_i - \\hat{\\mu}_{\\text{raw, train}}}{\\hat{\\sigma}_{\\text{raw, train}}}$
        - Descriptive T-score: $\\text{hfbi\\_descriptive}_i = 50.0 + 10.0 \\cdot \\text{hfbi\\_z}_i$

    Input Columns:
        `omega_break`, `tau_trans`, `a_exit`, `asr_w_box`, `overlap_70`, `g_comb_95`.
    Units:
        `hfbi_raw`, `hfbi_z`: dimensionless z-score units; `hfbi_descriptive`: T-score (mean 50, SD 10 on train).
    Temporal Window:
        Cross-sectional subject-level Combine summary (`nfl_id`).
    Edge Handling:
        Zero-variance training columns map to $0.0$ without division-by-zero errors.
    Missing-Value Behavior:
        Any missing component values in `train_df` or `eval_df` are imputed using strictly the
        training-fold median prior to scaling.
    Leakage Risk:
        Zero test/validation leakage. `StandardScaler`, medians, and composite normalization
        parameters are estimated exclusively on `train_df`; perturbing any row of `eval_df`
        has zero effect on any other row of `eval_df` or `train_df`.
    """
    train_pd = train_df.to_pandas() if isinstance(train_df, pl.DataFrame) else train_df.copy()
    eval_pd = (
        (eval_df.to_pandas() if isinstance(eval_df, pl.DataFrame) else eval_df.copy())
        if eval_df is not None
        else None
    )

    cols = list(feature_cols)
    train_mat = np.zeros((len(train_pd), len(cols)), dtype=np.float64)
    medians: dict[str, float] = {}

    for idx, col in enumerate(cols):
        vals = pd.to_numeric(train_pd[col], errors="coerce").to_numpy(dtype=np.float64)
        med = float(np.nanmedian(vals)) if not np.all(np.isnan(vals)) else 0.0
        medians[col] = med
        vals_filled = np.where(np.isfinite(vals), vals, med)
        # Invert tau_trans so lower transition latency -> higher fluidity
        if col == "tau_trans":
            vals_filled = -vals_filled
        train_mat[:, idx] = vals_filled

    scaler = StandardScaler()
    train_z = scaler.fit_transform(train_mat)
    train_raw = np.mean(train_z, axis=1)
    raw_mean = float(np.mean(train_raw))
    raw_std = float(np.std(train_raw, ddof=0))
    if raw_std < 1e-12:
        raw_std = 1.0

    train_hfbi_z = (train_raw - raw_mean) / raw_std
    train_pd["hfbi_raw"] = train_raw
    train_pd["hfbi_z"] = train_hfbi_z
    train_pd["hfbi_descriptive"] = 50.0 + 10.0 * train_hfbi_z

    if eval_pd is None:
        return train_pd

    eval_mat = np.zeros((len(eval_pd), len(cols)), dtype=np.float64)
    for idx, col in enumerate(cols):
        vals = pd.to_numeric(eval_pd[col], errors="coerce").to_numpy(dtype=np.float64)
        vals_filled = np.where(np.isfinite(vals), vals, medians[col])
        if col == "tau_trans":
            vals_filled = -vals_filled
        eval_mat[:, idx] = vals_filled

    eval_z = scaler.transform(eval_mat)
    eval_raw = np.mean(eval_z, axis=1)
    eval_hfbi_z = (eval_raw - raw_mean) / raw_std

    eval_pd["hfbi_raw"] = eval_raw
    eval_pd["hfbi_z"] = eval_hfbi_z
    eval_pd["hfbi_descriptive"] = 50.0 + 10.0 * eval_hfbi_z

    if return_eval_only:
        return eval_pd
    return train_pd, eval_pd


def run_db_combine_feature_pipeline(
    combine_results_path: str | Path = "combine_results.parquet",
    players_path: str | Path = "players.parquet",
    combine_tracking_path: str | Path = "combine_tracking.parquet",
    episodes_output_path: str | Path = "data/interim/db_combine_drill_episodes.parquet",
    features_output_path: str | Path = "data/processed/db_combine_features.parquet",
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Execute Phase 6A Combine biomechanical feature pipeline for all 122 DB prospects.

    Reads `combine_results.parquet`, `players.parquet`, and `combine_tracking.parquet`
    using Polars lazy scanning, computes frame-level and drill-episode-level kinematics,
    aggregates subject-level DB drill features, and writes both Parquet tables.
    """
    combine_df = (
        pl.scan_parquet(combine_results_path)
        .filter(pl.col("combine_position") == "DB")
        .collect()
        .sort("nfl_id")
    )
    players_df = (
        pl.scan_parquet(players_path)
        .select([
            "nfl_id",
            "display_name",
            "nfl_position",
            "birth_date",
            "college_name",
            "college_conference",
            "draft_round",
            "draft_pick_within_round",
            "draft_overall_pick",
        ])
        .collect()
    )

    db_ids = combine_df["nfl_id"].to_list()

    tracking_lazy = (
        pl.scan_parquet(combine_tracking_path)
        .filter(pl.col("nfl_id").is_in(db_ids) & (pl.col("entity_type") == "PLAYER"))
    )
    frames_df = compute_combine_frame_kinematics(tracking_lazy, dt=0.1, singularity_threshold=0.2)

    # Extract episode-level metrics for each distinct event_id
    episode_records: list[dict[str, Any]] = []
    for event_key, ep_group in frames_df.group_by("event_id", maintain_order=True):
        ev_id = event_key[0] if isinstance(event_key, tuple) else event_key
        ep_sorted = ep_group.sort("time")
        first_row = ep_sorted.row(0, named=True)
        metrics = extract_episode_kinematic_metrics(ep_sorted, dt=0.1)
        drill_name = str(first_row["drill_name"])
        if drill_name in BACKPEDAL_BREAK_DRILLS:
            drill_category = "BACKPEDAL_BREAK"
        elif drill_name in MULTICUT_AGILITY_DRILLS:
            drill_category = "MULTICUT_AGILITY"
        elif drill_name in PURSUIT_BALLHAWKING_DRILLS:
            drill_category = "PURSUIT_BALLHAWKING"
        else:
            drill_category = "TIMER_COMBINE"

        episode_records.append({
            "event_id": str(ev_id),
            "nfl_id": int(first_row["nfl_id"]),
            "draft_year": int(first_row["draft_year"]),
            "drill_type": str(first_row["drill_type"]),
            "drill_name": drill_name,
            "drill_category": drill_category,
            "attempt": int(first_row["attempt"]) if first_row["attempt"] is not None else 1,
            **metrics,
        })

    episodes_df = pl.DataFrame(episode_records).sort(["nfl_id", "drill_name", "attempt", "event_id"])
    ep_out = Path(episodes_output_path)
    ep_out.parent.mkdir(parents=True, exist_ok=True)
    episodes_df.write_parquet(ep_out)

    # Aggregate episode-level metrics to subject level (1 row per DB nfl_id, 122 rows)
    # 1. Backpedal & Break drills (`BACK_PEDAL_AND_TRANSITION_45_DEGREE_REACTION`, `BACK_PEDAL_AND_90_DEGREE_BREAK_TO_BALL`)
    bp_agg = (
        episodes_df.filter(pl.col("drill_category") == "BACKPEDAL_BREAK")
        .group_by("nfl_id")
        .agg([
            pl.len().alias("n_backpedal_break_events"),
            pl.col("v_bp").mean().alias("v_bp"),
            pl.col("a_plant").min().alias("a_plant"),
            pl.col("j_plant").max().alias("j_plant"),
            pl.col("omega_break").max().alias("omega_break"),
            pl.col("kappa_break").max().alias("kappa_break"),
            pl.col("tau_trans").mean().alias("tau_trans"),
            pl.col("v_apex").mean().alias("v_apex"),
            pl.col("a_exit").max().alias("a_exit"),
        ])
    )

    # Drill-specific sub-features for 45-deg vs 90-deg break drills
    bp45_agg = (
        episodes_df.filter(pl.col("drill_name") == "BACK_PEDAL_AND_TRANSITION_45_DEGREE_REACTION")
        .group_by("nfl_id")
        .agg([
            pl.col("v_bp").mean().alias("bp45_v_bp"),
            pl.col("omega_break").max().alias("bp45_omega_break"),
            pl.col("tau_trans").mean().alias("bp45_tau_trans"),
            pl.col("a_exit").max().alias("bp45_a_exit"),
        ])
    )
    bp90_agg = (
        episodes_df.filter(pl.col("drill_name") == "BACK_PEDAL_AND_90_DEGREE_BREAK_TO_BALL")
        .group_by("nfl_id")
        .agg([
            pl.col("v_bp").mean().alias("bp90_v_bp"),
            pl.col("omega_break").max().alias("bp90_omega_break"),
            pl.col("tau_trans").mean().alias("bp90_tau_trans"),
            pl.col("a_exit").max().alias("bp90_a_exit"),
        ])
    )

    # 2. Multi-Cut Agility drills (`W_DRILL`, `BOX_DRILL`)
    mc_agg = (
        episodes_df.filter(pl.col("drill_category") == "MULTICUT_AGILITY")
        .group_by("nfl_id")
        .agg([
            pl.len().alias("n_multicut_events"),
            pl.col("asr_ratio").mean().alias("asr_w_box"),
            pl.col("overlap_70").mean().alias("overlap_70"),
            pl.col("g_comb_95").max().alias("g_comb_95"),
            pl.col("v_max_drill").max().alias("v_max_w_box"),
            pl.col("a_exit").max().alias("a_exit_w_box"),
        ])
    )

    # 3. Ball-Hawking & Pursuit drills (`GAUNTLET_DRILL`, `TERYL_AUSTIN_DRILL_1/2`, `LINE_DRILL`, `LINE`)
    gauntlet_only = (
        episodes_df.filter(pl.col("drill_name") == "GAUNTLET_DRILL")
        .group_by("nfl_id")
        .agg([
            pl.col("v_max_drill").max().alias("_v_max_gauntlet_only"),
            pl.col("kappa_rms").mean().alias("_kappa_rms_gauntlet_only"),
        ])
    )
    pursuit_all = (
        episodes_df.filter(pl.col("drill_category") == "PURSUIT_BALLHAWKING")
        .group_by("nfl_id")
        .agg([
            pl.len().alias("n_pursuit_events"),
            pl.col("v_max_drill").max().alias("_v_max_pursuit_all"),
            pl.col("kappa_rms").mean().alias("_kappa_rms_pursuit_all"),
        ])
    )

    # 4. Overall skill-drill summary across all DB position skill drills
    skill_all = (
        episodes_df.filter(pl.col("drill_type") == "SKILL_DRILLS_DB")
        .group_by("nfl_id")
        .agg([
            pl.len().alias("n_combine_skill_events"),
            pl.col("v_max_drill").max().alias("skill_v_max"),
            pl.col("v_p95_drill").mean().alias("skill_v_p95"),
        ])
    )
    total_events_agg = (
        episodes_df.group_by("nfl_id")
        .agg(pl.len().alias("n_combine_total_events"))
    )

    player_features = (
        combine_df.join(players_df, on="nfl_id", how="left")
        .join(bp_agg, on="nfl_id", how="left")
        .join(bp45_agg, on="nfl_id", how="left")
        .join(bp90_agg, on="nfl_id", how="left")
        .join(mc_agg, on="nfl_id", how="left")
        .join(gauntlet_only, on="nfl_id", how="left")
        .join(pursuit_all, on="nfl_id", how="left")
        .join(skill_all, on="nfl_id", how="left")
        .join(total_events_agg, on="nfl_id", how="left")
        .with_columns([
            pl.coalesce(["_v_max_gauntlet_only", "_v_max_pursuit_all", "skill_v_max"]).alias("v_max_gauntlet"),
            pl.coalesce(["_kappa_rms_gauntlet_only", "_kappa_rms_pursuit_all"]).alias("kappa_rms"),
        ])
        .drop([
            "_v_max_gauntlet_only",
            "_v_max_pursuit_all",
            "_kappa_rms_gauntlet_only",
            "_kappa_rms_pursuit_all",
        ])
        .sort("nfl_id")
    )

    # Populate descriptive full-cohort HFBI columns for EDA tables (while models use compute_fold_safe_hfbi per fold)
    pf_pd = compute_fold_safe_hfbi(player_features)
    assert isinstance(pf_pd, pd.DataFrame)
    player_features_out = pl.from_pandas(pf_pd).sort("nfl_id")

    feat_out = Path(features_output_path)
    feat_out.parent.mkdir(parents=True, exist_ok=True)
    player_features_out.write_parquet(feat_out)

    return episodes_df, player_features_out


if __name__ == "__main__":
    ep_df, pf_df = run_db_combine_feature_pipeline()
    print(
        f"Phase 6A Combine Features completed: episodes={ep_df.height} rows, "
        f"players={pf_df.height} rows, cols={len(pf_df.columns)}"
    )
