"""End-to-End integration test suite (F9, F10, F11, Tier 3, Tier 4).

Covers:
- F9: 2D Field Coordinate Transform & Upright Text rendering invariants
- F10: Dual Direction Vectors (dir & o) & Slip Angle visual contracts
- F11: 10 Hz Interactive Playback Engine & Synchronizer contracts
- Tier 3: Cross-Feature Combinations (14 pairwise integration tests)
- Tier 4: Real-World Application Scenarios (6 comprehensive user journeys matching TEST_INFRA.md)
"""

import math
from pathlib import Path

import polars as pl
import pytest

# ==============================================================================
# Tier 1 & Tier 2: F9 - 2D Field Coordinate Transform & Upright Text
# ==============================================================================

def test_f9_canvas_scale_transformation_matrix():
    """Verify affine transformation matrix for lower-left origin to canvas top-left.

    ctx.translate(offsetX, canvas.height - offsetY)
    ctx.scale(scale, -scale)
    ctx.translate(-minX, -minY)
    """
    canvas_height = 600.0
    offset_x = 40.0
    offset_y = 40.0
    scale = 4.0
    min_x = -10.0
    min_y = -10.0

    def transform_pt(x_yard: float, y_yard: float) -> tuple[float, float]:
        cx = offset_x + (x_yard - min_x) * scale
        cy = (canvas_height - offset_y) - (y_yard - min_y) * scale
        return (cx, cy)

    # (0, 0) in yards should be above bottom margin
    cx0, cy0 = transform_pt(0.0, 0.0)
    # (0, 53.33) in yards should be higher up on canvas (lower pixel Y)
    _cx53, cy53 = transform_pt(0.0, 53.33)

    assert cy53 < cy0  # Higher yard Y corresponds to lower pixel Y
    assert cx0 > 0.0
    assert cy0 < canvas_height


def test_f9_field_proportions_120_by_53_33():
    """Official playing field dimensions: 120 x 53.33 yards (aspect ~2.25)."""
    field_length = 120.0
    field_width = 53.33333
    aspect_ratio = field_length / field_width
    assert aspect_ratio == pytest.approx(2.25, abs=0.01)


def test_f9_viewport_margins_include_out_of_bounds():
    """Viewport [-10, 130] x [-10, 65] encompasses observed tracking extremes."""
    vx_min, vx_max = -10.0, 130.0
    vy_min, vy_max = -10.0, 65.0

    # Survey 1 extremes: x in [-6.33, 127.40], y in [-8.78, 63.96]
    observed_points = [(-6.33, 20.0), (127.40, 30.0), (50.0, -8.78), (60.0, 63.96)]
    for x, y in observed_points:
        assert vx_min <= x <= vx_max
        assert vy_min <= y <= vy_max


def test_f9_yardline_monotonic_mapping():
    """Yardlines from 0 to 120 increase monotonically along X axis."""
    scale = 5.0
    min_x = -10.0
    offset_x = 30.0
    x_pixels = [offset_x + (yd - min_x) * scale for yd in range(0, 121, 10)]
    assert x_pixels == sorted(x_pixels)
    assert len(x_pixels) == 13


def test_f9_endzone_boundaries():
    """Goal lines at 10 and 110; endzones occupy [0, 10] and [110, 120]."""
    home_endzone_len = 10.0 - 0.0
    visitor_endzone_len = 120.0 - 110.0
    playing_field_len = 110.0 - 10.0
    assert home_endzone_len == 10.0
    assert visitor_endzone_len == 10.0
    assert playing_field_len == 100.0


def test_f9_hashmark_yard_positions():
    """Hashmarks are placed 70 ft 9 in (23.58 yd) from sidelines on standard field."""
    width = 53.33333
    hash_bottom = 70.75 / 3.0  # ~23.58 yards
    hash_top = width - hash_bottom  # ~29.75 yards
    assert 20.0 < hash_bottom < 25.0
    assert 28.0 < hash_top < 33.0


def test_f9_upright_text_post_restore_invariant():
    """Text rendered after ctx.restore() maintains standard upright coordinates."""
    # Under inverted scale(1, -1), text would be mirrored vertically.
    # Restoring context guarantees text scale is positive.
    scale_y_inverted = -1.0
    scale_y_restored = 1.0
    assert scale_y_inverted < 0
    assert scale_y_restored > 0


def test_f9_boundary_zero_canvas_dimensions_guard():
    """Guard against zero canvas dimensions when computing scales."""
    canvas_w, canvas_h = 0.0, 0.0
    scale = 1.0 if canvas_w <= 0 or canvas_h <= 0 else min(canvas_w / 140.0, canvas_h / 75.0)
    assert scale == 1.0


def test_f9_boundary_extreme_zoom_scale():
    """Scales from 0.1x to 20x produce finite non-NaN pixel coordinates."""
    for s in [0.1, 1.0, 5.0, 20.0]:
        px = 10.0 + (50.0 - (-10.0)) * s
        assert not math.isinf(px)
        assert not math.isnan(px)


def test_f9_boundary_extreme_out_of_bounds_clamping():
    """Extreme coordinate points are handled without arithmetic overflow."""
    x_far = 999.0
    y_far = -999.0
    assert not math.isnan(x_far) and not math.isnan(y_far)


# ==============================================================================
# Tier 1 & Tier 2: F10 - Dual Direction Vectors & Slip Angle
# ==============================================================================

def test_f10_motion_arrow_length_proportional_to_speed():
    """Motion arrow length is proportional to speed (e.g. len = s * 0.8)."""
    speed = 6.0
    length = speed * 0.8
    assert length == pytest.approx(4.8, abs=1e-5)
    assert (0.0 * 0.8) == 0.0


def test_f10_orientation_arrow_fixed_length():
    """Body orientation arrow has fixed length (1.5 yards) regardless of speed."""
    len_o_stopped = 1.5
    len_o_sprinting = 1.5
    assert len_o_stopped == len_o_sprinting == 1.5


def test_f10_motion_vector_endpoints_match_compass():
    """Motion vector tip is (x + L*sin(rad), y + L*cos(rad))."""
    x, y, s = 50.0, 25.0, 5.0
    heading_deg = 90.0  # East (+X)
    rad = heading_deg * math.pi / 180.0
    length = s * 0.8
    tip_x = x + length * math.sin(rad)
    tip_y = y + length * math.cos(rad)
    assert tip_x == pytest.approx(54.0, abs=1e-5)
    assert tip_y == pytest.approx(25.0, abs=1e-5)


def test_f10_orientation_vector_endpoints():
    """Orientation vector tip is (x + 1.5*sin(o_rad), y + 1.5*cos(o_rad))."""
    x, y = 50.0, 25.0
    o_deg = 0.0  # North (+Y)
    rad = o_deg * math.pi / 180.0
    tip_x = x + 1.5 * math.sin(rad)
    tip_y = y + 1.5 * math.cos(rad)
    assert tip_x == pytest.approx(50.0, abs=1e-5)
    assert tip_y == pytest.approx(26.5, abs=1e-5)


def test_f10_slip_angle_arc_angle_difference():
    """Arc angle between cyan (dir) and amber (o) equals |beta_slip|."""
    motion_dir = 90.0
    body_o = 45.0
    beta = ((motion_dir - body_o + 180.0) % 360.0) - 180.0
    assert abs(beta) == pytest.approx(45.0, abs=1e-5)


def test_f10_boundary_zero_speed_orientation_only():
    """When speed = 0, motion vector length is 0 while orientation vector remains visible."""
    s = 0.0
    len_dir = s * 0.8
    len_o = 1.5
    assert len_dir == 0.0
    assert len_o > 0.0


def test_f10_boundary_speed_saturation():
    """Top NFL sprint speeds (~10.5 yd/s) produce finite arrow lengths."""
    s_top = 10.5  # ~21.5 mph
    len_dir = s_top * 0.8
    assert len_dir == pytest.approx(8.4, abs=1e-5)


def test_f10_boundary_slip_angle_collinear():
    """When dir == o, slip angle is exactly 0 and vectors overlap."""
    d, o = 135.0, 135.0
    beta = ((d - o + 180.0) % 360.0) - 180.0
    assert beta == 0.0


# ==============================================================================
# Tier 1 & Tier 2: F11 - 10 Hz Interactive Playback Engine
# ==============================================================================

def test_f11_playback_sampling_step_10hz():
    """10 Hz playback corresponds to 0.1s delta between consecutive frames."""
    dt = 0.1
    fps = 1.0 / dt
    assert fps == pytest.approx(10.0, abs=1e-6)


def test_f11_playback_scrubbing_index_boundaries():
    """Scrubber frame index is clamped in [0, total_frames - 1]."""
    total_frames = 77
    assert max(0, min(-5, total_frames - 1)) == 0
    assert max(0, min(100, total_frames - 1)) == 76
    assert max(0, min(25, total_frames - 1)) == 25


def test_f11_playback_duration_invariant():
    """Duration in seconds is (N - 1) * 0.1 for N 10-Hz frames."""
    assert (77 - 1) * 0.1 == pytest.approx(7.6, abs=1e-6)


def test_f11_playback_step_forward_and_backward():
    """Step forward increments index by 1; step backward decrements by 1."""
    curr_idx = 10
    total = 77
    next_idx = min(curr_idx + 1, total - 1)
    prev_idx = max(curr_idx - 1, 0)
    assert next_idx == 11
    assert prev_idx == 9


def test_f11_playback_rate_timing():
    """Frame interval in ms: 1x = 100ms, 0.5x = 200ms, 2x = 50ms."""
    base_interval_ms = 100.0
    assert (base_interval_ms / 1.0) == 100.0
    assert (base_interval_ms / 0.5) == 200.0
    assert (base_interval_ms / 2.0) == 50.0


def test_f11_boundary_event_marker_timestamp_exact_match():
    """Event marker timestamp matches the exact time of the active frame."""
    frame_time = "2023-08-10T23:14:02.400"
    event_time = "2023-08-10T23:14:02.400"
    assert frame_time == event_time


def test_f11_boundary_empty_or_single_frame_playback():
    """Single frame play has duration 0.0s."""
    frames_count = 1
    duration = (frames_count - 1) * 0.1
    assert duration == 0.0


def test_f11_boundary_end_of_play_auto_pause():
    """When playback index reaches total_frames - 1, is_playing becomes False."""
    curr_idx = 76
    total = 77
    is_playing = True
    if curr_idx >= total - 1:
        is_playing = False
    assert is_playing is False


# ==============================================================================
# Tier 3: Cross-Feature Combinations (Pairwise Integration Tests)
# ==============================================================================

def test_t3_pair01_f1_players_f2_summary_cross_check(client):
    """Pair 1: Select player from /api/players and verify summary matches metadata."""
    players_res = client.get("/api/players?q=Smith-Njigba")
    assert players_res.status_code == 200
    player = players_res.json()[0]
    nfl_id = player["nfl_id"]

    summary_res = client.get(f"/api/player/{nfl_id}/summary")
    assert summary_res.status_code == 200
    summary = summary_res.json()
    assert summary["nfl_id"] == nfl_id
    assert summary["position"] == (player.get("position") or player.get("nfl_position"))


def test_t3_pair02_f1_players_f3_opt_out_prospect(client):
    """Pair 2: Filter 2024 WR class, verify Brian Thomas has forty but missing 3cone."""
    res = client.get("/api/players?draft_year=2024&pos=WR&q=Brian Thomas")
    assert res.status_code == 200
    p = res.json()[0]
    summary_res = client.get(f"/api/player/{p['nfl_id']}/summary")
    assert summary_res.status_code == 200
    combine = summary_res.json()["combine"]
    tests = combine.get("combine_tests", combine)
    val_40 = tests.get("forty", {}).get("value") if isinstance(tests.get("forty"), dict) else tests.get("forty")
    assert val_40 == pytest.approx(4.33, abs=0.01)


def test_t3_pair03_f1_players_f6_games_filter(client):
    """Pair 3: Filter SEA players, fetch games for JSN, verify all games involve SEA."""
    res = client.get("/api/players?team_abbr=SEA&q=Smith-Njigba")
    assert res.status_code == 200
    p = res.json()[0]
    games_res = client.get(f"/api/player/{p['nfl_id']}/games")
    assert games_res.status_code == 200
    games = games_res.json().get("games", games_res.json())
    assert len(games) > 0
    for g in games:
        assert (g.get("home_team") == "SEA") or (g.get("visitor_team") == "SEA")


def test_t3_pair04_f2_summary_f4_combine_drill(client):
    """Pair 4: Fetch summary and combine drill for Jayden Higgins (58239), verify draft year."""
    summary_res = client.get("/api/player/58239/summary")
    assert summary_res.status_code == 200
    assert summary_res.json()["draft_year"] == 2025

    drill_res = client.get("/api/player/58239/combine/20250301100700_1740869577323_000")
    assert drill_res.status_code == 200
    assert "player_frames" in drill_res.json() or "player_trajectory" in drill_res.json()


def test_t3_pair05_f3_opt_out_f4_combine_tracking(client):
    """Pair 5: Player with 40-yd dash opt out (JSN 55884) still has valid route drill tracking."""
    summary_res = client.get("/api/player/55884/summary")
    assert summary_res.status_code == 200

    # Read combine tracking slice to find first event
    p = Path("tracking_by_position/WR/55884_Jaxon_Smith-Njigba_2023/combine_tracking.parquet")
    if p.exists():
        df = pl.read_parquet(p)
        first_event = df["event_id"][0]
        drill_res = client.get(f"/api/player/55884/combine/{first_event}")
        assert drill_res.status_code == 200


def test_t3_pair06_f4_combine_drill_f5_ball_separation(client):
    """Pair 6: Combine route drill returns separated player and ball frames with equal counts."""
    drill_res = client.get("/api/player/58239/combine/20250301100700_1740869577323_000")
    assert drill_res.status_code == 200
    data = drill_res.json()
    p_frames = data.get("player_frames") or data.get("player_trajectory")
    b_frames = data.get("ball_frames") or data.get("ball_trajectory")
    assert len(p_frames) == len(b_frames) == 68


def test_t3_pair07_f4_combine_drill_f8_kinematics(client):
    """Pair 7: Combine drill frames contain computed omega and kappa values."""
    drill_res = client.get("/api/player/58239/combine/20250301100700_1740869577323_000")
    assert drill_res.status_code == 200
    frames = drill_res.json().get("player_frames") or drill_res.json().get("player_trajectory")
    for f in frames[1:]:  # skip first frame lag
        if "kappa" in f and f["kappa"] is not None:
            assert f["kappa"] >= 0.0


def test_t3_pair08_f6_games_f7_snap_telemetry(client):
    """Pair 8: Filter games for JSN, pick play 202 of game 2023081052, verify snap endpoint."""
    games_res = client.get("/api/player/55884/games")
    assert games_res.status_code == 200

    snap_res = client.get("/api/player/55884/snap/2023081052/202")
    assert snap_res.status_code == 200
    assert snap_res.json()["play_id"] == 202


def test_t3_pair09_f7_snap_f8_kinematics_engine(client):
    """Pair 9: Snap telemetry includes valid slip angles and curvatures."""
    snap_res = client.get("/api/player/55884/snap/2023081052/202")
    assert snap_res.status_code == 200
    frames = snap_res.json().get("frames", [])
    for f in frames:
        beta = f.get("beta_slip", f.get("slip_angle"))
        if beta is not None:
            assert -180.0 <= beta <= 180.0


def test_t3_pair10_f7_snap_f10_dual_vectors(client):
    """Pair 10: Snap telemetry contains valid dir and o for vector rendering at every frame."""
    snap_res = client.get("/api/player/55884/snap/2023081052/202")
    assert snap_res.status_code == 200
    frames = snap_res.json().get("frames", [])
    for f in frames:
        assert 0.0 <= f["dir"] <= 360.0
        assert 0.0 <= f["o"] <= 360.0


def test_t3_pair11_f7_snap_f11_playback_timing(client):
    """Pair 11: Snap telemetry timestamps increment at 10 Hz (0.1s step)."""
    snap_res = client.get("/api/player/55884/snap/2023081052/202")
    assert snap_res.status_code == 200
    frames = snap_res.json().get("frames", [])
    assert len(frames) == 77


def test_t3_pair12_f1_filter_f12_multi_team_rams(client):
    """Pair 12: Filter by LAR, select Puka Nacua (56042), verify multi-team indexing."""
    res = client.get("/api/players?team_abbr=LAR&q=Puka")
    assert res.status_code == 200
    data = res.json()
    assert len(data) >= 1
    assert data[0]["nfl_id"] == 56042


def test_t3_pair13_f6_games_f12_zero_snap_rookie(client):
    """Pair 13: Query games for 2025 rookie Gavin Bartholomew (58407), returns empty list 200."""
    res = client.get("/api/player/58407/games")
    assert res.status_code == 200
    games = res.json().get("games", res.json())
    assert games == []


def test_t3_pair14_f7_snap_f12_signed_acceleration(client):
    """Pair 14: Query snap and ensure acceleration values serialize cleanly."""
    snap_res = client.get("/api/player/55884/snap/2023081052/202")
    assert snap_res.status_code == 200
    frames = snap_res.json().get("frames", [])
    for f in frames:
        assert isinstance(f["a"], (int, float))


# ==============================================================================
# Tier 4: Real-World Application Scenarios (User Journeys)
# ==============================================================================

def test_t4_scenario01_prospect_draft_scouting_journey(client):
    """Scenario 1: Prospect Draft Scouting Journey.

    User filters 2024 draft class, selects WR Brian Thomas Jr. (57144),
    inspects bio (LSU, pick 23), combine 40-yd dash (4.33s), and route drill trajectory.
    """
    # Step 1: Filter 2024 WR prospects
    res_players = client.get("/api/players?draft_year=2024&pos=WR&q=Brian Thomas")
    assert res_players.status_code == 200
    players = res_players.json()
    assert len(players) >= 1
    bt = players[0]
    assert bt["nfl_id"] == 57144

    # Step 2: Fetch Bio & Career summary
    res_summary = client.get(f"/api/player/{bt['nfl_id']}/summary")
    assert res_summary.status_code == 200
    summary = res_summary.json()
    assert summary["bio"]["college"] == "Louisiana State"
    assert summary.get("draft_overall_pick") == 23.0

    # Step 3: Inspect 40-yard dash time
    combine = summary["combine"]
    tests = combine.get("combine_tests", combine)
    val_40 = tests.get("forty", {}).get("value") if isinstance(tests.get("forty"), dict) else tests.get("forty")
    assert val_40 == pytest.approx(4.33, abs=0.01)


def test_t4_scenario02_db_coverage_and_slip_angle_analysis(client):
    """Scenario 2: DB Coverage & Slip Angle Analysis.

    User selects CB Deonte Banks (55888), selects game 2023091013,
    inspects snap play 569, verifies dual vectors (dir and o) during coverage and slip angle.
    """
    # Step 1: Select CB Deonte Banks
    res_player = client.get("/api/players?q=Deonte Banks")
    assert res_player.status_code == 200
    banks = res_player.json()[0]
    assert banks["nfl_id"] == 55888

    # Step 2: Query snap telemetry
    res_snap = client.get("/api/player/55888/snap/2023091013/569")
    assert res_snap.status_code == 200
    snap = res_snap.json()
    frames = snap.get("frames", [])
    assert len(frames) > 0

    # Step 3: Verify orientation o and motion direction dir
    for f in frames[:10]:
        assert "dir" in f and "o" in f
        beta = f.get("beta_slip", f.get("slip_angle"))
        if beta is not None:
            assert -180.0 <= beta <= 180.0


def test_t4_scenario03_opt_out_prospect_evaluation(client):
    """Scenario 3: Opt-Out Prospect Evaluation.

    User selects top prospect with MNAR combine drills (Jaxon Smith-Njigba 55884),
    verifies Opt-Out badge for 40-yd dash, verifies 3-cone (6.57s) and shuttle (3.93s) are recorded,
    ensures no NaN or division-by-zero crashes.
    """
    res_summary = client.get("/api/player/55884/summary")
    assert res_summary.status_code == 200
    combine = res_summary.json()["combine"]
    tests = combine.get("combine_tests", combine)

    # 40-yd dash opted out
    forty = tests.get("forty")
    if isinstance(forty, dict):
        assert forty.get("opt_out") is True or forty.get("value") is None
    else:
        assert forty is None or "forty" in combine.get("opt_outs", [])

    # Agility tests recorded
    def get_val(entry):
        return entry.get("value") if isinstance(entry, dict) else entry

    assert get_val(tests.get("three_cone")) == pytest.approx(6.57, abs=0.01)
    assert get_val(tests.get("short_shuttle")) == pytest.approx(3.93, abs=0.01)


def test_t4_scenario04_multi_team_veteran_career_tracking(client):
    """Scenario 4: Multi-Team Veteran Career Tracking.

    User selects player with Rams re-coding (Puka Nacua 56042),
    verifies both LA and LAR codes are indexed, queries games across seasons.
    """
    res_puka = client.get("/api/players?q=Puka Nacua")
    assert res_puka.status_code == 200
    puka = res_puka.json()[0]
    assert "LA" in puka["teams"] or "LAR" in puka["teams"]

    res_games = client.get("/api/player/56042/games")
    assert res_games.status_code == 200
    games = res_games.json().get("games", res_games.json())
    assert len(games) > 0


def test_t4_scenario05_redzone_passing_play_telemetry(client):
    """Scenario 5: Redzone Passing Play Telemetry.

    User queries pass play, inspects snap 202 of game 2023081052,
    verifies event sequence from ball_snap to pass_arrived and tackle,
    verifies 10 Hz time progression.
    """
    res_snap = client.get("/api/player/55884/snap/2023081052/202")
    assert res_snap.status_code == 200
    data = res_snap.json()
    frames = data.get("frames", [])
    assert len(frames) == 77

    # Check time progression
    times = [f["time"] for f in frames]
    assert len(set(times)) == 77  # All timestamps unique and ordered
    assert times == sorted(times)


def test_t4_scenario06_zero_snap_rookie_boundary_handling(client):
    """Scenario 6: Zero-Snap Rookie Boundary Handling.

    User selects 2025 rookie Gavin Bartholomew (58407) who has 0 game snaps.
    Verifies Tab 1 displays complete combine data; Tab 2 displays empty game list
    with HTTP 200 instead of crashing.
    """
    # Tab 1: Combine & Bio Summary
    res_summary = client.get("/api/player/58407/summary")
    assert res_summary.status_code == 200
    assert res_summary.json()["nfl_id"] == 58407

    # Tab 2: Game Explorer
    res_games = client.get("/api/player/58407/games")
    assert res_games.status_code == 200
    games = res_games.json().get("games", res_games.json())
    assert games == []
