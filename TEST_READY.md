# TEST_READY: NFL Combine & Game Automated Test Suite

## Executive Summary
The opaque-box, requirement-driven automated test suite for the NFL Combine & Game Interactive Web Application has been authored, verified, and published.

- **Total Test Count**: **142 test cases** (exceeds requirement of $\ge 138$).
- **Test Runner Command**: `.venv\Scripts\pytest.exe tests/`
- **Execution Speed**: **~3.28 seconds** total runtime.
- **Pass / Skip Semantics**:
  - Independent mathematical and data verification tests: **57 passed** immediately.
  - Web API and E2E integration tests: **85 tests** conditionally skip prior to `src.web.app` implementation (Milestones M1–M4), enabling progressive testability without false failures.
  - Zero unhandled exceptions or 500 errors.

---

## Test Architecture & Tier Mapping

| Tier | Category | Target Scope | Test Count | Files |
| :--- | :--- | :--- | :---: | :--- |
| **Tier 1** | **Feature Coverage** | F1 through F12 core behavior contracts | **60 tests** | `test_web_api.py`, `test_kinematics.py`, `test_e2e.py` |
| **Tier 2** | **Boundary & Corner Cases** | Edge cases, MNAR opt-outs, 0-snap players, coordinate extremes, singular cutoffs | **62 tests** | `test_web_api.py`, `test_kinematics.py`, `test_e2e.py` |
| **Tier 3** | **Cross-Feature Combinations** | Pairwise interaction tests across filters, combine, telemetry, kinematics | **14 tests** | `test_e2e.py` |
| **Tier 4** | **Real-World Scenarios** | End-to-end user journeys (Draft scouting, DB coverage, opt-out eval, multi-team, redzone, 0-snap rookie) | **6 tests** | `test_e2e.py` |
| **TOTAL** | | | **142 tests** | |

---

## Deliverables & File Index

### 1. `tests/test_kinematics.py` (32 tests)
- **Mathematical Formulations**:
  - Unwrapped angular velocity $\omega_t = \frac{|\Delta \theta_t|}{\Delta t}$ with modulo $360^\circ$ periodic unwrapping ($[-180^\circ, 180^\circ]$).
  - Curvature $\kappa_t = \frac{\omega_{t, \text{rad}}}{s_t}$ with strict singularity cutoff: $\kappa_t = 0.0$ when $s_t < 0.2\text{ yd/s}$.
  - Slip angle $\beta_{\text{slip}, t} = ((\text{dir}_t - o_t + 180^\circ) \bmod 360^\circ) - 180^\circ \in [-180^\circ, 180^\circ]$.
  - Velocity vector decomposition: $v_x = s_t \sin(\text{dir}_t), v_y = s_t \cos(\text{dir}_t)$ in NGS compass coordinates ($0^\circ=\text{North}, 90^\circ=\text{East}$).
- **Vectorized Polars Engine**:
  - Validates Polars expression pipeline against real sliced parquet files (`combine_tracking.parquet`, `game_tracking_2023.parquet`).
  - Verifies interface contract `compute_tracking_kinematics(df, is_combine)`.

### 2. `tests/test_web_api.py` (64 tests)
- **F1: Player Indexing & Query API** (`/api/players`):
  - Global query returning 510 player master index with required schema fields.
  - Filtering by `draft_year` (2023: 160, 2024: 177, 2025: 173).
  - Filtering by `pos` (e.g. `WR`: 106, `CB`: 60).
  - Filtering by `team_abbr` (e.g. `SEA`, `LAR`, `LA`).
  - Text search by name, college, and `nfl_id`.
  - Boundaries: non-existent years (1990), non-existent positions (`KICKER`), empty search queries, special character sanitization.
- **F2: Player Bio & Career Summary** (`/api/player/{id}/summary`):
  - Bio details: college, conference, birth date, height, weight, anthropometrics (hand size, arm length, wing span).
  - Career snap counts: offensive, defensive, and special teams snaps.
  - Career accolades: Pro Bowl and All-Pro selections.
  - Boundaries: 404 for invalid/negative IDs, UDFA draft pick handling.
- **F3: Combine Metrics & Opt-Out Badges**:
  - Verification of physical drill scores (`forty`, `vertical`, `broad_jump`, `three_cone`, `short_shuttle`, `bench_reps`).
  - Missing Not At Random (MNAR) opt-out badge detection (e.g. Jaxon Smith-Njigba 40-yard dash opt-out).
  - NGS athleticism, college production, and final scores.
- **F4 & F5: Tracked Combine Drills & Ball Separation** (`/api/player/{id}/combine/{event_id}`):
  - Summary metrics: $s_{\max}, a_{\max}, \kappa_{90}$, duration.
  - Entity separation: strictly separates `PLAYER` and `BALL` trajectory frames for route drills (e.g. Jayden Higgins WR drill).
  - Boundaries: 404 on nonexistent event IDs, empty ball frame handling for drills without a tracked ball.
- **F6: Game & Play Filtering API** (`/api/player/{id}/games`):
  - Game metadata (game ID, season, week, home/visitor teams).
  - Pass vs Run derivation based on `pass_result` and `rush_yards`.
  - Play analytics (EPA, game clock, quarter, down, yards to go).
  - Boundaries: 404 on invalid players, empty list 200 OK for 0-snap players.
- **F7: Game Snap Telemetry & Multi-Year Routing** (`/api/player/{id}/snap/{game_id}/{play_id}`):
  - 10 Hz telemetry with dual angles (`dir` and `o`), slip angle, curvature.
  - Event marker sequence (`ball_snap`, `pass_forward`, `pass_arrived`, `tackle`).
  - Boundaries: 404 on invalid game/play IDs.
- **F12: Edge Cases & Data Anomalies**:
  - Multi-team Rams normalization (`LA` vs `LAR` for Puka Nacua 56042).
  - Zero-snap rookie handling without 500 error (Ikenna Enechukwu 56648, Gavin Bartholomew 58407).
  - Preservation of signed/negative accelerations in 2025 game data.

### 3. `tests/test_e2e.py` (46 tests)
- **F9: 2D Field Coordinate Transform**:
  - Inverted Y-axis Canvas matrix mathematics `ctx.translate(offsetX, H - offsetY); ctx.scale(scale, -scale); ctx.translate(-minX, -minY)`.
  - Field proportions $120 \times 53.33$ yards, hashmarks at $23.58$ and $29.75$ yards.
  - Viewport bounds $[-10, 130] \times [-10, 65]$ accommodating out-of-bounds plays.
  - Post-restore upright text rendering invariants.
- **F10: Dual Direction Vectors & Visual Slip Angle**:
  - Proportional cyan motion direction vector ($L \propto s_t$).
  - Fixed-length amber body orientation vector ($1.5$ yards).
  - Visual slip angle arc $|\beta_{\text{slip}}|$.
  - Boundary: stationary athlete ($s = 0$) retains visible body orientation arrow while motion vector length is 0.
- **F11: 10 Hz Interactive Playback Engine**:
  - 10 Hz time step ($\Delta t = 0.1\text{ s}$).
  - Playback duration formula $(N - 1) \times 0.1\text{ s}$.
  - Scrubber frame clamping $[0, N - 1]$, step forward/backward, and auto-pause at play end.
  - Playback rates: 0.5x (200 ms), 1x (100 ms), 2x (50 ms).
- **Tier 3: 14 Cross-Feature Pairwise Tests**:
  - Pairwise coverage spanning F1 through F12.
- **Tier 4: 6 Real-World Application Workflows**:
  - **Scenario 1**: Prospect Draft Scouting Journey (Brian Thomas Jr. 57144, 40-yd dash 4.33s, route drill).
  - **Scenario 2**: DB Coverage & Slip Angle Analysis (Deonte Banks 55888, snap 569, backpedal vs lateral cut).
  - **Scenario 3**: Opt-Out Prospect Evaluation (Jaxon Smith-Njigba 55884, 40-yd opt-out badge, recorded 3-cone 6.57s).
  - **Scenario 4**: Multi-Team Veteran Career Tracking (Puka Nacua 56042, `LA` and `LAR` indexing across seasons).
  - **Scenario 5**: Redzone Passing Play Telemetry (JSN snap 202 of game 2023081052, full event marker lifecycle).
  - **Scenario 6**: Zero-Snap Rookie Boundary Handling (Gavin Bartholomew 58407, empty game list 200 OK without crash).

### 4. `tests/conftest.py`
- Session-scoped Starlette `TestClient` fixture with automatic lifespan management.
- Authoritative ground-truth dictionary for key reference athletes.
- Safe dynamic import of `src.web.app` supporting progressive test execution.

### 5. `pytest.ini` & `pyproject.toml`
- Configured with `testpaths = ["tests"]`.
- Configured with `norecursedirs = [".venv", "tracking_by_position", "combine_tracking_by_position", "data", "bdb2027", "artifacts", ".agents"]` preventing recursive folder scans and achieving **3.28s test suite execution**.

---

## Instructions for Verification

Run the entire test suite via:
```powershell
.venv\Scripts\pytest.exe tests/ -v
```

To run individual test modules:
```powershell
# Mathematical and Polars kinematics verification:
.venv\Scripts\pytest.exe tests/test_kinematics.py -v

# Starlette REST API endpoints:
.venv\Scripts\pytest.exe tests/test_web_api.py -v

# End-to-end integration and user journeys:
.venv\Scripts\pytest.exe tests/test_e2e.py -v
```
