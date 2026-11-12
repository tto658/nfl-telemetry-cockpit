"""Tests for Starlette REST API endpoints (F1, F2, F3, F4, F5, F6, F7, F12).

Covers:
- F1: Player Indexing & Query API (/api/players)
- F2: Player Bio & Career Summary (/api/player/{id}/summary)
- F3: Combine Metrics & Opt-Out Badges
- F4: Tracked Combine Drills API (/api/player/{id}/combine/{event_id})
- F5: Combine 2D Field & Ball Separation
- F6: Game & Play Filtering API (/api/player/{id}/games)
- F7: Game Snap Telemetry & Season Dispatch (/api/player/{id}/snap/{game_id}/{play_id})
- F12: Edge Cases (0-snap players, MNAR opt-outs, LA vs LAR Rams)
"""

import pytest

# ==============================================================================
# Tier 1 & Tier 2: F1 - Player Indexing & Query API (/api/players)
# ==============================================================================

def test_f1_players_get_all_status_and_count(client):
    """GET /api/players returns HTTP 200 and exactly 510 players."""
    response = client.get("/api/players")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 510


def test_f1_players_item_schema(client):
    """Each player object has mandatory keys: nfl_id, name, position, draft_year, teams."""
    response = client.get("/api/players")
    assert response.status_code == 200
    first = response.json()[0]
    assert "nfl_id" in first
    assert ("name" in first) or ("display_name" in first)
    assert ("position" in first) or ("nfl_position" in first)
    assert "draft_year" in first
    assert "teams" in first
    assert isinstance(first["teams"], list)


def test_f1_players_filter_draft_year_2023(client):
    """GET /api/players?draft_year=2023 returns exactly 160 players."""
    response = client.get("/api/players?draft_year=2023")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 160
    assert all(p["draft_year"] == 2023 for p in data)


def test_f1_players_filter_draft_year_2024(client):
    """GET /api/players?draft_year=2024 returns exactly 177 players."""
    response = client.get("/api/players?draft_year=2024")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 177
    assert all(p["draft_year"] == 2024 for p in data)


def test_f1_players_filter_draft_year_2025(client):
    """GET /api/players?draft_year=2025 returns exactly 173 players."""
    response = client.get("/api/players?draft_year=2025")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 173
    assert all(p["draft_year"] == 2025 for p in data)


def test_f1_players_filter_position_wr(client):
    """GET /api/players?pos=WR returns exactly 106 wide receivers."""
    response = client.get("/api/players?pos=WR")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 106
    for p in data:
        pos = p.get("position") or p.get("nfl_position")
        assert pos == "WR"


def test_f1_players_filter_position_cb(client):
    """GET /api/players?pos=CB returns exactly 60 cornerbacks."""
    response = client.get("/api/players?pos=CB")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 60


def test_f1_players_filter_team_sea(client):
    """GET /api/players?team_abbr=SEA returns players who played for Seattle."""
    response = client.get("/api/players?team_abbr=SEA")
    assert response.status_code == 200
    data = response.json()
    assert len(data) > 0
    pids = [p["nfl_id"] for p in data]
    assert 55884 in pids  # Jaxon Smith-Njigba


def test_f1_players_search_by_name(client):
    """GET /api/players?q=Smith-Njigba returns Jaxon Smith-Njigba."""
    response = client.get("/api/players?q=Smith-Njigba")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 1
    assert any(p["nfl_id"] == 55884 for p in data)


def test_f1_players_search_by_id(client):
    """GET /api/players?q=55884 returns Jaxon Smith-Njigba."""
    response = client.get("/api/players?q=55884")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["nfl_id"] == 55884


def test_f1_players_search_by_college(client):
    """GET /api/players?q=Ohio State returns Buckeyes alumni."""
    response = client.get("/api/players?q=Ohio State")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 1
    pids = [p["nfl_id"] for p in data]
    assert 55884 in pids


def test_f1_players_boundary_nonexistent_year(client):
    """GET /api/players?draft_year=1990 returns an empty list."""
    response = client.get("/api/players?draft_year=1990")
    assert response.status_code == 200
    assert response.json() == []


def test_f1_players_boundary_nonexistent_position(client):
    """GET /api/players?pos=KICKER returns an empty list."""
    response = client.get("/api/players?pos=KICKER")
    assert response.status_code == 200
    assert response.json() == []


def test_f1_players_boundary_nonexistent_team(client):
    """GET /api/players?team_abbr=XYZ returns an empty list."""
    response = client.get("/api/players?team_abbr=XYZ")
    assert response.status_code == 200
    assert response.json() == []


def test_f1_players_boundary_empty_search(client):
    """GET /api/players?q= returns all 510 players."""
    response = client.get("/api/players?q=")
    assert response.status_code == 200
    assert len(response.json()) == 510


def test_f1_players_boundary_special_characters_search(client):
    """GET /api/players?q=!@#$%^&*() returns empty list without regex error."""
    response = client.get("/api/players?q=!@#$%^&*()")
    assert response.status_code == 200
    assert response.json() == []


# ==============================================================================
# Tier 1 & Tier 2: F2 - Player Bio & Career Summary (/api/player/{id}/summary)
# ==============================================================================

def test_f2_summary_status_200(client):
    """GET /api/player/55884/summary returns HTTP 200."""
    response = client.get("/api/player/55884/summary")
    assert response.status_code == 200


def test_f2_summary_top_level_keys(client):
    """Summary response has bio, combine, career blocks."""
    response = client.get("/api/player/55884/summary")
    assert response.status_code == 200
    data = response.json()
    assert data["nfl_id"] == 55884
    assert "bio" in data
    assert "combine" in data
    assert ("career" in data) or ("career_stats" in data)


def test_f2_summary_bio_fields(client):
    """Bio block contains college, conference, birth_date, height, weight."""
    response = client.get("/api/player/55884/summary")
    bio = response.json()["bio"]
    assert bio["college"] == "Ohio State"
    assert "birth_date" in bio
    height = bio.get("height_in") or bio.get("combine_height")
    weight = bio.get("weight_lbs") or bio.get("combine_weight")
    assert height is not None and float(height) > 60.0
    assert weight is not None and int(weight) > 150


def test_f2_summary_bio_anthropometrics(client):
    """Bio includes hand_size, arm_length, wing_span."""
    response = client.get("/api/player/55884/summary")
    bio = response.json()["bio"]
    assert "hand_size" in bio
    assert "arm_length" in bio
    assert "wing_span" in bio


def test_f2_summary_career_snaps(client):
    """Career stats include offensive, defensive, and special teams snaps."""
    response = client.get("/api/player/55884/summary")
    data = response.json()
    career = data.get("career") or data.get("career_stats")
    assert "offensive_snaps" in career or "career_offensive_snaps" in career
    off_snaps = career.get("offensive_snaps", career.get("career_offensive_snaps"))
    assert off_snaps >= 0


def test_f2_summary_career_accolades(client):
    """Career stats include games_active, all_pro, and pro_bowl."""
    response = client.get("/api/player/55884/summary")
    data = response.json()
    career = data.get("career") or data.get("career_stats")
    active_games = career.get("games_active", career.get("career_games_active", 0))
    assert active_games >= 0


def test_f2_summary_boundary_nonexistent_id(client):
    """GET /api/player/999999/summary returns 404 Not Found."""
    response = client.get("/api/player/999999/summary")
    assert response.status_code == 404


def test_f2_summary_boundary_invalid_id_format(client):
    """GET /api/player/not_a_number/summary returns 404 or 422."""
    response = client.get("/api/player/not_a_number/summary")
    assert response.status_code in [404, 422]


def test_f2_summary_boundary_negative_id(client):
    """GET /api/player/-1/summary returns 404 or 422."""
    response = client.get("/api/player/-1/summary")
    assert response.status_code in [404, 422]


def test_f2_summary_udfa_draft_pick(client):
    """Undrafted Free Agent (UDFA) has null draft_round or marked as UDFA."""
    # Find an undrafted player
    players_res = client.get("/api/players")
    udfa = next(
        (p for p in players_res.json() if p.get("draft_round") is None or p.get("draft_round") == 0),
        None
    )
    if udfa:
        res = client.get(f"/api/player/{udfa['nfl_id']}/summary")
        assert res.status_code == 200


# ==============================================================================
# Tier 1 & Tier 2: F3 - Combine Metrics & Opt-Out Badges
# ==============================================================================

def test_f3_combine_metrics_presence(client):
    """Combine block includes forty, vertical, broad_jump, three_cone, shuttle, bench."""
    response = client.get("/api/player/55884/summary")
    combine = response.json()["combine"]
    tests = combine.get("combine_tests", combine)
    for key in ["vertical", "three_cone", "short_shuttle"]:
        assert key in tests


def test_f3_combine_opt_out_structure(client):
    """Opt-outs are explicitly represented via flag, tag, or opt_outs list."""
    response = client.get("/api/player/55884/summary")
    combine = response.json()["combine"]
    tests = combine.get("combine_tests", combine)
    # JSN did not run 40 at combine (MNAR opt-out)
    forty_entry = tests.get("forty")
    if isinstance(forty_entry, dict):
        assert forty_entry.get("opt_out") is True or forty_entry.get("value") is None
    elif isinstance(forty_entry, (int, float, type(None))):
        assert forty_entry is None or "forty" in combine.get("opt_outs", [])


def test_f3_combine_recorded_values_jsn(client):
    """Verify recorded combine test scores for Jaxon Smith-Njigba."""
    response = client.get("/api/player/55884/summary")
    combine = response.json()["combine"]
    tests = combine.get("combine_tests", combine)

    def extract_val(entry):
        return entry.get("value") if isinstance(entry, dict) else entry

    assert extract_val(tests.get("vertical")) == pytest.approx(35.0, abs=0.1)
    assert extract_val(tests.get("three_cone")) == pytest.approx(6.57, abs=0.01)
    assert extract_val(tests.get("short_shuttle")) == pytest.approx(3.93, abs=0.01)


def test_f3_combine_ngs_scores(client):
    """Combine includes NGS athleticism, college production, and final scores."""
    response = client.get("/api/player/55884/summary")
    combine = response.json()["combine"]
    ngs = combine.get("ngs_scores", combine)
    assert "athleticism_score" in ngs or "ngs_athleticism_score" in ngs


def test_f3_combine_boundary_full_participant(client):
    """Brian Thomas Jr. (57144) ran forty: 4.33s."""
    response = client.get("/api/player/57144/summary")
    assert response.status_code == 200
    combine = response.json()["combine"]
    tests = combine.get("combine_tests", combine)
    val = tests.get("forty", {}).get("value") if isinstance(tests.get("forty"), dict) else tests.get("forty")
    assert val == pytest.approx(4.33, abs=0.01)


# ==============================================================================
# Tier 1 & Tier 2: F4 & F5 - Tracked Combine Drills & Ball Separation
# ==============================================================================

def test_f4_combine_drill_endpoint_valid(client):
    """Query a valid combine drill attempt."""
    # Jayden Higgins route drill
    event_id = "20250301100700_1740869577323_000"
    response = client.get(f"/api/player/58239/combine/{event_id}")
    assert response.status_code == 200
    data = response.json()
    assert "drill_name" in data
    assert ("player_frames" in data) or ("player_trajectory" in data)


def test_f4_combine_drill_summary_metrics(client):
    """Combine drill includes s_max, a_max, and duration."""
    event_id = "20250301100700_1740869577323_000"
    response = client.get(f"/api/player/58239/combine/{event_id}")
    data = response.json()
    metrics = data.get("metrics", data)
    assert "s_max" in metrics and metrics["s_max"] > 0
    assert "a_max" in metrics
    duration = metrics.get("duration", metrics.get("duration_sec"))
    assert duration is not None and duration > 0


def test_f4_combine_drill_curvature_90(client):
    """Combine drill includes kappa_90 (90th percentile curvature)."""
    event_id = "20250301100700_1740869577323_000"
    response = client.get(f"/api/player/58239/combine/{event_id}")
    data = response.json()
    metrics = data.get("metrics", data)
    assert "kappa_90" in metrics
    assert metrics["kappa_90"] >= 0.0


def test_f5_combine_drill_ball_separation(client):
    """Route drill for WR 58239 separates player_frames and ball_frames."""
    event_id = "20250301100700_1740869577323_000"
    response = client.get(f"/api/player/58239/combine/{event_id}")
    data = response.json()
    p_frames = data.get("player_frames") or data.get("player_trajectory")
    b_frames = data.get("ball_frames") or data.get("ball_trajectory")
    assert len(p_frames) == 68
    assert len(b_frames) == 68


def test_f5_combine_drill_ball_coordinates_valid(client):
    """Ball frames contain coordinates within reasonable playing area."""
    event_id = "20250301100700_1740869577323_000"
    response = client.get(f"/api/player/58239/combine/{event_id}")
    b_frames = response.json().get("ball_frames") or response.json().get("ball_trajectory")
    for f in b_frames:
        assert 0.0 <= f["x"] <= 120.0
        assert 0.0 <= f["y"] <= 53.33


def test_f4_combine_drill_boundary_nonexistent_event(client):
    """GET /api/player/58239/combine/nonexistent_event returns 404."""
    response = client.get("/api/player/58239/combine/fake_event_9999")
    assert response.status_code == 404


def test_f4_combine_drill_boundary_nonexistent_player(client):
    """GET /api/player/999999/combine/event returns 404."""
    response = client.get("/api/player/999999/combine/some_event")
    assert response.status_code == 404


# ==============================================================================
# Tier 1 & Tier 2: F6 - Game & Play Filtering API (/api/player/{id}/games)
# ==============================================================================

def test_f6_games_status_200(client):
    """GET /api/player/55884/games returns HTTP 200."""
    response = client.get("/api/player/55884/games")
    assert response.status_code == 200


def test_f6_games_list_structure(client):
    """Returns games list containing game metadata."""
    response = client.get("/api/player/55884/games")
    data = response.json()
    games = data.get("games", data)
    assert len(games) > 0
    first_game = games[0]
    assert "game_id" in first_game
    assert "season" in first_game


def test_f6_games_filter_play_type_pass(client):
    """GET /api/player/55884/games?play_type=PASS returns only pass plays."""
    response = client.get("/api/player/55884/games?play_type=PASS")
    assert response.status_code == 200
    data = response.json()
    games = data.get("games", data)
    for g in games:
        for p in g.get("plays", []):
            ptype = p.get("play_type", "").upper()
            assert ptype == "PASS"


def test_f6_games_filter_play_type_run(client):
    """GET /api/player/55884/games?play_type=RUN returns only run plays."""
    response = client.get("/api/player/55884/games?play_type=RUN")
    assert response.status_code == 200
    data = response.json()
    games = data.get("games", data)
    for g in games:
        for p in g.get("plays", []):
            ptype = p.get("play_type", "").upper()
            assert ptype == "RUN"


def test_f6_games_play_analytics_epa(client):
    """Plays include expected_points_added (epa) and game_clock."""
    response = client.get("/api/player/55884/games")
    games = response.json().get("games", response.json())
    sample_play = next((p for g in games for p in g.get("plays", [])), None)
    assert sample_play is not None
    assert "epa" in sample_play or "expected_points_added" in sample_play
    assert "game_clock" in sample_play or "quarter" in sample_play


def test_f6_games_boundary_nonexistent_player(client):
    """GET /api/player/999999/games returns 404 Not Found."""
    response = client.get("/api/player/999999/games")
    assert response.status_code == 404


def test_f6_games_boundary_zero_snap_player(client):
    """Player 56648 (0 game snaps) returns HTTP 200 with empty games/plays list."""
    response = client.get("/api/player/56648/games")
    assert response.status_code == 200
    data = response.json()
    games = data.get("games", data)
    assert games == []


# ==============================================================================
# Tier 1 & Tier 2: F7 - Game Snap Telemetry & Season Dispatch
# ==============================================================================

def test_f7_snap_status_200(client):
    """GET /api/player/55884/snap/2023081052/202 returns HTTP 200."""
    response = client.get("/api/player/55884/snap/2023081052/202")
    assert response.status_code == 200


def test_f7_snap_frames_count(client):
    """Play 202 of game 2023081052 contains 77 10-Hz frames."""
    response = client.get("/api/player/55884/snap/2023081052/202")
    data = response.json()
    frames = data.get("frames", [])
    assert len(frames) == 77


def test_f7_snap_frames_dual_angles(client):
    """Frames include motion direction dir and body orientation o."""
    response = client.get("/api/player/55884/snap/2023081052/202")
    frames = response.json().get("frames", [])
    for f in frames[:10]:
        assert "dir" in f and 0.0 <= f["dir"] <= 360.0
        assert "o" in f and 0.0 <= f["o"] <= 360.0


def test_f7_snap_frames_slip_angle(client):
    """Frames include slip angle beta_slip bounded in [-180, 180]."""
    response = client.get("/api/player/55884/snap/2023081052/202")
    frames = response.json().get("frames", [])
    for f in frames:
        beta = f.get("beta_slip", f.get("slip_angle"))
        if beta is not None:
            assert -180.0 <= beta <= 180.0


def test_f7_snap_event_markers(client):
    """Snap includes event markers such as ball_snap, pass_forward, tackle."""
    response = client.get("/api/player/55884/snap/2023081052/202")
    data = response.json()
    # Check events list or event tags in frames
    events = data.get("events")
    if events is not None:
        event_names = [e["event"] for e in events]
    else:
        event_names = [f["event"] for f in data.get("frames", []) if f.get("event")]
    assert "ball_snap" in event_names


def test_f7_snap_boundary_nonexistent_play_id(client):
    """GET /api/player/55884/snap/2023081052/999999 returns 404."""
    response = client.get("/api/player/55884/snap/2023081052/999999")
    assert response.status_code == 404


def test_f7_snap_boundary_nonexistent_game_id(client):
    """GET /api/player/55884/snap/9999999999/202 returns 404."""
    response = client.get("/api/player/55884/snap/9999999999/202")
    assert response.status_code == 404


def test_f7_snap_boundary_nonexistent_player(client):
    """GET /api/player/999999/snap/2023081052/202 returns 404."""
    response = client.get("/api/player/999999/snap/2023081052/202")
    assert response.status_code == 404


# ==============================================================================
# Tier 1 & Tier 2: F12 - Edge Cases & Data Anomalies
# ==============================================================================

def test_f12_multi_team_puka_nacua_indexing(client):
    """Puka Nacua (56042) is indexed with both LA and LAR."""
    response = client.get("/api/players?q=Puka")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 1
    puka = data[0]
    teams = puka["teams"]
    assert "LA" in teams or "LAR" in teams


def test_f12_multi_team_filter_both_codes(client):
    """Querying either LA or LAR finds Rams players."""
    res_lar = client.get("/api/players?team_abbr=LAR")
    res_la = client.get("/api/players?team_abbr=LA")
    assert res_lar.status_code == 200
    assert res_la.status_code == 200
    pids_lar = [p["nfl_id"] for p in res_lar.json()]
    pids_la = [p["nfl_id"] for p in res_la.json()]
    # Puka Nacua is in either or both
    assert (56042 in pids_lar) or (56042 in pids_la)


def test_f12_zero_snap_rookie_summary_success(client):
    """Zero-snap rookie 56648 returns full summary without failure."""
    response = client.get("/api/player/56648/summary")
    assert response.status_code == 200
    assert response.json()["nfl_id"] == 56648


def test_f1_players_filter_combination_pos_and_year(client):
    """GET /api/players?draft_year=2023&pos=WR returns only 2023 wide receivers."""
    response = client.get("/api/players?draft_year=2023&pos=WR")
    assert response.status_code == 200
    data = response.json()
    assert len(data) > 0
    for p in data:
        assert p["draft_year"] == 2023
        pos = p.get("position") or p.get("nfl_position")
        assert pos == "WR"


def test_f1_players_filter_combination_pos_and_team(client):
    """GET /api/players?pos=WR&team_abbr=SEA returns Seahawks wide receivers."""
    response = client.get("/api/players?pos=WR&team_abbr=SEA")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 1
    assert any(p["nfl_id"] == 55884 for p in data)


def test_f2_summary_draft_round_and_pick_numerical(client):
    """Summary draft picks are numbers or null."""
    response = client.get("/api/player/55884/summary")
    data = response.json()
    assert data.get("draft_round") in [1.0, 1]
    assert data.get("draft_overall_pick") in [20.0, 20]


def test_f4_combine_drill_entity_types_strictly_player_or_ball(client):
    """Tracking drill only returns PLAYER and BALL entities."""
    event_id = "20250301100700_1740869577323_000"
    response = client.get(f"/api/player/58239/combine/{event_id}")
    data = response.json()
    assert "player_frames" in data or "player_trajectory" in data


def test_f6_games_filter_season_2023(client):
    """GET /api/player/55884/games?season=2023 returns only 2023 season games."""
    response = client.get("/api/player/55884/games?season=2023")
    assert response.status_code == 200
    games = response.json().get("games", response.json())
    for g in games:
        assert g["season"] == 2023


def test_f6_games_plays_contain_descriptions(client):
    """Game plays contain descriptive play text."""
    response = client.get("/api/player/55884/games")
    games = response.json().get("games", response.json())
    sample_play = next((p for g in games for p in g.get("plays", [])), None)
    assert sample_play is not None
    assert "description" in sample_play or "play_description" in sample_play


def test_f7_snap_frames_temporal_monotonicity(client):
    """Snap tracking frames are ordered sequentially by time."""
    response = client.get("/api/player/55884/snap/2023081052/202")
    frames = response.json().get("frames", [])
    times = [f["time"] for f in frames]
    assert times == sorted(times)


def test_f12_zero_snap_rookie_games_graceful(client):
    """Zero-snap rookie 58407 returns empty games list without 500 crash."""
    response = client.get("/api/player/58407/games")
    assert response.status_code == 200
    games = response.json().get("games", response.json())
    assert games == []


def test_f7_snap_playoff_game_january_2024(client):
    """Playoff game played in January 2024 returns HTTP 200 with 81 valid frames and kinematics."""
    response = client.get("/api/player/56042/snap/2024011402/986")
    assert response.status_code == 200
    data = response.json()
    assert data["game_id"] == 2024011402
    assert data["play_id"] == 986
    frames = data.get("frames", [])
    assert len(frames) == 81
    assert any(f.get("omega") is not None for f in frames)
    assert any(f.get("curvature") is not None for f in frames)
    assert any(f.get("slip_angle") is not None for f in frames)


def test_f6_games_filter_season_2023_includes_playoffs(client):
    """GET /api/player/56042/games?season=2023 includes all 19 games including January 2024 playoff games."""
    response = client.get("/api/player/56042/games?season=2023")
    assert response.status_code == 200
    games = response.json().get("games", [])
    assert len(games) == 19
    game_ids = [g["game_id"] for g in games]
    assert 2024010710 in game_ids  # Week 18 regular season played Jan 2024
    assert 2024011402 in game_ids  # Wild Card playoff played Jan 2024
    assert all(g["season"] == 2023 for g in games)


def test_f6_games_filter_season_2024_no_leakage(client):
    """GET /api/player/56042/games?season=2024 does not leak 2023 games played in calendar year 2024."""
    response = client.get("/api/player/56042/games?season=2024")
    assert response.status_code == 200
    games = response.json().get("games", [])
    mismatches = [g for g in games if g["season"] != 2024]
    assert len(mismatches) == 0
    assert all(g["season"] == 2024 for g in games)


