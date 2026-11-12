"""Unit tests for Pydantic schemas and serialization protocols."""

import json

from src.web.schemas import (
    FrameDTO,
    MetadataResponse,
    PlayerListItem,
    PlayerQueryParams,
    format_draft_pick,
    format_height,
    serialize_player_list,
)


def test_udfa_formatting():
    """Verify UDFA pick formatting for None, NaN, and 0."""
    assert format_draft_pick(None) == "UDFA"
    assert format_draft_pick(float("nan")) == "UDFA"
    assert format_draft_pick(0) == "UDFA"


def test_drafted_pick_formatting():
    """Verify drafted pick formatting for round 1 pick 20 and later picks."""
    assert format_draft_pick(1.0, 20.0, 20.0) == "Round 1, Pick 20"
    assert format_draft_pick(2.0, 5.0, 37.0) == "Round 2, Pick 5 (#37)"
    assert format_draft_pick(3.0, None, 75.0) == "Round 3, Pick 75"
    assert format_draft_pick(4.0, None, None) == "Round 4"


def test_height_formatting():
    """Verify height formatting into standard feet and inches."""
    assert format_height(72.625) == "6' 1\""
    assert format_height(70.0) == "5' 10\""
    assert format_height(77.0) == "6' 5\""
    assert format_height(None) == "N/A"
    assert format_height(float("nan")) == "N/A"
    assert format_height(0) == "N/A"


def test_player_list_item_from_raw():
    """Verify PlayerListItem creation via from_raw with aliases."""
    item = PlayerListItem.from_raw(
        nfl_id=55884,
        display_name="Jaxon Smith-Njigba",
        nfl_position="WR",
        draft_year=2023,
        draft_round=1.0,
        draft_pick_within_round=20.0,
        draft_overall_pick=20.0,
        combine_position="WR",
        combine_height=72.625,
        combine_weight=196,
        teams=["SEA"],
        college_name="Ohio State",
    )
    assert item.nfl_id == 55884
    assert item.display_name == "Jaxon Smith-Njigba"
    assert item.name == "Jaxon Smith-Njigba"
    assert item.nfl_position == "WR"
    assert item.position == "WR"
    assert item.draft_year == 2023
    assert item.draft_pick_formatted == "Round 1, Pick 20"
    assert item.height_formatted == "6' 1\""
    assert item.height_display == "6' 1\""
    assert item.weight_lbs == 196
    assert item.weight == 196
    assert item.teams == ["SEA"]
    assert item.team == "SEA"
    assert item.college == "Ohio State"
    assert item.display_label == "Jaxon Smith-Njigba [WR • SEA] (2023 • Round 1, Pick 20)"


def test_zero_team_fa_fallback():
    """Verify zero-snap rookie falls back to FA."""
    item = PlayerListItem.from_raw(
        nfl_id=56648,
        display_name="Ikenna Enechukwu",
        nfl_position="OLB",
        draft_year=2023,
        draft_round=None,
        teams=[],
        combine_height=76.0,
        combine_weight=264,
    )
    assert item.teams == []
    assert item.team == "FA"
    assert item.draft_pick_formatted == "UDFA"
    assert item.display_label == "Ikenna Enechukwu [OLB • FA] (2023 • UDFA)"


def test_multi_team_display_label():
    """Verify multi-team player joins teams with slash."""
    item = PlayerListItem.from_raw(
        nfl_id=56012,
        display_name="Sample Player",
        nfl_position="WR",
        draft_year=2023,
        draft_round=1.0,
        draft_overall_pick=10.0,
        teams=["GB", "TEN"],
        combine_height=73.0,
        combine_weight=200,
    )
    assert item.teams == ["GB", "TEN"]
    assert item.display_label == "Sample Player [WR • GB/TEN] (2023 • Round 1, Pick 10)"


def test_nan_safety_serialization():
    """Verify serialize_player_list produces valid JSON and translates None/NaN to null."""
    item = PlayerListItem.from_raw(
        nfl_id=12345,
        display_name="Test Athlete",
        nfl_position="DB",
        draft_year=2024,
        draft_round=None,
        combine_height=None,
        combine_weight=None,
        teams=[],
    )
    json_bytes = serialize_player_list([item])
    assert isinstance(json_bytes, bytes)
    data = json.loads(json_bytes.decode("utf-8"))
    assert len(data) == 1
    first = data[0]
    assert first["nfl_id"] == 12345
    assert first["draft_round"] is None
    assert first["draft_overall_pick"] is None


def test_player_query_params_cleaning():
    """Verify whitespace stripping and uppercase normalization on query params."""
    params = PlayerQueryParams(pos="  wr  ", team_abbr="  sea  ", q="  smith  ")
    assert params.pos == "WR"
    assert params.team_abbr == "SEA"
    assert params.q == "smith"

    empty_params = PlayerQueryParams(pos="", team_abbr="", q="")
    assert empty_params.pos is None
    assert empty_params.team_abbr is None
    assert empty_params.q is None


def test_frame_dto_model():
    """Verify FrameDTO structure, slip_angle sync, and serialization."""
    frame = FrameDTO(
        frameId=10,
        time=1.0,
        x=25.5,
        y=15.2,
        s=4.5,
        a=1.2,
        dir=90.0,
        o=80.0,
        slip_angle=10.0,
        event="ball_snap",
    )
    assert frame.frameId == 10
    assert frame.time == 1.0
    assert frame.beta_slip == 10.0
    assert frame.slip_angle == 10.0
    assert frame.event == "ball_snap"


def test_metadata_response():
    """Verify MetadataResponse validation."""
    meta = MetadataResponse(
        draft_years=[2023, 2024, 2025],
        positions=["CB", "WR"],
        teams=["KC", "SEA"],
        total_players=510,
    )
    assert meta.total_players == 510
    assert len(meta.draft_years) == 3


def test_framedto_zero_slip_angle_preservation():
    """Verify FrameDTO retains beta_slip=0.0 and slip_angle=0.0 when initialized with 0.0."""
    frame = FrameDTO(
        frameId=0,
        time=0.0,
        x=1.0,
        y=2.0,
        s=3.0,
        a=4.0,
        dir=5.0,
        beta_slip=0.0,
        slip_angle=None,
    )
    assert frame.beta_slip == 0.0
    assert frame.slip_angle == 0.0


def test_framedto_zero_curvature_preservation():
    """Verify FrameDTO retains kappa=0.0 and curvature=0.0 when initialized with 0.0."""
    frame = FrameDTO(
        frameId=0,
        time=0.0,
        x=1.0,
        y=2.0,
        s=3.0,
        a=4.0,
        dir=5.0,
        kappa=0.0,
        curvature=None,
    )
    assert frame.kappa == 0.0
    assert frame.curvature == 0.0


def test_framedto_nan_inf_serialization_safety():
    """Verify FrameDTO coerces NaN and Inf floats to None or 0.0 for JSON compliance."""
    frame = FrameDTO(
        frameId=0,
        time=0.0,
        x=1.0,
        y=2.0,
        s=float("nan"),
        a=float("inf"),
        dir=5.0,
        o=float("nan"),
        omega=float("inf"),
        curvature=float("nan"),
    )
    assert frame.s == 0.0
    assert frame.a == 0.0
    assert frame.o is None
    assert frame.omega is None
    assert frame.curvature is None
    dumped = frame.model_dump()
    assert json.dumps(dumped)

