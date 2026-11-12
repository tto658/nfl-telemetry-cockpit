# NFL Telemetry Cockpit & Biomechanics Lab 🏈🏎️

> **Next Gen Stats Biomechanics, Vehicle Dynamics & F1-Style Spatial Telemetry Platform for NFL Tracking Data**

A high-performance, auditable analytics platform and interactive web dashboard applying motorsports telemetry principles (Kamm Friction Circles, Yaw/Sideslip dynamics, Arc-Length Spatial Resampling, and 2D Kernel Density Estimation) to NFL Next Gen Stats player tracking data.

---

## 🌟 Core Pillars & Architectural Capabilities

### 1. Draft & Combine Scouting Lab
* **10 Hz Drill Player**: Interactive 2D drill replay on regulation field canvas with 60 FPS interpolation and scrub controls.
* **Combine Scorecards**: Comprehensive measurement cards (40-Yard Dash, 3-Cone Drill, 20-Yard Shuttle, Vertical Jump, Broad Jump, Bench Press).
* **MNAR (Missing-Not-At-Random) Badging**: Explicitly identifies medical/opt-out combine non-participants vs. non-qualifiers.
* **Kinematic Metrics**: Real-time evaluation of $v_{\max}$, $a_{\max}$, and high-curvature deceleration rates ($\kappa_{90}$).

### 2. In-Game Snap & Vehicle Dynamics Explorer
* **Vehicle Dynamics & Stability Metrics**:
  * **Sideslip Angle ($\beta$)**: Angular difference between velocity vector ($\text{dir}$) and body orientation ($\text{o}$), classifying movement into *Forward Drive*, *Lateral Slide*, and *Snap Oversteer*.
  * **Yaw Rate ($\dot{\beta}$)**: Rotational speed around the vertical axis ($^{\circ}/\text{sec}$).
  * **Jerk ($j_t$)**: Derivative of linear acceleration ($da/dt$), isolating explosive cuts from gradual transitions.
  * **Combined G-Force ($G_{\text{comb}}$)**: Total horizontal acceleration vector magnitude:
    $$\Vert \vec{a}_{\text{comb}} \Vert = \sqrt{a_t^2 + a_{\text{lat}}^2} \big/ g$$
  * **Impulse Coupling (Human Trail-Braking)**: Quantifies the transition delay between maximum braking $G$ and maximum lateral push $G$ during sharp plant-and-cut maneuvers.
  * **Apex Speed ($v_{\text{apex}}$)**: Instantaneous speed at points of local maximum trajectory curvature ($\kappa$).
  * **Corner Exit Traction ($a_{\text{exit}}$)**: Mean tangential acceleration over the first 0.5 s (5 frames) post-apex.
* **Interactive 2D NFL Field**: Zoomable and pannable canvas with field coordinate bijections and dynamic line-of-scrimmage markers.
* **Synchronized 5-Lane Timeseries**: High-speed multi-lane visualization of Speed, Acceleration, Sideslip, Yaw Rate, and G-Force.

### 3. F1 Spatial Resampling & Benchmark Lab
* **Curvilinear Distance Normalization**: Telemetry resampled along arc length $d(t) = \sum \Delta s$ rather than raw clock time, solving the fundamental time-phase misalignment between faster and slower movers.
* **Trajectory Overlay Canvas**: Normalized 2D spatial alignment of Prospect A vs. Prospect B (or Position Average baseline).
* **F1 Delta Telemetry Strips**: Delta velocity, delta acceleration, and vehicle dynamics divergence ribbons.
* **Sector & Split Analysis**: Automated 5-yard mini-sector scoring, lead/lag badges, and milestone gate splits (5, 10, 20, 40 yards).

### 4. G-G Friction Circle with 2D Kernel Density Estimation (KDE)
* **Heatmap Density Frontier**: Computes a continuous 2D probability density function over lateral acceleration ($a_{\text{lat}}$) and longitudinal acceleration ($a_t$).
* **Noise Rejection**: Distinguishes sustained traction boundaries ($G_{\text{sustained}}$ at 90th density percentile) from momentary vibration/impact spikes.
* **Low-Energy Coasting Filter**: Dynamic speed and energy gating that strips out pre-snap idle frames to highlight true athletic envelope limits.

### 5. Streamlined Mission Control Header
* **Ultra-Compact Design**: Reduced vertical header footprint by **~65%** down to 40 px, maximizing viewport space for canvases and telemetry graphs.
* **Collapsible Bio Ribbon**: 1-click toggle (`- Bio` / `+ Bio`) to hide/show prospect career metadata and snap breakdowns.

---

## 🛠️ Technology Stack

* **Backend Engine**:
  * [FastAPI](https://fastapi.tiangolo.com/) — Async high-throughput REST API with pydantic schemas.
  * [Polars](https://pola.rs/) — Zero-copy, multi-threaded columnar processing for gigabyte-scale tracking data.
  * [NumPy](https://numpy.org/) & [SciPy](https://scipy.org/) — Vector kinematics, angular unwrapping, and matrix interpolation.
  * [Uvicorn](https://www.uvicorn.org/) — ASGI web server.
* **Frontend Cockpit**:
  * Pure Vanilla JavaScript (ES6 Modules) — Zero bloated external frameworks or third-party chart libraries.
  * HTML5 Canvas 2D — Custom-built hardware-accelerated renderers for fields, strip charts, and G-G heatmaps.
  * Modern CSS Custom Properties & Responsive Flex/Grid Layouts.

---

## 🚀 Quickstart & Installation

### Prerequisites
* Python 3.11+
* [uv](https://github.com/astral-sh/uv) (recommended) or standard `pip`
* Node.js 18+ (for frontend verification tests)

### 1. Clone & Set Up Virtual Environment

```bash
git clone https://github.com/tto658/nfl-telemetry-cockpit.git
cd nfl-telemetry-cockpit

# Using uv:
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -e ".[dev]"

# Or using standard pip:
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

### 2. Launch the Telemetry Cockpit

```bash
python -m uvicorn src.web.app:app --host 127.0.0.1 --port 8000 --reload
```

Open your browser at `http://127.0.0.1:8000` to access the interactive Mission Control dashboard.

---

## 🧪 Testing & Verification

The platform features an extensive adversarial and mathematical test suite ensuring numerical precision, transform bijections, and UI state integrity:

```bash
# Run backend pytest suite (kinematics, vehicle dynamics, spatial resampling)
pytest tests/test_vehicle_dynamics.py -v
pytest tests/test_spatial.py -v

# Run Node.js adversarial frontend test runners
node tests/test_tier5_adversarial_frontend.mjs
node tests/game_explorer_runner.mjs
node tests/test_gg_kde.mjs
```

---

## 📁 Repository Structure

```
├── src/
│   └── web/
│       ├── app.py              # FastAPI server & route handlers
│       ├── data_loader.py      # Columnar Polars player registry & caching
│       ├── kinematics.py       # Slip angle, yaw rate, jerk, G-comb algorithms
│       ├── spatial.py          # Arc-length curvilinear resampling engine
│       ├── schemas.py          # Pydantic models & DTOs
│       └── static/             # Frontend application
│           ├── index.html      # Mission Control layout
│           ├── css/styles.css  # Compact theme & responsive telemetry styling
│           └── js/
│               ├── app.js               # Main application coordinator
│               ├── api.js               # Fetch client & API integration
│               ├── combine_field.js     # 2D Combine drill canvas
│               ├── game_field.js        # 2D Zoomable NFL regulation field
│               ├── timeseries.js        # 5-lane synchronized playback canvas
│               ├── spatial_strip.js     # Spatial trajectory overlay & delta strips
│               ├── gg_diagram.js        # G-G Kamm circle with 2D KDE heatmap
│               └── telemetry_cockpit.js # Biomechanical archetypes & HUD controller
├── tests/                      # Pytest & Node.js test suites
├── pyproject.toml              # Dependencies & build configuration
├── pytest.ini                  # Pytest runner settings
└── README.md
```

---

## 📄 License & Attribution

Developed for NFL tracking data research and advanced athletic biomechanics exploration. Tracking datasets courtesy of the NFL Big Data Bowl.
