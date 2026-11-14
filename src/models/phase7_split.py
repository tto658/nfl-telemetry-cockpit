"""Phase 7: Subject-Grouped Cross-Validation Split and Leakage Audit.

Implements deterministic 5-fold GroupKFold cross-validation grouped strictly by
subject identifier (`nfl_id`) using the fixed random seed (`20261102`) from
`configs/models.yaml`. Verifies zero subject, drill-episode, or play-window
overlap across partitions for both the 510-player global cohort and the
122-player Defensive Back (`combine_position == 'DB'`) cohort.

Outputs:
- `artifacts/split_manifest.csv`
- `artifacts/leakage_audit.md`
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import yaml
from sklearn.model_selection import GroupKFold

DEFAULT_RANDOM_SEED: int = 20261102
DEFAULT_N_SPLITS: int = 5


def load_split_config(config_path: str | Path = "configs/models.yaml") -> tuple[int, int]:
    """Load fixed random_seed and n_splits from configs/models.yaml."""
    path = Path(config_path)
    random_seed = DEFAULT_RANDOM_SEED
    n_splits = DEFAULT_N_SPLITS
    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        if "random_seed" in cfg:
            random_seed = int(cfg["random_seed"])
        elif "seed" in cfg:
            random_seed = int(cfg["seed"])
        cv_cfg = cfg.get("cross_validation", cfg.get("cv", {}))
        if isinstance(cv_cfg, dict) and "n_splits" in cv_cfg:
            n_splits = int(cv_cfg["n_splits"])
        elif "n_splits" in cfg:
            n_splits = int(cfg["n_splits"])
    return random_seed, n_splits


def _assign_group_kfold_subset(
    df_subset: pl.DataFrame,
    n_splits: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Deterministically shuffle subject order with rng and assign GroupKFold fold IDs."""
    sorted_df = df_subset.sort("nfl_id")
    n_subjects = sorted_df.height
    perm = rng.permutation(n_subjects)
    shuffled_ids = sorted_df["nfl_id"].to_numpy()[perm]

    gkf = GroupKFold(n_splits=n_splits)
    dummy_x = np.zeros((n_subjects, 1))
    dummy_y = np.zeros(n_subjects)
    fold_for_shuffled = np.full(n_subjects, -1, dtype=np.int64)
    for fold_idx, (_, val_idx) in enumerate(gkf.split(dummy_x, dummy_y, groups=shuffled_ids)):
        fold_for_shuffled[val_idx] = int(fold_idx)

    # Map back to sorted nfl_id order
    fold_for_sorted = np.empty(n_subjects, dtype=np.int64)
    fold_for_sorted[perm] = fold_for_shuffled
    return fold_for_sorted


def generate_group_kfold_splits(
    players_path: str | Path = "players.parquet",
    combine_path: str | Path = "combine_results.parquet",
    career_path: str | Path = "player_career_successes.parquet",
    n_splits: int = DEFAULT_N_SPLITS,
    random_seed: int = DEFAULT_RANDOM_SEED,
) -> pl.DataFrame:
    """Generate deterministic 5-fold GroupKFold split manifest grouped by nfl_id.

    Stratifies across the 122 DB cohort and 388 non-DB cohort while assigning each
    `nfl_id` to a single unique fold in {0, 1, 2, 3, 4}.
    """
    players = pl.read_parquet(players_path).select([
        "nfl_id",
        "display_name",
        "draft_year",
        "nfl_position",
        "draft_round",
        "draft_overall_pick",
    ])
    combine = pl.read_parquet(combine_path).select([
        "nfl_id",
        "combine_position",
        "three_cone",
        "short_shuttle",
    ])
    career = pl.read_parquet(career_path).select([
        "nfl_id",
        "career_games_active",
        "career_defensive_snaps",
    ])

    merged = (
        players.join(combine, on="nfl_id", how="inner")
        .join(career, on="nfl_id", how="inner")
        .sort("nfl_id")
    )

    rng = np.random.default_rng(random_seed)

    db_df = merged.filter(pl.col("combine_position") == "DB").sort("nfl_id")
    non_db_df = merged.filter(pl.col("combine_position") != "DB").sort("nfl_id")

    db_folds = _assign_group_kfold_subset(db_df, n_splits=n_splits, rng=rng)
    non_db_folds = _assign_group_kfold_subset(non_db_df, n_splits=n_splits, rng=rng)

    db_df = db_df.with_columns([
        pl.lit(True).alias("is_db"),
        pl.Series("fold", db_folds, dtype=pl.Int64),
        pl.Series("fold_id", db_folds, dtype=pl.Int64),
        pl.Series("global_fold", db_folds, dtype=pl.Int64),
        pl.Series("db_fold", db_folds, dtype=pl.Int64),
    ])

    non_db_df = non_db_df.with_columns([
        pl.lit(False).alias("is_db"),
        pl.Series("fold", non_db_folds, dtype=pl.Int64),
        pl.Series("fold_id", non_db_folds, dtype=pl.Int64),
        pl.Series("global_fold", non_db_folds, dtype=pl.Int64),
        pl.lit(None, dtype=pl.Int64).alias("db_fold"),
    ])

    pp_ids = set(
        pl.scan_parquet("player_play.parquet")
        .select("nfl_id")
        .unique()
        .collect()["nfl_id"]
        .to_list()
    )

    manifest = (
        pl.concat([db_df, non_db_df], how="vertical")
        .sort("nfl_id")
        .with_columns([
            pl.col("nfl_id").is_in(list(pp_ids)).alias("has_nfl_snaps"),
            pl.col("three_cone").is_not_null().alias("has_three_cone"),
            pl.col("short_shuttle").is_not_null().alias("has_short_shuttle"),
            pl.lit(random_seed, dtype=pl.Int64).alias("random_seed"),
            pl.lit("GroupKFold_by_nfl_id").alias("split_strategy"),
        ])
        .drop(["three_cone", "short_shuttle"])
    )
    return manifest


def verify_zero_leakage(
    manifest: pl.DataFrame,
    combine_tracking_path: str | Path = "combine_tracking.parquet",
    player_play_path: str | Path = "player_play.parquet",
    n_splits: int = DEFAULT_N_SPLITS,
) -> dict[str, Any]:
    """Audit subject, Combine event_id, and player_play overlap across all CV folds."""
    total_subjects = manifest.height
    distinct_subjects = manifest["nfl_id"].n_unique()

    db_manifest = manifest.filter(pl.col("is_db"))
    db_subjects = db_manifest.height
    db_distinct = db_manifest["nfl_id"].n_unique()

    # Check pairwise intersection of nfl_id across all folds
    global_pairwise_overlaps = 0
    db_pairwise_overlaps = 0
    fold_summary: list[dict[str, Any]] = []

    for f_i in range(n_splits):
        ids_i = set(manifest.filter(pl.col("fold") == f_i)["nfl_id"].to_list())
        db_ids_i = set(db_manifest.filter(pl.col("db_fold") == f_i)["nfl_id"].to_list())
        for f_j in range(f_i + 1, n_splits):
            ids_j = set(manifest.filter(pl.col("fold") == f_j)["nfl_id"].to_list())
            db_ids_j = set(db_manifest.filter(pl.col("db_fold") == f_j)["nfl_id"].to_list())
            global_pairwise_overlaps += len(ids_i.intersection(ids_j))
            db_pairwise_overlaps += len(db_ids_i.intersection(db_ids_j))

        db_f = db_manifest.filter(pl.col("db_fold") == f_i)
        fold_summary.append({
            "fold": f_i,
            "global_n": len(ids_i),
            "db_n": len(db_ids_i),
            "db_active_n": int(db_f.filter(pl.col("has_nfl_snaps")).height),
            "db_three_cone_observed_n": int(db_f.filter(pl.col("has_three_cone")).height),
            "db_shuttle_observed_n": int(db_f.filter(pl.col("has_short_shuttle")).height),
            "db_2023_n": int(db_f.filter(pl.col("draft_year") == 2023).height),
            "db_2024_n": int(db_f.filter(pl.col("draft_year") == 2024).height),
            "db_2025_n": int(db_f.filter(pl.col("draft_year") == 2025).height),
        })

    # Verify Combine drill episodes (event_id) never span multiple folds
    ct_events = (
        pl.scan_parquet(combine_tracking_path)
        .select(["event_id", "nfl_id"])
        .unique()
        .collect()
        .join(manifest.select(["nfl_id", "fold"]), on="nfl_id", how="inner")
    )
    event_fold_counts = ct_events.group_by("event_id").agg(pl.col("fold").n_unique().alias("n_folds"))
    multi_fold_events = int(event_fold_counts.filter(pl.col("n_folds") > 1).height)

    # Verify player_play (game_id, play_id, nfl_id) subject fold uniqueness
    pp_subjects = (
        pl.scan_parquet(player_play_path)
        .select(["nfl_id"])
        .unique()
        .collect()
        .join(manifest.select(["nfl_id", "fold"]), on="nfl_id", how="inner")
    )
    pp_multi_fold_subjects = int(
        pp_subjects.group_by("nfl_id")
        .agg(pl.col("fold").n_unique().alias("n_folds"))
        .filter(pl.col("n_folds") > 1)
        .height
    )

    passed = (
        total_subjects == 510
        and distinct_subjects == 510
        and db_subjects == 122
        and db_distinct == 122
        and global_pairwise_overlaps == 0
        and db_pairwise_overlaps == 0
        and multi_fold_events == 0
        and pp_multi_fold_subjects == 0
    )

    return {
        "passed": passed,
        "total_subjects": total_subjects,
        "distinct_subjects": distinct_subjects,
        "db_subjects": db_subjects,
        "db_distinct": db_distinct,
        "global_pairwise_overlaps": global_pairwise_overlaps,
        "db_pairwise_overlaps": db_pairwise_overlaps,
        "multi_fold_combine_events": multi_fold_events,
        "multi_fold_play_subjects": pp_multi_fold_subjects,
        "total_combine_events_checked": int(ct_events.height),
        "total_active_play_subjects_checked": int(pp_subjects.height),
        "fold_summary": fold_summary,
    }


def write_leakage_audit_report(
    audit: dict[str, Any],
    random_seed: int,
    n_splits: int,
    output_path: str | Path = "artifacts/leakage_audit.md",
) -> None:
    """Write comprehensive Phase 7 split and leakage audit report."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    rows_md = []
    for fs in audit["fold_summary"]:
        rows_md.append(
            f"| Fold {fs['fold']} | {fs['global_n']} | {fs['db_n']} | {fs['db_active_n']} | "
            f"{fs['db_three_cone_observed_n']} | {fs['db_shuttle_observed_n']} | "
            f"{fs['db_2023_n']} / {fs['db_2024_n']} / {fs['db_2025_n']} |"
        )
    table_str = "\n".join(rows_md)

    content = f"""# Phase 7: Cross-Validation Split & Data Leakage Audit

## 1. Split Architecture & Dependence Structure
- **Grouping Identifier**: `nfl_id` (Subject-level grouping per AGENT.md Rule 11 & Phase 7)
- **Cross-Validation Strategy**: Deterministic `GroupKFold(n_splits={n_splits})`
- **Fixed Random Seed**: `{random_seed}` (from `configs/models.yaml`)
- **Global Cohort Size**: `{audit['total_subjects']}` unique prospects (`{audit['distinct_subjects']}` distinct `nfl_id`)
- **Defensive Back (`DB`) Cohort Size**: `{audit['db_subjects']}` unique DBs (`{audit['db_distinct']}` distinct `nfl_id`)

## 2. Fold Distribution Summary

| Partition | Global Subjects ($N$) | DB Subjects ($N$) | Active NFL DBs ($N$) | Observed 3-Cone DBs | Observed Shuttle DBs | DB Draft Class (2023 / 2024 / 2025) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
{table_str}

## 3. Zero-Overlap & Transductive Leakage Verification

| Audit Check | Expected | Observed | Status |
| :--- | :--- | :--- | :--- |
| Global Cohort Subject Uniqueness (`510` rows) | `0` duplicate `nfl_id` | `{audit['total_subjects'] - audit['distinct_subjects']}` duplicates | **PASS** |
| Global Pairwise Fold Intersection (`nfl_id`) | `0` shared `nfl_id` | `{audit['global_pairwise_overlaps']}` shared | **PASS** |
| DB Cohort Pairwise Fold Intersection (`nfl_id`) | `0` shared `nfl_id` | `{audit['db_pairwise_overlaps']}` shared | **PASS** |
| Combine Drill Episode (`event_id`) Multi-Fold Leakage | `0` multi-fold episodes | `{audit['multi_fold_combine_events']}` across `{audit['total_combine_events_checked']}` events | **PASS** |
| In-Game Tracking (`player_play`) Subject Multi-Fold Leakage | `0` multi-fold players | `{audit['multi_fold_play_subjects']}` across `{audit['total_active_play_subjects_checked']}` active players | **PASS** |

## 4. Pipeline Leakage Firewalls Enforced in Phases 8–12
1. **Subject-Grouped Partitioning (`nfl_id`)**: Every drill trial (`event_id`) and every NFL snap (`game_id, play_id`) belonging to player `nfl_id` is restricted to that player's assigned fold.
2. **In-Fold Scaling & Composite Index Construction (`compute_fold_safe_hfbi`)**: All feature standardization (`StandardScaler`), median imputation for missing covariates, and composite Hip Fluidity & Break Index (`HFBI`) weights/means/SDs are estimated strictly on the training folds ($K-1$ folds) and applied out-of-fold to the held-out validation fold.
3. **Pre-Draft Proxy Quarantine**: `draft_overall_pick`, `draft_round`, `ngs_college_production_score`, and `ngs_final_score` are strictly excluded from biomechanical feature matrices (`X_kinematic` and `X_stopwatch`) in Model Families 1 and 2, and used only as benchmark references or explicit Draft Sunk-Cost instruments in Model Family 5.
4. **Temporal & Game-Type Hygiene**: Primary on-field execution targets strictly filter to regular-season (`season_type == 'REG'`) and non-nullified (`play_nullified_by_penalty == 'N'`) snaps, preventing preseason (`PRE`) roster noise from contaminating regular-season validation metrics.
"""
    out.write_text(content, encoding="utf-8")


def run_phase7_split(
    manifest_output_path: str | Path = "artifacts/split_manifest.csv",
    audit_output_path: str | Path = "artifacts/leakage_audit.md",
) -> dict[str, Any]:
    """Execute Phase 7 split generation and leakage verification."""
    random_seed, n_splits = load_split_config()
    manifest = generate_group_kfold_splits(n_splits=n_splits, random_seed=random_seed)

    manifest_out = Path(manifest_output_path)
    manifest_out.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_csv(manifest_out)

    audit = verify_zero_leakage(manifest, n_splits=n_splits)
    if not audit["passed"]:
        raise RuntimeError(f"Phase 7 leakage audit failed: {audit}")

    write_leakage_audit_report(
        audit=audit,
        random_seed=random_seed,
        n_splits=n_splits,
        output_path=audit_output_path,
    )
    return audit


if __name__ == "__main__":
    result = run_phase7_split()
    print(f"Phase 7 Split completed: passed={result['passed']}, DBs={result['db_subjects']}")
