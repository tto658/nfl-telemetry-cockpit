"""Adversarial stress-testing suite for calendar-year boundary & playoff game snap retrieval.

Verifies:
1. Exact failure cases reported by challenger_m1_2_2:
   - Puka Nacua (56042) snap 2024011402/986 returns HTTP 200, 81 frames, valid non-null kinematics
   - Season 2024 query returns 0 leaked games from season 2023
   - Season 2023 query returns all 19 games (including 2024010710 Week 18 and 2024011402 Wild Card)
2. Will Anderson (55867) January games across seasons:
   - 2024011300 (2023 Wild Card) snap retrieval & season filter
   - 2026011200 (2025 Wild Card) snap retrieval & season filter
3. Cross-player generalization across 10 postseason players in January:
   - Darnell Wright (55874), Lukas Van Ness (55877), Broderick Jones (55878),
     Jaxon Smith-Njigba (55884), Quentin Johnston (55885), Jordan Addison (55887),
     Anton Harrison (55891), Steve Avila (55901), Brian Branch (55910), Keion White (55911)
4. Natural 404 error handling for non-existent games, snaps, and players without crashes.
"""

from __future__ import annotations

import random

import pytest
from starlette.testclient import TestClient

from src.web.schemas import FrameDTO

# ==============================================================================
# SECTION 1: Exact Failure Cases Reported by challenger_m1_2_2
# ==============================================================================


def test_challenger_m1_2_2_exact_snap_retrieval(client: TestClient):
    """GET /api/player/56042/snap/2024011402/986: HTTP 200, 81 frames, non-null kinematics."""
    res = client.get("/api/player/56042/snap/2024011402/986")
    assert res.status_code == 200, f"Expected HTTP 200, got {res.status_code}: {res.text}"

    data = res.json()
    assert data["game_id"] == 2024011402
    assert data["play_id"] == 986

    frames = data.get("frames", [])
    assert len(frames) == 81, f"Expected 81 frames, got {len(frames)}"

    # Validate kinematics presence and FrameDTO mathematical bounds
    has_non_null_omega = False
    has_non_null_curvature = False
    has_non_null_slip_angle = False

    for f in frames:
        dto = FrameDTO.model_validate(f)

        if dto.omega is not None:
            has_non_null_omega = True
            assert dto.omega >= 0.0, f"Negative angular velocity: {dto.omega}"

        if dto.curvature is not None:
            has_non_null_curvature = True
            if dto.s < 0.2:
                assert dto.curvature == 0.0, f"Non-zero curvature below singularity threshold: {dto.curvature}"
            else:
                assert dto.curvature >= 0.0

        if dto.slip_angle is not None:
            has_non_null_slip_angle = True
            assert -180.0 <= dto.slip_angle <= 180.0, f"Slip angle out of bounds: {dto.slip_angle}"

    assert has_non_null_omega, "All omega values were null or missing"
    assert has_non_null_curvature, "All curvature values were null or missing"
    assert has_non_null_slip_angle, "All slip_angle values were null or missing"


def test_challenger_m1_2_2_exact_season_2024_no_leakage(client: TestClient):
    """GET /api/player/56042/games?season=2024: 0 leaked 2023 games."""
    res = client.get("/api/player/56042/games?season=2024")
    assert res.status_code == 200
    games = res.json().get("games", [])
    assert len(games) > 0, "Expected non-empty 2024 games list"

    mismatches = [g for g in games if g["season"] != 2024]
    assert len(mismatches) == 0, f"Leaked {len(mismatches)} non-2024 games into season=2024: {mismatches}"
    assert all(g["season"] == 2024 for g in games)


def test_challenger_m1_2_2_exact_season_2023_all_19_games(client: TestClient):
    """GET /api/player/56042/games?season=2023: all 19 games returned including Jan 2024 games."""
    res = client.get("/api/player/56042/games?season=2023")
    assert res.status_code == 200
    games = res.json().get("games", [])
    assert len(games) == 19, f"Expected 19 games for Puka Nacua 2023 season, got {len(games)}"

    game_ids = [g["game_id"] for g in games]
    assert 2024010710 in game_ids, "Week 18 game 2024010710 missing from season 2023"
    assert 2024011402 in game_ids, "Wild Card playoff 2024011402 missing from season 2023"
    assert all(g["season"] == 2023 for g in games)


# ==============================================================================
# SECTION 2: Will Anderson (55867) Stress Testing Across Seasons
# ==============================================================================


def test_will_anderson_january_2024_wild_card_snap(client: TestClient):
    """Will Anderson 55867 in game 2024011300 (2023 Season Wild Card): HTTP 200, valid telemetry."""
    res = client.get("/api/player/55867/snap/2024011300/130")
    assert res.status_code == 200, f"Failed with {res.status_code}: {res.text}"
    data = res.json()
    assert len(data.get("frames", [])) > 0
    assert any(f.get("omega") is not None for f in data["frames"])
    assert any(f.get("slip_angle") is not None for f in data["frames"])


def test_will_anderson_january_2026_wild_card_snap(client: TestClient):
    """Will Anderson 55867 in game 2026011200 (2025 Season Wild Card): HTTP 200, valid telemetry."""
    res = client.get("/api/player/55867/snap/2026011200/57")
    assert res.status_code == 200, f"Failed with {res.status_code}: {res.text}"
    data = res.json()
    assert len(data.get("frames", [])) > 0
    assert any(f.get("omega") is not None for f in data["frames"])
    assert any(f.get("slip_angle") is not None for f in data["frames"])


def test_will_anderson_season_boundary_filters(client: TestClient):
    """Will Anderson 55867 games filter across 2023, 2024, and 2025 seasons."""
    # Season 2023 includes January 2024 postseason games
    r23 = client.get("/api/player/55867/games?season=2023")
    assert r23.status_code == 200
    g23 = r23.json().get("games", [])
    g23_ids = [g["game_id"] for g in g23]
    assert 2024010601 in g23_ids  # Week 18
    assert 2024011300 in g23_ids  # Wild Card
    assert 2024012000 in g23_ids  # Divisional
    assert all(g["season"] == 2023 for g in g23)

    # Season 2024 includes January 2025 postseason games
    r24 = client.get("/api/player/55867/games?season=2024")
    assert r24.status_code == 200
    g24 = r24.json().get("games", [])
    g24_ids = [g["game_id"] for g in g24]
    assert 2025011100 in g24_ids  # Wild Card
    assert 2025011800 in g24_ids  # Divisional
    assert all(g["season"] == 2024 for g in g24)

    # Season 2025 includes January 2026 postseason games
    r25 = client.get("/api/player/55867/games?season=2025")
    assert r25.status_code == 200
    g25 = r25.json().get("games", [])
    g25_ids = [g["game_id"] for g in g25]
    assert 2026010405 in g25_ids  # Week 18
    assert 2026011200 in g25_ids  # Wild Card
    assert 2026011801 in g25_ids  # Divisional
    assert all(g["season"] == 2025 for g in g25)


# ==============================================================================
# SECTION 3: Cross-Player Stress Testing Across 10 Postseason Players
# ==============================================================================

JANUARY_POSTSEASON_BENCHMARK = [
    # (nfl_id, player_name, game_id, true_season, play_id)
    (55874, "Darnell Wright", 2026011001, 2025, 179),
    (55877, "Lukas Van Ness", 2024011401, 2023, 820),
    (55878, "Broderick Jones", 2024011501, 2023, 675),
    (55884, "Jaxon Smith-Njigba", 2026011701, 2025, 1271),
    (55885, "Quentin Johnston", 2025011100, 2024, 3524),
    (55887, "Jordan Addison", 2025011300, 2024, 702),
    (55891, "Anton Harrison", 2026011100, 2025, 728),
    (55901, "Steve Avila", 2024011402, 2023, 1479),
    (55910, "Brian Branch", 2024011402, 2023, 2368),
    (55911, "Keion White", 2026011101, 2025, 3398),
]


@pytest.mark.parametrize("nfl_id,name,game_id,season,play_id", JANUARY_POSTSEASON_BENCHMARK)
def test_january_postseason_snap_retrieval(client: TestClient, nfl_id: int, name: str, game_id: int, season: int, play_id: int):
    """Verify snap retrieval returns HTTP 200 and valid kinematics for January playoff games across multiple players."""
    url = f"/api/player/{nfl_id}/snap/{game_id}/{play_id}"
    res = client.get(url)
    assert res.status_code == 200, f"Failed for {name} ({nfl_id}) at {url}: {res.status_code} - {res.text}"

    data = res.json()
    assert data["game_id"] == game_id
    assert data["play_id"] == play_id
    frames = data.get("frames", [])
    assert len(frames) > 0, f"No frames returned for {name}"

    # Verify mathematical integrity on each frame
    for f in frames:
        dto = FrameDTO.model_validate(f)
        if dto.slip_angle is not None:
            assert -180.0 <= dto.slip_angle <= 180.0
        if dto.omega is not None:
            assert dto.omega >= 0.0
        if dto.curvature is not None and dto.s < 0.2:
            assert dto.curvature == 0.0


@pytest.mark.parametrize("nfl_id,name,game_id,season,play_id", JANUARY_POSTSEASON_BENCHMARK)
def test_january_postseason_season_filter_integrity(client: TestClient, nfl_id: int, name: str, game_id: int, season: int, play_id: int):
    """Verify that querying the genuine NFL season returns the January playoff game with zero cross-season leaks."""
    res = client.get(f"/api/player/{nfl_id}/games?season={season}")
    assert res.status_code == 200
    games = res.json().get("games", [])
    game_ids = [g["game_id"] for g in games]
    assert game_id in game_ids, f"Postseason game {game_id} missing from season {season} query for {name}"
    assert all(g["season"] == season for g in games), f"Cross-season leakage detected for {name} ({nfl_id})"


# ==============================================================================
# SECTION 4: Clean Natural HTTP 404 Errors on Non-Existent Games & Snaps
# ==============================================================================


def test_natural_404_nonexistent_snap_in_valid_game(client: TestClient):
    """Non-existent play ID in a real January game returns natural HTTP 404."""
    res = client.get("/api/player/56042/snap/2024011402/99999999")
    assert res.status_code == 404
    assert "not found" in res.json().get("detail", "").lower()


def test_natural_404_nonexistent_game_id(client: TestClient):
    """Non-existent game ID returns natural HTTP 404."""
    res = client.get("/api/player/56042/snap/2024019999/986")
    assert res.status_code == 404
    assert "not found" in res.json().get("detail", "").lower()


def test_natural_404_nonexistent_player_id(client: TestClient):
    """Non-existent player ID returns natural HTTP 404."""
    res = client.get("/api/player/99999999/snap/2024011402/986")
    assert res.status_code == 404
    assert "not found" in res.json().get("detail", "").lower()


def test_natural_404_fuzz_random_ids(client: TestClient):
    """Randomized fuzz testing of invalid/malformed IDs produces 0 HTTP 500 crashes."""
    rng = random.Random(20261103)
    real_player = 56042
    real_game = 2024011402
    real_play = 986

    for _ in range(25):
        choice = rng.randint(1, 4)
        if choice == 1:
            # Random fake play ID
            p = rng.randint(100000, 9999999)
            res = client.get(f"/api/player/{real_player}/snap/{real_game}/{p}")
        elif choice == 2:
            # Random fake game ID
            g = rng.randint(2020010100, 2030123199)
            res = client.get(f"/api/player/{real_player}/snap/{g}/{real_play}")
        elif choice == 3:
            # Random fake player ID
            pid = rng.randint(900000, 9999999)
            res = client.get(f"/api/player/{pid}/snap/{real_game}/{real_play}")
        else:
            # Negative / zero IDs
            bad_id = rng.choice([0, -1, -999])
            res = client.get(f"/api/player/{bad_id}/snap/{real_game}/{real_play}")

        assert res.status_code in (404, 400), f"Unexpected status {res.status_code} for URL {res.url}"
        assert res.status_code != 500, f"HTTP 500 Internal Server Error encountered: {res.text}"
