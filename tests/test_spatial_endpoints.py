"""Unit and integration tests for Spatial Benchmark & Overlay REST endpoints."""

import pytest
from starlette.testclient import TestClient

from src.web.app import app


@pytest.fixture
def client():
    """TestClient fixture for Starlette application."""
    return TestClient(app)


def test_spatial_drills_endpoint_missing_params(client):
    """GET /api/spatial/drills without nfl_id returns 400."""
    resp = client.get("/api/spatial/drills")
    assert resp.status_code == 400


def test_spatial_drills_endpoint_player_not_found(client):
    """GET /api/spatial/drills with non-existent player returns 404."""
    resp = client.get("/api/spatial/drills?nfl_id=99999999")
    assert resp.status_code == 404


def test_spatial_drills_endpoint_success(client):
    """GET /api/spatial/drills with valid player returns drill list."""
    # 55867 is Will Anderson
    resp = client.get("/api/spatial/drills?nfl_id=55867")
    assert resp.status_code == 200
    data = resp.json()
    assert "drills" in data
    assert isinstance(data["drills"], list)
    assert len(data["drills"]) > 0
    drill_names = [d["drill_name"] for d in data["drills"]]
    assert "FORTY_YARD_DASH" in drill_names


def test_spatial_compare_combine_endpoint_missing_params(client):
    """GET /api/spatial/compare/combine without required params returns 400."""
    resp = client.get("/api/spatial/compare/combine?player_a=55867")
    assert resp.status_code == 400


def test_spatial_compare_combine_success(client):
    """GET /api/spatial/compare/combine between two prospects returns SpatialDeltaComparison."""
    # 55867 (Will Anderson) and 55877 (Lukas Van Ness) both ran FORTY_YARD_DASH
    drills_a = client.get("/api/spatial/drills?nfl_id=55867").json()["drills"]
    drills_b = client.get("/api/spatial/drills?nfl_id=55877").json()["drills"]

    event_a = [d["event_id"] for d in drills_a if "FORTY" in d["drill_name"]][0]
    event_b = [d["event_id"] for d in drills_b if "FORTY" in d["drill_name"]][0]

    resp = client.get(
        f"/api/spatial/compare/combine?player_a=55867&drill_a={event_a}&player_b=55877&drill_b={event_b}&step=0.5"
    )
    assert resp.status_code == 200
    data = resp.json()

    assert "common_max_distance" in data
    assert data["common_max_distance"] > 20.0
    assert "grid_distance" in data
    assert "delta_time" in data
    assert "delta_speed" in data
    assert "mini_sectors" in data
    assert "milestones" in data
    assert "player_a" in data
    assert "player_b" in data
    assert "resampled_a" in data
    assert "resampled_b" in data
    assert len(data["grid_distance"]) == len(data["delta_time"])
    assert len(data["mini_sectors"]) > 0


def test_spatial_compare_snap_endpoint(client):
    """GET /api/spatial/compare/snap between two plays returns SpatialDeltaComparison."""
    # Fetch games for a player who has snaps, e.g., 55867
    games_resp = client.get("/api/player/55867/games")
    games = games_resp.json().get("games", [])
    if games and games[0].get("plays"):
        g_id = games[0]["game_id"]
        p_id = games[0]["plays"][0]["play_id"]
        p_id_2 = games[0]["plays"][1]["play_id"] if len(games[0]["plays"]) > 1 else p_id

        resp = client.get(
            f"/api/spatial/compare/snap?player_a=55867&game_a={g_id}&play_a={p_id}&player_b=55867&game_b={g_id}&play_b={p_id_2}&step=0.5"
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "grid_distance" in data
        assert "delta_time" in data
        assert "resampled_a" in data
        assert "resampled_b" in data


def test_spatial_position_avg_endpoint(client):
    """GET /api/spatial/position_avg computes synthetic trajectory for a position."""
    resp = client.get("/api/spatial/position_avg?position=DE&drill_name=FORTY_YARD_DASH&step=0.5")
    assert resp.status_code == 200
    data = resp.json()
    assert data["position"] == "DE"
    assert data["sample_size"] >= 5
    assert "trajectory" in data
    assert data["trajectory"]["total_distance"] > 20.0
    assert len(data["trajectory"]["points"]) > 20
