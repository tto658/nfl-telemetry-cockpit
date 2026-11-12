# Project: NFL Combine & Game Interactive Web Application

## Architecture
- **Backend**: FastAPI / Starlette application in `src/web/app.py` powered by Polars in `src/web/data_loader.py` and `src/web/kinematics.py`.
- **Data Layer**:
  - Root tables: `players.parquet` (510 players), `games.parquet` (1,002 games).
  - Position directories: `./tracking_by_position/<POS>/<nfl_id>_<Name>_<Year>/` containing slices for `combine_results.parquet`, `combine_tracking.parquet`, `player_play.parquet`, `player_career_successes.parquet`, and `game_tracking_2023..2025.parquet`.
- **Frontend**: Zero-dependency vanilla HTML5/CSS/JavaScript in `src/web/static/` (`index.html`, `styles.css`, `app.js`).
  - Dark-theme responsive UI with 2-tab layout.
  - Exclusively consumes backend DTOs (`FrameDTO`) so all kinematics calculations remain 100% on the backend.
  - Affine Canvas transformation matrix (`ctx.scale(scale, -scale)`) for yard-coordinate rendering.
  - Upright text rendering post-restore.
  - Dual vector indicators (cyan motion direction $\text{dir}$, amber body orientation $o$, slip angle $\beta_{\text{slip}}$ arc).
  - 10 Hz time-series synchronizer and 60 FPS interpolated animation loop.
- **Testing Track**: Comprehensive 4-tier requirement-driven E2E test suite in `tests/test_web_api.py`, `tests/test_kinematics.py`, and `tests/test_e2e.py`.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | F1: Player Indexing & Query API | Startup in-memory player index of 510 directories + `players.parquet` + `combine_results.parquet` bio + `player_play.parquet` team abbreviations. Filter by draft year, position, team, search. | M1 | ORIGINAL_REQUEST §1, §4 |
| 2 | F2: Player Bio & Career Summary | Height, weight, college, draft pick, career snap counts from `player_career_successes.parquet` served via `/api/player/{nfl_id}/summary`. | M1 | ORIGINAL_REQUEST §2, §4 |
| 3 | F3: Combine Metrics & Opt-Out Badges | `/api/player/{nfl_id}/combine`: test metrics (forty, bench, vertical, broad jump, 3-cone, shuttle), NGS athleticism/production scores, explicit Opt-Out / MNAR badges for missing values. | M2 | ORIGINAL_REQUEST §2 (Tab 1), Follow-up |
| 4 | F4: Tracked Combine Drills API | `/api/player/{nfl_id}/combine/{event_id}` returning 10 Hz `FrameDTO` time series for player and ball, plus computed summary metrics ($s_{max}, a_{max}, \kappa_{90}$, duration). | M2 | ORIGINAL_REQUEST §1, §2, Follow-up |
| 5 | F5: Combine 2D Field & Ball Trajectory | HTML5 Canvas rendering of speed-colored player path and dashed ball path (Trap 2 style) with motion direction arrow. | M3 | ORIGINAL_REQUEST §2 (Tab 1), §3 |
| 6 | F6: Games & Plays Hierarchical APIs | `/api/player/{nfl_id}/games` (returns games list) and `/api/player/{nfl_id}/plays/{game_id}` (returns plays list for selected game with pass/run type, EPA, clock, and description). Supports: Select Game -> List Plays -> Select Play -> Load Tracking. | M2 | ORIGINAL_REQUEST §1, §2, Follow-up |
| 7 | F7: Game Snap Telemetry & Season Dispatch | `/api/player/{nfl_id}/snap/{game_id}/{play_id}` dispatching across `game_tracking_2023..2025.parquet` returning 10 Hz `FrameDTO` sequence, events, play metadata. | M2 | ORIGINAL_REQUEST §1, §2, Follow-up |
| 8 | F8: Kinematics Engine & FrameDTO | Polars vectorized calculation of unwrapped angular velocity $\omega_t$, curvature $\kappa_t$ with $s \ge 0.2\text{ yd/s}$ singularity threshold, and slip angle $\beta_{\text{slip}, t} = ((\text{dir}_t - o_t + 180^\circ) \bmod 360^\circ) - 180^\circ$. Formats into unified `FrameDTO`. | M2 | ORIGINAL_REQUEST §2, §4, Follow-up |
| 9 | F9: 2D NFL Field Canvas with Context Transform | Affine Canvas transformation `ctx.translate(offsetX, height - offsetY); ctx.scale(scale, -scale); ctx.translate(-minX, -minY)`, upright text rendering post-restore, 120x53.3 yard markings, hash marks, endzones. | M4 | ORIGINAL_REQUEST §2, §3 |
| 10 | F10: Dual Direction Vectors & Slip Angle | Cyan motion direction arrow ($\text{dir}_t$, length $\propto s_t$), amber body orientation arrow ($o_t$, fixed length), visual slip angle arc $\beta_{\text{slip}, t}$ driven by `FrameDTO`. | M4 | ORIGINAL_REQUEST §2 (Tab 2), Follow-up |
| 11 | F11: 10 Hz Interactive Playback Engine | Play/pause, step forward/backward, scrub timeline, playback rate (0.5x, 1x, 2x), synchronized 2D field canvas and 10 Hz timeseries canvas driven by `FrameDTO`. | M4 | ORIGINAL_REQUEST §2, Follow-up |
| 12 | F12: Edge Case & Data Anomaly Handling | Graceful handling of 13 players with 0 game snaps, multi-team players (e.g. Rams LA vs LAR), drills without ball data, and coordinate bounds exceeding standard field. | M1, M2, M3, M4 | ORIGINAL_REQUEST §1, Survey findings |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Backend & Player Registry | `src/web/data_loader.py`, `src/web/schemas.py`, `src/web/app.py` core, `/api/players`, startup indexing of 510 players & team codes | None | DONE |
| M2 | Kinematics Engine, Tracking APIs & FrameDTO | `src/web/kinematics.py`, FrameDTO model, endpoints: `/api/player/{nfl_id}/summary`, `/api/player/{nfl_id}/combine`, `/api/player/{nfl_id}/combine/{event_id}`, `/api/player/{nfl_id}/games`, `/api/player/{nfl_id}/plays/{game_id}`, `/api/player/{nfl_id}/snap/{game_id}/{play_id}`, season routing | M1 | DONE |
| M3 | Frontend Base & Tab 1 Combine Explorer | `src/web/static/index.html`, `styles.css`, `app.js` (header filters, bio banner, Tab 1 combine metrics, Opt-Out badges, drill selector, 2D field canvas with ball separation, 10 Hz timeseries canvas) consuming DTOs | M1, M2 | DONE |
| M4 | Tab 2 Game Explorer & 10 Hz Playback | Tab 2 Game selector -> `/plays/{game_id}` list -> `/snap/{game_id}/{play_id}`, 2D NFL field canvas with context transform, cyan `dir` and amber `o` vector arrows, slip angle visualization, synchronized 10 Hz timeseries canvas, 60 FPS playback engine consuming FrameDTO | M2, M3 | DONE |
| M5 | Final Milestone: 100% E2E Pass + Hardening | Phase 1: Verify 100% pass of Tiers 1-4 E2E test suite published in `TEST_READY.md`. Phase 2: Tier 5 adversarial coverage hardening with Challengers. | M1, M2, M3, M4, TEST_READY | DONE |


---

## Interface Contracts

### Backend ↔ Frontend: API Contracts
1. `GET /api/players?draft_year={year}&pos={pos}&team_abbr={team}&q={search}`
   - Returns: `list[PlayerListItem]` where each item has:
     `{nfl_id: int, display_name: str, nfl_position: str, draft_year: int, draft_pick_formatted: str, teams: list[str], display_label: str}`
2. `GET /api/player/{nfl_id}/summary`
   - Returns: `{bio: PlayerBio, combine: CombineSummary, career: CareerSuccesses}`
3. `GET /api/player/{nfl_id}/combine`
   - Returns: combine metrics (`forty`, `bench_reps`, `vertical`, `broad_jump`, `three_cone`, `short_shuttle`, `ngs_scores`, `opt_outs: list[str]`) and list of available tracked drills.
4. `GET /api/player/{nfl_id}/combine/{event_id}`
   - Returns: `{drill_name: str, duration: float, s_max: float, a_max: float, kappa_90: float, player_frames: list[FrameDTO], ball_frames: list[FrameDTO]}`
5. `GET /api/player/{nfl_id}/games`
   - Returns: `list[GameSummary]` where each item has: `{game_id: int, season: int, week: int, opponent: str, home_away: str, date: str|null, total_plays: int}`
6. `GET /api/player/{nfl_id}/plays/{game_id}?lined_up_position={pos}&play_type={pass|run}`
   - Returns: `list[PlaySummary]` where each item has: `{play_id: int, quarter: int, game_clock: str, play_type: str, epa: float, description: str, lined_up_position: str}`
7. `GET /api/player/{nfl_id}/snap/{game_id}/{play_id}`
   - Returns: `{game_id: int, play_id: int, description: str, frames: list[FrameDTO], events: list[EventMarker]}`

### FrameDTO Schema
```json
{
  "frameId": 103,
  "time": 1.2,
  "x": 24.1,
  "y": 11.4,
  "s": 6.3,
  "a": 1.7,
  "dir": 91.2,
  "o": 79.3,
  "omega": 12.1,
  "curvature": 0.06,
  "slip_angle": 11.9,
  "event": "ball_snap"
}
```

---

## Code Layout
```
c:\#NFL\
├── players.parquet
├── games.parquet
├── combine_results.parquet
├── tracking_by_position/
│   └── <POS>/
│       └── <nfl_id>_<Name>_<Year>/
│           ├── combine_results.parquet
│           ├── combine_tracking.parquet
│           ├── player_career_successes.parquet
│           ├── player_play.parquet
│           └── game_tracking_2023..2025.parquet
├── src/
│   └── web/
│       ├── __init__.py
│       ├── app.py              # Starlette application entrypoint, routes, lifespan
│       ├── data_loader.py      # PlayerRegistry, Parquet reading with Polars
│       ├── kinematics.py       # Polars kinematic calculations (omega, kappa, beta_slip, FrameDTO)
│       ├── schemas.py          # Pydantic models for API responses & FrameDTO
│       └── static/
│           ├── index.html      # Dark-themed 2-tab dashboard layout
│           ├── css/
│           │   └── styles.css  # Responsive styling, badges, cards, sliders
│           └── js/
│               ├── app.js      # Main controller, state management, tab switching
│               ├── api.js      # API fetch client
│               ├── field.js    # 2D Canvas renderer consuming FrameDTO
│               └── timeseries.js # 10 Hz dynamic metrics canvas consuming FrameDTO
└── tests/
    ├── __init__.py
    ├── conftest.py             # Pytest fixtures and test client setup
    ├── test_web_api.py         # Starlette TestClient API verification
    ├── test_kinematics.py      # Kinematics engine unit tests
    └── test_e2e.py             # E2E integration test suite
```
