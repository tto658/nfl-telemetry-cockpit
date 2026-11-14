"""Phase 6B: NFL In-Game Biomechanical Feature Engineering for Defensive Backs.

Streams across `game_tracking_2023.parquet`, `game_tracking_2024.parquet`, and
`game_tracking_2025.parquet` for all 122 Combine DBs (`118` active NFL DBs, `4` zero-snap DBs),
applies canonical play-direction coordinate standardization (`play_direction == 'left'`),
and extracts per-snap and player-aggregated Sideslip, Hip-Flip, Snap Oversteer,
Cushion, Co-Tracked Separation, Closing Speed, and Right-Censoring-Normalized Career Metrics.

Every feature transformation adheres to AGENT.md Phase 6 documentation requirements:
- Mathematical definition
- Input columns
- Units
- Temporal window
- Edge handling
- Missing-value behavior
- Leakage risk

Outputs:
- `data/processed/db_game_plays_kinematics.parquet`: Play-level (`game_id, play_id, nfl_id`) dataset
- `data/processed/db_player_master_dataset.parquet`: Subject-level (`nfl_id`, N=122) master dataset
"""

from __future__ import annotations

import math
from pathlib import Path

import polars as pl

from src.web.kinematics import G_CONST_YD

FIELD_LENGTH_YARDS: float = 120.0
FIELD_WIDTH_YARDS: float = 53.3333


def standardize_play_direction_coordinates(
    df: pl.DataFrame | pl.LazyFrame,
) -> pl.LazyFrame:
    """Apply canonical play-direction reflection when `play_direction == 'left'`.

    Mathematical Definition:
        When offensive play progression is right-to-left (`play_direction == 'left'`),
        coordinates and compass angles ($0^\\circ = +y$, $90^\\circ = +x$) are reflected
        through the field center so all offensive plays progress toward $+x$ ($90^\\circ$):
        $$x_{\\text{std}} = 120.0 - x, \\qquad y_{\\text{std}} = 53.3333 - y$$
        $$\\text{dir}_{\\text{std}} = (\\text{dir} + 180^\\circ) \\bmod 360^\\circ, \\qquad o_{\\text{std}} = (o + 180^\\circ) \\bmod 360^\\circ$$
        When `play_direction != 'left'`, $(x_{\\text{std}}, y_{\\text{std}}, \\text{dir}_{\\text{std}}, o_{\\text{std}}) = (x, y, \\text{dir} \\bmod 360^\\circ, o \\bmod 360^\\circ)$.

    Input Columns:
        `x` (Float64), `y` (Float64), `dir` (Float64), `o` (Float64), `play_direction` (String).
    Units:
        `x_std`, `y_std`: yards; `dir_std`, `o_std`: degrees in $[0, 360)$.
    Temporal Window:
        Instantaneous frame-level spatial transformation.
    Edge Handling:
        Angles outside $[0, 360)$ wrap cleanly via modulo $360.0$. Relative angular metrics
        ($\\beta_{\\text{slip}}$ and $\\omega_t$) are mathematically invariant under $180^\\circ$ rotation.
    Missing-Value Behavior:
        Null `play_direction` defaults to unreflected coordinates; null `o` or `dir` remains null.
    Leakage Risk:
        None. Play direction is known at ball snap (`ball_snap`).
    """
    lf = df.lazy() if isinstance(df, pl.DataFrame) else df
    is_left = pl.col("play_direction").fill_null("right").str.to_lowercase() == "left"

    return lf.with_columns([
        pl.when(is_left).then(FIELD_LENGTH_YARDS - pl.col("x")).otherwise(pl.col("x")).alias("x_std"),
        pl.when(is_left).then(FIELD_WIDTH_YARDS - pl.col("y")).otherwise(pl.col("y")).alias("y_std"),
        pl.when(is_left)
        .then((pl.col("dir") + 180.0) % 360.0)
        .otherwise(pl.col("dir") % 360.0)
        .alias("dir_std"),
        pl.when(is_left)
        .then((pl.col("o") + 180.0) % 360.0)
        .otherwise(pl.col("o") % 360.0)
        .alias("o_std"),
    ])


def compute_game_frame_kinematics(
    df: pl.DataFrame | pl.LazyFrame,
    dt: float = 0.1,
    singularity_threshold: float = 0.2,
    g_const: float = G_CONST_YD,
) -> pl.LazyFrame:
    """Compute vectorized in-game sideslip, hip-flip rate, curvature, G-force, and snap oversteer.

    Mathematical Definition:
        - Sideslip angle:
          $$\\beta_{\\text{slip}, t} = ((\\text{dir}_{\\text{std}, t} - o_{\\text{std}, t} + 180^\\circ) \\bmod 360^\\circ) - 180^\\circ \\in [-180^\\circ, 180^\\circ]$$
        - Unwrapped sideslip rate (Hip-Flip Rate):
          $$\\dot{\\beta}_{\\text{slip}, t} = \\frac{((\\beta_{\\text{slip}, t} - \\beta_{\\text{slip}, t-1} + 180^\\circ) \\bmod 360^\\circ) - 180^\\circ}{\\Delta t}$$
        - Unwrapped trajectory turn rate & curvature:
          $$\\omega_t = \\frac{|\\text{unwrap}(\\text{dir}_{\\text{std}, t} - \\text{dir}_{\\text{std}, t-1})|}{\\Delta t}, \\qquad \\kappa_t = \\mathbb{I}(s_t \\ge 0.2)\\frac{\\omega_t (\\pi/180^\\circ)}{s_t}$$
        - Snap Oversteer Indicator:
          $$\\text{SnapOversteer}_t = \\mathbb{I}\\left(s_t \\ge 1.0 \\;\\wedge\\; |\\dot{\\beta}_{\\text{slip}, t}| \\ge 100^\\circ/\\text{s} \\;\\wedge\\; |j_t| \\ge 6.0\\text{ yd/s}^3\\right)$$

    Input Columns:
        `game_id`, `play_id`, `nfl_id`, `time`, `x`, `y`, `s`, `a`, `dir`, `o`, `play_direction`.
    Units:
        `beta_slip`: deg; `beta_rate`, `omega_t`: deg/s; `kappa_t`: 1/yd; `jerk`: yd/s^3; `g_comb`: g.
    Temporal Window:
        Backward finite differences ($\\Delta t = 0.1\\text{ s}$) partitioned by `(game_id, play_id, nfl_id)`.
    Edge Handling:
        First frame of each play has zero angular rates and zero jerk; $\\kappa_t = 0$ for $s_t < 0.2$.
    Missing-Value Behavior:
        Frames with null orientation `o` yield null `beta_slip` and `False` for `snap_oversteer`.
    Leakage Risk:
        None. Strictly within-play backward differences.
    """
    lf = standardize_play_direction_coordinates(df)
    schema_names = set(lf.collect_schema().names())

    play_key = ["game_id", "play_id", "nfl_id"]
    has_play_key = all(k in schema_names for k in play_key)
    if has_play_key and "time" in schema_names:
        lf = lf.sort([*play_key, "time"])
    elif "time" in schema_names:
        lf = lf.sort("time")

    over_cols = play_key if has_play_key else None

    def _shift(col_name: str) -> pl.Expr:
        expr = pl.col(col_name).shift(1)
        return expr.over(over_cols) if over_cols else expr

    lf = lf.with_columns([
        pl.when(pl.col("dir_std").is_not_null() & pl.col("o_std").is_not_null())
        .then(((pl.col("dir_std") - pl.col("o_std") + 180.0) % 360.0) - 180.0)
        .otherwise(None)
        .alias("beta_slip"),
        pl.when(pl.col("dir_std").is_not_null() & _shift("dir_std").is_not_null())
        .then(((pl.col("dir_std") - _shift("dir_std") + 180.0) % 360.0) - 180.0)
        .otherwise(0.0)
        .alias("_delta_dir"),
        pl.when(pl.col("s").is_not_null() & _shift("s").is_not_null())
        .then((pl.col("s") - _shift("s")) / dt)
        .otherwise(0.0)
        .alias("ds_dt"),
    ])

    lf = lf.with_columns([
        pl.when(pl.col("beta_slip").is_not_null() & _shift("beta_slip").is_not_null())
        .then((((pl.col("beta_slip") - _shift("beta_slip") + 180.0) % 360.0) - 180.0) / dt)
        .otherwise(0.0)
        .alias("beta_rate"),
        (pl.col("_delta_dir").abs() / dt).alias("omega_t"),
        pl.when(pl.col("a") < 0.0)
        .then(pl.col("a"))
        .when(_shift("s").is_not_null() & (pl.col("s") < _shift("s")))
        .then(-pl.col("a").abs())
        .otherwise(pl.col("a").fill_null(0.0))
        .alias("a_t"),
        pl.when(_shift("a").is_not_null())
        .then((pl.col("a") - _shift("a")) / dt)
        .otherwise(0.0)
        .alias("jerk"),
    ])

    lf = lf.with_columns([
        pl.when(pl.col("s") >= singularity_threshold)
        .then((pl.col("omega_t") * (math.pi / 180.0)) / pl.col("s"))
        .otherwise(0.0)
        .alias("kappa_t"),
        pl.when(pl.col("s") >= 0.5)
        .then((pl.col("omega_t") * (math.pi / 180.0)) / pl.col("s"))
        .otherwise(0.0)
        .alias("kappa_t_s05"),
        (pl.col("s").fill_null(0.0) * (pl.col("omega_t") * (math.pi / 180.0))).alias("a_lat"),
        (
            (pl.col("s") >= 1.0)
            & (pl.col("beta_rate").abs() >= 100.0)
            & (pl.col("jerk").abs() >= 6.0)
            & pl.col("beta_slip").is_not_null()
        )
        .fill_null(False)
        .alias("snap_oversteer"),
    ])

    lf = lf.with_columns([
        ((pl.col("a_t").pow(2) + pl.col("a_lat").pow(2)).sqrt() / g_const).alias("g_comb"),
    ])

    return lf.drop("_delta_dir")


def _aggregate_season_tracking_to_plays(
    tracking_path: str | Path,
    db_ids: list[int],
    play_dir_lf: pl.LazyFrame,
) -> pl.DataFrame:
    """Stream a single season's game_tracking Parquet and aggregate to `(game_id, play_id, nfl_id)`."""
    play_key = ["game_id", "play_id", "nfl_id"]

    base_lf = (
        pl.scan_parquet(tracking_path)
        .filter(pl.col("nfl_id").is_in(db_ids))
        .join(play_dir_lf, on=play_key, how="left")
    )

    kin_lf = compute_game_frame_kinematics(base_lf, dt=0.1, singularity_threshold=0.2)

    # Tag frame index and key event frames (ball_snap, pass_forward, pass_arrived, first_contact, tackle)
    kin_lf = kin_lf.with_columns([
        pl.int_range(0, pl.len()).over(play_key).alias("_f_idx"),
        pl.len().over(play_key).alias("_n_frames"),
    ])

    kin_lf = kin_lf.with_columns([
        pl.when(pl.col("event") == "ball_snap").then(pl.col("_f_idx")).otherwise(None).min().over(play_key).alias("_snap_idx"),
        pl.when(pl.col("event").is_in(["pass_forward", "pass_shovel", "autoevent_passforward"]))
        .then(pl.col("_f_idx"))
        .otherwise(None)
        .min()
        .over(play_key)
        .alias("_pf_idx"),
        pl.when(pl.col("event").is_in(["pass_arrived", "autoevent_passinterrupted", "pass_outcome_caught", "pass_outcome_incomplete"]))
        .then(pl.col("_f_idx"))
        .otherwise(None)
        .min()
        .over(play_key)
        .alias("_pa_idx"),
        pl.when(pl.col("event").is_in(["first_contact", "tackle", "out_of_bounds", "touchdown"]))
        .then(pl.col("_f_idx"))
        .otherwise(None)
        .min()
        .over(play_key)
        .alias("_contact_idx"),
    ])

    # Define pre-throw window (ball_snap to pass_forward, or first 55% of play)
    # and break/closing window (pass_forward onward, or 45%..90% of play)
    pre_throw_cond = (
        (pl.col("_f_idx") >= pl.coalesce(["_snap_idx", pl.lit(0)]))
        & (
            pl.col("_f_idx")
            <= pl.coalesce(["_pf_idx", (pl.col("_n_frames") * 0.55).cast(pl.Int64)])
        )
    )
    closing_cond = (
        (
            pl.col("_f_idx")
            >= pl.coalesce(["_pf_idx", (pl.col("_n_frames") * 0.45).cast(pl.Int64)])
        )
        & (
            pl.col("_f_idx")
            <= pl.coalesce(["_contact_idx", (pl.col("_n_frames") * 0.92).cast(pl.Int64)])
        )
    )

    play_agg = (
        kin_lf.group_by(play_key)
        .agg([
            pl.len().alias("n_frames"),
            ((pl.len() - 1) * 0.1).alias("play_duration_sec"),
            # Pre-throw backpedal dwell fraction (|beta_slip| > 45 deg among active pre-throw frames s >= 0.5)
            (
                (pl.col("beta_slip").abs() > 45.0)
                .filter(pre_throw_cond & (pl.col("s") >= 0.5) & pl.col("beta_slip").is_not_null())
                .mean()
            )
            .fill_null(0.0)
            .alias("backpedal_dwell_frac"),
            # Mean absolute sideslip angle during pre-throw phase
            pl.col("beta_slip")
            .abs()
            .filter(pre_throw_cond & (pl.col("s") >= 0.5))
            .mean()
            .fill_null(0.0)
            .alias("pre_throw_beta_abs_mean"),
            # In-game Hip-Flip Rate (unwrapped |beta_rate| P95 and Max on active frames s >= 0.5)
            pl.col("beta_rate")
            .abs()
            .filter(pl.col("s") >= 0.5)
            .quantile(0.95)
            .fill_null(0.0)
            .alias("hip_flip_rate_p95"),
            pl.col("beta_rate")
            .abs()
            .filter(pl.col("s") >= 0.5)
            .max()
            .fill_null(0.0)
            .alias("hip_flip_rate_max"),
            # Snap Oversteer count and indicator
            pl.col("snap_oversteer").sum().cast(pl.Int64).alias("snap_oversteer_count"),
            (pl.col("snap_oversteer").sum() > 0).alias("has_snap_oversteer"),
            # Game Break Exit Traction (mean drive acceleration during closing/break transition)
            pl.col("a")
            .filter(closing_cond & (pl.col("s") >= 1.0) & (pl.col("a_t") >= 0.0))
            .quantile(0.80)
            .fill_null(pl.col("a").filter(pl.col("s") >= 1.0).quantile(0.80))
            .fill_null(0.0)
            .alias("game_a_exit"),
            # Game Closing Speed (peak/P90 speed during ball-flight / tackle closing window)
            pl.col("s")
            .filter(closing_cond)
            .quantile(0.90)
            .fill_null(pl.col("s").quantile(0.90))
            .fill_null(0.0)
            .alias("game_v_close"),
            # Pre-tackle / contact deceleration control
            pl.col("a_t")
            .filter(closing_cond)
            .min()
            .fill_null(0.0)
            .alias("pre_tackle_decel"),
            # Play-level P95 speed and peak G-force
            pl.col("s").quantile(0.95).fill_null(0.0).alias("play_speed_p95"),
            pl.col("s").max().fill_null(0.0).alias("play_speed_max"),
            pl.col("g_comb").max().fill_null(0.0).alias("play_g_comb_max"),
            pl.col("g_comb")
            .filter(pl.col("s") >= 0.5)
            .quantile(0.95)
            .fill_null(0.0)
            .alias("play_g_comb_p95"),
            pl.col("omega_t")
            .filter(pl.col("s") >= 1.0)
            .quantile(0.95)
            .fill_null(0.0)
            .alias("play_omega_p95"),
            pl.col("kappa_t")
            .filter(pl.col("s") >= 1.0)
            .quantile(0.95)
            .fill_null(0.0)
            .alias("play_kappa_p95_s02"),
            pl.col("kappa_t_s05")
            .filter(pl.col("s") >= 1.0)
            .quantile(0.95)
            .fill_null(0.0)
            .alias("play_kappa_p95_s05"),
        ])
    )

    return play_agg.collect()


def _aggregate_plays_by_stratum(
    plays_df: pl.DataFrame,
    prefix: str,
) -> pl.DataFrame:
    """Aggregate play-level kinematics and coverage/tackle metrics to player level for a given stratum."""
    return (
        plays_df.group_by("nfl_id")
        .agg([
            pl.len().alias(f"{prefix}_snaps"),
            pl.col("game_id").n_unique().alias(f"{prefix}_games"),
            pl.col("play_speed_p95").mean().alias(f"{prefix}_speed_p95"),
            pl.col("play_speed_max").quantile(0.95).alias(f"{prefix}_speed_max_p95"),
            pl.col("hip_flip_rate_p95").mean().alias(f"{prefix}_hip_flip_rate_p95"),
            pl.col("hip_flip_rate_max").quantile(0.90).alias(f"{prefix}_hip_flip_rate_max_p90"),
            pl.col("backpedal_dwell_frac").mean().alias(f"{prefix}_backpedal_dwell_frac"),
            pl.col("game_a_exit").mean().alias(f"{prefix}_a_exit"),
            pl.col("game_v_close").mean().alias(f"{prefix}_v_close"),
            pl.col("pre_tackle_decel").mean().alias(f"{prefix}_pre_tackle_decel"),
            pl.col("has_snap_oversteer").mean().alias(f"{prefix}_snap_oversteer_rate"),
            pl.col("snap_oversteer_count").sum().alias(f"{prefix}_snap_oversteer_total"),
            pl.col("play_g_comb_max").mean().alias(f"{prefix}_g_comb_max"),
            pl.col("play_g_comb_p95").mean().alias(f"{prefix}_g_comb_p95"),
            pl.col("play_omega_p95").mean().alias(f"{prefix}_omega_p95"),
            pl.col("play_kappa_p95_s02").mean().alias(f"{prefix}_kappa_p95_s02"),
            pl.col("play_kappa_p95_s05").mean().alias(f"{prefix}_kappa_p95_s05"),
            pl.col("cushion").mean().alias(f"{prefix}_cushion"),
            pl.col("cushion")
            .filter(pl.col("team_coverage_man_zone") == "MAN_COVERAGE")
            .mean()
            .alias(f"{prefix}_man_cushion"),
            pl.col("cushion")
            .filter(pl.col("team_coverage_man_zone") == "ZONE_COVERAGE")
            .mean()
            .alias(f"{prefix}_zone_cushion"),
            pl.col("separation_at_pass_forward").mean().alias(f"{prefix}_separation_at_pass_forward"),
            pl.col("expected_points_added").mean().alias(f"{prefix}_epa_mean"),
            pl.col("expected_points_added")
            .filter(pl.col("coverage_assignment").is_not_null())
            .mean()
            .alias(f"{prefix}_coverage_epa_mean"),
            (pl.col("tackle").fill_null(0.0) + 0.5 * pl.col("assist").fill_null(0.0))
            .sum()
            .alias(f"{prefix}_combined_tackles"),
            ((pl.col("tackle").fill_null(0.0) > 0.0) | (pl.col("assist").fill_null(0.0) > 0.0))
            .mean()
            .alias(f"{prefix}_tackle_rate"),
        ])
    )


def run_db_game_feature_pipeline(
    combine_features_path: str | Path = "data/processed/db_combine_features.parquet",
    player_play_path: str | Path = "player_play.parquet",
    games_path: str | Path = "games.parquet",
    players_path: str | Path = "players.parquet",
    career_path: str | Path = "player_career_successes.parquet",
    tracking_paths: tuple[str | Path, ...] = (
        "game_tracking_2023.parquet",
        "game_tracking_2024.parquet",
        "game_tracking_2025.parquet",
    ),
    plays_output_path: str | Path = "data/processed/db_game_plays_kinematics.parquet",
    master_output_path: str | Path = "data/processed/db_player_master_dataset.parquet",
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Execute Phase 6B NFL In-Game Feature Pipeline and build the DB Master Dataset.

    Streams across `game_tracking_2023..2025.parquet`, joins with `player_play.parquet`,
    `games.parquet`, `players.parquet`, `player_career_successes.parquet`, and
    `db_combine_features.parquet`, and writes both processed Parquet tables.
    """
    combine_feat_df = pl.read_parquet(combine_features_path).sort("nfl_id")
    db_ids = combine_feat_df["nfl_id"].to_list()

    games_lf = pl.scan_parquet(games_path).select([
        "game_id",
        "season",
        "season_type",
        "week",
        "home_team_abbr",
        "visitor_team_abbr",
    ])
    players_lf = pl.scan_parquet(players_path).select([
        "nfl_id",
        "draft_year",
        "nfl_position",
    ])

    # Co-tracked opponent WR/TE separation on the same (game_id, play_id)
    opp_sep_df = (
        pl.scan_parquet(player_play_path)
        .filter(pl.col("separation_at_pass_forward").is_not_null())
        .group_by(["game_id", "play_id", "team_abbr"])
        .agg([
            pl.col("separation_at_pass_forward")
            .filter(pl.col("target") == True)
            .mean()
            .alias("_opp_target_sep"),
            pl.col("separation_at_pass_forward").mean().alias("_opp_any_sep"),
        ])
        .collect()
    )

    pp_db_df = (
        pl.scan_parquet(player_play_path)
        .filter(pl.col("nfl_id").is_in(db_ids))
        .select([
            "game_id",
            "play_id",
            "nfl_id",
            "team_abbr",
            "possession_team",
            "lined_up_position",
            "play_direction",
            "quarter",
            "down",
            "yards_to_go",
            "pass_result",
            "pass_length",
            "play_nullified_by_penalty",
            "team_coverage_man_zone",
            "team_coverage_type",
            "coverage_assignment",
            "coverage_assignment_at_snap",
            "cushion",
            "separation_at_pass_forward",
            "tackle",
            "assist",
            "tackle_for_loss",
            "sack",
            "unblocked_pressure",
            "expected_points_added",
            "home_team_win_probability_added",
            "visitor_team_win_probility_added",
            "run",
        ])
        .join(games_lf, on="game_id", how="inner")
        .join(players_lf, on="nfl_id", how="left")
        .with_columns([
            pl.col("visitor_team_win_probility_added").alias("visitor_team_win_probability_added"),
            (pl.col("play_nullified_by_penalty") == "Y").fill_null(False).alias("is_penalty_nullified"),
            (pl.col("season") == pl.col("draft_year")).fill_null(False).alias("is_rookie_season"),
        ])
        .collect()
    )

    # Match co-tracked opponent receiver separation on the opposing team
    opp_joined = (
        pp_db_df.select(["game_id", "play_id", "nfl_id", "team_abbr"])
        .join(opp_sep_df, on=["game_id", "play_id"], how="left")
        .filter(pl.col("team_abbr") != pl.col("team_abbr_right"))
        .group_by(["game_id", "play_id", "nfl_id"])
        .agg([
            pl.col("_opp_target_sep").mean().alias("opp_targeted_separation"),
            pl.col("_opp_any_sep").mean().alias("opp_receiver_separation"),
        ])
    )

    pp_db_df = (
        pp_db_df.join(opp_joined, on=["game_id", "play_id", "nfl_id"], how="left")
        .with_columns([
            pl.coalesce([
                "separation_at_pass_forward",
                "opp_targeted_separation",
                "opp_receiver_separation",
            ]).alias("separation_at_pass_forward"),
        ])
    )

    play_dir_lf = pp_db_df.select(["game_id", "play_id", "nfl_id", "play_direction"]).lazy()

    season_play_dfs: list[pl.DataFrame] = []
    for t_path in tracking_paths:
        season_play_dfs.append(_aggregate_season_tracking_to_plays(t_path, db_ids, play_dir_lf))

    tracking_plays_df = pl.concat(season_play_dfs, how="vertical")

    game_plays_df = (
        pp_db_df.join(tracking_plays_df, on=["game_id", "play_id", "nfl_id"], how="inner")
        .sort(["game_id", "play_id", "nfl_id"])
    )

    plays_out = Path(plays_output_path)
    plays_out.parent.mkdir(parents=True, exist_ok=True)
    game_plays_df.write_parquet(plays_out)

    # Build subject-level aggregations across strata:
    # 1. REG: Regular season non-nullified snaps (Primary on-field analysis scope)
    reg_plays = game_plays_df.filter(
        (pl.col("season_type") == "REG") & (~pl.col("is_penalty_nullified"))
    )
    reg_agg = _aggregate_plays_by_stratum(reg_plays, prefix="reg")

    # 2. ROOKIE_REG: Rookie regular season non-nullified snaps (`season == draft_year & season_type == 'REG'`)
    rookie_reg_plays = reg_plays.filter(pl.col("is_rookie_season"))
    rookie_reg_agg = _aggregate_plays_by_stratum(rookie_reg_plays, prefix="rookie_reg")

    # 3. REG_POST: Regular + Postseason non-nullified snaps (Phase 12 sensitivity stratum)
    reg_post_plays = game_plays_df.filter(
        pl.col("season_type").is_in(["REG", "POST"]) & (~pl.col("is_penalty_nullified"))
    )
    reg_post_agg = _aggregate_plays_by_stratum(reg_post_plays, prefix="reg_post")

    # 4. PRE: Preseason snaps (Phase 12 preseason contamination stratum)
    pre_plays = game_plays_df.filter(pl.col("season_type") == "PRE")
    pre_agg = _aggregate_plays_by_stratum(pre_plays, prefix="pre")

    # 5. POST: Postseason snaps
    post_plays = game_plays_df.filter(pl.col("season_type") == "POST")
    post_agg = _aggregate_plays_by_stratum(post_plays, prefix="post")

    # 6. ALL: All tracked snaps across all seasons and game types
    all_agg = _aggregate_plays_by_stratum(game_plays_df, prefix="all")

    # Join career successes and compute right-censoring-normalized rates
    career_df = pl.read_parquet(career_path)

    master_df = (
        combine_feat_df.join(career_df, on="nfl_id", how="left")
        .join(reg_agg, on="nfl_id", how="left")
        .join(rookie_reg_agg, on="nfl_id", how="left")
        .join(reg_post_agg, on="nfl_id", how="left")
        .join(pre_agg, on="nfl_id", how="left")
        .join(post_agg, on="nfl_id", how="left")
        .join(all_agg, on="nfl_id", how="left")
        .with_columns([
            pl.col("reg_snaps").fill_null(0).cast(pl.Int64),
            pl.col("rookie_reg_snaps").fill_null(0).cast(pl.Int64),
            pl.col("reg_post_snaps").fill_null(0).cast(pl.Int64),
            pl.col("pre_snaps").fill_null(0).cast(pl.Int64),
            pl.col("post_snaps").fill_null(0).cast(pl.Int64),
            pl.col("all_snaps").fill_null(0).cast(pl.Int64),
            (pl.col("all_snaps").fill_null(0) > 0).alias("has_nfl_game_snaps"),
            (pl.col("reg_snaps").fill_null(0) > 0).alias("has_reg_season_snaps"),
            (
                pl.col("career_defensive_snaps").fill_null(0).cast(pl.Float64)
                / pl.when(pl.col("career_games_active").fill_null(0) > 0)
                .then(pl.col("career_games_active").cast(pl.Float64))
                .otherwise(1.0)
            ).alias("def_snaps_per_active_game"),
            (
                pl.col("career_games_started").fill_null(0).cast(pl.Float64)
                / pl.when(pl.col("career_games_active").fill_null(0) > 0)
                .then(pl.col("career_games_active").cast(pl.Float64))
                .otherwise(1.0)
            ).alias("start_rate"),
            # Canonical unprefixed aliases pointing to primary REG-season execution mediators
            pl.col("reg_v_close").alias("game_v_close"),
            pl.col("reg_a_exit").alias("game_a_exit"),
            pl.col("reg_hip_flip_rate_p95").alias("hip_flip_rate_p95"),
            pl.col("reg_backpedal_dwell_frac").alias("backpedal_dwell_frac"),
            pl.col("reg_cushion").alias("cushion"),
            pl.col("reg_separation_at_pass_forward").alias("separation_at_pass_forward"),
            pl.col("reg_epa_mean").alias("expected_points_added"),
        ])
        .sort("nfl_id")
    )

    master_out = Path(master_output_path)
    master_out.parent.mkdir(parents=True, exist_ok=True)
    master_df.write_parquet(master_out)

    return game_plays_df, master_df


if __name__ == "__main__":
    plays_df, master_df = run_db_game_feature_pipeline()
    print(
        f"Phase 6B Game Features completed: plays={plays_df.height} rows, "
        f"master={master_df.height} rows, cols={len(master_df.columns)}"
    )
