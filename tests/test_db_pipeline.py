"""Comprehensive automated test suite for the 2027 Big Data Bowl DB Hip Fluidity pipeline.

Covers:
1. Synthetic trajectory unit tests with known analytical ground truth:
   - NGS compass velocity decomposition (vx = s * sin(dir), vy = s * cos(dir))
   - Play-direction coordinate reflection (play_direction == 'left') and exact mathematical
     invariance of beta_slip and omega_t under 180-degree rotation
   - Unwrapped angular velocity omega_t, curvature kappa_t with s < 0.2 yd/s singularity cutoff,
     plant-to-drive transition latency tau_trans, corner exit traction a_exit,
     trail-braking overlap_70, and sideslip hip-flip rate beta_rate
2. Fold-safety & zero leakage invariants:
   - artifacts/split_manifest.csv has 0 nfl_id overlap across the 5 folds
   - compute_fold_safe_hfbi fits strictly on training data without test leakage
   - draft_overall_pick, ngs_college_production_score, and ngs_final_score are excluded
     from kinematic predictor matrices in Model Families 1 & 2
3. Dataset & Empirical Audit Invariants:
   - Exact 9-file row counts in artifacts/file_manifest.csv (510 players, 122 DBs,
     314,197 player_play rows, 1,002 games split into 147 PRE / 816 REG / 39 POST)
   - season_type == 'REG' and play_nullified_by_penalty == 'N' filtering in primary game models
   - visitor_team_win_probility_added typo alias handling
   - Right-censoring normalization (def_snaps_per_active_game and is_rookie_season)
4. Presence and non-emptiness of all required Phase 0-13 artifacts, tables, figures, and report.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import pytest
import yaml

from src.features.db_combine_features import (
    compute_combine_frame_kinematics,
    compute_plant_to_drive_latency,
    extract_episode_kinematic_metrics,
)
from src.features.db_game_features import (
    compute_game_frame_kinematics,
    standardize_play_direction_coordinates,
)
from src.web.kinematics import (
    compute_angular_velocity,
    compute_apex_metrics,
    compute_beta_rate,
    compute_curvature,
    compute_overlap_index,
    compute_slip_angle,
    compute_tracking_kinematics,
    decompose_velocity,
    detect_snap_oversteer,
    unwrap_angle_diff,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent


# ==============================================================================
# 1. Synthetic Trajectory Unit Tests with Analytical Ground Truth
# ==============================================================================


def test_ngs_compass_velocity_decomposition_ground_truth() -> None:
    """Verify vx = s * sin(dir), vy = s * cos(dir) across cardinal and diagonal angles."""
    speed = 8.0
    # 0 deg = North (+y), 90 deg = East (+x), 180 deg = South (-y), 270 deg = West (-x)
    cases = [
        (0.0, 0.0, 8.0),
        (90.0, 8.0, 0.0),
        (180.0, 0.0, -8.0),
        (270.0, -8.0, 0.0),
        (30.0, 8.0 * 0.5, 8.0 * (math.sqrt(3.0) / 2.0)),
        (135.0, 8.0 * math.sin(math.radians(135.0)), 8.0 * math.cos(math.radians(135.0))),
        (315.0, 8.0 * math.sin(math.radians(315.0)), 8.0 * math.cos(math.radians(315.0))),
    ]
    for heading_deg, expected_vx, expected_vy in cases:
        vx, vy = decompose_velocity(speed, heading_deg)
        assert vx == pytest.approx(expected_vx, abs=1e-6)
        assert vy == pytest.approx(expected_vy, abs=1e-6)
        assert (vx**2 + vy**2) == pytest.approx(speed**2, rel=1e-6)


def test_play_direction_reflection_and_rotational_invariance() -> None:
    """Verify play_direction == 'left' reflection and invariance of beta_slip and omega_t."""
    raw_df = pl.DataFrame(
        {
            "time": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5],
            "x": [35.0, 34.5, 33.8, 33.0, 32.5, 32.2],
            "y": [20.0, 20.4, 21.0, 21.8, 22.5, 23.1],
            "s": [5.5, 6.2, 6.8, 4.5, 5.1, 7.0],
            "a": [1.5, 2.0, -4.5, -2.0, 3.5, 4.2],
            "dir": [265.0, 272.0, 285.0, 355.0, 8.0, 25.0],
            "o": [90.0, 95.0, 110.0, 185.0, 5.0, 22.0],
            "play_direction": ["left"] * 6,
        }
    )

    # Compute standardized coordinates for play_direction == 'left' via pipeline function
    reflected_df = standardize_play_direction_coordinates(raw_df).collect()

    # Check exact coordinate reflection formulas
    assert reflected_df["x_std"].to_list() == pytest.approx(
        [85.0, 85.5, 86.2, 87.0, 87.5, 87.8], abs=1e-6
    )
    assert reflected_df["y_std"].to_list() == pytest.approx(
        [53.3333 - y for y in [20.0, 20.4, 21.0, 21.8, 22.5, 23.1]], abs=1e-6
    )
    assert reflected_df["dir_std"].to_list() == pytest.approx(
        [85.0, 92.0, 105.0, 175.0, 188.0, 205.0], abs=1e-6
    )
    assert reflected_df["o_std"].to_list() == pytest.approx(
        [270.0, 275.0, 290.0, 5.0, 185.0, 202.0], abs=1e-6
    )

    # Compute kinematics on unreflected ('right') vs 180-degree reflected ('left') via compute_game_frame_kinematics
    game_kin_left = compute_game_frame_kinematics(raw_df, dt=0.1).collect()
    game_kin_right = compute_game_frame_kinematics(
        raw_df.with_columns(pl.lit("right").alias("play_direction")), dt=0.1
    ).collect()
    assert game_kin_left["omega_t"].to_list() == pytest.approx(
        game_kin_right["omega_t"].to_list(), abs=1e-6
    )
    assert game_kin_left["kappa_t"].to_list() == pytest.approx(
        game_kin_right["kappa_t"].to_list(), abs=1e-6
    )
    assert game_kin_left["beta_rate"].to_list() == pytest.approx(
        game_kin_right["beta_rate"].to_list(), abs=1e-6
    )

    # Also verify via compute_tracking_kinematics
    kin_raw = compute_tracking_kinematics(raw_df, is_combine=False, dt=0.1)
    kin_std = compute_tracking_kinematics(
        reflected_df.select(
            pl.col("time"),
            pl.col("x_std").alias("x"),
            pl.col("y_std").alias("y"),
            pl.col("s"),
            pl.col("a"),
            pl.col("dir_std").alias("dir"),
            pl.col("o_std").alias("o"),
        ),
        is_combine=False,
        dt=0.1,
    )

    # Mathematical invariance of omega_t, kappa_t, beta_slip, and beta_rate under 180-deg rotation
    assert kin_raw["omega"].to_list() == pytest.approx(kin_std["omega"].to_list(), abs=1e-6)
    assert kin_raw["kappa"].to_list() == pytest.approx(kin_std["kappa"].to_list(), abs=1e-6)
    for b_raw, b_std in zip(
        kin_raw["beta_slip"].to_list(), kin_std["beta_slip"].to_list(), strict=True
    ):
        # At exact +/-180 boundary, abs(beta_slip) is invariant and unwrap_angle_diff is 0
        assert unwrap_angle_diff(b_raw, b_std) == pytest.approx(0.0, abs=1e-6)
    assert kin_raw["beta_rate"].to_list() == pytest.approx(
        kin_std["beta_rate"].to_list(), abs=1e-6
    )


def test_synthetic_omega_curvature_and_singularity_cutoff() -> None:
    """Verify unwrapped omega_t and curvature kappa_t with s < 0.2 yd/s cutoff."""
    # Wrap across 0/360 boundary: 352 deg -> 8 deg in dt=0.1s is +16 deg -> 160 deg/s
    omega = compute_angular_velocity(8.0, 352.0, dt=0.1)
    assert omega == pytest.approx(160.0, abs=1e-6)

    # Normal speed s = 4.0 yd/s, omega = 180/pi deg/s (1 rad/s) -> kappa = 0.25 yd^-1
    kappa_normal = compute_curvature(speed=4.0, omega_deg_s=180.0 / math.pi, singularity_threshold=0.2)
    assert kappa_normal == pytest.approx(0.25, abs=1e-6)

    # Singularity cutoff: s < 0.2 yd/s must return 0.0
    for low_speed in [0.0, 0.05, 0.15, 0.1999]:
        assert compute_curvature(speed=low_speed, omega_deg_s=250.0, singularity_threshold=0.2) == 0.0


def test_synthetic_plant_to_drive_latency_and_corner_exit_traction() -> None:
    """Verify analytical ground truth for plant-to-drive latency tau_trans, v_apex, and a_exit."""
    # Construct a 15-frame (1.4s at 10 Hz) backpedal -> plant -> apex -> drive break trajectory:
    # Frame 0..3: steady backpedal (s=4.5, a=-0.5, kappa=0.02)
    # Frame 4 (t=0.4s): plant deceleration trough (a_plant = -6.5 yd/s^2)
    # Frame 6 (t=0.6s): break apex peak curvature (kappa = 0.85 yd^-1, v_apex = 2.4 yd/s)
    # Frames 7..11 (t=0.7..1.1s, 0.5s window post-apex): corner exit accelerations [3.0, 4.0, 5.0, 6.0, 7.0]
    dt = 0.1
    speeds = [4.5, 4.4, 4.2, 3.8, 3.1, 2.6, 2.4, 2.7, 3.1, 3.6, 4.2, 4.9, 5.4, 5.8, 6.0]
    curvatures = [0.01, 0.01, 0.02, 0.05, 0.25, 0.55, 0.85, 0.40, 0.15, 0.05, 0.02, 0.01, 0.01, 0.01, 0.01]
    accelerations = [-0.2, -0.5, -1.5, -3.5, -6.5, -4.0, -1.0, 3.0, 4.0, 5.0, 6.0, 7.0, 4.5, 3.5, 2.0]

    # 1. Plant frame is minimum acceleration (frame 4, t=0.4s)
    plant_idx = int(np.argmin(accelerations))
    assert plant_idx == 4

    # 2. Apex metrics via compute_apex_metrics
    apexes = compute_apex_metrics(
        speeds=speeds,
        curvatures=curvatures,
        accelerations=accelerations,
        dt=dt,
        min_curvature=0.10,
        exit_window_sec=0.5,
    )
    assert len(apexes) == 1
    apex = apexes[0]
    assert apex["frame_index"] == 6
    assert apex["v_apex"] == pytest.approx(2.4, abs=1e-6)
    # Mean of next 5 frames [3.0, 4.0, 5.0, 6.0, 7.0] = 5.0 yd/s^2
    assert apex["exit_traction"] == pytest.approx(5.0, abs=1e-6)

    # 3. Plant-to-drive transition latency tau_trans via compute_plant_to_drive_latency:
    # First frame after plant_idx (4) where acceleration turns positive (> 0) is frame 7 (t=0.7s)
    latency_res = compute_plant_to_drive_latency(
        accelerations=accelerations, speeds=speeds, curvatures=curvatures, dt=dt
    )
    assert latency_res["plant_idx"] == 4
    assert latency_res["drive_idx"] == 7
    assert latency_res["tau_trans"] == pytest.approx(0.3, abs=1e-6)
    assert latency_res["a_plant"] == pytest.approx(-6.5, abs=1e-6)

    # Verify compute_combine_frame_kinematics and extract_episode_kinematic_metrics on synthetic episode
    synth_ep = pl.DataFrame(
        {
            "event_id": ["SYNTH_EP_1"] * 15,
            "time": [round(i * dt, 1) for i in range(15)],
            "s": speeds,
            "a": accelerations,
            "dir": [0.0, 0.0, 2.0, 8.0, 25.0, 60.0, 110.0, 130.0, 135.0, 135.0, 135.0, 135.0, 135.0, 135.0, 135.0],
        }
    )
    ep_kin = compute_combine_frame_kinematics(synth_ep, dt=dt, singularity_threshold=0.2)
    ep_metrics = extract_episode_kinematic_metrics(ep_kin, dt=dt)
    assert ep_metrics["tau_trans"] == pytest.approx(0.3, abs=1e-4)
    assert ep_metrics["a_plant"] == pytest.approx(-6.5, abs=1e-4)
    assert ep_metrics["v_apex"] == pytest.approx(2.4, abs=1e-4)


def test_synthetic_trail_braking_overlap_70_and_sideslip_hip_flip_rate() -> None:
    """Verify trail-braking overlap_70 and unwrapped sideslip hip-flip rate beta_rate."""
    # 10 active frames (s >= 0.5 yd/s). P70 of [1..10] is 7.3, so top 3 values (8, 9, 10) exceed P70.
    # Let both |a_t| and |a_lat| exceed P70 on indices 7 and 8 (2 out of 10 frames -> 0.2000).
    a_t = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 9.0, 10.0, 8.0]
    a_lat = [2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 1.0]
    speeds = [5.0] * 10

    overlap = compute_overlap_index(
        a_tangential=a_t,
        a_lateral=a_lat,
        speeds=speeds,
        min_speed_threshold=0.5,
        percentile=70.0,
    )
    assert overlap == pytest.approx(0.2, abs=1e-4)

    # Sideslip hip-flip rate across +/-180 backpedal wrap and rapid hip turn
    # Frame 0: dir=0, o=175 -> beta_slip = -175 deg
    # Frame 1: dir=0, o=185 -> beta_slip = +175 deg (unwrapped diff = -10 deg -> -100 deg/s)
    # Frame 2: dir=0, o=115 -> beta_slip = -115 deg (unwrapped diff = +70 deg -> +700 deg/s)
    b0 = compute_slip_angle(0.0, 175.0)
    b1 = compute_slip_angle(0.0, 185.0)
    b2 = compute_slip_angle(0.0, 115.0)
    assert b0 == pytest.approx(-175.0, abs=1e-6)
    assert b1 == pytest.approx(175.0, abs=1e-6)
    assert compute_beta_rate(b1, b0, dt=0.1) == pytest.approx(-100.0, abs=1e-6)
    assert compute_beta_rate(b2, b1, dt=0.1) == pytest.approx(700.0, abs=1e-6)

    # Snap oversteer trigger check
    assert detect_snap_oversteer(speed=5.0, beta_rate=700.0, jerk=8.5) is True
    assert detect_snap_oversteer(speed=0.4, beta_rate=700.0, jerk=8.5) is False


# ==============================================================================
# 2. Fold-Safety & Zero Leakage Invariants
# ==============================================================================


def test_split_manifest_zero_subject_overlap() -> None:
    """Verify artifacts/split_manifest.csv has 0 nfl_id overlap across all 5 folds."""
    manifest_path = PROJECT_ROOT / "artifacts" / "split_manifest.csv"
    assert manifest_path.exists() and manifest_path.stat().st_size > 0, (
        "artifacts/split_manifest.csv must exist and be non-empty"
    )

    df = pd.read_csv(manifest_path)
    assert "nfl_id" in df.columns
    fold_col = "fold" if "fold" in df.columns else "fold_id"
    assert fold_col in df.columns

    # Check 5 folds exist
    folds = sorted(df[fold_col].unique())
    assert len(folds) == 5, f"Expected 5 folds, got {folds}"

    # Verify pairwise disjoint nfl_id sets across all folds
    for i, f1 in enumerate(folds):
        ids_1 = set(df.loc[df[fold_col] == f1, "nfl_id"])
        assert len(ids_1) > 0
        for f2 in folds[i + 1 :]:
            ids_2 = set(df.loc[df[fold_col] == f2, "nfl_id"])
            overlap = ids_1.intersection(ids_2)
            assert len(overlap) == 0, f"Leakage detected between fold {f1} and {f2}: {overlap}"


def test_compute_fold_safe_hfbi_zero_test_leakage() -> None:
    """Verify compute_fold_safe_hfbi fits strictly on train_df with zero eval_df leakage."""
    from src.features.db_combine_features import compute_fold_safe_hfbi

    rng = np.random.default_rng(20261102)
    n_train = 40
    train_df = pd.DataFrame(
        {
            "nfl_id": np.arange(1001, 1001 + n_train),
            "omega_break": rng.normal(240.0, 35.0, n_train),
            "tau_trans": rng.normal(0.35, 0.08, n_train),
            "a_exit": rng.normal(4.2, 0.7, n_train),
            "asr_w_box": rng.normal(0.55, 0.06, n_train),
            "overlap_70": rng.normal(0.18, 0.04, n_train),
            "g_comb_95": rng.normal(0.68, 0.09, n_train),
        }
    )

    eval_clean = pd.DataFrame(
        {
            "nfl_id": [2001, 2002],
            "omega_break": [260.0, 220.0],
            "tau_trans": [0.30, 0.42],
            "a_exit": [4.8, 3.7],
            "asr_w_box": [0.60, 0.50],
            "overlap_70": [0.22, 0.14],
            "g_comb_95": [0.74, 0.62],
        }
    )

    # Perturb the second row of eval_df with extreme values (+10000) while keeping row 0 identical
    eval_perturbed = eval_clean.copy()
    for col in ["omega_break", "tau_trans", "a_exit", "asr_w_box", "overlap_70", "g_comb_95"]:
        eval_perturbed.loc[1, col] = 10000.0

    res_clean = compute_fold_safe_hfbi(train_df, eval_clean)
    res_perturbed = compute_fold_safe_hfbi(train_df, eval_perturbed)

    # Handle either tuple (train_out, eval_out) or DataFrame return conventions
    if isinstance(res_clean, tuple):
        train_out_1, eval_out_1 = res_clean
        train_out_2, eval_out_2 = res_perturbed
    else:
        eval_out_1 = res_clean
        eval_out_2 = res_perturbed
        train_out_1 = None
        train_out_2 = None

    if isinstance(eval_out_1, pl.DataFrame):
        eval_out_1 = eval_out_1.to_pandas()
    if isinstance(eval_out_2, pl.DataFrame):
        eval_out_2 = eval_out_2.to_pandas()

    hfbi_cols = [c for c in eval_out_1.columns if "hfbi" in c.lower()]
    assert len(hfbi_cols) >= 1, f"Expected hfbi column in {eval_out_1.columns}"

    for col in hfbi_cols:
        # Row 0 of eval_df MUST be invariant to extreme perturbations in Row 1 of eval_df
        assert float(eval_out_1.iloc[0][col]) == pytest.approx(
            float(eval_out_2.iloc[0][col]), abs=1e-9
        ), f"Test leakage detected in {col}: eval row 0 changed when eval row 1 was perturbed"

    if train_out_1 is not None and train_out_2 is not None:
        if isinstance(train_out_1, pl.DataFrame):
            train_out_1 = train_out_1.to_pandas()
        if isinstance(train_out_2, pl.DataFrame):
            train_out_2 = train_out_2.to_pandas()
        for col in hfbi_cols:
            np.testing.assert_allclose(
                train_out_1[col].to_numpy(),
                train_out_2[col].to_numpy(),
                atol=1e-9,
            )


def test_pre_draft_proxy_quarantine_in_kinematic_models() -> None:
    """Verify draft_overall_pick, ngs_college_production_score, ngs_final_score are quarantined."""
    from src.models.phase8_11_models import verify_proxy_firewall

    models_yaml_path = PROJECT_ROOT / "configs" / "models.yaml"
    assert models_yaml_path.exists(), "configs/models.yaml must exist"

    with open(models_yaml_path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    assert cfg.get("random_seed") == 20261102

    # Recursively collect stopwatch and kinematic predictor lists vs quarantined proxies
    cfg_str = json.dumps(cfg)
    assert "draft_overall_pick" in cfg_str
    assert "ngs_final_score" in cfg_str

    quarantined = {"draft_overall_pick", "ngs_college_production_score", "ngs_final_score"}
    feature_blocks = cfg.get("feature_blocks", cfg.get("features", cfg))
    for block_name in ["stopwatch_features", "drill_kinematic_features"]:
        if block_name in feature_blocks:
            block_cols = set(feature_blocks[block_name])
            leaked = block_cols.intersection(quarantined)
            assert not leaked, f"Quarantined proxy {leaked} found inside {block_name}"

    # Verify verify_proxy_firewall raises ValueError if quarantined proxies enter Families 1 or 2
    for proxy_col in quarantined:
        with pytest.raises(ValueError, match="Proxy leakage firewall violation"):
            verify_proxy_firewall(["hfbi_z", proxy_col], "Model_Family_1")
        with pytest.raises(ValueError, match="Proxy leakage firewall violation"):
            verify_proxy_firewall(["forty", proxy_col], "Model_Family_2")

    # Verify model_comparison.csv predictors for Model_Family_1 and Model_Family_2 exclude proxies
    comp_df = pd.read_csv(PROJECT_ROOT / "reports" / "tables" / "model_comparison.csv")
    fam12 = comp_df[comp_df["model_family"].isin(["Model_Family_1", "Model_Family_2"])]
    assert len(fam12) > 0
    for _, row in fam12.iterrows():
        preds = set(str(row["predictors"]).split(";"))
        assert preds.isdisjoint(quarantined), (
            f"Quarantined proxy found in {row['model_id']}: {preds.intersection(quarantined)}"
        )


# ==============================================================================
# 3. Dataset & Empirical Audit Invariants
# ==============================================================================


def test_exact_9_file_manifest_and_cohort_counts() -> None:
    """Verify exact 9-file row counts in artifacts/file_manifest.csv and season_type split."""
    manifest_path = PROJECT_ROOT / "artifacts" / "file_manifest.csv"
    assert manifest_path.exists() and manifest_path.stat().st_size > 0

    manifest_df = pd.read_csv(manifest_path)
    expected_counts = {
        "players": 510,
        "combine_results": 510,
        "combine_tracking": 463189,
        "player_career_successes": 510,
        "player_play": 314197,
        "games": 1002,
        "game_tracking_2023": 3665443,
        "game_tracking_2024": 7827944,
        "game_tracking_2025": 11160903,
    }

    # Match row counts by table/file stem
    row_col = next(c for c in manifest_df.columns if "row" in c.lower() or "count" in c.lower())
    file_col = next(
        c for c in manifest_df.columns if any(k in c.lower() for k in ("file", "table", "name", "path"))
    )

    for stem, expected_rows in expected_counts.items():
        matched = manifest_df[manifest_df[file_col].astype(str).str.contains(stem, regex=False)]
        assert len(matched) >= 1, f"Missing {stem} in artifacts/file_manifest.csv"
        actual_rows = int(matched.iloc[0][row_col])
        assert actual_rows == expected_rows, (
            f"Row count mismatch for {stem}: expected {expected_rows}, got {actual_rows}"
        )

    # Verify 510 total players in players.parquet and 122 DBs in combine_results.parquet
    players_df = pl.read_parquet(PROJECT_ROOT / "players.parquet")
    assert players_df.height == 510
    combine_res_df = pl.read_parquet(PROJECT_ROOT / "combine_results.parquet")
    assert combine_res_df.height == 510
    db_df = combine_res_df.filter(pl.col("combine_position") == "DB")
    assert db_df.height == 122

    # Verify 1,002 games split into 147 PRE / 816 REG / 39 POST
    games_df = pl.read_parquet(PROJECT_ROOT / "games.parquet")
    assert games_df.height == 1002
    season_counts = dict(
        games_df.group_by("season_type").len().iter_rows()
    )
    assert season_counts.get("PRE") == 147
    assert season_counts.get("REG") == 816
    assert season_counts.get("POST") == 39


def test_typo_alias_reg_filtering_and_right_censoring_invariants() -> None:
    """Verify visitor_team_win_probability_added alias, REG/penalty filtering, and right-censoring."""
    enriched_path = PROJECT_ROOT / "data" / "interim" / "db_player_play_enriched.parquet"
    assert enriched_path.exists(), "data/interim/db_player_play_enriched.parquet must exist"

    enriched_df = pl.read_parquet(enriched_path)
    # 1. Typo alias check
    assert "visitor_team_win_probability_added" in enriched_df.columns
    if "visitor_team_win_probility_added" in enriched_df.columns:
        diff = (
            enriched_df["visitor_team_win_probability_added"].drop_nulls()
            - enriched_df["visitor_team_win_probility_added"].drop_nulls()
        ).abs().max()
        assert diff == pytest.approx(0.0, abs=1e-9)

    # 2. Rookie-season indicator check: is_rookie_season == (season == draft_year)
    assert "is_rookie_season" in enriched_df.columns
    assert "season" in enriched_df.columns
    assert "draft_year" in enriched_df.columns
    expected_rookie = enriched_df["season"] == enriched_df["draft_year"]
    assert (enriched_df["is_rookie_season"] == expected_rookie).all()

    # 3. Master player dataset checks (122 DBs, right-censoring normalization, REG columns)
    master_path = PROJECT_ROOT / "data" / "processed" / "db_player_master_dataset.parquet"
    assert master_path.exists(), "data/processed/db_player_master_dataset.parquet must exist"
    master_df = pl.read_parquet(master_path)
    assert master_df.height == 122
    assert master_df["nfl_id"].n_unique() == 122
    assert "def_snaps_per_active_game" in master_df.columns

    # Verify right-censoring normalization formula: career_defensive_snaps / max(1, career_games_active)
    if "career_defensive_snaps" in master_df.columns and "career_games_active" in master_df.columns:
        valid = master_df.filter(pl.col("career_games_active") > 0)
        expected_rate = valid["career_defensive_snaps"] / valid["career_games_active"]
        np.testing.assert_allclose(
            valid["def_snaps_per_active_game"].to_numpy(),
            expected_rate.to_numpy(),
            rtol=1e-4,
            atol=1e-4,
        )

    # 4. Verify primary game execution features strictly filter to season_type == 'REG'
    # and play_nullified_by_penalty == 'N'
    plays_kin_path = PROJECT_ROOT / "data" / "processed" / "db_game_plays_kinematics.parquet"
    assert plays_kin_path.exists(), "data/processed/db_game_plays_kinematics.parquet must exist"
    plays_kin_df = pl.read_parquet(plays_kin_path)
    clean_reg_plays = plays_kin_df.filter(
        (pl.col("season_type") == "REG") & (pl.col("play_nullified_by_penalty") == "N")
    )
    assert clean_reg_plays.height > 0
    assert clean_reg_plays.height < plays_kin_df.height, (
        "Clean REG non-penalty subset must strictly filter out PRE/POST and penalty-nullified plays"
    )
    if "reg_n_plays" in master_df.columns:
        assert int(master_df["reg_n_plays"].sum()) == clean_reg_plays.height


# ==============================================================================
# 4. Phase 0-13 Artifacts, Tables, Figures, and Final Report Presence
# ==============================================================================


@pytest.mark.parametrize(
    "rel_path",
    [
        "configs/paths.yaml",
        "configs/models.yaml",
        "configs/variables.yaml",
        "artifacts/environment_report.md",
        "artifacts/file_manifest.csv",
        "artifacts/schema_report.md",
        "artifacts/data_dictionary.csv",
        "artifacts/assumptions.md",
        "artifacts/schema_snapshot.json",
        "artifacts/conversion_report.md",
        "artifacts/conversion_manifest.json",
        "artifacts/validation_report.md",
        "artifacts/validation_results.json",
        "artifacts/analysis_contract.md",
        "artifacts/eda_report.md",
        "artifacts/split_manifest.csv",
        "artifacts/leakage_audit.md",
        "artifacts/model_selection_report.md",
        "artifacts/diagnostics.json",
        "artifacts/diagnostic_interpretation.md",
        "artifacts/robustness_report.md",
        "data/interim/db_combine_tracking.parquet",
        "data/interim/db_player_play_enriched.parquet",
        "data/interim/db_combine_drill_episodes.parquet",
        "data/processed/db_combine_features.parquet",
        "data/processed/db_game_plays_kinematics.parquet",
        "data/processed/db_player_master_dataset.parquet",
        "reports/tables/descriptive_statistics.csv",
        "reports/tables/db_mnar_optout_audit.csv",
        "reports/tables/model_comparison.csv",
        "reports/tables/db_prospect_scouting_leaderboard.csv",
        "reports/figures/fig1_mnar_optout_vs_skill_drill_coverage.png",
        "reports/figures/fig2_db_pedal_break_mechanics_comparison.png",
        "reports/figures/fig3_lab_to_field_kinematic_transfer.png",
        "reports/figures/fig4_sideslip_polar_and_gg_envelope.png",
        "reports/figures/fig5_mediation_and_model_comparison.png",
        "reports/figures/fig6_db_archetype_scouting_matrix.png",
        "reports/bdb2027_db_hip_fluidity_report.md",
    ],
)
def test_required_phase_0_to_13_artifact_exists_and_non_empty(rel_path: str) -> None:
    """Verify every required Phase 0-13 config, artifact, dataset, table, figure, and report exists."""
    full_path = PROJECT_ROOT / rel_path
    assert full_path.exists(), f"Required pipeline artifact missing: {rel_path}"
    assert full_path.stat().st_size > 0, f"Required pipeline artifact is empty: {rel_path}"
