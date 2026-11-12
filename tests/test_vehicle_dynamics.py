"""Unit and integration test suite for Vehicle Dynamics (Sideslip Angle, Beta Rate, Jerk, Snap Oversteer)."""

import pytest
import polars as pl
from starlette.testclient import TestClient

from src.web.app import app
from src.web.kinematics import (
    compute_slip_angle,
    compute_beta_rate,
    compute_jerk,
    detect_snap_oversteer,
    classify_dynamics_state,
    compute_tracking_kinematics,
)
from src.web.schemas import FrameDTO


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_sideslip_angle_and_rate_math():
    """Verify sideslip angle beta(t) = angdiff(dir, o) and rate beta_dot(t)."""
    # Pure forward ('on rails')
    assert compute_slip_angle(45.0, 45.0) == pytest.approx(0.0)
    assert compute_slip_angle(0.0, 0.0) == pytest.approx(0.0)
    assert compute_slip_angle(360.0, 0.0) == pytest.approx(0.0)

    # Moderate cut / lateral drift
    assert compute_slip_angle(70.0, 45.0) == pytest.approx(25.0)
    assert compute_slip_angle(20.0, 45.0) == pytest.approx(-25.0)

    # Wrap boundary
    assert compute_slip_angle(5.0, 355.0) == pytest.approx(10.0)
    assert compute_slip_angle(355.0, 5.0) == pytest.approx(-10.0)

    # Beta rate dbeta/dt
    assert compute_beta_rate(15.0, 5.0, dt=0.1) == pytest.approx(100.0)
    assert compute_beta_rate(-10.0, 10.0, dt=0.1) == pytest.approx(-200.0)
    # Wrap boundary minimal diff (e.g. 179 to -179 is +2 degrees / 0.1s = +20 deg/s)
    assert compute_beta_rate(-179.0, 179.0, dt=0.1) == pytest.approx(20.0)


def test_jerk_math():
    """Verify kinematic jerk j(t) = da/dt."""
    assert compute_jerk(3.5, 1.5, dt=0.1) == pytest.approx(20.0)
    assert compute_jerk(1.0, 3.0, dt=0.1) == pytest.approx(-20.0)
    assert compute_jerk(None, 2.0) == 0.0


def test_snap_oversteer_and_dynamics_states():
    """Verify snap oversteer detection and classification of balance states."""
    # Snap Oversteer: high speed, sharp slip rate jump, and sharp jerk spike
    assert detect_snap_oversteer(speed=4.5, beta_rate=140.0, jerk=8.5) is True
    assert detect_snap_oversteer(speed=0.2, beta_rate=140.0, jerk=8.5) is False # low speed
    assert detect_snap_oversteer(speed=5.0, beta_rate=30.0, jerk=8.5) is False  # smooth slip rate
    assert detect_snap_oversteer(speed=5.0, beta_rate=140.0, jerk=1.5) is False # low jerk

    # Classifications
    assert classify_dynamics_state(speed=0.1, beta=0.0) == "STATIONARY"
    assert classify_dynamics_state(speed=4.0, beta=4.0) == "ON_RAILS"
    assert classify_dynamics_state(speed=5.0, beta=28.0, beta_rate=25.0, jerk=2.0) == "CONTROLLED_DRIFT"
    assert classify_dynamics_state(speed=4.0, beta=85.0, beta_rate=20.0, jerk=1.5) == "LATERAL_BACKPEDAL"
    assert classify_dynamics_state(speed=4.0, beta=35.0, beta_rate=130.0, jerk=7.5) == "SNAP_OVERSTEER"


def test_compute_tracking_kinematics_vectorized():
    """Verify Polars vectorized output includes all vehicle dynamics fields."""
    df = pl.DataFrame({
        "time": ["2023-09-10T12:00:00.000", "2023-09-10T12:00:00.100", "2023-09-10T12:00:00.200"],
        "x": [10.0, 10.5, 11.2],
        "y": [20.0, 20.8, 21.8],
        "s": [4.0, 4.5, 5.0],
        "a": [1.0, 2.0, 3.2],
        "dir": [45.0, 60.0, 80.0],
        "o": [45.0, 45.0, 45.0],
    })

    res = compute_tracking_kinematics(df, is_combine=False)
    assert "beta_slip" in res.columns
    assert "beta_rate" in res.columns
    assert "jerk" in res.columns
    assert "snap_oversteer" in res.columns
    assert "dynamics_state" in res.columns

    # Check jerk: (2.0 - 1.0)/0.1 = 10.0
    assert res["jerk"][1] == pytest.approx(10.0, abs=1e-4)


def test_framedto_vehicle_dynamics_fields():
    """Verify FrameDTO accepts and serializes vehicle dynamics fields."""
    dto = FrameDTO(
        frameId=1,
        time=0.1,
        x=12.0,
        y=24.0,
        s=4.5,
        a=2.0,
        dir=45.0,
        o=35.0,
        slip_angle=10.0,
        beta_rate=50.0,
        jerk=8.0,
        snap_oversteer=True,
        dynamics_state="SNAP_OVERSTEER",
    )
    data = dto.model_dump()
    assert data["beta_rate"] == 50.0
    assert data["slip_rate"] == 50.0
    assert data["jerk"] == 8.0
    assert data["snap_oversteer"] is True
    assert data["dynamics_state"] == "SNAP_OVERSTEER"


def test_api_snap_vehicle_dynamics(client: TestClient):
    """Verify /api/player/{id}/snap/... returns vehicle dynamics summary and frames."""
    # Jaxon Smith-Njigba 55884
    resp = client.get("/api/player/55884/games")
    assert resp.status_code == 200
    data = resp.json()
    games = data.get("games", data)
    assert len(games) > 0
    g_id = games[0]["game_id"]
    p_id = games[0]["plays"][0]["play_id"]

    snap_resp = client.get(f"/api/player/55884/snap/{g_id}/{p_id}")
    assert snap_resp.status_code == 200
    snap = snap_resp.json()

    assert "frames" in snap
    assert "snap_oversteer_incidents" in snap
    assert "snap_oversteer_frames" in snap

    f0 = snap["frames"][0]
    assert "slip_angle" in f0
    assert "beta_rate" in f0
    assert "jerk" in f0
    assert "snap_oversteer" in f0
    assert "dynamics_state" in f0


def test_combined_g_force_math():
    """Verify combined G-Force calculation: a_comb = sqrt(a_t^2 + a_lat^2), G_comb = a_comb / 10.7247."""
    from src.web.kinematics import compute_combined_g_force, G_CONST_YD

    # Pure tangential: a_t = 10.7247 yd/s^2, lateral = 0 -> 1.0 g
    a_comb, g_comb = compute_combined_g_force(a_tangential=10.7247, speed=0.0, omega_deg_s=0.0)
    assert a_comb == pytest.approx(10.7247)
    assert g_comb == pytest.approx(1.0)

    # 3-4-5 triangle: a_t = 3, a_lat = 4 -> a_comb = 5 yd/s^2, g_comb = 5 / 10.7247
    # speed = 2 yd/s, omega = 2 rad/s -> 2 * 2 = 4 yd/s^2
    omega_deg = 2.0 * 180.0 / 3.141592653589793
    a_comb, g_comb = compute_combined_g_force(a_tangential=3.0, speed=2.0, omega_deg_s=omega_deg)
    assert a_comb == pytest.approx(5.0, rel=1e-3)
    assert g_comb == pytest.approx(5.0 / G_CONST_YD, rel=1e-3)


def test_overlap_index_and_apex_metrics():
    """Verify Trail-Braking / Overlap Index and Apex Speed / Exit Traction."""
    from src.web.kinematics import compute_overlap_index, compute_apex_metrics

    # Test Overlap Index
    a_t = [0.1, 0.2, 3.0, 4.0, 0.5, 3.5, 4.5, 0.2, 0.1, 0.1]
    a_lat = [0.1, 0.2, 3.5, 4.5, 0.5, 3.0, 4.0, 0.2, 0.1, 0.1]
    speeds = [0.1, 0.2, 4.0, 5.0, 4.5, 4.0, 5.0, 1.0, 0.2, 0.1]

    idx = compute_overlap_index(a_t, a_lat, speeds=speeds, min_speed_threshold=0.5, percentile=70.0)
    assert 0.0 <= idx <= 1.0
    assert idx > 0.0

    # Test Apex metrics
    # Curvature peak at index 3
    curvatures = [0.02, 0.05, 0.15, 0.35, 0.18, 0.08, 0.04, 0.02, 0.01, 0.01]
    speeds = [8.0, 7.5, 6.5, 5.2, 5.8, 6.7, 7.4, 7.9, 8.1, 8.2]
    accels = [-1.0, -1.5, -2.0, 0.5, 2.5, 3.0, 2.8, 2.2, 1.5, 1.0]

    apexes = compute_apex_metrics(speeds, curvatures, accels, dt=0.1, min_curvature=0.10, exit_window_sec=0.5)
    assert len(apexes) == 1
    assert apexes[0]["frame_index"] == 3
    assert apexes[0]["v_apex"] == pytest.approx(5.2)
    # Exit traction is the average acceleration in the next 5 frames (idx 4..8)
    expected_exit = sum(accels[4:9]) / 5.0
    assert apexes[0]["exit_traction"] == pytest.approx(expected_exit)


def test_api_vehicle_dynamics_four_metrics(client: TestClient):
    """Verify snap and combine endpoints return all 4 advanced vehicle dynamics metrics."""
    # Test snap API: fallback to first available play
    resp = client.get("/api/player/55884/games")
    games = resp.json().get("games", resp.json())
    g_id = games[0]["game_id"]
    p_id = games[0]["plays"][0]["play_id"]
    snap_resp = client.get(f"/api/player/55884/snap/{g_id}/{p_id}")

    assert snap_resp.status_code == 200
    snap = snap_resp.json()
    assert "g_comb_max" in snap
    assert "overlap_index" in snap
    assert "overlap_pct" in snap
    assert "v_apex" in snap
    assert "corner_exit_traction" in snap
    assert "apex_metrics" in snap

    f0 = snap["frames"][0]
    assert "a_lat" in f0
    assert "a_comb" in f0
    assert "g_comb" in f0


def test_api_player_dynamics_and_archetype(client: TestClient):
    """Verify GET /api/player/{id}/dynamics returns combine dynamics summary and Biomechanical Archetype."""
    resp = client.get("/api/player/55884/dynamics")
    assert resp.status_code == 200
    data = resp.json()
    assert data["nfl_id"] == 55884
    assert "combine_dynamics" in data
    assert "peak_g_comb" in data
    assert "mean_overlap_pct" in data
    assert "archetype" in data
    arch = data["archetype"]
    assert arch["code"] in {"ELITE_TRAIL_BRAKER", "EXPLOSIVE_EXIT", "HIGH_APEX_MOMENTUM", "BALANCED_MOVER"}
    assert isinstance(arch["label"], str) and len(arch["label"]) > 0
    assert isinstance(arch["rationale"], str) and len(arch["rationale"]) > 0


def test_api_spatial_position_avg_caching_and_dispersion(client: TestClient):
    """Verify GET /api/spatial/position_avg returns dispersion bands and caches in memory."""
    resp1 = client.get("/api/spatial/position_avg?position=WR&drill_name=FORTY_YARD_DASH&step=0.5")
    assert resp1.status_code == 200
    d1 = resp1.json()
    assert "speeds_std" in d1
    assert "times_std" in d1
    assert "speeds_p25" in d1
    assert "speeds_p75" in d1
    assert "trajectory" in d1
    assert len(d1["speeds_std"]) == d1["trajectory"]["point_count"]
    assert "g_comb" in d1["trajectory"]["points"][0]

    # Second call should hit _POS_AVG_CACHE
    resp2 = client.get("/api/spatial/position_avg?position=WR&drill_name=FORTY_YARD_DASH&step=0.5")
    assert resp2.status_code == 200
    assert resp2.json()["trajectory"]["total_distance"] == d1["trajectory"]["total_distance"]


def test_binary_gg_cloud_endpoint(client: TestClient):
    """Verify GET /api/player/{id}/gg-kde returns Base64 float32 binary arrays with energy gating."""
    import base64
    import numpy as np

    # 1. Season scope for existing player
    resp = client.get("/api/player/55867/gg-kde?scope=season")
    assert resp.status_code == 200
    data = resp.json()
    assert data["nfl_id"] == 55867
    assert data["scope"] == "season"
    assert data["count"] > 0
    assert "b64_g_lat" in data
    assert "b64_g_t" in data
    assert "b64_s" in data
    assert "b64_beta" in data
    assert "bounds" in data

    # Decode binary buffers
    g_lat_bytes = base64.b64decode(data["b64_g_lat"])
    g_t_bytes = base64.b64decode(data["b64_g_t"])
    s_bytes = base64.b64decode(data["b64_s"])

    g_lat = np.frombuffer(g_lat_bytes, dtype=np.float32)
    g_t = np.frombuffer(g_t_bytes, dtype=np.float32)
    s = np.frombuffer(s_bytes, dtype=np.float32)

    assert len(g_lat) == data["count"]
    assert len(g_t) == data["count"]
    assert len(s) == data["count"]

    # Verify bounds match decoded arrays
    assert data["bounds"]["g_lat_min"] <= float(np.min(g_lat)) + 0.01
    assert data["bounds"]["g_lat_max"] >= float(np.max(g_lat)) - 0.01

    # Verify dynamic energy gating (no frames where speed <= 0.3 AND g_comb < 0.12)
    g_comb = np.hypot(g_lat, g_t)
    invalid_frames = np.sum((s <= 0.3) & (g_comb < 0.12))
    assert invalid_frames == 0

    # 2. Combine scope
    resp_comb = client.get("/api/player/55867/gg-kde?scope=combine")
    assert resp_comb.status_code == 200
    assert resp_comb.json()["scope"] == "combine"

    # 3. 404 on invalid player
    resp_404 = client.get("/api/player/9999999/gg-kde")
    assert resp_404.status_code == 404


def test_polars_kinematics_signed_alat_and_gt():
    """Verify compute_tracking_kinematics emits signed g_lat and g_t while keeping omega unsigned."""
    import polars as pl
    from src.web.kinematics import compute_tracking_kinematics

    # Simulate player moving straight, then turning right (+10 deg), then left (-20 deg), with speed drop
    df = pl.DataFrame({
        "time": [0.0, 0.1, 0.2, 0.3],
        "s": [5.0, 6.0, 4.0, 3.0],
        "a": [0.0, 10.0, 20.0, 10.0],
        "dir": [0.0, 10.0, 350.0, 350.0],
    })
    res = compute_tracking_kinematics(df, is_combine=False)

    assert "g_lat" in res.columns
    assert "g_t" in res.columns
    assert "g_comb" in res.columns
    assert "omega" in res.columns

    # Omega must always be unsigned (non-negative)
    omegas = res["omega"].to_list()
    assert all(w >= 0.0 for w in omegas)

    # Frame 1: turning right (dir 0 -> 10 deg) -> positive g_lat
    assert res["g_lat"][1] > 0.0

    # Frame 2: turning left (dir 10 -> 350 deg, -20 deg diff) -> negative g_lat
    assert res["g_lat"][2] < 0.0

    # Frame 2: decelerating (speed drops 6.0 -> 4.0) -> negative g_t
    assert res["g_t"][2] < 0.0

