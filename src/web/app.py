"""Starlette application exposing REST API for NFL Player Tracking platform."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from src.web.data_loader import get_player_registry
from src.web.schemas import FrameDTO, PlayerQueryParams, serialize_player_list
from src.web.spatial import (
    DRILL_MILESTONES,
    SpatialDeltaComparison,
    SpatialTrajectory,
    SpatialResampledPoint,
    compare_trajectories_spatial,
    compute_position_average_trajectory,
    generate_distance_grid,
    resample_trajectory_spatial,
)
import numpy as np

__all__ = ["FrameDTO", "app"]


# -----------------------------------------------------------------------------
# Lifespan
# -----------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: Starlette):
    """Application lifespan context."""
    yield


# -----------------------------------------------------------------------------
# Synchronous Endpoint Handlers
# -----------------------------------------------------------------------------
def get_players(request: Request) -> Response:
    """GET /api/players: Query players by draft_year, pos, team_abbr, q."""
    registry = get_player_registry()

    # Fast path: serve pre-serialized bytes if no query parameters provided
    if not request.query_params:
        return Response(registry.cached_all_players_bytes, media_type="application/json")

    try:
        params = PlayerQueryParams.model_validate(dict(request.query_params))
    except ValidationError:
        return Response(b"[]", media_type="application/json")

    # If all query parameters normalized to None/empty, serve cached full list
    if params.draft_year is None and not params.pos and not params.team_abbr and not params.q:
        return Response(registry.cached_all_players_bytes, media_type="application/json")

    items = registry.filter_players(
        draft_year=params.draft_year,
        position=params.pos,
        team_abbr=params.team_abbr,
        query=params.q,
    )
    return Response(serialize_player_list(items), media_type="application/json")


def get_player_summary(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/summary: Player bio, combine metrics, and career stats."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    registry = get_player_registry()
    try:
        summary = registry.get_player_summary(nfl_id)
    except KeyError:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    return JSONResponse(summary)


def get_metadata(request: Request) -> Response:
    """GET /api/metadata: Return available filter options (years, positions, teams)."""
    registry = get_player_registry()
    return JSONResponse(registry.get_metadata().model_dump())


def get_player_combine(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/combine: Combine summary for player."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    registry = get_player_registry()
    if registry.get_player(nfl_id) is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    summary = registry.get_player_summary(nfl_id)
    return JSONResponse(summary.get("combine", {}))


def get_player_combine_drill(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/combine/{event_id}: 10 Hz tracked combine drill."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    event_id = request.path_params.get("event_id")
    if not event_id:
        return JSONResponse({"detail": "Missing event ID"}, status_code=404)

    registry = get_player_registry()
    if registry.get_player(nfl_id) is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    try:
        drill_data = registry.load_combine_drill(nfl_id, event_id)
    except KeyError:
        return JSONResponse({"detail": f"Event {event_id} not found for player {nfl_id}"}, status_code=404)

    return JSONResponse(drill_data)


def get_player_dynamics(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/dynamics: Vehicle dynamics metrics across combine drills."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    registry = get_player_registry()
    player = registry.get_player(nfl_id)
    if player is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    drills_list = registry.get_combine_drills_list(nfl_id)
    combine_dynamics: list[dict[str, Any]] = []

    for d in drills_list:
        event_id = d.get("event_id")
        if not event_id:
            continue
        try:
            drill_data = registry.load_combine_drill(nfl_id, event_id)
            metrics = drill_data.get("metrics", {})
            g_comb_max = float(drill_data.get("g_comb_max") if drill_data.get("g_comb_max") is not None else metrics.get("g_comb_max", 0.0))
            overlap_index = float(drill_data.get("overlap_index") if drill_data.get("overlap_index") is not None else metrics.get("overlap_index", 0.0))
            overlap_pct = float(drill_data.get("overlap_pct") if drill_data.get("overlap_pct") is not None else metrics.get("overlap_pct", 0.0))
            v_apex = float(drill_data.get("v_apex") if drill_data.get("v_apex") is not None else metrics.get("v_apex", 0.0))
            corner_exit_traction = float(drill_data.get("corner_exit_traction") if drill_data.get("corner_exit_traction") is not None else metrics.get("corner_exit_traction", 0.0))

            combine_dynamics.append({
                "event_id": str(event_id),
                "drill_name": str(drill_data.get("drill_name") or d.get("drill_name", "COMBINE_DRILL")),
                "g_comb_max": round(g_comb_max, 2),
                "overlap_index": round(overlap_index, 4),
                "overlap_pct": round(overlap_pct, 1),
                "v_apex": round(v_apex, 2),
                "corner_exit_traction": round(corner_exit_traction, 2),
            })
        except Exception:
            continue

    if combine_dynamics:
        peak_g_comb = round(max(cd["g_comb_max"] for cd in combine_dynamics), 2)
        mean_overlap_pct = round(float(np.mean([cd["overlap_pct"] for cd in combine_dynamics])), 1)
        best_v_apex = round(max(cd["v_apex"] for cd in combine_dynamics), 2)
        best_exit_traction = round(max(cd["corner_exit_traction"] for cd in combine_dynamics), 2)
    else:
        peak_g_comb = 0.0
        mean_overlap_pct = 0.0
        best_v_apex = 0.0
        best_exit_traction = 0.0

    # Classify archetype based on peak_g_comb, mean_overlap_pct, best_v_apex, best_exit_traction
    if mean_overlap_pct >= 18.0 and peak_g_comb >= 0.75:
        archetype = {
            "code": "ELITE_TRAIL_BRAKER",
            "label": "Fluid High-G Cornering (Elit Trail-Braker)",
            "rationale": "Magas fázis-átfedés (Overlap) és kiemelkedő kombinált G-erő kanyarodás közben."
        }
    elif best_exit_traction is not None and best_exit_traction >= 3.5:
        archetype = {
            "code": "EXPLOSIVE_EXIT",
            "label": "Explosive Linear / Corner-Exit Accelerator",
            "rationale": "Robbanékony kigyorsítási gradiens az irányváltási csúcspontok (Apex) után."
        }
    elif best_v_apex is not None and best_v_apex >= 5.0:
        archetype = {
            "code": "HIGH_APEX_MOMENTUM",
            "label": "High-Momentum Apex Runner",
            "rationale": "Kimagasló sebességmegtartás a legélesebb iránytörések csúcspontján."
        }
    else:
        archetype = {
            "code": "BALANCED_MOVER",
            "label": "Balanced Two-Phase Mover",
            "rationale": "Kiegyensúlyozott, kontrollált kétfázisú (fékezés → fordulás) mozgásprofil."
        }

    return JSONResponse({
        "nfl_id": nfl_id,
        "display_name": player.display_name,
        "position": player.position,
        "combine_dynamics": combine_dynamics,
        "peak_g_comb": peak_g_comb,
        "mean_overlap_pct": mean_overlap_pct,
        "best_v_apex": best_v_apex,
        "best_exit_traction": best_exit_traction,
        "archetype": archetype,
    })


def get_player_games(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/games: Game list and plays."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    registry = get_player_registry()
    player = registry.get_player(nfl_id)
    if player is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    # 13 zero-snap players gracefully return empty list
    if not player.teams:
        return JSONResponse({"games": []})

    qp = request.query_params
    season_raw = qp.get("season")
    season = int(season_raw) if season_raw and season_raw.isdigit() else None
    play_type = qp.get("play_type")

    games = registry.load_player_games(nfl_id, season=season, play_type=play_type)
    return JSONResponse({"games": games})


def get_player_plays_for_game(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/plays/{game_id:int}: Plays for a specific game."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    game_id = request.path_params.get("game_id")
    registry = get_player_registry()
    if registry.get_player(nfl_id) is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    qp = request.query_params
    play_type = qp.get("play_type")
    pos_filter = qp.get("lined_up_position")

    games = registry.load_player_games(nfl_id, play_type=play_type)
    for g in games:
        if g["game_id"] == game_id:
            plays = g.get("plays", [])
            if pos_filter:
                pos_upper = pos_filter.strip().upper()
                plays = [p for p in plays if p.get("lined_up_position", "").upper() == pos_upper]
            return JSONResponse(plays)
    return JSONResponse([])


def get_player_snap(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/snap/{game_id:int}/{play_id:int}: 10 Hz game snap telemetry."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    game_id = request.path_params.get("game_id")
    play_id = request.path_params.get("play_id")

    registry = get_player_registry()
    if registry.get_player(nfl_id) is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    try:
        snap_data = registry.load_player_snap(nfl_id, game_id, play_id)
    except KeyError:
        return JSONResponse({"detail": f"Snap {play_id} not found"}, status_code=404)

    return JSONResponse(snap_data)


# -----------------------------------------------------------------------------


def get_spatial_drills(request: Request) -> Response:
    """GET /api/spatial/drills?nfl_id={nfl_id}: Return available tracked drills for player."""
    nfl_id_raw = request.query_params.get("nfl_id")
    if not nfl_id_raw or not nfl_id_raw.isdigit():
        return JSONResponse({"detail": "Missing or invalid nfl_id"}, status_code=400)
    nfl_id = int(nfl_id_raw)
    registry = get_player_registry()
    if registry.get_player(nfl_id) is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)
    drills = registry.get_combine_drills_list(nfl_id)
    return JSONResponse({"drills": drills})


def compare_spatial_combine(request: Request) -> Response:
    """GET /api/spatial/compare/combine: Compare two combine drill trajectories on uniform distance grid."""
    qp = request.query_params
    p_a_raw = qp.get("player_a")
    drill_a = qp.get("drill_a")
    p_b_raw = qp.get("player_b")
    drill_b = qp.get("drill_b")
    step_raw = qp.get("step", "0.5")
    milestones = qp.get("milestones")

    if not p_a_raw or not drill_a or not p_b_raw or not drill_b:
        return JSONResponse({"detail": "Missing player_a, drill_a, player_b, or drill_b parameter"}, status_code=400)

    try:
        player_a = int(p_a_raw)
        player_b = int(p_b_raw)
        step = float(step_raw)
    except ValueError:
        return JSONResponse({"detail": "Invalid player ID or step parameter"}, status_code=400)

    registry = get_player_registry()
    p_a = registry.get_player(player_a)
    p_b = registry.get_player(player_b)
    if not p_a:
        return JSONResponse({"detail": f"Player {player_a} not found"}, status_code=404)
    if not p_b:
        return JSONResponse({"detail": f"Player {player_b} not found"}, status_code=404)

    try:
        drill_a_data = registry.load_combine_drill(player_a, drill_a)
    except KeyError:
        return JSONResponse({"detail": f"Drill {drill_a} not found for player {player_a}"}, status_code=404)

    try:
        drill_b_data = registry.load_combine_drill(player_b, drill_b)
    except KeyError:
        return JSONResponse({"detail": f"Drill {drill_b} not found for player {player_b}"}, status_code=404)

    drill_name_a = drill_a_data.get("drill_name", "COMBINE_DRILL")
    drill_name_b = drill_b_data.get("drill_name", "COMBINE_DRILL")

    ms_preset = milestones or drill_name_a
    comparison = compare_trajectories_spatial(
        drill_a_data.get("player_frames", []),
        drill_b_data.get("player_frames", []),
        step_yards=step,
        milestones=ms_preset,
        include_trajectories=True,
    )

    result = comparison.model_dump()
    result["player_a"] = {
        "nfl_id": player_a,
        "name": p_a.display_name,
        "position": p_a.position,
        "draft_year": p_a.draft_year,
        "team": p_a.teams[0] if p_a.teams else "",
        "drill_name": drill_name_a,
        "event_id": drill_a,
    }
    result["player_b"] = {
        "nfl_id": player_b,
        "name": p_b.display_name,
        "position": p_b.position,
        "draft_year": p_b.draft_year,
        "team": p_b.teams[0] if p_b.teams else "",
        "drill_name": drill_name_b,
        "event_id": drill_b,
    }
    return JSONResponse(result)


def compare_spatial_snap(request: Request) -> Response:
    """GET /api/spatial/compare/snap: Compare two in-game snap trajectories on uniform distance grid."""
    qp = request.query_params
    p_a_raw = qp.get("player_a")
    game_a_raw = qp.get("game_a")
    play_a_raw = qp.get("play_a")
    p_b_raw = qp.get("player_b")
    game_b_raw = qp.get("game_b")
    play_b_raw = qp.get("play_b")
    step_raw = qp.get("step", "0.5")

    if not all([p_a_raw, game_a_raw, play_a_raw, p_b_raw, game_b_raw, play_b_raw]):
        return JSONResponse({"detail": "Missing player, game, or play parameter"}, status_code=400)

    try:
        player_a, game_a, play_a = int(p_a_raw), int(game_a_raw), int(play_a_raw)
        player_b, game_b, play_b = int(p_b_raw), int(game_b_raw), int(play_b_raw)
        step = float(step_raw)
    except ValueError:
        return JSONResponse({"detail": "Invalid numeric parameter"}, status_code=400)

    registry = get_player_registry()
    p_a = registry.get_player(player_a)
    p_b = registry.get_player(player_b)
    if not p_a:
        return JSONResponse({"detail": f"Player {player_a} not found"}, status_code=404)
    if not p_b:
        return JSONResponse({"detail": f"Player {player_b} not found"}, status_code=404)

    try:
        snap_a = registry.load_player_snap(player_a, game_a, play_a)
    except KeyError:
        return JSONResponse({"detail": f"Snap {play_a} not found for player {player_a}"}, status_code=404)

    try:
        snap_b = registry.load_player_snap(player_b, game_b, play_b)
    except KeyError:
        return JSONResponse({"detail": f"Snap {play_b} not found for player {player_b}"}, status_code=404)

    comparison = compare_trajectories_spatial(
        snap_a.get("frames", []),
        snap_b.get("frames", []),
        step_yards=step,
        include_trajectories=True,
    )

    result = comparison.model_dump()
    result["player_a"] = {
        "nfl_id": player_a,
        "name": p_a.display_name,
        "position": p_a.position,
        "game_id": game_a,
        "play_id": play_a,
    }
    result["player_b"] = {
        "nfl_id": player_b,
        "name": p_b.display_name,
        "position": p_b.position,
        "game_id": game_b,
        "play_id": play_b,
    }
    return JSONResponse(result)


def get_spatial_position_avg(request: Request) -> Response:
    """GET /api/spatial/position_avg: Compute position-average trajectory for a combine drill."""
    qp = request.query_params
    pos = qp.get("position", "").strip().upper()
    drill_name = qp.get("drill_name", "FORTY_YARD_DASH").strip().upper()
    step_raw = qp.get("step", "0.5")

    try:
        step = float(step_raw)
    except ValueError:
        step = 0.5

    registry = get_player_registry()
    try:
        result = compute_position_average_trajectory(registry, pos, drill_name, step)
        return JSONResponse(result)
    except LookupError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=404)


def get_player_gg_cloud(request: Request) -> Response:
    """GET /api/player/{nfl_id:int}/gg-kde: Base64 binary float32 G-G telemetry cloud for KDE analysis."""
    nfl_id = request.path_params.get("nfl_id")
    if nfl_id is None or nfl_id <= 0:
        return JSONResponse({"detail": "Invalid player ID"}, status_code=404)

    registry = get_player_registry()
    if registry.get_player(nfl_id) is None:
        return JSONResponse({"detail": f"Player {nfl_id} not found"}, status_code=404)

    qp = request.query_params
    scope = qp.get("scope", "season").strip().lower()
    season_raw = qp.get("season")
    game_id_raw = qp.get("game_id")

    season: int | None = None
    if season_raw:
        try:
            season = int(season_raw)
        except ValueError:
            pass

    game_id: int | None = None
    if game_id_raw:
        try:
            game_id = int(game_id_raw)
        except ValueError:
            pass

    try:
        cloud = registry.load_player_gg_cloud_binary(
            nfl_id=nfl_id,
            scope=scope,
            season=season,
            game_id=game_id,
        )
        return JSONResponse(cloud)
    except KeyError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=404)


# Static files and routes setup
# -----------------------------------------------------------------------------
static_dir = Path(__file__).resolve().parent / "static"
static_dir.mkdir(parents=True, exist_ok=True)
index_html = static_dir / "index.html"
if not index_html.exists():
    index_html.write_text("<!DOCTYPE html><html><head><title>NFL Tracking</title></head><body><h1>NFL Tracking Dashboard</h1></body></html>", encoding="utf-8")

def serve_index(request: Request) -> Response:
    """Serve index.html at root."""
    return FileResponse(str(index_html))

routes = [
    Route("/", endpoint=serve_index, methods=["GET"]),
    Route("/api/players", endpoint=get_players, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/summary", endpoint=get_player_summary, methods=["GET"]),
    Route("/api/metadata", endpoint=get_metadata, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/combine", endpoint=get_player_combine, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/combine/{event_id}", endpoint=get_player_combine_drill, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/dynamics", endpoint=get_player_dynamics, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/gg-kde", endpoint=get_player_gg_cloud, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/games", endpoint=get_player_games, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/plays/{game_id:int}", endpoint=get_player_plays_for_game, methods=["GET"]),
    Route("/api/player/{nfl_id:int}/snap/{game_id:int}/{play_id:int}", endpoint=get_player_snap, methods=["GET"]),
    Route("/api/spatial/drills", endpoint=get_spatial_drills, methods=["GET"]),
    Route("/api/spatial/compare/combine", endpoint=compare_spatial_combine, methods=["GET"]),
    Route("/api/spatial/compare/snap", endpoint=compare_spatial_snap, methods=["GET"]),
    Route("/api/spatial/position_avg", endpoint=get_spatial_position_avg, methods=["GET"]),
    Mount("/static", app=StaticFiles(directory=str(static_dir), html=True), name="static"),
]

middleware = [
    Middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    ),
]

app = Starlette(routes=routes, middleware=middleware, lifespan=lifespan)
