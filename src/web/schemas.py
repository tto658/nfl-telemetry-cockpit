"""Pydantic schemas and serialization protocols for NFL Tracking API."""

from __future__ import annotations

import math
from typing import Any

from pydantic import BaseModel, Field, TypeAdapter, field_validator, model_validator


def format_draft_pick(
    draft_round: float | None,
    draft_pick_within_round: float | None = None,
    draft_overall_pick: float | None = None,
) -> str:
    """Format draft pick into human-readable string.

    Drafted: 'Round 1, Pick 20' or 'Round 2, Pick 5 (#37)'
    UDFA: 'UDFA'
    """
    if draft_round is None:
        return "UDFA"
    if isinstance(draft_round, float) and math.isnan(draft_round):
        return "UDFA"
    r = int(draft_round)
    if r <= 0:
        return "UDFA"

    p = (
        int(draft_pick_within_round)
        if draft_pick_within_round is not None and not math.isnan(draft_pick_within_round)
        else None
    )
    o = (
        int(draft_overall_pick)
        if draft_overall_pick is not None and not math.isnan(draft_overall_pick)
        else None
    )

    if p is not None and o is not None:
        if p == o:
            return f"Round {r}, Pick {o}"
        return f"Round {r}, Pick {p} (#{o})"
    if o is not None:
        return f"Round {r}, Pick {o}"
    if p is not None:
        return f"Round {r}, Pick {p}"
    return f"Round {r}"


def format_height(height_in: float | None) -> str:
    """Format height in inches into standard feet and inches string, e.g. 72.625 -> 6' 1"."""
    if height_in is None:
        return "N/A"
    if isinstance(height_in, float) and math.isnan(height_in):
        return "N/A"
    if height_in <= 0:
        return "N/A"
    total_inches = round(float(height_in))
    feet = total_inches // 12
    inches = total_inches % 12
    return f"{feet}' {inches}\""


class PlayerListItem(BaseModel):
    """Player record returned in GET /api/players."""

    nfl_id: int = Field(..., description="Unique 5-digit NFL player ID")
    display_name: str = Field(..., description="Full player name")
    name: str = Field(default="", description="Name alias for backward compatibility")
    nfl_position: str = Field(..., description="NFL official position group (e.g. WR, CB)")
    position: str = Field(default="", description="Position alias")
    combine_position: str = Field(default="", description="Position recorded at NFL Combine")
    draft_year: int = Field(..., description="Draft class year (2023, 2024, or 2025)")
    draft_round: float | None = Field(default=None, description="Draft round or None if UDFA")
    draft_overall_pick: float | None = Field(default=None, description="Draft overall pick or None if UDFA")
    draft_pick_formatted: str = Field(..., description="Formatted pick e.g. 'Round 1, Pick 20' or 'UDFA'")
    teams: list[str] = Field(default_factory=list, description="List of NFL teams player played for")
    team: str = Field(default="", description="Primary team or FA")
    display_label: str = Field(..., description="Formatted dropdown text e.g. 'Name [Pos • Team] (Year • Pick)'")
    display_text: str = Field(default="", description="Display text alias")
    height_in: float = Field(..., description="Height in inches (e.g. 72.625)")
    height_formatted: str = Field(..., description="Height formatted (e.g. 6' 1\")")
    height_display: str = Field(default="", description="Height display alias")
    weight_lbs: int = Field(..., description="Weight in pounds (lbs)")
    weight: int = Field(default=0, description="Weight alias in lbs")
    college: str = Field(default="", description="College name alias")
    college_name: str = Field(default="", description="College name")

    @model_validator(mode="before")
    @classmethod
    def populate_aliases(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # Display name <-> name
            if "display_name" in data and not data.get("name"):
                data["name"] = data["display_name"]
            elif "name" in data and not data.get("display_name"):
                data["display_name"] = data["name"]

            # Position <-> nfl_position
            if "nfl_position" in data and not data.get("position"):
                data["position"] = data["nfl_position"]
            elif "position" in data and not data.get("nfl_position"):
                data["nfl_position"] = data["position"]

            # Height
            if "height_formatted" in data and not data.get("height_display"):
                data["height_display"] = data["height_formatted"]
            elif "height_display" in data and not data.get("height_formatted"):
                data["height_formatted"] = data["height_display"]

            # Weight
            if "weight_lbs" in data and not data.get("weight"):
                data["weight"] = data["weight_lbs"]
            elif "weight" in data and not data.get("weight_lbs"):
                data["weight_lbs"] = data["weight"]

            # Display label
            if "display_label" in data and not data.get("display_text"):
                data["display_text"] = data["display_label"]
            elif "display_text" in data and not data.get("display_label"):
                data["display_label"] = data["display_text"]

            # Team
            if "teams" in data and not data.get("team"):
                teams_list = data["teams"]
                data["team"] = teams_list[0] if teams_list else "FA"

            # College
            if "college_name" in data and not data.get("college"):
                data["college"] = data["college_name"]
            elif "college" in data and not data.get("college_name"):
                data["college_name"] = data["college"]
        return data

    @classmethod
    def from_raw(
        cls,
        nfl_id: int,
        display_name: str,
        nfl_position: str,
        draft_year: int,
        draft_round: float | None = None,
        draft_pick_within_round: float | None = None,
        draft_overall_pick: float | None = None,
        combine_position: str | None = None,
        combine_height: float | None = None,
        combine_weight: float | None = None,
        teams: list[str] | None = None,
        college_name: str | None = None,
    ) -> PlayerListItem:
        pick_str = format_draft_pick(draft_round, draft_pick_within_round, draft_overall_pick)
        h_str = format_height(combine_height)
        h_in = round(float(combine_height), 3) if combine_height and not math.isnan(combine_height) else 0.0
        w_lbs = int(combine_weight) if combine_weight and not math.isnan(combine_weight) else 0

        clean_teams = list(teams) if teams else []
        team_label = "/".join(clean_teams) if clean_teams else "FA"
        pos = nfl_position or combine_position or "ATH"
        label = f"{display_name} [{pos} • {team_label}] ({draft_year} • {pick_str})"

        d_round = float(draft_round) if draft_round is not None and not math.isnan(draft_round) else None
        d_overall = float(draft_overall_pick) if draft_overall_pick is not None and not math.isnan(draft_overall_pick) else None

        return cls(
            nfl_id=nfl_id,
            display_name=display_name,
            name=display_name,
            nfl_position=pos,
            position=pos,
            combine_position=combine_position or pos,
            draft_year=draft_year,
            draft_round=d_round,
            draft_overall_pick=d_overall,
            draft_pick_formatted=pick_str,
            teams=clean_teams,
            team=clean_teams[0] if clean_teams else "FA",
            display_label=label,
            display_text=label,
            height_in=h_in,
            height_formatted=h_str,
            height_display=h_str,
            weight_lbs=w_lbs,
            weight=w_lbs,
            college=college_name or "",
            college_name=college_name or "",
        )


class PlayerBio(BaseModel):
    """Detailed player biographical card and career snap statistics."""

    nfl_id: int
    display_name: str
    name: str = ""
    nfl_position: str
    position: str = ""
    draft_year: int
    draft_round: float | None = None
    draft_overall_pick: float | None = None
    draft_pick_formatted: str = ""
    birth_date: str = ""
    college_name: str = ""
    college: str = ""
    college_conference: str = ""
    conference: str = ""
    height_in: float = 0.0
    height_formatted: str = ""
    height_display: str = ""
    weight_lbs: int = 0
    weight: int = 0
    hand_size: float | None = None
    arm_length: float | None = None
    wing_span: float | None = None
    teams: list[str] = Field(default_factory=list)
    team: str = ""
    display_label: str = ""

    # Career Snap Counts
    career_offensive_snaps: int = 0
    career_defensive_snaps: int = 0
    career_special_teams_snaps: int = 0
    career_total_snaps: int = 0
    career_games_active: int = 0
    career_games_started: int = 0

    # Accolades
    ap_all_pro_1st_team: int = 0
    ap_all_pro_2nd_team: int = 0
    all_pro_total: int = 0
    pro_bowl_original_ballot: int = 0
    pro_bowl_count: int = 0

    @model_validator(mode="before")
    @classmethod
    def populate_aliases(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if "display_name" in data and not data.get("name"):
                data["name"] = data["display_name"]
            elif "name" in data and not data.get("display_name"):
                data["display_name"] = data["name"]

            if "nfl_position" in data and not data.get("position"):
                data["position"] = data["nfl_position"]
            elif "position" in data and not data.get("nfl_position"):
                data["nfl_position"] = data["position"]

            if "college_name" in data and not data.get("college"):
                data["college"] = data["college_name"]
            elif "college" in data and not data.get("college_name"):
                data["college_name"] = data["college"]

            if "college_conference" in data and not data.get("conference"):
                data["conference"] = data["college_conference"]
            elif "conference" in data and not data.get("college_conference"):
                data["college_conference"] = data["conference"]

            if "height_formatted" in data and not data.get("height_display"):
                data["height_display"] = data["height_formatted"]
            elif "height_display" in data and not data.get("height_formatted"):
                data["height_formatted"] = data["height_display"]

            if "weight_lbs" in data and not data.get("weight"):
                data["weight"] = data["weight_lbs"]
            elif "weight" in data and not data.get("weight_lbs"):
                data["weight_lbs"] = data["weight"]

            if "ap_all_pro_1st_team" in data and "ap_all_pro_2nd_team" in data and not data.get("all_pro_total"):
                data["all_pro_total"] = int(data.get("ap_all_pro_1st_team") or 0) + int(data.get("ap_all_pro_2nd_team") or 0)

            if "pro_bowl_original_ballot" in data and not data.get("pro_bowl_count"):
                data["pro_bowl_count"] = int(data.get("pro_bowl_original_ballot") or 0)

            if "teams" in data and not data.get("team"):
                teams_list = data["teams"]
                data["team"] = teams_list[0] if teams_list else "FA"
        return data


class PlayerQueryParams(BaseModel):
    """Validation and sanitization model for player query parameters."""

    draft_year: int | None = Field(default=None, ge=1900, le=2100)
    pos: str | None = Field(default=None, max_length=20)
    team_abbr: str | None = Field(default=None, max_length=20)
    q: str | None = Field(default=None, max_length=100)

    @field_validator("draft_year", mode="before")
    @classmethod
    def clean_draft_year(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            return int(v) if v else None
        return v

    @field_validator("pos", "team_abbr", mode="before")
    @classmethod
    def clean_upper(cls, v: Any) -> str | None:
        if isinstance(v, str):
            cleaned = v.strip()
            return cleaned.upper() if cleaned else None
        return v

    @field_validator("q", mode="before")
    @classmethod
    def clean_query(cls, v: Any) -> str | None:
        if isinstance(v, str):
            cleaned = v.strip()
            return cleaned if cleaned else None
        return v


class PlaySummary(BaseModel):
    """Play metadata item within a game."""

    play_id: int = Field(..., description="Play identifier")
    quarter: int = Field(default=1, description="Quarter number")
    game_clock: str = Field(default="", description="Game clock timestamp")
    play_type: str = Field(default="PASS", description="Derived play type: PASS or RUN")
    epa: float = Field(default=0.0, description="Expected Points Added (EPA)")
    expected_points_added: float = Field(default=0.0, description="EPA alias")
    description: str = Field(default="", description="Play description text")
    play_description: str = Field(default="", description="Play description alias")
    lined_up_position: str = Field(default="", description="Position player lined up in")


class GameSummary(BaseModel):
    """Game summary item returned in GET /api/player/{nfl_id}/games."""

    game_id: int = Field(..., description="Unique 10-digit game identifier")
    game_key: int | None = Field(default=None, description="NFL game key")
    season: int = Field(..., description="NFL season year")
    season_type: str = Field(default="REG", description="Season type: REG, POST, PRE")
    week: int | None = Field(default=None, description="NFL schedule week")
    date: str | None = Field(default=None, description="Game date in YYYY-MM-DD")
    home_team: str | None = Field(default=None, description="Home team abbreviation")
    home_team_abbr: str | None = Field(default=None, description="Home team abbreviation alias")
    visitor_team: str | None = Field(default=None, description="Visitor team abbreviation")
    visitor_team_abbr: str | None = Field(default=None, description="Visitor team abbreviation alias")
    opponent: str | None = Field(default=None, description="Opponent team abbreviation")
    home_away: str | None = Field(default=None, description="home or away indicator")
    total_plays: int = Field(default=0, description="Total number of plays player was active in")
    plays: list[dict[str, Any]] = Field(default_factory=list, description="List of plays for the game")


class MetadataResponse(BaseModel):
    """Global system metadata for frontend filter options."""

    draft_years: list[int] = Field(..., description="Available draft years, sorted")
    positions: list[str] = Field(..., description="Available NFL position groups, sorted")
    teams: list[str] = Field(..., description="Available NFL team abbreviations, sorted")
    total_players: int = Field(default=510, description="Total number of indexed players")


class FrameDTO(BaseModel):
    """Unified 10 Hz kinematic tracking telemetry frame."""

    frameId: int = Field(..., description="Sequential integer frame index")
    time: float = Field(..., description="Elapsed time in seconds from drill/play start")
    x: float = Field(..., description="Field X coordinate in yards")
    y: float = Field(..., description="Field Y coordinate in yards")
    s: float = Field(..., description="Speed in yards/second")
    a: float = Field(..., description="Acceleration in yards/second^2")
    dir: float = Field(..., description="Motion direction angle in degrees [0, 360)")
    o: float | None = Field(default=None, description="Body orientation angle in degrees [0, 360)")
    omega: float | None = Field(default=None, description="Angular velocity in degrees/second")
    curvature: float | None = Field(default=None, description="Trajectory curvature kappa in 1/yard")
    kappa: float | None = Field(default=None, description="Trajectory curvature alias")
    slip_angle: float | None = Field(default=None, description="Slip angle beta in degrees [-180, 180]")
    beta_slip: float | None = Field(default=None, description="Slip angle alias")
    beta_rate: float | None = Field(default=None, description="Sideslip angle derivative dbeta/dt in deg/s")
    slip_rate: float | None = Field(default=None, description="Sideslip angle rate alias in deg/s")
    jerk: float | None = Field(default=None, description="Kinematic jerk da/dt in yd/s^3")
    snap_oversteer: bool = Field(default=False, description="Snap oversteer / loss of balance flag")
    dynamics_state: str | None = Field(default=None, description="Biomechanical / vehicle dynamics state")
    a_lat: float | None = Field(default=None, description="Lateral acceleration in yd/s^2")
    a_comb: float | None = Field(default=None, description="Combined horizontal acceleration in yd/s^2")
    g_comb: float | None = Field(default=None, description="Combined G-Force in g (a_comb / 10.7247)")
    g_lat: float | None = Field(default=None, description="Lateral acceleration in g (a_lat / 10.7247)")
    g_t: float | None = Field(default=None, description="Tangential acceleration in g (a / 10.7247)")
    event: str | None = Field(default=None, description="Annotated event marker (e.g. ball_snap, pass_forward)")

    @model_validator(mode="before")
    @classmethod
    def sync_slip_angle(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for k, v in list(data.items()):
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    if k in ("o", "omega", "curvature", "kappa", "slip_angle", "beta_slip", "beta_rate", "slip_rate", "jerk", "a_lat", "a_comb", "g_comb", "g_lat", "g_t"):
                        data[k] = None
                    else:
                        data[k] = 0.0

            if "slip_angle" in data and data.get("beta_slip") is None:
                data["beta_slip"] = data["slip_angle"]
            elif "beta_slip" in data and data.get("slip_angle") is None:
                data["slip_angle"] = data["beta_slip"]
            if "beta_rate" in data and data.get("slip_rate") is None:
                data["slip_rate"] = data["beta_rate"]
            elif "slip_rate" in data and data.get("beta_rate") is None:
                data["beta_rate"] = data["slip_rate"]
            if "curvature" in data and data.get("kappa") is None:
                data["kappa"] = data["curvature"]
            elif "kappa" in data and data.get("curvature") is None:
                data["curvature"] = data["kappa"]
        return data


class ErrorResponse(BaseModel):
    """Standard error response."""

    detail: str = Field(..., description="Error message explanation")


# Pydantic Rust-backed TypeAdapter for high-performance JSON serialization
_PLAYER_LIST_ADAPTER = TypeAdapter(list[PlayerListItem])


def serialize_player_list(players: list[PlayerListItem]) -> bytes:
    """Serialize list of PlayerListItem into compliant UTF-8 JSON bytes via Rust.

    Translates math.nan floats to valid JSON null values automatically.
    """
    return _PLAYER_LIST_ADAPTER.dump_json(players)
