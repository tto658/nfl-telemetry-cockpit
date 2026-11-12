# E2E Test Infra: NFL Combine & Game Interactive Web Application

## Test Philosophy
- Opaque-box, requirement-driven. Derived from `ORIGINAL_REQUEST.md` and user-facing specifications.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Progressive testability: Tier 1 tests verify basic endpoint accessibility and format contracts; higher tiers verify kinematics calculations, complex filtering, and edge conditions.

---

## Feature Inventory & Test Matrix
| # | Feature | Source | Tier 1 (Coverage ≥5) | Tier 2 (Boundary ≥5) | Tier 3 (Pairwise) | Tier 4 (Scenario) |
|---|---------|--------|:--------------------:|:--------------------:|:-----------------:|:-----------------:|
| 1 | F1: Player Index & Filters (`/api/players`) | ORIGINAL_REQUEST §1, §4 | 5 | 5 | ✓ | ✓ |
| 2 | F2: Player Bio & Career Summary (`/api/player/{id}/summary`) | ORIGINAL_REQUEST §2, §4 | 5 | 5 | ✓ | ✓ |
| 3 | F3: Combine Metrics & Opt-Out Badges | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 4 | F4: Tracked Combine Drills API (`/api/player/{id}/combine/{event}`) | ORIGINAL_REQUEST §1, §2 | 5 | 5 | ✓ | ✓ |
| 5 | F5: Combine 2D Field & Ball Separation | ORIGINAL_REQUEST §2, §3 | 5 | 5 | ✓ | ✓ |
| 6 | F6: Game & Play Filtering API (`/api/player/{id}/games`) | ORIGINAL_REQUEST §1, §2 | 5 | 5 | ✓ | ✓ |
| 7 | F7: Game Snap 10 Hz Telemetry & Multi-Year Routing | ORIGINAL_REQUEST §1, §2 | 5 | 5 | ✓ | ✓ |
| 8 | F8: Kinematics Engine ($\omega, \kappa, \beta_{\text{slip}}$) | ORIGINAL_REQUEST §2, §4 | 5 | 5 | ✓ | ✓ |
| 9 | F9: 2D Field Coordinate Transform & Upright Text | ORIGINAL_REQUEST §2, §3 | 5 | 5 | ✓ | ✓ |
| 10 | F10: Dual Direction Vectors ($\text{dir}$ & $o$) | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 11 | F11: 10 Hz Playback Engine & Synchronizer | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 12 | F12: Edge Cases (0-snap players, MNAR, LA/LAR) | ORIGINAL_REQUEST §1, §2 | 5 | 5 | ✓ | ✓ |

---

## Test Architecture
- **Test Runner**: `.venv\Scripts\pytest.exe tests/`
- **Pass/Fail Semantics**: 100% pass, exit code 0, no unhandled exceptions or 500 errors.
- **Client**: Starlette `TestClient(app)` executing asynchronous endpoints synchronously.
- **Directory Layout**:
  - `tests/test_web_api.py`: Comprehensive API endpoint verification, status codes, schema validation, filtering logic.
  - `tests/test_kinematics.py`: Unit and property tests for kinematics equations ($\omega, \kappa, \beta_{\text{slip}}$).
  - `tests/test_e2e.py`: End-to-end integration workflows simulating user journeys across tabs and edge cases.

---

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Prospect Draft Scouting Journey: Filter 2024 WR prospects, select Brian Thomas Jr., inspect combine 40-yd dash and route drill ball trajectory. | F1, F2, F3, F4, F5 | High |
| 2 | DB Coverage & Slip Angle Analysis: Select CB Christian Gonzalez, inspect game snap vs Miami, verify body orientation ($o$) vs motion direction ($\text{dir}$) and negative slip angle during backpedal. | F1, F6, F7, F8, F10 | High |
| 3 | Opt-Out Prospect Evaluation: Select top prospect with MNAR combine drills (e.g. Marvin Harrison Jr. or Jaxon Smith-Njigba), verify Opt-Out badges, ensure no division-by-zero or crash. | F1, F2, F3, F12 | Medium |
| 4 | Multi-Team Veteran Career Tracking: Select player traded between seasons (e.g. Rams LA vs LAR), verify all team codes index correctly in player filter. | F1, F6, F12 | Medium |
| 5 | Redzone Passing Play Telemetry: Query redzone pass play, verify ball snap and pass arrival event markers, verify 10 Hz coordinates sequence. | F6, F7, F8, F11 | High |
| 6 | Zero-Snap Rookie Boundary Handling: Select 2025 rookie with 0 game snaps, verify summary and combine endpoints succeed, verify game endpoint returns empty list gracefully without 500 error. | F1, F2, F6, F12 | Medium |

---

## Coverage Thresholds
- **Tier 1 (Feature Coverage)**: ≥60 tests (≥5 per feature across 12 features)
- **Tier 2 (Boundary & Corner)**: ≥60 tests (≥5 per feature covering empty inputs, missing combine drills, extreme coordinates)
- **Tier 3 (Cross-Feature Interaction)**: ≥12 tests (pairwise feature combinations)
- **Tier 4 (Real-World Workloads)**: ≥6 end-to-end application scenarios
- **Total Minimum Test Count**: ≥138 automated test cases
