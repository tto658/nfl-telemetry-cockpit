"""Biomechanical feature engineering package for the 2027 NFL Big Data Bowl DB pipeline.

Exposes Phase 6A (Combine Lab Drill Kinematics & Fold-Safe HFBI) and Phase 6B
(NFL In-Game Play-Direction-Standardized Sideslip, Hip-Flip & Coverage Kinematics).
"""

from __future__ import annotations

from src.features.db_combine_features import (
    compute_combine_frame_kinematics,
    compute_fold_safe_hfbi,
    compute_plant_to_drive_latency,
    run_db_combine_feature_pipeline,
)
from src.features.db_game_features import (
    compute_game_frame_kinematics,
    run_db_game_feature_pipeline,
    standardize_play_direction_coordinates,
)

__all__ = [
    "compute_combine_frame_kinematics",
    "compute_fold_safe_hfbi",
    "compute_game_frame_kinematics",
    "compute_plant_to_drive_latency",
    "run_db_combine_feature_pipeline",
    "run_db_game_feature_pipeline",
    "standardize_play_direction_coordinates",
]
