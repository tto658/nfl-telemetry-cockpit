"""Phase 4: Analysis-Unit Definition & Leakage Firewall Contract.

Codifies the hierarchical observational units, subject/episode/system levels,
time index, outcomes, predictor feature blocks, `season_type == 'REG'` and
`play_nullified_by_penalty == 'N'` filtering rules, right-censoring rate
normalization, pre-draft proxy quarantine (`draft_overall_pick`,
`ngs_college_production_score`, `ngs_final_score`), and `GroupKFold(n_splits=5)`
by `nfl_id`.

Generates:
  - `artifacts/analysis_contract.md`
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import polars as pl
import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def run_phase4_contract(project_root: Path = PROJECT_ROOT) -> dict[str, Any]:
    """Generate the formal Phase 4 Analysis Contract markdown artifact."""
    configs_dir = project_root / "configs"
    artifacts_dir = project_root / "artifacts"
    interim_dir = project_root / "data" / "interim"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    with (configs_dir / "models.yaml").open("r", encoding="utf-8") as f:
        models_cfg = yaml.safe_load(f)
    with (configs_dir / "variables.yaml").open("r", encoding="utf-8") as f:
        vars_cfg = yaml.safe_load(f)

    db_ct = pl.scan_parquet(interim_dir / "db_combine_tracking.parquet")
    db_pp = pl.scan_parquet(interim_dir / "db_player_play_enriched.parquet")

    n_ct_frames = int(db_ct.select(pl.len()).collect().item())
    n_ct_events = int(db_ct.select(pl.col("event_id").n_unique()).collect().item())
    n_pp_total = int(db_pp.select(pl.len()).collect().item())
    n_pp_reg_clean = int(
        db_pp.filter(
            (pl.col("season_type") == "REG") & (~pl.col("is_penalty_nullified"))
        )
        .select(pl.len())
        .collect()
        .item()
    )
    n_pp_rookie_reg_clean = int(
        db_pp.filter(
            (pl.col("season_type") == "REG")
            & (~pl.col("is_penalty_nullified"))
            & pl.col("is_rookie_season")
        )
        .select(pl.len())
        .collect()
        .item()
    )

    fb = models_cfg["feature_blocks"]
    cv = models_cfg["cross_validation"]

    contract_lines = [
        "# Phase 4: Analysis-Unit Definition & Methodological Contract",
        "",
        "Per `AGENT.md` Phase 4 and Non-Negotiable Rules 10–17, no statistical or machine learning model may be fitted prior to this contract. Every downstream script (`src/features/`, `src/models/`, `src/diagnostics/`, `src/reporting/`) is bound by the specifications below.",
        "",
        "---",
        "",
        "## 1. Hierarchical Observational Units & Indexing Levels",
        "| Hierarchy Level | Combine Lab Domain (Domain A) | NFL Game Domain (Domain B) | Primary Key / Grouping Unit | Observed DB Sample Size |",
        "| :--- | :--- | :--- | :--- | :--- |",
        f"| **1. Frame Level (10 Hz)** | Combine Optical Sensor Frame | NGS In-Game Sensor Frame | `(event_id, entity_type, time)` / `(game_id, play_id, nfl_id, time)` | `{n_ct_frames:,}` DB Combine frames; `7,139,862` DB Game frames |",
        f"| **2. Episode / Snap Level** | Single Combine Drill Attempt | Single NFL Player-Play Snap | `(event_id, nfl_id)` / `(game_id, play_id, nfl_id)` | `{n_ct_events:,}` DB drill events; `{n_pp_total:,}` total DB snaps (`{n_pp_reg_clean:,}` clean `REG` snaps) |",
        f"| **3. Subject-Season Level** | Draft Class Cohort (`2023–2025`) | Player-Season Stratum (`is_rookie_season`) | `(nfl_id, season)` | `{n_pp_rookie_reg_clean:,}` clean rookie `REG` snaps |",
        "| **4. Subject Level (Primary Unit)** | Combine Prospect (`combine_position == 'DB'`) | Active NFL Defensive Back | `(nfl_id)` | **`N = 122` Combine DBs** (`118` active NFL DBs + `4` zero-snap DBs; `510` global) |",
        "| **5. System Level** | Drill Type & Ball Trajectory Context | 22-Player Coverage & Down/Distance Context | `(game_id, play_id)` | `816` `REG` games (`147` `PRE`, `39` `POST`) |",
        "",
        "### Time Index & Spatial Reference Frame",
        f"- **Sampling Cadence**: Uniform `10.0 Hz` (`dt = {vars_cfg['spatial_and_angular_conventions']['sampling_interval_sec']} s`) ISO-8601 UTC timestamps.",
        f"- **Angle Convention**: `{vars_cfg['spatial_and_angular_conventions']['angle_convention']}` where $v_x = s \\sin(\\text{{dir}} \\cdot \\pi/180)$ and $v_y = s \\cos(\\text{{dir}} \\cdot \\pi/180)$.",
        "- **Play-Direction Standardization**: All game frames with `play_direction == 'left'` are reflected via:",
        "  $$x_{\\text{std}} = 120.0 - x, \\quad y_{\\text{std}} = 53.3333 - y, \\quad \\text{dir}_{\\text{std}} = (\\text{dir} + 180^\\circ) \\bmod 360^\\circ, \\quad o_{\\text{std}} = (o + 180^\\circ) \\bmod 360^\\circ$$",
        "",
        "---",
        "",
        "## 2. Mandatory Filtering & Right-Censoring Rules",
        "1. **Primary On-Field Game Scope (`season_type == 'REG'`)**:",
        "   - Primary in-game feature aggregations and outcome models strictly filter to **`season_type == 'REG'`** (`816` regular-season games).",
        "   - Preseason (`season_type == 'PRE'`, `147` games) and Postseason (`season_type == 'POST'`, `39` games) snaps are quarantined from primary outcome targets and evaluated exclusively in Phase 12 robustness checks.",
        "2. **Penalty-Nullified Play Exclusion (`play_nullified_by_penalty == 'N'`)**:",
        "   - Primary coverage, cushion, separation, tackle, and EPA execution models exclude penalty-nullified plays (`is_penalty_nullified == False`).",
        "3. **Multi-Season Right-Censoring Normalization**:",
        "   - Because 2023 draftees have up to 3 NFL seasons, 2024 draftees have up to 2 seasons, and 2025 draftees have 1 season, raw cumulative career totals (`career_defensive_snaps`, `career_games_started`) are **never** modeled without exposure normalization.",
        "   - Mandatory rate-normalized targets:",
        "     - `def_snaps_per_active_game = career_defensive_snaps / max(1, career_games_active)`",
        "     - `start_rate = career_games_started / max(1, career_games_active)`",
        "     - Rookie-season-only regular-season stratum: `is_rookie_season == True` (`season == draft_year` & `season_type == 'REG'`).",
        "",
        "---",
        "",
        "## 3. Feature Blocks & Strict Pre-Draft Proxy Firewall",
        "### 3.1 Traditional Stopwatch & Anthropometric Baseline Block (`X_stopwatch`)",
        f"- Columns: `{fb['stopwatch_features']}`",
        "",
        "### 3.2 Combine Skill-Drill Kinematic Block (`X_kinematic`)",
        f"- Columns: `{fb['drill_kinematic_features']}`",
        f"- **Fold-Safe Composite Index (`HFBI`) Components**: `{fb['hfbi_component_features']}` standardized strictly inside each training fold (`compute_fold_safe_hfbi(train_df, eval_df)`).",
        "",
        "### 3.3 In-Game Biomechanical Execution Mediator Block (`M_DB`)",
        f"- Columns: `{fb['in_game_execution_mediators']}`",
        "",
        "### 3.4 Quarantined Pre-Draft Proxies (`QUARANTINED_PROXIES`)",
        f"- Columns: `{fb['quarantined_pre_draft_proxies']}`",
        "- **Firewall Rule**: These columns are **strictly prohibited** from entering `X_kinematic` or `X_stopwatch` in Model Families 1, 2, 3, and 4. They are permitted solely as:",
        "  1. Standalone benchmark comparisons, or",
        "  2. Explicit draft-capital allocation predictors in Model Family 5 (proving front-office draft sunk-cost snap allocation).",
        "",
        "---",
        "",
        "## 4. Target Outcomes Across the 5 Model Families",
        "| Model Family | Observational Unit | Target Outcome(s) | Primary Predictor Comparison | Weighting / Estimation |",
        "| :--- | :--- | :--- | :--- | :--- |",
        "| **Family 1: MNAR Agility Recovery** | Subject (`nfl_id`, observed agility subset & `N=122` DBs) | `three_cone`, `short_shuttle`, `ngs_athleticism_score` | `X_stopwatch` (40-yd/size) vs. `X_kinematic` (`HFBI` + drill mechanics) | Out-of-fold Ridge / Huber / ElasticNet |",
        "| **Family 2: Lab-to-Field Kinematic Transfer ($A \\to B$)** | Subject (`N=118` active `REG` DBs) | `reg_speed_p95`, `reg_hip_flip_rate_p95`, `reg_a_exit`, `reg_snap_oversteer_rate` | `X_stopwatch` vs. `X_kinematic` (Proxy-Free) | Out-of-fold Ridge / OLS with 95% Bootstrap CIs |",
        "| **Family 3: Man/Zone Cushion & Separation Mediation** | Subject & Snap (`season_type == 'REG'`, non-penalty) | `cushion` (Man vs. Zone), `separation_at_pass_forward`, `game_v_close` | `HFBI` + `M_DB` (in-game hip-flip & exit traction) | Inverse-Exposure-Weighted (`IPW = 1 / N_i^B`) & Cluster-Robust SEs |",
        "| **Family 4: Tackling & Two-Stage Mediated Defensive EPA** | Subject & Snap (`season_type == 'REG'`, non-penalty) | `expected_points_added` (Coverage/Tackle EPA) & Tackle Efficiency | `Model 4A` (Direct Naive Lab $\\to$ EPA) vs. `Model 4B` (Two-Stage Mediated $\\text{Lab} \\to \\mathbf{M}_{\\text{DB}} \\to \\text{EPA}$) | Two-stage mediation & player-clustered SEs |",
        "| **Family 5: Right-Censoring-Corrected Snap Allocation** | Subject (`N=122` DBs) | `def_snaps_per_active_game`, `rookie_reg_snaps`, `start_rate` | `draft_overall_pick` (Sunk-Cost Capital) vs. `HFBI` (Biomechanical Fluidity) | Right-censoring-normalized regression |",
        "",
        "---",
        "",
        "## 5. Train/Test Partitioning & Zero-Leakage Protocol",
        f"- **Partitioning Strategy**: `{cv['strategy']}(n_splits={cv['n_splits']})` grouped strictly by `{cv['group_column']}` (`random_seed: {models_cfg['random_seed']}`).",
        "- **Subject Disjointness Invariant**: For every fold $k \\in \\{0, 1, 2, 3, 4\\}$, $\\text{Train}_k \\cap \\text{Test}_k = \\emptyset$ at the `nfl_id` level. No drill attempt or game snap from a test player ever enters training.",
        "- **Fold-Safe Preprocessing**: All `StandardScaler`, median imputers, and `compute_fold_safe_hfbi` index weights are fitted **exclusively** on `Train_k` and applied transform-only to `Test_k`.",
        "",
    ]

    contract_path = artifacts_dir / "analysis_contract.md"
    contract_path.write_text("\n".join(contract_lines), encoding="utf-8")

    return {
        "status": "PASSED",
        "analysis_contract_path": str(contract_path),
        "n_ct_frames": n_ct_frames,
        "n_pp_reg_clean": n_pp_reg_clean,
    }


main = run_phase4_contract

if __name__ == "__main__":
    res = run_phase4_contract()
    print(f"[Phase 4] Completed: analysis contract written -> {res['analysis_contract_path']}")
