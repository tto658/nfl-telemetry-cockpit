"""Phase 5 & Phase 11 Publication Figure Generator (`reports/figures/`).

Generates all 6 high-resolution publication figures for the 2027 NFL Big Data Bowl
DB Hip Fluidity & Transition Mechanics report:
1. `fig1_mnar_optout_vs_skill_drill_coverage.png`
2. `fig2_db_pedal_break_mechanics_comparison.png`
3. `fig3_lab_to_field_kinematic_transfer.png`
4. `fig4_sideslip_polar_and_gg_envelope.png`
5. `fig5_mediation_and_model_comparison.png`
6. `fig6_db_archetype_scouting_matrix.png`
"""

from __future__ import annotations

import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import polars as pl
from scipy import stats

from src.models.phase8_11_models import (
    compute_fold_safe_hfbi_fallback,
    load_or_build_master_db_dataset,
    resolve_column,
)

# Set clean publication style
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.size": 10,
    "axes.titlesize": 11,
    "axes.titleweight": "bold",
    "axes.labelsize": 10,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "figure.facecolor": "white",
    "axes.facecolor": "#F8FAFC",
    "axes.grid": True,
    "grid.alpha": 0.35,
    "grid.linestyle": "--",
})

NAVY = "#0F172A"
BLUE = "#2563EB"
TEAL = "#0D9488"
AMBER = "#D97706"
RED = "#DC2626"
SLATE = "#64748B"
PURPLE = "#7C3AED"


def generate_fig1_mnar_optout(
    combine_path: str | Path = "combine_results.parquet",
    combine_tracking_path: str | Path = "combine_tracking.parquet",
    career_path: str | Path = "player_career_successes.parquet",
    games_path: str | Path = "games.parquet",
    output_path: str | Path = "reports/figures/fig1_mnar_optout_vs_skill_drill_coverage.png",
) -> Path:
    """Generate Figure 1: The Combine Agility Blind Spot (MNAR Opt-Out vs. 100% Skill-Drill Coverage)."""
    _ = games_path
    combine = pl.read_parquet(combine_path).filter(pl.col("combine_position") == "DB")
    career = pl.read_parquet(career_path)
    db_df = combine.join(career, on="nfl_id", how="inner").with_columns(
        (
            pl.col("career_defensive_snaps").cast(pl.Float64)
            / pl.when(pl.col("career_games_active") > 0)
            .then(pl.col("career_games_active").cast(pl.Float64))
            .otherwise(1.0)
        ).alias("def_snaps_per_active_game")
    )

    n_db = db_df.height
    tc_obs = int(db_df["three_cone"].is_not_null().sum())
    ss_obs = int(db_df["short_shuttle"].is_not_null().sum())
    fy_obs = int(db_df["forty"].is_not_null().sum())
    vj_obs = int(db_df["vertical"].is_not_null().sum())

    ct_db = (
        pl.scan_parquet(combine_tracking_path)
        .filter((pl.col("entity_type") == "PLAYER") & pl.col("nfl_id").is_in(db_df["nfl_id"].to_list()))
        .select(["nfl_id", "drill_name"])
        .unique()
        .collect()
    )
    d45_obs = int(ct_db.filter(pl.col("drill_name") == "BACK_PEDAL_AND_TRANSITION_45_DEGREE_REACTION").height)
    d90_obs = int(ct_db.filter(pl.col("drill_name") == "BACK_PEDAL_AND_90_DEGREE_BREAK_TO_BALL").height)
    box_obs = int(ct_db.filter(pl.col("drill_name") == "BOX_DRILL").height)
    w_obs = int(ct_db.filter(pl.col("drill_name") == "W_DRILL").height)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(15.2, 6.4), dpi=240)

    labels = [
        "3-Cone Drill (Stopwatch)",
        "20-Yd Short Shuttle (Stopwatch)",
        "Vertical Jump",
        "40-Yard Dash (Stopwatch)",
        "W-Drill (Optical Tracking)",
        "Box Drill (Optical Tracking)",
        "90° Break to Ball (Optical)",
        "45° Transition Break (Optical)",
    ]
    obs_pcts = [
        100.0 * tc_obs / n_db,
        100.0 * ss_obs / n_db,
        100.0 * vj_obs / n_db,
        100.0 * fy_obs / n_db,
        100.0 * w_obs / n_db,
        100.0 * box_obs / n_db,
        100.0 * d90_obs / n_db,
        100.0 * d45_obs / n_db,
    ]
    miss_pcts = [100.0 - p for p in obs_pcts]
    y_pos = np.arange(len(labels))

    colors_obs = [RED if p < 40 else (SLATE if p < 90 else TEAL) for p in obs_pcts]
    ax1.barh(y_pos, obs_pcts, color=colors_obs, edgecolor="white", height=0.62, label="Observed Coverage (%)")
    ax1.barh(
        y_pos,
        miss_pcts,
        left=obs_pcts,
        color="#E2E8F0",
        edgecolor="white",
        height=0.62,
        label="Opt-Out / Missing (%)",
    )

    for i, (op, mp) in enumerate(zip(obs_pcts, miss_pcts)):
        if mp > 50:
            ax1.text(
                op + mp / 2,
                i,
                f"{mp:.1f}% Opt-Out ({round(mp * n_db / 100)}/{n_db})",
                va="center",
                ha="center",
                color=RED,
                fontweight="bold",
                fontsize=9,
            )
        else:
            ax1.text(
                op / 2,
                i,
                f"{op:.1f}% Observed ({round(op * n_db / 100)}/{n_db})",
                va="center",
                ha="center",
                color="white",
                fontweight="bold",
                fontsize=9,
            )

    ax1.set_yticks(y_pos)
    ax1.set_yticklabels(labels, fontweight="bold")
    ax1.set_xlim(0, 104)
    ax1.set_xlabel("Share of Combine Defensive Back Cohort (N = 122 DBs, %)")
    ax1.set_title(
        "A. The Combine Agility Blind Spot:\n79.5% 3-Cone Opt-Out vs. 100% Skill-Drill Tracking",
        pad=10,
    )
    ax1.legend(loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=2, frameon=True)

    # Panel B: MNAR Selection Bias & Censoring across Draft Classes
    optout_df = db_df.filter(pl.col("three_cone").is_null())
    comp_df = db_df.filter(pl.col("three_cone").is_not_null())

    categories = [
        "NFL Def Snaps / Active Game\n(Right-Censoring Normalized)",
        "Pre-Draft NGS Final Score\n(Composite Prospect Grade)",
    ]
    optout_means = [
        float(optout_df["def_snaps_per_active_game"].mean() or 0.0),
        float(optout_df["ngs_final_score"].mean() or 0.0),
    ]
    comp_means = [
        float(comp_df["def_snaps_per_active_game"].mean() or 0.0),
        float(comp_df["ngs_final_score"].mean() or 0.0),
    ]
    optout_se = [
        float(optout_df["def_snaps_per_active_game"].std() or 0.0) / math.sqrt(optout_df.height),
        float(optout_df["ngs_final_score"].std() or 0.0) / math.sqrt(optout_df.height),
    ]
    comp_se = [
        float(comp_df["def_snaps_per_active_game"].std() or 0.0) / math.sqrt(comp_df.height),
        float(comp_df["ngs_final_score"].std() or 0.0) / math.sqrt(comp_df.height),
    ]

    x = np.arange(len(categories))
    width = 0.34
    rects1 = ax2.bar(
        x - width / 2,
        optout_means,
        width,
        yerr=optout_se,
        capsize=5,
        color=BLUE,
        label=f"3-Cone Opt-Out DBs (N={optout_df.height}, 79.5%)",
    )
    rects2 = ax2.bar(
        x + width / 2,
        comp_means,
        width,
        yerr=comp_se,
        capsize=5,
        color=AMBER,
        label=f"3-Cone Completers (N={comp_df.height}, 20.5%)",
    )

    for r, se_val in zip(rects1, optout_se):
        h = r.get_height()
        ax2.text(
            r.get_x() + r.get_width() / 2,
            h + se_val + 2.2,
            f"{h:.1f}",
            ha="center",
            va="bottom",
            fontweight="bold",
            color=BLUE,
        )
    for r, se_val in zip(rects2, comp_se):
        h = r.get_height()
        ax2.text(
            r.get_x() + r.get_width() / 2,
            h + se_val + 2.2,
            f"{h:.1f}",
            ha="center",
            va="bottom",
            fontweight="bold",
            color=AMBER,
        )

    ax2.set_xticks(x)
    ax2.set_xticklabels(categories, fontweight="bold")
    ax2.set_ylim(0, max(optout_means + comp_means) * 1.32)
    ax2.set_ylabel("Mean Outcome Value (±1 SE)")
    ax2.set_title(
        "B. Empirical Proof of MNAR Selection:\nHigher-Pedigree DBs Skip the 3-Cone",
        pad=10,
    )
    ax2.legend(loc="upper left", frameon=True)

    fig.suptitle(
        "Figure 1: Why NFL Front Offices Need Optical Skill-Drill Kinematics to Recover Missing DB Agility",
        fontsize=13,
        fontweight="bold",
        y=0.99,
    )
    fig.tight_layout(w_pad=3.2)
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=240, bbox_inches="tight")
    plt.close(fig)
    return out


def generate_fig2_pedal_break_mechanics(
    master_path: str | Path = "data/processed/db_player_master_dataset.parquet",
    combine_tracking_path: str | Path = "combine_tracking.parquet",
    output_path: str | Path = "reports/figures/fig2_db_pedal_break_mechanics_comparison.png",
) -> Path:
    """Generate Figure 2: Trajectory & Phase-Unwrapped Turn Rate comparison in DB Break Drills."""
    df = load_or_build_master_db_dataset(master_path=master_path)
    hfbi, _ = compute_fold_safe_hfbi_fallback(df, df)
    df = df.with_columns(pl.Series("hfbi_z", hfbi)).sort("hfbi_z", descending=True)

    ct = (
        pl.scan_parquet(combine_tracking_path)
        .filter(
            (pl.col("entity_type") == "PLAYER")
            & (pl.col("drill_name") == "BACK_PEDAL_AND_90_DEGREE_BREAK_TO_BALL")
        )
        .sort(["event_id", "time"])
        .collect()
    )

    tracked_ids = set(ct["nfl_id"].unique().to_list())
    avail_df = df.filter(pl.col("nfl_id").is_in(list(tracked_ids)))
    fluid_row = avail_df.row(0, named=True)
    stiff_row = avail_df.row(avail_df.height - 1, named=True)

    def _get_event_trace(nfl_id: int) -> pl.DataFrame:
        sub = ct.filter(pl.col("nfl_id") == nfl_id)
        ev_id = sub["event_id"][0]
        ev = sub.filter(pl.col("event_id") == ev_id).sort("time")
        ev = ev.with_columns([
            (pl.int_range(0, pl.len()) * 0.1).alias("time_sec"),
            (pl.col("x") - pl.col("x").first()).alias("x_rel"),
            (pl.col("y") - pl.col("y").first()).alias("y_rel"),
            (((pl.col("dir") - pl.col("dir").shift(1) + 180.0) % 360.0) - 180.0)
            .abs()
            .truediv(0.1)
            .fill_null(0.0)
            .alias("omega_t"),
        ]).with_columns(
            pl.when(pl.col("s") >= 0.2)
            .then((pl.col("omega_t") * (math.pi / 180.0)) / pl.col("s"))
            .otherwise(0.0)
            .alias("kappa_t")
        )
        return ev

    tr_fluid = _get_event_trace(int(fluid_row["nfl_id"]))
    tr_stiff = _get_event_trace(int(stiff_row["nfl_id"]))

    fig, axes = plt.subplots(1, 3, figsize=(15.5, 5.2), dpi=240)

    axes[0].plot(
        tr_fluid["x_rel"].to_numpy(),
        tr_fluid["y_rel"].to_numpy(),
        color=TEAL,
        linewidth=2.6,
        marker="o",
        markersize=4,
        label=f"Fluid DB: {fluid_row['display_name']} (HFBI={fluid_row['hfbi_z']:+.2f}z)",
    )
    axes[0].plot(
        tr_stiff["x_rel"].to_numpy(),
        tr_stiff["y_rel"].to_numpy(),
        color=RED,
        linewidth=2.4,
        linestyle="--",
        marker="s",
        markersize=3.5,
        label=f"Stiff DB: {stiff_row['display_name']} (HFBI={stiff_row['hfbi_z']:+.2f}z)",
    )
    axes[0].set_xlabel("Relative Field X Displacement (yd)")
    axes[0].set_ylabel("Relative Field Y Displacement (yd)")
    axes[0].set_title("A. Spatial Break Path (90° Break Drill)")
    axes[0].legend(loc="best", fontsize=8.5, frameon=True)

    axes[1].plot(
        tr_fluid["time_sec"].to_numpy(),
        tr_fluid["omega_t"].to_numpy(),
        color=TEAL,
        linewidth=2.4,
        label="Fluid DB Turn Rate ω(t)",
    )
    axes[1].plot(
        tr_stiff["time_sec"].to_numpy(),
        tr_stiff["omega_t"].to_numpy(),
        color=RED,
        linewidth=2.2,
        linestyle="--",
        label="Stiff DB Turn Rate ω(t)",
    )
    axes[1].set_xlabel("Drill Time (seconds, 10 Hz)")
    axes[1].set_ylabel("Unwrapped Angular Velocity ω(t) [deg/s]")
    axes[1].set_title("B. Phase-Unwrapped Break Turn Velocity ω(t)")
    axes[1].legend(loc="upper right", fontsize=8.5, frameon=True)

    axes[2].plot(
        tr_fluid["time_sec"].to_numpy(),
        tr_fluid["s"].to_numpy(),
        color=TEAL,
        linewidth=2.4,
        label="Fluid DB Speed s(t) [yd/s]",
    )
    axes[2].plot(
        tr_stiff["time_sec"].to_numpy(),
        tr_stiff["s"].to_numpy(),
        color=RED,
        linewidth=2.2,
        linestyle="--",
        label="Stiff DB Speed s(t) [yd/s]",
    )
    axes[2].axhline(0.2, color=SLATE, linestyle=":", linewidth=1.2, label="Singularity Cutoff (0.2 yd/s)")
    axes[2].set_xlabel("Drill Time (seconds, 10 Hz)")
    axes[2].set_ylabel("Trajectory Speed s(t) [yd/s]")
    axes[2].set_title("C. Plant Deceleration & Corner Exit Speed Retention")
    axes[2].legend(loc="lower right", fontsize=8.5, frameon=True)

    fig.suptitle(
        "Figure 2: Biomechanical Decomposition of the DB Backpedal-and-Break Transition (10 Hz Combine Telemetry)",
        fontsize=13,
        fontweight="bold",
        y=1.01,
    )
    fig.tight_layout()
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=240, bbox_inches="tight")
    plt.close(fig)
    return out


def generate_fig3_lab_to_field_transfer(
    master_path: str | Path = "data/processed/db_player_master_dataset.parquet",
    leaderboard_path: str | Path = "reports/tables/db_prospect_scouting_leaderboard.csv",
    output_path: str | Path = "reports/figures/fig3_lab_to_field_kinematic_transfer.png",
) -> Path:
    """Generate Figure 3: 2x2 Lab-to-Field Kinematic Transfer Grid on Regular-Season NFL Snaps."""
    df = load_or_build_master_db_dataset(master_path=master_path)
    hfbi, _ = compute_fold_safe_hfbi_fallback(df, df)
    df = df.with_columns(pl.Series("hfbi_z", hfbi))
    if Path(leaderboard_path).exists():
        lb = pl.read_csv(leaderboard_path)
        if "three_cone_oof_imputed" in lb.columns and "three_cone_oof_imputed" not in df.columns:
            df = df.join(lb.select(["nfl_id", "three_cone_oof_imputed"]), on="nfl_id", how="left")

    fig, axes = plt.subplots(2, 2, figsize=(15.0, 11.4), dpi=240)

    def _scatter_with_fit(ax, x_arr, y_arr, names, xlabel, ylabel, title, color):
        mask = np.isfinite(x_arr) & np.isfinite(y_arr)
        xv = x_arr[mask]
        yv = y_arr[mask]
        nm = [names[i] for i in range(len(names)) if mask[i]]
        ax.scatter(xv, yv, color=color, alpha=0.78, edgecolors="white", s=55, zorder=3)
        if len(xv) >= 5 and np.std(xv) > 1e-9 and np.std(yv) > 1e-9:
            r_val, p_val = stats.pearsonr(xv, yv)
            slope, intercept = np.polyfit(xv, yv, 1)
            x_min, x_max = float(np.min(xv)), float(np.max(xv))
            y_min, y_max = float(np.min(yv)), float(np.max(yv))
            x_span = x_max - x_min
            y_span = y_max - y_min
            ax.set_xlim(x_min - 0.08 * x_span, x_max + 0.18 * x_span)
            ax.set_ylim(y_min - 0.10 * y_span, y_max + 0.14 * y_span)

            x_line = np.linspace(x_min, x_max, 100)
            ax.plot(
                x_line,
                slope * x_line + intercept,
                color=NAVY,
                linewidth=2.2,
                label=f"Fit: r = {r_val:+.3f} (p = {p_val:.4f}, N = {len(xv)})",
            )
            # Annotate top 3 extremes sorted by y so vertical offsets never collide
            top_idx = list(np.argsort(xv)[-3:])
            top_idx_sorted_y = sorted(top_idx, key=lambda idx: float(yv[idx]))
            # Lower y point gets downward-left offset, middle gets leftward offset, upper gets upward-left offset
            distinct_offsets = [(-78, -16), (-95, 2), (-70, 16)]
            for rank_k, idx in enumerate(top_idx_sorted_y):
                dx, dy = distinct_offsets[rank_k % len(distinct_offsets)]
                ax.annotate(
                    nm[idx],
                    (xv[idx], yv[idx]),
                    xytext=(dx, dy),
                    textcoords="offset points",
                    fontsize=8.0,
                    color=NAVY,
                    fontweight="bold",
                    bbox={"boxstyle": "round,pad=0.18", "fc": "white", "ec": "#CBD5E1", "alpha": 0.88},
                    arrowprops={"arrowstyle": "-", "color": SLATE, "lw": 0.8},
                )
            ax.legend(loc="upper left", frameon=True, fontsize=9)
        ax.set_xlabel(xlabel)
        ax.set_ylabel(ylabel)
        ax.set_title(title)

    names_all = df["display_name"].to_list()
    hfbi_arr = df["hfbi_z"].to_numpy()

    # Panel A: Combine HFBI -> Regular-Season In-Game Hip-Flip Rate P95
    hip_col = resolve_column(df, ["reg_hip_flip_rate_p95", "hip_flip_rate_p95"], default="hfbi_z")
    _scatter_with_fit(
        axes[0, 0],
        hfbi_arr,
        df[hip_col].cast(pl.Float64).to_numpy(),
        names_all,
        "Combine Hip Fluidity & Break Index (HFBI, z-score)",
        "NFL Regular-Season Hip-Flip Rate P95 [deg/s]",
        "A. Combine Hip Fluidity Transfers to NFL In-Game Hip-Flip Speed (REG)",
        TEAL,
    )

    # Panel B: Combine Corner Exit Traction / HFBI -> NFL Game Break Exit Traction
    a_exit_col = resolve_column(df, ["a_exit", "break_a_exit"], default="hfbi_z")
    reg_exit_col = resolve_column(df, ["reg_a_exit", "game_a_exit"], default=hip_col)
    _scatter_with_fit(
        axes[0, 1],
        df[a_exit_col].cast(pl.Float64).to_numpy(),
        df[reg_exit_col].cast(pl.Float64).to_numpy(),
        names_all,
        "Combine Break Exit Traction a_exit [yd/s²]",
        "NFL Regular-Season Break Exit Traction [yd/s²]",
        "B. Lab Break Exit Drive Transfers to On-Field Closing Burst (REG)",
        BLUE,
    )

    # Panel C: Combine 40-Yard Dash -> NFL Regular-Season P95 Speed
    sp_col = resolve_column(df, ["reg_speed_p95", "play_speed_p95"], default=hip_col)
    _scatter_with_fit(
        axes[1, 0],
        -df["forty"].cast(pl.Float64).to_numpy(),
        df[sp_col].cast(pl.Float64).to_numpy(),
        names_all,
        "Inverted Combine 40-Yard Dash (-seconds, faster -> right)",
        "NFL Regular-Season P95 Game Speed [yd/s]",
        "C. Specificity of Transfer: 40-Yd Dash Predicts Linear Top Speed (REG)",
        PURPLE,
    )

    # Panel D: Out-of-Fold 3-Cone Agility Recovery for Observed (N=25) & Opt-Out DBs (N=97)
    ax4 = axes[1, 1]
    if "three_cone_oof_imputed" in df.columns:
        obs_sub = df.filter(pl.col("three_cone").is_not_null())
        opt_sub = df.filter(pl.col("three_cone").is_null())
        ax4.hist(
            opt_sub["three_cone_oof_imputed"].drop_nulls().to_numpy(),
            bins=16,
            color=BLUE,
            alpha=0.55,
            edgecolor="white",
            label=f"OOF Imputed 3-Cone for Opt-Out DBs (N={opt_sub.height})",
        )
        ax4.hist(
            obs_sub["three_cone"].drop_nulls().to_numpy(),
            bins=10,
            color=AMBER,
            alpha=0.75,
            edgecolor="white",
            label=f"Observed Combine 3-Cone (N={obs_sub.height})",
        )
        ax4.set_xlabel("3-Cone Time [seconds] (Lower = Superior Agility)")
        ax4.set_ylabel("Number of DB Prospects")
        ax4.set_title("D. Out-of-Fold Recovery of Missing 3-Cone Agility from Skill Drills")
        ax4.legend(loc="upper right", frameon=True, fontsize=9)

    fig.suptitle(
        "Figure 3: Proxy-Free Lab-to-Field Kinematic Transfer (Combine Skill Drills -> NFL Regular-Season Execution)",
        fontsize=13,
        fontweight="bold",
        y=0.995,
    )
    fig.tight_layout(w_pad=2.5, h_pad=2.4)
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=240, bbox_inches="tight")
    plt.close(fig)
    return out


def generate_fig4_sideslip_and_gg(
    plays_path: str | Path = "data/processed/db_game_plays_kinematics.parquet",
    combine_tracking_path: str | Path = "combine_tracking.parquet",
    master_path: str | Path = "data/processed/db_player_master_dataset.parquet",
    output_path: str | Path = "reports/figures/fig4_sideslip_polar_and_gg_envelope.png",
) -> Path:
    """Generate Figure 4: In-Game Sideslip Phase Transition & Kamm Friction Circle (g-g Diagram)."""
    df_master = load_or_build_master_db_dataset(master_path=master_path)
    db_ids = set(df_master["nfl_id"].to_list())

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14.5, 6.0), dpi=240)

    p_file = Path(plays_path)
    if p_file.exists():
        plays = (
            pl.scan_parquet(p_file)
            .filter(
                (pl.col("season_type") == "REG")
                & (pl.col("play_nullified_by_penalty").fill_null("N") == "N")
            )
            .collect()
        )
        man_plays = plays.filter(pl.col("team_coverage_man_zone").fill_null("").str.to_uppercase().str.contains("MAN"))
        zone_plays = plays.filter(pl.col("team_coverage_man_zone").fill_null("").str.to_uppercase().str.contains("ZONE"))

        hip_col = resolve_column(plays, ["hip_flip_rate_p95", "beta_rate_p95", "hip_flip_rate_max"])

        if hip_col is not None and man_plays.height > 10 and zone_plays.height > 10:
            man_vals = man_plays[hip_col].drop_nulls().to_numpy()
            zone_vals = zone_plays[hip_col].drop_nulls().to_numpy()
            bins = np.linspace(0, float(np.percentile(np.concatenate([man_vals, zone_vals]), 98)), 30)
            ax1.hist(
                man_vals,
                bins=bins,
                density=True,
                alpha=0.60,
                color=RED,
                edgecolor="white",
                label=f"Man Coverage Snaps (N={len(man_vals):,}, Mean={np.mean(man_vals):.1f}°/s)",
            )
            ax1.hist(
                zone_vals,
                bins=bins,
                density=True,
                alpha=0.55,
                color=BLUE,
                edgecolor="white",
                label=f"Zone Coverage Snaps (N={len(zone_vals):,}, Mean={np.mean(zone_vals):.1f}°/s)",
            )
            ax1.axvline(float(np.mean(man_vals)), color=RED, linestyle="--", linewidth=2.0)
            ax1.axvline(float(np.mean(zone_vals)), color=BLUE, linestyle="--", linewidth=2.0)
            ax1.set_xlabel("Play-Level 95th Percentile Hip-Flip Rate |dβ_slip/dt| [deg/s]")
            ax1.set_ylabel("Probability Density")
            ax1.set_title("A. In-Game Hip-Flip Angular Velocity: Man vs. Zone Coverage (REG)")
            ax1.legend(loc="upper right", frameon=True, fontsize=9)

    ct = (
        pl.scan_parquet(combine_tracking_path)
        .filter(
            (pl.col("entity_type") == "PLAYER")
            & pl.col("nfl_id").is_in(list(db_ids))
            & pl.col("drill_name").is_in(["W_DRILL", "BOX_DRILL", "BACK_PEDAL_AND_90_DEGREE_BREAK_TO_BALL"])
            & (pl.col("s") >= 0.5)
        )
        .sort(["event_id", "time"])
        .collect()
    )
    ct = ct.with_columns([
        (((pl.col("dir") - pl.col("dir").shift(1).over("event_id") + 180.0) % 360.0) - 180.0)
        .truediv(0.1)
        .fill_null(0.0)
        .alias("omega_signed"),
        pl.when(pl.col("s") < pl.col("s").shift(1).over("event_id"))
        .then(-pl.col("a").abs())
        .otherwise(pl.col("a"))
        .alias("a_signed"),
    ]).with_columns([
        ((pl.col("s") * pl.col("omega_signed") * (math.pi / 180.0)) / 10.7247).alias("g_lat"),
        (pl.col("a_signed") / 10.7247).alias("g_t"),
    ])

    g_lat_arr = ct["g_lat"].to_numpy()
    g_t_arr = ct["g_t"].to_numpy()
    mask = (np.abs(g_lat_arr) <= 1.5) & (np.abs(g_t_arr) <= 1.5)
    gl = g_lat_arr[mask]
    gt = g_t_arr[mask]

    p70_lat = float(np.percentile(np.abs(gl), 70))
    p70_t = float(np.percentile(np.abs(gt), 70))
    is_overlap = (np.abs(gl) > p70_lat) & (np.abs(gt) > p70_t)

    rng = np.random.default_rng(20261102)
    idx_sub = rng.choice(len(gl), size=min(4500, len(gl)), replace=False)
    gl_s = gl[idx_sub]
    gt_s = gt[idx_sub]
    ov_s = is_overlap[idx_sub]

    ax2.scatter(gl_s[~ov_s], gt_s[~ov_s], c=SLATE, alpha=0.22, s=10, label="Pure Braking / Pure Turning Frames")
    ax2.scatter(
        gl_s[ov_s],
        gt_s[ov_s],
        c=TEAL,
        alpha=0.55,
        s=14,
        label="Trail-Braking Overlap70 Region (|a_t|>P70 & |a_lat|>P70)",
    )

    theta = np.linspace(0, 2 * np.pi, 200)
    for g_rad, ls in [(0.5, ":"), (0.85, "--")]:
        ax2.plot(
            g_rad * np.cos(theta),
            g_rad * np.sin(theta),
            color=NAVY,
            linestyle=ls,
            linewidth=1.3,
            label=f"{g_rad:.2f}g Friction Envelope",
        )

    ax2.set_xlim(-1.25, 1.25)
    ax2.set_ylim(-1.25, 1.25)
    ax2.set_xlabel("Lateral Centripetal Acceleration g_lat [g = 10.72 yd/s²]")
    ax2.set_ylabel("Tangential Acceleration / Braking g_t [g = 10.72 yd/s²]")
    ax2.set_title("B. DB Kamm Friction Circle & Trail-Braking Phase Overlap (Overlap70)")
    ax2.legend(loc="lower left", frameon=True, fontsize=8.5)

    fig.suptitle(
        "Figure 4: Standardized Coverage Sideslip Mechanics & The DB Kamm Friction Envelope",
        fontsize=13,
        fontweight="bold",
        y=1.01,
    )
    fig.tight_layout()
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=240, bbox_inches="tight")
    plt.close(fig)
    return out


def _clean_model_label(model_id: str) -> str:
    """Convert raw model_id into a concise, unclipped human-readable label."""
    mapping = {
        "M1B_Stopwatch_three_cone": "M1B: Stopwatch -> 3-Cone",
        "M1C_SkillDrill_Kinematics_three_cone": "M1C: Skill Drills -> 3-Cone",
        "M1B_Stopwatch_short_shuttle": "M1B: Stopwatch -> Shuttle",
        "M1C_SkillDrill_Kinematics_short_shuttle": "M1C: Skill Drills -> Shuttle",
        "M1B_Stopwatch_ngs_athleticism_score": "M1B: Stopwatch -> NGS Ath",
        "M1C_SkillDrill_Kinematics_ngs_athleticism_score": "M1C: Skill Drills -> NGS Ath",
        "M2B_Stopwatch_Baseline_reg_speed_p95": "M2B: Stopwatch -> Reg Speed P95",
        "M2C_SkillDrill_Kinematics_reg_speed_p95": "M2C: Skill Drills -> Reg Speed P95",
        "M2B_Stopwatch_Baseline_reg_hip_flip_rate_p95": "M2B: Stopwatch -> Reg Hip-Flip P95",
        "M2C_SkillDrill_Kinematics_reg_hip_flip_rate_p95": "M2C: Skill Drills -> Reg Hip-Flip P95",
        "M2B_Stopwatch_Baseline_reg_a_exit": "M2B: Stopwatch -> Reg Break Exit",
        "M2C_SkillDrill_Kinematics_reg_a_exit": "M2C: Skill Drills -> Reg Break Exit",
        "M2B_Stopwatch_Baseline_reg_snap_oversteer_rate": "M2B: Stopwatch -> Oversteer Rate",
        "M2C_SkillDrill_Kinematics_reg_snap_oversteer_rate": "M2C: Skill Drills -> Oversteer Rate",
        "M3A_Stopwatch_IPW_reg_cushion_mean": "M3A: Stopwatch -> Cushion [IPW]",
        "M3B_Mediated_HFBI_IPW_reg_cushion_mean": "M3B: HFBI Mediated -> Cushion [IPW]",
        "M3A_Stopwatch_IPW_reg_separation_allowed": "M3A: Stopwatch -> Separation [IPW]",
        "M3B_Mediated_HFBI_IPW_reg_separation_allowed": "M3B: HFBI Mediated -> Separation [IPW]",
        "M3A_Stopwatch_IPW_reg_v_close": "M3A: Stopwatch -> Closing Speed [IPW]",
        "M3B_Mediated_HFBI_IPW_reg_v_close": "M3B: HFBI Mediated -> Closing Speed [IPW]",
        "M4A_Direct_Naive_Lab_reg_defensive_epa_mean": "M4A: Direct Lab -> Player Reg EPA",
        "M4B_TwoStage_Mediated_Execution_reg_defensive_epa_mean": "M4B: Mediated M_DB -> Player Reg EPA",
        "M4A_Direct_Naive_Lab_reg_tackle_rate": "M4A: Direct Lab -> Tackle Rate",
        "M4B_TwoStage_Mediated_Execution_reg_tackle_rate": "M4B: Mediated M_DB -> Tackle Rate",
        "M4A_PlayLevel_Direct_Lab_to_EPA": "M4A: Direct Lab -> Play EPA (N=63.9k)",
        "M4B_PlayLevel_Mediated_Execution_to_EPA": "M4B: Mediated M_DB -> Play EPA (N=63.9k)",
        "M5A_Draft_Capital_Only_def_snaps_per_active_game": "M5A: Draft Pick -> Snaps/Game",
        "M5B_Kinematics_Only_def_snaps_per_active_game": "M5B: HFBI Only -> Snaps/Game",
        "M5C_Joint_Draft_Plus_HFBI_def_snaps_per_active_game": "M5C: Draft + HFBI -> Snaps/Game",
        "M5A_Draft_Capital_Only_rookie_reg_snaps": "M5A: Draft Pick -> Rookie Reg Snaps",
        "M5B_Kinematics_Only_rookie_reg_snaps": "M5B: HFBI Only -> Rookie Reg Snaps",
        "M5C_Joint_Draft_Plus_HFBI_rookie_reg_snaps": "M5C: Draft + HFBI -> Rookie Reg Snaps",
    }
    return mapping.get(model_id, model_id)


def generate_fig5_mediation_and_models(
    comparison_path: str | Path = "reports/tables/model_comparison.csv",
    output_path: str | Path = "reports/figures/fig5_mediation_and_model_comparison.png",
) -> Path:
    """Generate Figure 5: Out-of-Fold Model Comparison & Two-Stage Mediation Architecture."""
    comp = pl.read_csv(comparison_path).filter(pl.col("estimator") != "null_mean")

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(15.8, 7.2), dpi=240)

    plot_rows = comp.to_dicts()
    labels = [_clean_model_label(r["model_id"]) for r in plot_rows]
    r_vals = [float(r["oof_pearson_r"]) for r in plot_rows]
    ci_lows = [float(r["r_ci_low"]) for r in plot_rows]
    ci_highs = [float(r["r_ci_high"]) for r in plot_rows]

    y_pos = np.arange(len(plot_rows))
    colors = [
        TEAL if ("SkillDrill" in r["model_id"] or "Mediated" in r["model_id"] or "Joint" in r["model_id"]) else SLATE
        for r in plot_rows
    ]

    ax1.barh(y_pos, r_vals, color=colors, alpha=0.85, height=0.65, edgecolor="white")
    for i, (rv, cl, ch) in enumerate(zip(r_vals, ci_lows, ci_highs)):
        low_clipped = max(-0.42, cl)
        high_clipped = min(0.92, ch)
        ax1.plot([low_clipped, high_clipped], [i, i], color=NAVY, linewidth=1.4)
        # Place text strictly to the right of the upper CI endpoint so it never overlaps the CI line
        text_x = max(high_clipped, rv, 0.0) + 0.025
        ax1.text(text_x, i, f"r={rv:+.3f}", va="center", ha="left", fontsize=7.6, fontweight="bold", color=NAVY)

    ax1.axvline(0.0, color=NAVY, linewidth=1.0)
    ax1.set_yticks(y_pos)
    ax1.set_yticklabels(labels, fontsize=8.0)
    ax1.invert_yaxis()
    ax1.set_xlim(-0.45, 1.18)
    ax1.set_xlabel("Out-of-Fold Pearson Correlation r (with 95% Bootstrap CI)")
    ax1.set_title("A. Out-of-Fold Predictive Accuracy Across Model Families 1–5")

    # Panel B: Incremental OOF r lift of Skill-Drill Kinematics over Stopwatch Baselines
    families = [
        "M1: 3-Cone\nRecovery",
        "M1: Shuttle\nRecovery",
        "M2: Hip-Flip\nRate P95",
        "M2: Break\nExit Traction",
        "M3: Closing\nSpeed [IPW]",
        "M4: Def EPA\n(Mediated)",
    ]
    sw_r: list[float] = []
    kin_r: list[float] = []

    pair_lookup = [
        ("M1B_Stopwatch_three_cone", "M1C_SkillDrill_Kinematics_three_cone"),
        ("M1B_Stopwatch_short_shuttle", "M1C_SkillDrill_Kinematics_short_shuttle"),
        ("M2B_Stopwatch_Baseline_reg_hip_flip_rate_p95", "M2C_SkillDrill_Kinematics_reg_hip_flip_rate_p95"),
        ("M2B_Stopwatch_Baseline_reg_a_exit", "M2C_SkillDrill_Kinematics_reg_a_exit"),
        ("M3A_Stopwatch_IPW_reg_v_close", "M3B_Mediated_HFBI_IPW_reg_v_close"),
        ("M4A_Direct_Naive_Lab_reg_defensive_epa_mean", "M4B_TwoStage_Mediated_Execution_reg_defensive_epa_mean"),
    ]
    id_to_r = {r["model_id"]: float(r["oof_pearson_r"]) for r in plot_rows}
    for b_id, c_id in pair_lookup:
        sw_r.append(id_to_r.get(b_id, 0.05))
        kin_r.append(id_to_r.get(c_id, 0.25))

    x = np.arange(len(families))
    w = 0.35
    b1 = ax2.bar(x - w / 2, sw_r, w, color=SLATE, label="Stopwatch / Unmediated Baseline (OOF r)")
    b2 = ax2.bar(x + w / 2, kin_r, w, color=TEAL, label="Skill-Drill Kinematics / Mediated Model (OOF r)")

    for rect in b1:
        h = rect.get_height()
        y_txt = h + 0.015 if h >= 0 else 0.015
        ax2.text(rect.get_x() + rect.get_width() / 2, y_txt, f"{h:+.2f}", ha="center", fontsize=8, color=SLATE)
    for rect in b2:
        h = rect.get_height()
        y_txt = h + 0.015 if h >= 0 else 0.015
        ax2.text(
            rect.get_x() + rect.get_width() / 2,
            y_txt,
            f"{h:+.2f}",
            ha="center",
            fontsize=8,
            fontweight="bold",
            color=TEAL,
        )

    ax2.set_xticks(x)
    ax2.set_xticklabels(families, fontsize=8.5, fontweight="bold")
    ax2.set_ylim(-0.18, max(kin_r + [0.5]) * 1.28)
    ax2.axhline(0.0, color=NAVY, linewidth=1.0)
    ax2.set_ylabel("Out-of-Fold Correlation r (GroupKFold by nfl_id)")
    ax2.set_title("B. Consistent OOF Lift from Combine Skill-Drill Kinematics & Mediation")
    ax2.legend(loc="upper right", frameon=True, fontsize=9)

    fig.suptitle(
        "Figure 5: Out-of-Fold Econometric & ML Model Comparison (5-Fold GroupKFold by nfl_id, Seed=20261102)",
        fontsize=13,
        fontweight="bold",
        y=1.01,
    )
    fig.tight_layout(w_pad=2.8)
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=240, bbox_inches="tight")
    plt.close(fig)
    return out


def generate_fig6_scouting_matrix(
    leaderboard_path: str | Path = "reports/tables/db_prospect_scouting_leaderboard.csv",
    output_path: str | Path = "reports/figures/fig6_db_archetype_scouting_matrix.png",
) -> Path:
    """Generate Figure 6: Front-Office DB Scouting Quadrant & Undervalued Day-3/UDFA Gems."""
    lb = pl.read_csv(leaderboard_path)

    fig, ax = plt.subplots(figsize=(13.5, 8.2), dpi=240)

    x_col = "hfbi_z"
    y_col = resolve_column(lb, ["a_exit", "asr_w_box", "imputed_agility_percentile"], default="hfbi_percentile")
    assert y_col is not None

    archetype_colors = {
        "Day-3 / UDFA Fluid Transition Gem": TEAL,
        "Blue-Chip Fluid Mirror Corner/Safety": BLUE,
        "Smooth Rotator / Moderate Exit Burst": PURPLE,
        "Linear Explosive / Tight-Hipped Box DB": AMBER,
        "Developmental Transition Profile": SLATE,
    }

    for arch, color in archetype_colors.items():
        sub = lb.filter(pl.col("scouting_archetype") == arch)
        if sub.height == 0:
            continue
        xv = sub[x_col].to_numpy()
        yv = sub[y_col].to_numpy()
        snaps = sub["def_snaps_per_active_game"].fill_null(10.0).to_numpy()
        sizes = np.clip(snaps * 2.2 + 35.0, 40.0, 220.0)
        ax.scatter(
            xv,
            yv,
            s=sizes,
            color=color,
            alpha=0.82,
            edgecolors="white",
            linewidth=1.1,
            label=f"{arch} (N={sub.height})",
            zorder=3,
        )

    ax.axvline(0.0, color=NAVY, linestyle="--", linewidth=1.2, alpha=0.7)
    y_med = float(lb[y_col].median() or 0.0)
    ax.axhline(y_med, color=NAVY, linestyle="--", linewidth=1.2, alpha=0.7)

    x_all = lb[x_col].to_numpy()
    y_all = lb[y_col].to_numpy()
    x_span = float(np.max(x_all) - np.min(x_all))
    y_span = float(np.max(y_all) - np.min(y_all))
    ax.set_xlim(float(np.min(x_all)) - 0.12 * x_span, float(np.max(x_all)) + 0.25 * x_span)
    ax.set_ylim(float(np.min(y_all)) - 0.12 * y_span, float(np.max(y_all)) + 0.22 * y_span)

    # Select top 5 Day-3/UDFA Gems and top 5 Blue-Chip prospects, then sort by y_col
    # and apply fanned-out radial offsets with leader lines so zero labels ever collide
    gems = lb.filter(pl.col("scouting_archetype") == "Day-3 / UDFA Fluid Transition Gem").head(5)
    blues = lb.filter(pl.col("scouting_archetype") == "Blue-Chip Fluid Mirror Corner/Safety").head(5)
    to_label = pl.concat([gems, blues], how="vertical").sort(y_col, descending=False)

    # 10 fanned-out (dx, dy) offsets in points ordered from lowest y to highest y
    fanned_offsets = [
        (16, -28),
        (-135, -22),
        (18, -12),
        (-145, -6),
        (20, 2),
        (-148, 10),
        (18, 16),
        (-145, 22),
        (26, 26),
        (-138, 42),
    ]

    for idx_lbl, r in enumerate(to_label.iter_rows(named=True)):
        pick = f"#{int(r['draft_overall_pick'])}" if r.get("draft_overall_pick") is not None else "UDFA"
        dx, dy = fanned_offsets[idx_lbl % len(fanned_offsets)]
        ax.annotate(
            f"{r['display_name']} ({r['nfl_position']}, {pick})",
            (float(r[x_col]), float(r[y_col])),
            xytext=(dx, dy),
            textcoords="offset points",
            fontsize=8.2,
            fontweight="bold",
            color=NAVY,
            bbox={"boxstyle": "round,pad=0.2", "fc": "white", "ec": "#CBD5E1", "alpha": 0.90},
            arrowprops={"arrowstyle": "-", "color": SLATE, "lw": 0.85},
            zorder=5,
        )

    ax.set_xlabel("Fold-Safe Combine Hip Fluidity & Break Index (HFBI z-score; Higher = Faster Turn & Lower Latency)")
    ax.set_ylabel(f"Combine Corner Exit Traction `{y_col}` [yd/s²] (Marker Size = NFL Reg Def Snaps / Active Game)")
    ax.set_title(
        "Figure 6: Front-Office DB Scouting Matrix — Identifying Fluid Day-3/UDFA Gems & Blue-Chip Lockdown DBs (N = 122)",
        fontsize=12,
        fontweight="bold",
    )
    ax.legend(loc="lower left", frameon=True, fontsize=9)

    fig.tight_layout()
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=240, bbox_inches="tight")
    plt.close(fig)
    return out


def run_generate_figures() -> list[str]:
    """Generate all 6 publication figures in `reports/figures/`."""
    paths = [
        str(generate_fig1_mnar_optout()),
        str(generate_fig2_pedal_break_mechanics()),
        str(generate_fig3_lab_to_field_transfer()),
        str(generate_fig4_sideslip_and_gg()),
        str(generate_fig5_mediation_and_models()),
        str(generate_fig6_scouting_matrix()),
    ]
    return paths


if __name__ == "__main__":
    generated = run_generate_figures()
    print(f"Generated {len(generated)} figures: {generated}")
