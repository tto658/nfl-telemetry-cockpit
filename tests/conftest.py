"""Pytest fixtures and configuration for NFL Combine & Game application test suite."""

import sys
from pathlib import Path

import pytest

# Ensure repository root is in sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Known authoritative ground-truth entities verified against Parquet datasets
SAMPLE_PLAYERS = {
    "wr_jsn": {
        "nfl_id": 55884,
        "name": "Jaxon Smith-Njigba",
        "position": "WR",
        "draft_year": 2023,
        "college": "Ohio State",
        "draft_overall_pick": 20.0,
        "team": "SEA",
        "game_id": 2023081052,
        "play_id": 202,
    },
    "wr_brian_thomas": {
        "nfl_id": 57144,
        "name": "Brian Thomas",
        "position": "WR",
        "draft_year": 2024,
        "college": "Louisiana State",
        "draft_overall_pick": 23.0,
        "forty": 4.33,
    },
    "cb_banks": {
        "nfl_id": 55888,
        "name": "Deonte Banks",
        "position": "CB",
        "draft_year": 2023,
        "college": "Maryland",
        "draft_overall_pick": 24.0,
        "game_id": 2023091013,
        "play_id": 569,
    },
    "wr_higgins_ball": {
        "nfl_id": 58239,
        "name": "Jayden Higgins",
        "position": "WR",
        "draft_year": 2025,
        "event_id": "20250301100700_1740869577323_000",
        "drill_name": "SLOT_SAIL_ROUTE_RIGHT",
    },
    "zero_snap_rookie": {
        "nfl_id": 56648,
        "name": "Ikenna Enechukwu",
        "position": "OLB",
        "draft_year": 2023,
    },
    "zero_snap_2025": {
        "nfl_id": 58407,
        "name": "Gavin Bartholomew",
        "position": "TE",
        "draft_year": 2025,
    },
    "multi_team_rams": {
        "nfl_id": 56042,
        "name": "Puka Nacua",
        "position": "WR",
        "draft_year": 2023,
        "teams": ["LA", "LAR"],
    },
}


def _load_app():
    """Attempt to import Starlette application from src.web.app."""
    try:
        from src.web.app import app
        return app
    except (ImportError, ModuleNotFoundError):
        return None


@pytest.fixture(scope="session")
def app_instance():
    """Returns the Starlette app instance if available, else None."""
    return _load_app()


@pytest.fixture(scope="session")
def client(app_instance):
    """Provides a Starlette TestClient with lifespan execution."""
    if app_instance is None:
        pytest.skip("src.web.app is not yet implemented (Milestones M1-M4 in progress)")
    from starlette.testclient import TestClient
    with TestClient(app_instance) as test_client:
        yield test_client


@pytest.fixture
def sample_data():
    """Provides verified ground truth player records."""
    return SAMPLE_PLAYERS
