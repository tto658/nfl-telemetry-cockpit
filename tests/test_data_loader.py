"""Unit tests for PlayerRegistry and Polars data loading infrastructure."""

import pytest

from src.web.data_loader import get_player_directory, get_player_registry


@pytest.fixture(scope="module")
def registry():
    """Provides loaded PlayerRegistry singleton instance."""
    return get_player_registry()


def test_registry_discovery(registry):
    """Verify registry loads all 510 players and directory mappings."""
    assert len(registry._players_list) == 510
    assert len(registry._players_by_id) == 510
    assert len(registry._dir_by_id) == 510


def test_get_player_jsn(registry):
    """Verify Jaxon Smith-Njigba (55884) core attributes and joined bio."""
    player = registry.get_player(55884)
    assert player is not None
    assert player.nfl_id == 55884
    assert player.display_name == "Jaxon Smith-Njigba"
    assert player.name == "Jaxon Smith-Njigba"
    assert player.nfl_position == "WR"
    assert player.position == "WR"
    assert player.draft_year == 2023
    assert player.draft_round in [1.0, 1]
    assert player.draft_overall_pick in [20.0, 20]
    assert player.draft_pick_formatted == "Round 1, Pick 20"
    assert player.height_in == pytest.approx(72.625, abs=0.01)
    assert player.height_formatted == "6' 1\""
    assert player.weight_lbs == 196
    assert "SEA" in player.teams
    assert "Jaxon Smith-Njigba [WR • SEA] (2023 • Round 1, Pick 20)" in player.display_label


def test_get_player_directory(registry):
    """Verify directory path resolution and exception handling."""
    p_dir = registry.get_player_directory(55884)
    assert p_dir is not None
    assert p_dir.exists()
    assert "55884_Jaxon_Smith-Njigba_2023" in p_dir.name

    # Nonexistent player returns None from method, raises KeyError from helper
    assert registry.get_player_directory(999999) is None
    with pytest.raises(KeyError):
        get_player_directory(999999)


def test_draft_pick_formatting_udfa(registry):
    """Verify undrafted free agent (56648) formatting and 0 game snaps."""
    player = registry.get_player(56648)
    assert player is not None
    assert player.draft_pick_formatted == "UDFA"
    assert player.draft_round is None
    assert player.teams == []
    assert player.team == "FA"
    assert "[OLB • FA]" in player.display_label


def test_multi_team_and_rams_normalization(registry):
    """Verify multi-team player indexing and Rams LA/LAR alias filtering."""
    # Puka Nacua (56042)
    puka = registry.get_player(56042)
    assert puka is not None
    assert "LA" in puka.teams or "LAR" in puka.teams

    # Both LA and LAR queries find Rams players
    lar_results = registry.filter_players(team_abbr="LAR")
    la_results = registry.filter_players(team_abbr="LA")
    assert len(lar_results) > 0
    assert len(la_results) > 0
    lar_pids = {p.nfl_id for p in lar_results}
    la_pids = {p.nfl_id for p in la_results}
    assert 56042 in lar_pids or 56042 in la_pids


def test_filter_by_draft_year(registry):
    """Verify exact counts per draft year."""
    assert len(registry.filter_players(draft_year=2023)) == 160
    assert len(registry.filter_players(draft_year=2024)) == 177
    assert len(registry.filter_players(draft_year=2025)) == 173
    assert len(registry.filter_players(draft_year=1990)) == 0


def test_filter_by_position(registry):
    """Verify exact counts per position."""
    assert len(registry.filter_players(position="WR")) == 106
    assert len(registry.filter_players(position="CB")) == 60
    assert len(registry.filter_players(position="KICKER")) == 0


def test_filter_free_text_query(registry):
    """Verify free-text search matching name, college, and nfl_id."""
    by_name = registry.filter_players(query="Smith-Njigba")
    assert len(by_name) >= 1
    assert any(p.nfl_id == 55884 for p in by_name)

    by_college = registry.filter_players(query="Ohio State")
    assert len(by_college) >= 1
    assert any(p.nfl_id == 55884 for p in by_college)

    by_id = registry.filter_players(query="55884")
    assert len(by_id) == 1
    assert by_id[0].nfl_id == 55884

    # Empty search returns all 510
    assert len(registry.filter_players(query="")) == 510

    # Special characters do not crash
    assert len(registry.filter_players(query="!@#$%^&*()")) == 0


def test_get_player_summary(registry):
    """Verify get_player_summary payload structure and combine opt-out tags."""
    summary = registry.get_player_summary(55884)
    assert summary["nfl_id"] == 55884
    assert summary["name"] == "Jaxon Smith-Njigba"
    assert "bio" in summary
    assert "combine" in summary
    assert "career" in summary

    bio = summary["bio"]
    assert bio["college"] == "Ohio State"
    assert bio["height_in"] > 60.0
    assert bio["weight_lbs"] > 150

    combine = summary["combine"]
    tests = combine["combine_tests"]
    assert tests["vertical"]["value"] == pytest.approx(35.0, abs=0.1)
    assert tests["three_cone"]["value"] == pytest.approx(6.57, abs=0.01)
    # JSN opted out of 40-yd dash
    assert tests["forty"]["opt_out"] is True
    assert "forty" in combine["opt_outs"]

    career = summary["career"]
    assert career["offensive_snaps"] >= 0
    assert career["games_active"] >= 0


def test_get_metadata(registry):
    """Verify metadata response options."""
    meta = registry.get_metadata()
    assert meta.total_players == 510
    assert 2023 in meta.draft_years
    assert "WR" in meta.positions
    assert "SEA" in meta.teams


def test_load_player_plays_zero_snap(registry):
    """Verify 0-snap rookie returns empty DataFrame without FileNotFoundError."""
    df_empty = registry.load_player_plays(56648)
    assert df_empty.height == 0

    df_jsn = registry.load_player_plays(55884)
    assert df_jsn.height > 0
