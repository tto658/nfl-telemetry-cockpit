"""Tier 5 Adversarial Backend Verification Suite.

Milestone M5 Phase 2: White-Box Adversarial Coverage Hardening.

Covers:
- Section 1: Query string anomalies, missing or malformed params on all 7 API endpoints.
- Section 2: Status code correctness: exact 404 for missing resources, 200 for empty lists, CORS/MIME headers.
- Section 3: Data boundary conditions across all 510 players (0-snap rookies, Rams LA/LAR, FA filtering, January postseason routing).
- Section 4: Kinematics engine & FrameDTO mathematical oracles (modular compass wraps, slip angle range [-180, 180],
  singularity threshold cutoff s < 0.2, float NaN/Inf prevention, zero preservation).
"""

from __future__ import annotations

import json
import math

import polars as pl
import pytest
from starlette.testclient import TestClient

from src.web.data_loader import get_player_registry
from src.web.kinematics import (
    compute_angular_velocity,
    compute_curvature,
    compute_slip_angle,
    compute_tracking_kinematics,
    decompose_velocity,
    unwrap_angle_diff,
)
from src.web.schemas import (
    FrameDTO,
    format_draft_pick,
    format_height,
)

# ==============================================================================
# SECTION 1: Query String Anomalies, Missing & Malformed Params on all 7 Endpoints
# ==============================================================================


class TestEndpointQueryAnomalies:
    """Stress tests query parameter parsing, sanitization, and edge cases across all endpoints."""

    def test_api_players_missing_query_params(self, client: TestClient):
        """GET /api/players with no query parameters returns all 510 players (fast-path)."""
        res = client.get("/api/players")
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("application/json")
        data = res.json()
        assert isinstance(data, list)
        assert len(data) == 510

    def test_api_players_empty_query_params(self, client: TestClient):
        """GET /api/players with empty string query params returns all 510 players."""
        res = client.get("/api/players?draft_year=&pos=&team_abbr=&q=")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 510

    @pytest.mark.parametrize(
        "invalid_year",
        [
            "-2024",
            "0",
            "1899",
            "2101",
            "9999999999999",
            "two_thousand_twenty_four",
            "2023.5",
            "NaN",
            "null",
        ],
    )
    def test_api_players_invalid_draft_year(self, client: TestClient, invalid_year: str):
        """Invalid draft_year fails Pydantic validation and safely returns empty list []."""
        res = client.get(f"/api/players?draft_year={invalid_year}")
        assert res.status_code == 200
        data = res.json()
        assert data == []

    @pytest.mark.parametrize(
        "malicious_pos",
        [
            "' OR '1'='1",
            "<script>alert(1)</script>",
            "WR; DROP TABLE players; --",
            "A" * 150,  # exceeds max_length=20
            "../../etc/passwd",
            "%00",
        ],
    )
    def test_api_players_adversarial_position(self, client: TestClient, malicious_pos: str):
        """Adversarial position parameter does not crash the server and returns empty list or safe match."""
        res = client.get("/api/players", params={"pos": malicious_pos})
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        assert len(data) == 0

    @pytest.mark.parametrize(
        "malicious_q",
        [
            "' UNION SELECT * FROM users --",
            "\" OR \"\"=\"",
            "<svg onload=alert(1)>",
            "A" * 500,  # exceeds max_length=100
            "\\x00\\x01\\x02",
            "[a-z]*",  # regex chars
            "(.*)",
        ],
    )
    def test_api_players_adversarial_search_query(self, client: TestClient, malicious_q: str):
        """Adversarial text query does not trigger regex errors or SQL injection."""
        res = client.get("/api/players", params={"q": malicious_q})
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        assert len(data) == 0

    def test_api_players_unknown_extra_parameters(self, client: TestClient):
        """Unknown query parameters are safely ignored."""
        res = client.get("/api/players?extra_flag=true&limit=10&sort=desc")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 510

    @pytest.mark.parametrize(
        "bad_nfl_id",
        [-1, 0, -99999, 999999999],
    )
    def test_api_player_summary_invalid_ids(self, client: TestClient, bad_nfl_id: int):
        """GET /api/player/{nfl_id}/summary returns 404 for negative, zero, or non-existent IDs."""
        res = client.get(f"/api/player/{bad_nfl_id}/summary")
        assert res.status_code == 404
        if "application/json" in res.headers.get("content-type", ""):
            assert "detail" in res.json()
        else:
            assert "Not Found" in res.text

    def test_api_player_summary_spurious_params(self, client: TestClient):
        """GET /api/player/{nfl_id}/summary ignores unexpected query params."""
        res = client.get("/api/player/55884/summary?include=all&verbose=1")
        assert res.status_code == 200
        data = res.json()
        assert data["nfl_id"] == 55884
        assert "bio" in data
        assert "combine" in data
        assert "career" in data

    @pytest.mark.parametrize(
        "bad_nfl_id",
        [-1, 0, 999999999],
    )
    def test_api_player_combine_invalid_ids(self, client: TestClient, bad_nfl_id: int):
        """GET /api/player/{nfl_id}/combine returns 404 for invalid IDs."""
        res = client.get(f"/api/player/{bad_nfl_id}/combine")
        assert res.status_code == 404
        if "application/json" in res.headers.get("content-type", ""):
            assert "detail" in res.json()
        else:
            assert "Not Found" in res.text

    @pytest.mark.parametrize(
        "bad_event_id",
        [
            "nonexistent_event_999",
            "../../etc/passwd",
            "..%2f..%2fcombine_tracking",
            "event' OR '1'='1",
            "NUL",
            "CON",
        ],
    )
    def test_api_player_combine_drill_nonexistent_or_malicious_event(self, client: TestClient, bad_event_id: str):
        """GET /api/player/{nfl_id}/combine/{event_id} returns 404 for nonexistent or path traversal events."""
        res = client.get(f"/api/player/58239/combine/{bad_event_id}")
        assert res.status_code == 404
        if "application/json" in res.headers.get("content-type", ""):
            assert "detail" in res.json()
        else:
            assert "Not Found" in res.text

    def test_api_player_games_query_params(self, client: TestClient):
        """GET /api/player/{nfl_id}/games filters and handles malformed query parameters gracefully."""
        # Valid player, non-existent season -> returns empty list 200
        res = client.get("/api/player/55884/games?season=1980")
        assert res.status_code == 200
        assert res.json() == {"games": []}

        # Malformed season string is ignored (treated as None) -> returns all games
        res_bad = client.get("/api/player/55884/games?season=invalid_season")
        assert res_bad.status_code == 200
        res_all = client.get("/api/player/55884/games")
        assert len(res_bad.json()["games"]) == len(res_all.json()["games"])

        # Unknown play_type -> returns empty games
        res_pt = client.get("/api/player/55884/games?play_type=FIELD_GOAL")
        assert res_pt.status_code == 200
        assert res_pt.json() == {"games": []}

    def test_api_player_plays_game_query_params(self, client: TestClient):
        """GET /api/player/{nfl_id}/plays/{game_id} parameter variations."""
        # Non-existent game_id -> returns 200 []
        res = client.get("/api/player/55884/plays/9999999999")
        assert res.status_code == 200
        assert res.json() == []

        # Negative game_id fails Starlette path converter -> returns 404
        res_neg = client.get("/api/player/55884/plays/-1")
        assert res_neg.status_code == 404

        # Non-existent player -> returns 404
        res = client.get("/api/player/999999999/plays/2023081052")
        assert res.status_code == 404

        # Case-insensitive lined_up_position and play_type
        res_wr = client.get("/api/player/55884/plays/2023081052?lined_up_position=wr&play_type=pass")
        assert res_wr.status_code == 200
        plays = res_wr.json()
        assert len(plays) > 0
        for p in plays:
            assert p["lined_up_position"].upper() == "WR"
            assert p["play_type"].upper() == "PASS"

    def test_api_player_snap_invalid_params(self, client: TestClient):
        """GET /api/player/{nfl_id}/snap/{game_id}/{play_id} with invalid coordinates."""
        # Non-existent play_id in valid game
        res = client.get("/api/player/55884/snap/2023081052/999999")
        assert res.status_code == 404
        assert "detail" in res.json()

        # Non-existent game_id
        res = client.get("/api/player/55884/snap/9999999999/202")
        assert res.status_code == 404

        # Non-existent player
        res = client.get("/api/player/999999999/snap/2023081052/202")
        assert res.status_code == 404

        # Negative IDs
        res = client.get("/api/player/-1/snap/2023081052/202")
        assert res.status_code == 404


# ==============================================================================
# SECTION 2: Status Code Correctness & Response Header Invariants
# ==============================================================================


class TestStatusCodeAndHeaders:
    """Verifies strict adherence to HTTP status codes, MIME types, and CORS headers."""

    def test_cors_headers_present_on_all_endpoints(self, client: TestClient):
        """Every endpoint must expose CORS headers (allow_origins=*) when requested with Origin."""
        endpoints = [
            "/api/players",
            "/api/metadata",
            "/api/player/55884/summary",
            "/api/player/55884/combine",
            "/api/player/55884/games",
            "/api/player/55884/plays/2023081052",
            "/api/player/55884/snap/2023081052/202",
        ]
        headers = {"Origin": "http://localhost:3000"}
        for ep in endpoints:
            res = client.get(ep, headers=headers)
            assert res.status_code == 200, f"Endpoint {ep} failed with {res.status_code}"
            assert res.headers.get("access-control-allow-origin") == "*", f"Missing CORS on {ep}"
            assert "application/json" in res.headers.get("content-type", ""), f"Non-JSON content-type on {ep}"

    def test_not_found_status_code_strict_404(self, client: TestClient):
        """Non-existent entities must return exact 404 (not 500, 400, or 200)."""
        bad_endpoints = [
            "/api/player/999999999/summary",
            "/api/player/999999999/combine",
            "/api/player/999999999/combine/event_1",
            "/api/player/999999999/games",
            "/api/player/999999999/plays/2023081052",
            "/api/player/999999999/snap/2023081052/202",
            "/api/player/55884/snap/2023081052/999999",
            "/api/player/55884/combine/non_existent_drill_xyz",
        ]
        for ep in bad_endpoints:
            res = client.get(ep)
            assert res.status_code == 404, f"Expected 404 for {ep}, got {res.status_code}"
            assert "detail" in res.json()

    def test_empty_results_return_200_not_404(self, client: TestClient):
        """Valid queries that yield 0 results must return HTTP 200 with an empty structure."""
        # Unmatched search
        res = client.get("/api/players?q=completely_unmatched_player_name_12345")
        assert res.status_code == 200
        assert res.json() == []

        # Unmatched plays for existing game
        res = client.get("/api/player/55884/plays/2023081052?lined_up_position=PUNTER")
        assert res.status_code == 200
        assert res.json() == []

        # Zero snap player games
        res = client.get("/api/player/56648/games")
        assert res.status_code == 200
        assert res.json() == {"games": []}


# ==============================================================================
# SECTION 3: Data Boundary Conditions Across All 510 Players
# ==============================================================================


class TestDataBoundariesAndNormalization:
    """Verifies dataset completeness, zero-snap rookie boundaries, Rams LA/LAR, and calendar dispatch."""

    def test_registry_contains_exactly_510_players(self):
        """The in-memory PlayerRegistry must index exactly 510 players."""
        reg = get_player_registry()
        assert len(reg._players_list) == 510
        assert len(reg._players_by_id) == 510
        assert len(reg._bio_by_id) == 510

    def test_all_13_zero_snap_players_handling(self, client: TestClient):
        """All 13 players with 0 game snaps must be correctly indexed and safely handled."""
        reg = get_player_registry()
        zero_snap_players = [p for p in reg._players_list if len(p.teams) == 0]
        assert len(zero_snap_players) == 13, f"Expected 13 zero-snap players, found {len(zero_snap_players)}"

        for p in zero_snap_players:
            # 1. Player list item contract
            assert p.teams == []
            assert p.team == "FA"
            assert "FA" in p.display_label

            # 2. Summary endpoint contract
            res_sum = client.get(f"/api/player/{p.nfl_id}/summary")
            assert res_sum.status_code == 200
            s_data = res_sum.json()
            assert s_data["career"]["total_snaps"] == 0
            assert s_data["career"]["offensive_snaps"] == 0
            assert s_data["career"]["defensive_snaps"] == 0
            assert s_data["career"]["special_teams_snaps"] == 0

            # 3. Games endpoint returns empty list without error
            res_games = client.get(f"/api/player/{p.nfl_id}/games")
            assert res_games.status_code == 200
            assert res_games.json() == {"games": []}

    def test_free_agent_fa_filtering(self, client: TestClient):
        """Filtering by team_abbr=FA must return exactly the 13 zero-snap players."""
        res = client.get("/api/players?team_abbr=FA")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 13
        for p in data:
            assert p["teams"] == []
            assert p["team"] == "FA"

    def test_rams_la_vs_lar_normalization(self, client: TestClient):
        """Filtering by LA or LAR returns Puka Nacua (56042) and all Rams players seamlessly."""
        # Query LA
        res_la = client.get("/api/players?team_abbr=LA")
        assert res_la.status_code == 200
        la_ids = {p["nfl_id"] for p in res_la.json()}
        assert 56042 in la_ids, "Puka Nacua missing from LA filter"

        # Query LAR
        res_lar = client.get("/api/players?team_abbr=LAR")
        assert res_lar.status_code == 200
        lar_ids = {p["nfl_id"] for p in res_lar.json()}
        assert 56042 in lar_ids, "Puka Nacua missing from LAR filter"

        # Both queries must return identical player sets
        assert la_ids == lar_ids

        # Verify game opponent and home/away resolution for Puka Nacua (56042)
        res_games = client.get("/api/player/56042/games")
        assert res_games.status_code == 200
        games = res_games.json()["games"]
        assert len(games) > 0
        for g in games:
            # Home/away and opponent must never be None
            assert g["home_away"] in ("home", "away"), f"Invalid home_away: {g}"
            assert g["opponent"] is not None and len(g["opponent"]) >= 2, f"Invalid opponent: {g}"
            # Rams should not be playing against Rams
            assert g["opponent"] not in ("LA", "LAR"), f"Rams playing Rams: {g}"

    def test_january_postseason_routing_and_isolation(self, client: TestClient):
        """January postseason games belong to the previous calendar year's NFL season."""
        # Puka Nacua (56042) played in Wild Card on 2024-01-14 against DET (2024011402)
        res_2023 = client.get("/api/player/56042/games?season=2023")
        assert res_2023.status_code == 200
        games_2023 = res_2023.json()["games"]
        gids_2023 = {g["game_id"] for g in games_2023}
        assert 2024011402 in gids_2023, "January 2024 playoff game missing from Season 2023"

        # Querying season 2024 must NOT leak this 2023 playoff game
        res_2024 = client.get("/api/player/56042/games?season=2024")
        assert res_2024.status_code == 200
        games_2024 = res_2024.json()["games"]
        gids_2024 = {g["game_id"] for g in games_2024}
        assert 2024011402 not in gids_2024, "January 2024 playoff game leaked into Season 2024"

        # Snap retrieval for January playoff game succeeds and produces valid frames
        res_snap = client.get("/api/player/56042/snap/2024011402/986")
        assert res_snap.status_code == 200
        snap_data = res_snap.json()
        assert snap_data["game_id"] == 2024011402
        assert snap_data["play_id"] == 986
        assert len(snap_data["frames"]) > 0

    def test_udfa_and_draft_pick_formatting_boundaries(self):
        """Format draft pick formatting across draft rounds, picks, and UDFA boundaries."""
        assert format_draft_pick(None) == "UDFA"
        assert format_draft_pick(float("nan")) == "UDFA"
        assert format_draft_pick(0) == "UDFA"
        assert format_draft_pick(-1) == "UDFA"
        assert format_draft_pick(1, 20, 20) == "Round 1, Pick 20"
        assert format_draft_pick(2, 5, 37) == "Round 2, Pick 5 (#37)"
        assert format_draft_pick(7, None, 256) == "Round 7, Pick 256"
        assert format_draft_pick(5, 12, None) == "Round 5, Pick 12"
        assert format_draft_pick(3) == "Round 3"

    def test_height_formatting_boundaries(self):
        """Format height in inches into standard feet and inches string."""
        assert format_height(None) == "N/A"
        assert format_height(float("nan")) == "N/A"
        assert format_height(0.0) == "N/A"
        assert format_height(-72.0) == "N/A"
        assert format_height(72.0) == "6' 0\""
        assert format_height(72.625) == "6' 1\""
        assert format_height(69.4) == "5' 9\""
        assert format_height(78.8) == "6' 7\""


# ==============================================================================
# SECTION 4: Kinematics Engine & FrameDTO Mathematical Oracles
# ==============================================================================


class TestKinematicsAndFrameDTOOracles:
    """Rigorous mathematical stress tests for angular velocity, curvature, slip angle, and DTO serialization."""

    def test_framedto_zero_value_preservation(self):
        """Zero values for kinematics must not be omitted or converted to None in JSON serialization."""
        dto = FrameDTO(
            frameId=0,
            time=0.0,
            x=0.0,
            y=0.0,
            s=0.0,
            a=0.0,
            dir=0.0,
            o=0.0,
            omega=0.0,
            curvature=0.0,
            slip_angle=0.0,
            event=None,
        )
        d = dto.model_dump()
        assert d["frameId"] == 0
        assert d["time"] == 0.0
        assert d["x"] == 0.0
        assert d["y"] == 0.0
        assert d["s"] == 0.0
        assert d["a"] == 0.0
        assert d["dir"] == 0.0
        assert d["o"] == 0.0
        assert d["omega"] == 0.0
        assert d["curvature"] == 0.0
        assert d["slip_angle"] == 0.0

        # Ensure json string preserves 0.0 numbers
        dumped_json = dto.model_dump_json()
        parsed = json.loads(dumped_json)
        assert parsed["s"] == 0.0
        assert parsed["omega"] == 0.0
        assert parsed["curvature"] == 0.0
        assert parsed["slip_angle"] == 0.0

    def test_framedto_nan_inf_sanitization(self):
        """Float NaN or Inf values are safely converted to None/0.0 without invalid JSON tokens."""
        raw = {
            "frameId": 1,
            "time": 0.1,
            "x": float("nan"),
            "y": float("inf"),
            "s": float("-inf"),
            "a": 1.5,
            "dir": 90.0,
            "o": float("nan"),
            "omega": float("inf"),
            "curvature": float("nan"),
            "slip_angle": float("nan"),
        }
        dto = FrameDTO.model_validate(raw)
        assert dto.x == 0.0
        assert dto.y == 0.0
        assert dto.s == 0.0
        assert dto.o is None
        assert dto.omega is None
        assert dto.curvature is None
        assert dto.slip_angle is None

        # Verify JSON validity (no NaN or Infinity literals)
        json_str = dto.model_dump_json()
        assert "NaN" not in json_str
        assert "Infinity" not in json_str
        parsed = json.loads(json_str)
        assert parsed["o"] is None

    def test_angular_velocity_compass_modular_wrapping(self):
        """Angular velocity unwrap across 0/360 boundary."""
        # 1 deg past north to 1 deg before north (2 degrees change over dt=0.1)
        assert unwrap_angle_diff(1.0, 359.0) == 2.0
        assert unwrap_angle_diff(359.0, 1.0) == -2.0

        # compute_angular_velocity
        omega_fwd = compute_angular_velocity(1.0, 359.0, dt=0.1)
        assert pytest.approx(omega_fwd, rel=1e-5) == 20.0  # 2.0 / 0.1

        omega_rev = compute_angular_velocity(359.0, 1.0, dt=0.1)
        assert pytest.approx(omega_rev, rel=1e-5) == 20.0

        # Exact 180 reversal
        assert abs(unwrap_angle_diff(0.0, 180.0)) == 180.0
        assert pytest.approx(compute_angular_velocity(0.0, 180.0, dt=0.1), rel=1e-5) == 1800.0

    def test_slip_angle_range_and_quadrant_crossing(self):
        """Slip angle beta_slip = ((dir - o + 180) % 360) - 180 is strictly in [-180, 180]."""
        # Collinear sprint
        assert compute_slip_angle(45.0, 45.0) == 0.0
        assert compute_slip_angle(0.0, 0.0) == 0.0

        # Pure reverse / backpedal (180 deg)
        assert abs(compute_slip_angle(0.0, 180.0)) == 180.0
        assert abs(compute_slip_angle(90.0, 270.0)) == 180.0

        # Small angle across north boundary: dir=5, o=355 -> +10 deg
        assert pytest.approx(compute_slip_angle(5.0, 355.0), rel=1e-5) == 10.0

        # Small angle across north boundary: dir=355, o=5 -> -10 deg
        assert pytest.approx(compute_slip_angle(355.0, 5.0), rel=1e-5) == -10.0

        # Fuzz 360 orientations: verify output is ALWAYS within [-180.0, 180.0]
        for d in range(0, 360, 15):
            for o in range(0, 360, 15):
                beta = compute_slip_angle(float(d), float(o))
                assert -180.0 <= beta <= 180.0, f"Slip angle out of bounds: dir={d}, o={o}, beta={beta}"

    def test_curvature_singularity_cutoff(self):
        """Curvature kappa is strictly 0.0 when speed < 0.2 yd/s."""
        # Speeds strictly below 0.2
        assert compute_curvature(speed=0.0, omega_deg_s=100.0) == 0.0
        assert compute_curvature(speed=0.19999, omega_deg_s=100.0) == 0.0
        assert compute_curvature(speed=-5.0, omega_deg_s=100.0) == 0.0

        # Exactly at threshold 0.2 yd/s
        omega = 30.0  # deg/s
        omega_rad = 30.0 * (math.pi / 180.0)
        expected_kappa = omega_rad / 0.2
        assert pytest.approx(compute_curvature(speed=0.2, omega_deg_s=omega), rel=1e-4) == expected_kappa

        # Normal sprint: speed=8.0 yd/s, omega=45 deg/s
        sprint_kappa = (45.0 * math.pi / 180.0) / 8.0
        assert pytest.approx(compute_curvature(speed=8.0, omega_deg_s=45.0), rel=1e-4) == sprint_kappa

    def test_velocity_vector_decomposition(self):
        """Decompose speed and compass heading into (vx, vy)."""
        # North: 0 deg -> (0, s)
        vx, vy = decompose_velocity(10.0, 0.0)
        assert pytest.approx(vx, abs=1e-5) == 0.0
        assert pytest.approx(vy, abs=1e-5) == 10.0

        # East: 90 deg -> (s, 0)
        vx, vy = decompose_velocity(10.0, 90.0)
        assert pytest.approx(vx, abs=1e-5) == 10.0
        assert pytest.approx(vy, abs=1e-5) == 0.0

        # South: 180 deg -> (0, -s)
        vx, vy = decompose_velocity(10.0, 180.0)
        assert pytest.approx(vx, abs=1e-5) == 0.0
        assert pytest.approx(vy, abs=1e-5) == -10.0

        # West: 270 deg -> (-s, 0)
        vx, vy = decompose_velocity(10.0, 270.0)
        assert pytest.approx(vx, abs=1e-5) == -10.0
        assert pytest.approx(vy, abs=1e-5) == 0.0

    def test_polars_vectorized_kinematics_edge_cases(self):
        """Test compute_tracking_kinematics against empty, single-frame, and boundary dataframes."""
        # 1. Empty dataframe
        df_empty = pl.DataFrame({"x": [], "y": [], "s": [], "dir": [], "o": []})
        res_empty = compute_tracking_kinematics(df_empty)
        assert res_empty.height == 0
        assert "omega" in res_empty.columns
        assert "curvature" in res_empty.columns
        assert "slip_angle" in res_empty.columns

        # 2. Single-frame dataframe
        df_single = pl.DataFrame({
            "x": [10.0],
            "y": [20.0],
            "s": [5.0],
            "dir": [45.0],
            "o": [50.0],
        })
        res_single = compute_tracking_kinematics(df_single)
        assert res_single.height == 1
        assert res_single["omega"][0] == 0.0  # first frame has no delta
        assert res_single["curvature"][0] == 0.0
        assert pytest.approx(res_single["slip_angle"][0], rel=1e-4) == -5.0

        # 3. Trajectory crossing 360 wrap
        df_wrap = pl.DataFrame({
            "time": [0.0, 0.1, 0.2],
            "s": [5.0, 5.0, 5.0],
            "dir": [355.0, 359.0, 3.0],  # +4 deg, +4 deg
            "o": [350.0, 350.0, 350.0],
        })
        res_wrap = compute_tracking_kinematics(df_wrap)
        assert pytest.approx(res_wrap["omega"][1], rel=1e-4) == 40.0  # 4 / 0.1
        assert pytest.approx(res_wrap["omega"][2], rel=1e-4) == 40.0  # 4 / 0.1
