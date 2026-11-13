/**
 * ============================================================================
 * gg_diagram.js - F1-Style G-G Friction Circle (Kamm Circle) Canvas Engine
 * NFL Next Gen Stats & Curvilinear Kinematics Telemetry Platform
 * ============================================================================
 * 
 * Zero external JS dependencies. Pure Vanilla ES6 and HTML5 Canvas 2D context.
 * 
 * Renders an F1-style Kamm Friction Circle plotting Lateral Acceleration (a_lat)
 * on the X-axis vs Longitudinal / Tangential Acceleration (a_t) on the Y-axis:
 * 
 * Key Features:
 * 1. Concentric reference rings at 0.5 g and 1.0 g (where 1.0 g = 10.7247 yd/s²,
 *    max scale 1.3 g).
 * 2. Asymmetric Human Biomechanical Limit Envelope (asymmetric egg/ellipse where
 *    forward acceleration limit is +0.92 g, eccentric braking limit is -1.20 g,
 *    and lateral cut limit is ±1.05 g).
 * 3. Crosshair axes for a_lat = 0 and a_t = 0 with labels (+Accel, -Brake,
 *    Left Turn, Right Turn).
 * 4. Distinct P70 Multi-Axis Overlap Quadrants:
 *    - Upper 2 Quadrants (a_t > +P70(|a|) & |a_lat| > P70(|a_lat|)):
 *      Corner-Exit Traction Zone (shaded Emerald/Cyan).
 *    - Lower 2 Quadrants (a_t < -P70(|a|) & |a_lat| > P70(|a_lat|)):
 *      True Trail-Braking Zone (shaded Amber/Rose).
 * 5. Full trajectory scatter and connecting path trace across all frames,
 *    with points color-coded by Sideslip Angle |β|:
 *    - |β| <= 10°: Cyan (#06b6d4 - On Rails)
 *    - 10° < |β| <= 45°: Emerald (#10b981 - Controlled Cut)
 *    - |β| > 45° or snap_oversteer: Red (#ef4444 - High Slip / Instability)
 * 6. Current frame highlight: glowing vector arrow from origin (0, 0) to
 *    (a_lat, a_t) with live corner HUD readout showing G_comb, a_t, a_lat,
 *    total Overlap %, Trail-Brake %, and Exit-Overlap %.
 * ============================================================================
 */

// ============================================================================
// 1. Constants & Theme Configuration
// ============================================================================
const G_CONSTANT = 10.7247;        // 1.0 g = 10.7247 yd/s² (9.80665 m/s²)
const MAX_SCALE_G = 1.3;           // Diagram boundary scale in g
const MIN_ACTIVE_SPEED = 0.5;      // Active motion threshold in yd/s

// Asymmetric Human Biomechanical Limits (in g)
const HUMAN_LIMIT_FWD_G = 0.92;    // Forward concentric acceleration limit
const HUMAN_LIMIT_BRAKE_G = 1.20;  // Eccentric deceleration limit
const HUMAN_LIMIT_LAT_G = 1.05;    // Lateral cutting limit

const THEME = {
  bgPrimary: '#0f172a',      // Slate-900
  bgSecondary: '#1e293b',    // Slate-800
  bgCard: 'rgba(15, 23, 42, 0.94)',
  border: '#334155',
  borderLight: '#475569',
  borderSubtle: 'rgba(51, 65, 85, 0.5)',

  textPrimary: '#f8fafc',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',

  // Player / Telemetry Accents
  playerCyan: '#06b6d4',
  playerCyanGlow: 'rgba(6, 182, 212, 0.6)',
  playerCyanFill: 'rgba(6, 182, 212, 0.15)',

  playerAmber: '#f59e0b',
  playerAmberGlow: 'rgba(245, 158, 11, 0.6)',
  playerAmberFill: 'rgba(245, 158, 11, 0.15)',

  // Overlap Zones
  trailBrakeFill: 'rgba(245, 158, 11, 0.16)',     // Amber/Rose
  trailBrakeBorder: 'rgba(245, 158, 11, 0.55)',
  trailBrakeText: '#f59e0b',

  cornerExitFill: 'rgba(16, 185, 129, 0.14)',     // Emerald
  cornerExitBorder: 'rgba(16, 185, 129, 0.55)',
  cornerExitText: '#10b981',

  // Sideslip States
  slipRails: '#06b6d4',      // |β| <= 10°
  slipCut: '#10b981',        // 10° < |β| <= 45°
  slipInstability: '#ef4444',// |β| > 45° or snap_oversteer

  // Diagram Guides
  ring1g: '#f59e0b',
  ring05g: 'rgba(148, 163, 184, 0.45)',
  outerBoundary: 'rgba(51, 65, 85, 0.75)',
  crosshair: 'rgba(148, 163, 184, 0.6)',
  humanLimit: '#a855f7',     // Purple/Violet dashed egg
  humanLimitFill: 'rgba(168, 85, 247, 0.05)',

  fontSans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontMono: "'JetBrains Mono', 'Fira Code', 'Roboto Mono', monospace"
};

// ============================================================================
// 2. Mathematical Utilities & Base64 Decoder
// ============================================================================

/**
 * Decode Base64 string of contiguous little-endian float32 bytes into Float32Array.
 * Supports both browser window.atob and Node.js Buffer (for headless test suites).
 * @param {string} b64Str
 * @returns {Float32Array}
 */
export function decodeFloat32Base64(b64Str) {
  if (!b64Str || typeof b64Str !== 'string') return new Float32Array(0);
  try {
    if (typeof atob === 'function') {
      const binStr = atob(b64Str);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return new Float32Array(bytes.buffer);
    } else if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(b64Str, 'base64');
      return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    }
  } catch (err) {
    console.warn('Failed to decode Float32Array from base64:', err);
  }
  return new Float32Array(0);
}

/**
 * High-performance Turbo/Magma continuous thermal color generator for KDE Heatmap.
 * @param {number} normVal Normalized density in [0, 1]
 * @returns {string|null} CSS rgba() string or null if below threshold
 */
function getKDEColor(normVal) {
  const t = Math.max(0, Math.min(1, normVal));
  if (t < 0.04) return null;
  let r, g, b, a;
  if (t < 0.30) {
    const u = (t - 0.04) / 0.26;
    r = Math.round(6 + (16 - 6) * u);
    g = Math.round(182 + (185 - 182) * u);
    b = Math.round(212 + (129 - 212) * u);
    a = 0.35 + 0.30 * u;
  } else if (t < 0.65) {
    const u = (t - 0.30) / 0.35;
    r = Math.round(16 + (245 - 16) * u);
    g = Math.round(185 + (158 - 185) * u);
    b = Math.round(129 + (11 - 129) * u);
    a = 0.65 + 0.22 * u;
  } else {
    const u = (t - 0.65) / 0.35;
    r = Math.round(245 + (239 - 245) * u);
    g = Math.round(158 + (68 - 158) * u);
    b = Math.round(11 + (68 - 11) * u);
    a = 0.87 + 0.11 * u;
  }
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
}

/**
 * Compute the p-th percentile of a numeric array with linear interpolation.
 * @param {Array<number>} arr
 * @param {number} p Percentile in [0, 100]
 * @returns {number}
 */
function computePercentile(arr, p) {
  if (!arr || arr.length === 0) return 0.0;
  if (arr.length === 1) return arr[0];
  const sorted = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0.0;
  if (sorted.length === 1) return sorted[0];

  const idx = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.ceil(idx);
  if (i0 === i1) return sorted[i0];
  return sorted[i0] + (idx - i0) * (sorted[i1] - sorted[i0]);
}

/**
 * Classify sideslip angle |β| into telemetry color.
 * @param {number} betaDeg
 * @param {boolean} isSnap
 * @returns {string} HEX color string
 */
function getSlipColor(betaDeg, isSnap = false) {
  const absBeta = Math.abs(betaDeg || 0);
  if (isSnap || absBeta > 45.0) {
    return THEME.slipInstability; // Red
  }
  if (absBeta > 10.0) {
    return THEME.slipCut;         // Emerald
  }
  return THEME.slipRails;         // Cyan
}

// ============================================================================
// 3. GGDiagramCanvas Class
// ============================================================================

export class GGDiagramCanvas {
  /**
   * @param {HTMLCanvasElement|string} canvasElement
   * @param {Object} options
   */
  constructor(canvasElement, options = {}) {
    this.canvas = typeof canvasElement === 'string'
      ? document.getElementById(canvasElement)
      : canvasElement;

    if (!this.canvas) {
      throw new Error('GGDiagramCanvas: Canvas element not found.');
    }

    this.ctx = this.canvas.getContext('2d');
    this.options = {
      maxScaleG: options.maxScaleG || MAX_SCALE_G,
      gConstant: options.gConstant || G_CONSTANT,
      minActiveSpeed: options.minActiveSpeed || MIN_ACTIVE_SPEED,
      showHumanLimit: options.showHumanLimit !== false,
      showHUD: options.showHUD !== false,
      showScatter: options.showScatter !== false,
      showTrail: options.showTrail !== false,
      showLegend: options.showLegend !== false,
      title: options.title || 'ATHLETE FORCE ENVELOPE (G-G)',
      ...options
    };

    // Telemetry state
    this.rawFrames = [];
    this.parsedFrames = [];
    this.metrics = {};
    this.currentFrameIdx = 0;

    // Kinematic Overlap / Trail-Braking metrics
    this.p70_at = 0.0;
    this.p70_alat = 0.0;
    this.overlapPercent = 0.0;
    this.trailBrakePercent = 0.0;
    this.exitOverlapPercent = 0.0;

    // KDE Heatmap & Biomechanical Diagnostic State
    this.displayMode = options.displayMode || 'hybrid'; // 'kde' | 'hybrid' | 'scatter'
    this.cloudScope = options.cloudScope || 'play';     // 'play' | 'season'
    this.binaryCloud = null;
    this.kdeGrid = null;
    this.kdeIsovalues = null;
    this.diagnostics = {
      gSustained: 0.0,
      gMax: 0.0,
      spikeDeltaG: 0.0,
      impulseCouplingMs: 0,
      plantToCutScore: 0,
      coastingPct: 0.0,
      totalFrames: 0
    };

    // Layout metrics
    this.layout = {
      cssWidth: 400,
      cssHeight: 400,
      dpr: 1,
      cx: 200,
      cy: 200,
      maxRadius: 150,
      scaleG: 115.38,
      scaleYds2: 10.76
    };

    // Event listener bindings
    this.handleResize = this.handleResize.bind(this);
    this.handleClick = this.handleClick.bind(this);

    // Setup High-DPI observer & listeners
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.canvas.parentElement);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', this.handleResize);
    }
    this.canvas.addEventListener('click', this.handleClick);

    this.handleResize();
  }

  /**
   * High-DPI Retina buffer scaling & coordinate mapping calculation.
   */
  handleResize() {
    const rect = this.canvas && typeof this.canvas.getBoundingClientRect === 'function'
      ? this.canvas.getBoundingClientRect()
      : { width: 400, height: 400 };
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const cssWidth = Math.max(180, Math.floor(rect.width || this.canvas.clientWidth || 400));
    const cssHeight = Math.max(180, Math.floor(rect.height || this.canvas.clientHeight || 400));

    const bufW = Math.round(cssWidth * dpr);
    const bufH = Math.round(cssHeight * dpr);

    if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
      this.canvas.width = bufW;
      this.canvas.height = bufH;
    }

    const cx = Math.round(cssWidth / 2);
    const cy = Math.round(cssHeight / 2);

    // Reserve margin for outer ring labels, crosshair text (+Accel, -Brake, Left/Right Turn)
    const margin = 38;
    const maxRadius = Math.max(40, Math.min(cx - margin, cy - margin));
    const maxG = this.options.maxScaleG;
    const scaleG = maxRadius / maxG;
    const scaleYds2 = maxRadius / (maxG * this.options.gConstant);

    this.layout = {
      cssWidth,
      cssHeight,
      dpr,
      cx,
      cy,
      maxRadius,
      scaleG,
      scaleYds2
    };

    this.render();
  }

  /**
   * Load telemetry frames (FrameDTO array) and compute kinematics & P70 overlap thresholds.
   * @param {Array<Object>} frames
   * @param {Object} metrics
   */
  setFrames(frames = [], metrics = {}) {
    this.rawFrames = Array.isArray(frames) ? frames : [];
    this.metrics = metrics || {};
    this.parsedFrames = [];

    let prevDir = null;
    let prevTime = null;

    for (let i = 0; i < this.rawFrames.length; i++) {
      const f = this.rawFrames[i];
      if (!f) continue;

      const s = Number.isFinite(f.s) ? f.s : (Number.isFinite(f.speed) ? f.speed : 0.0);
      const a_t = Number.isFinite(f.a) ? f.a : (Number.isFinite(f.a_t) ? f.a_t : 0.0);

      // Extract or compute lateral acceleration a_lat
      let a_lat = 0.0;
      if (f.a_lat != null && Number.isFinite(f.a_lat)) {
        a_lat = f.a_lat;
      } else if (f.omega != null && Number.isFinite(f.omega)) {
        a_lat = s * (f.omega * Math.PI / 180.0);
      } else if (f.dir != null && prevDir != null) {
        let dDir = ((f.dir - prevDir + 540) % 360) - 180;
        const dt = (f.time != null && prevTime != null && f.time > prevTime) ? (f.time - prevTime) : 0.1;
        const omega = dDir / Math.max(0.01, dt);
        a_lat = s * (omega * Math.PI / 180.0);
      } else if (f.curvature != null || f.kappa != null) {
        const k = f.curvature ?? f.kappa ?? 0.0;
        a_lat = s * s * k;
      }

      if (f.dir != null && Number.isFinite(f.dir)) prevDir = f.dir;
      if (f.time != null && Number.isFinite(f.time)) prevTime = f.time;

      const a_comb = Number.isFinite(f.a_comb) ? f.a_comb : Math.hypot(a_t, a_lat);
      const g_comb = Number.isFinite(f.g_comb) ? f.g_comb : (a_comb / this.options.gConstant);

      const beta_slip = f.beta_slip ?? f.slip_angle ?? 0.0;
      const snap_oversteer = Boolean(f.snap_oversteer);

      this.parsedFrames.push({
        frameId: f.frameId ?? i,
        time: f.time ?? i * 0.1,
        s,
        a_t,
        a_lat,
        a_comb,
        g_comb,
        g_lat: a_lat / this.options.gConstant,
        g_t: a_t / this.options.gConstant,
        beta_slip,
        snap_oversteer
      });
    }

    // Active frames filter: speed >= minActiveSpeed (0.5 yd/s)
    const active = this.parsedFrames.filter((pt) => pt.s >= this.options.minActiveSpeed);
    const pool = active.length >= 3 ? active : this.parsedFrames;

    if (pool.length > 0) {
      const absAt = pool.map((pt) => Math.abs(pt.a_t));
      const absAlat = pool.map((pt) => Math.abs(pt.a_lat));
      this.p70_at = computePercentile(absAt, 70);
      this.p70_alat = computePercentile(absAlat, 70);

      // Distinguish the two biomechanical overlap zones:
      // 1. Lower 2 Quadrants: True Trail-Braking (a_t < -P70(|a|) & |a_lat| > P70(|a_lat|))
      const tbCount = pool.filter(
        (pt) => pt.a_t < -this.p70_at && Math.abs(pt.a_lat) > this.p70_alat
      ).length;

      // 2. Upper 2 Quadrants: Corner-Exit Traction (a_t > +P70(|a|) & |a_lat| > P70(|a_lat|))
      const exitCount = pool.filter(
        (pt) => pt.a_t > this.p70_at && Math.abs(pt.a_lat) > this.p70_alat
      ).length;

      const totalOverlap = tbCount + exitCount;
      this.trailBrakePercent = (tbCount / pool.length) * 100;
      this.exitOverlapPercent = (exitCount / pool.length) * 100;
      this.overlapPercent = (totalOverlap / pool.length) * 100;
    } else {
      this.p70_at = 0.0;
      this.p70_alat = 0.0;
      this.trailBrakePercent = 0.0;
      this.exitOverlapPercent = 0.0;
      this.overlapPercent = 0.0;
    }

    // Prioritize metrics.overlap_index / metrics.overlapIndex if explicitly provided
    if (this.metrics.overlap_index != null && Number.isFinite(this.metrics.overlap_index)) {
      this.overlapPercent = this.metrics.overlap_index * 100;
    } else if (this.metrics.overlapIndex != null && Number.isFinite(this.metrics.overlapIndex)) {
      this.overlapPercent = this.metrics.overlapIndex * 100;
    }

    // Recompute single-source-of-truth KDE density grid and diagnostics
    this.recomputeKDE();
    this.computeDiagnostics();

    this.currentFrameIdx = Math.max(0, Math.min(this.parsedFrames.length - 1, this.currentFrameIdx || 0));
    this.render();
  }

  /**
   * Update active frame pointer and re-render.
   * @param {number} frameIndex
   */
  setFrame(frameIndex) {
    if (!Number.isFinite(frameIndex) || this.parsedFrames.length === 0) return;
    this.currentFrameIdx = Math.max(0, Math.min(this.parsedFrames.length - 1, Math.round(frameIndex)));
    this.render();
  }

  /**
   * Alias for setFrame.
   */
  setFrameIndex(frameIndex) {
    this.setFrame(frameIndex);
  }

  /**
   * Click event to pick closest frame to clicked coordinate.
   */
  handleClick(e) {
    if (!this.parsedFrames || this.parsedFrames.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const { cx, cy, scaleYds2 } = this.layout;
    let closestIdx = 0;
    let minSqDist = Infinity;

    for (let i = 0; i < this.parsedFrames.length; i++) {
      const pt = this.parsedFrames[i];
      const px = cx + pt.a_lat * scaleYds2;
      const py = cy - pt.a_t * scaleYds2;
      const sqDist = (px - clickX) ** 2 + (py - clickY) ** 2;
      if (sqDist < minSqDist) {
        minSqDist = sqDist;
        closestIdx = i;
      }
    }

    if (minSqDist <= 400) { // within 20px radius
      this.setFrame(closestIdx);
      if (typeof this.options.onFrameSelect === 'function') {
        this.options.onFrameSelect(closestIdx, this.parsedFrames[closestIdx]);
      }
    }
  }

  /**
   * Load season-wide or multi-game binary G-G telemetry cloud.
   * Decodes Base64 Float32Array buffers and triggers KDE calculation.
   * @param {Object} cloudData
   */
  setBinaryCloud(cloudData) {
    if (!cloudData) {
      this.binaryCloud = null;
      this.recomputeKDE();
      this.computeDiagnostics();
      this.render();
      return;
    }
    const g_lat = decodeFloat32Base64(cloudData.b64_g_lat);
    const g_t = decodeFloat32Base64(cloudData.b64_g_t);
    const s = decodeFloat32Base64(cloudData.b64_s);
    const beta = decodeFloat32Base64(cloudData.b64_beta);
    this.binaryCloud = {
      nfl_id: cloudData.nfl_id,
      scope: cloudData.scope || 'season',
      count: cloudData.count || g_lat.length,
      g_lat,
      g_t,
      s,
      beta,
      bounds: cloudData.bounds || {}
    };
    this.cloudScope = 'season';
    this.recomputeKDE();
    this.computeDiagnostics();
    this.render();
  }

  /**
   * Set visualization display mode ('kde' | 'hybrid' | 'scatter').
   * @param {'kde' | 'hybrid' | 'scatter'} mode
   */
  setDisplayMode(mode) {
    if (['kde', 'hybrid', 'scatter'].includes(mode)) {
      this.displayMode = mode;
      this.render();
    }
  }

  /**
   * Toggle between current play/drill frames vs whole season telemetry cloud.
   * @param {'play' | 'season'} scope
   */
  setCloudScope(scope) {
    if (['play', 'season'].includes(scope)) {
      this.cloudScope = scope;
      this.recomputeKDE();
      this.computeDiagnostics();
      this.render();
    }
  }

  /**
   * Retrieve single-source-of-truth biomechanical diagnostics.
   * @returns {Object}
   */
  getDiagnostics() {
    return { ...this.diagnostics };
  }

  /**
   * Recompute 84x84 separable 2D Gaussian KDE density grid and contour isovalues.
   */
  recomputeKDE() {
    const N = 84;
    const Xmin = -1.4;
    const Ymin = -1.4;
    const delta = 2.8 / N;

    let g_lat_arr = null;
    let g_t_arr = null;
    let count = 0;

    if (this.cloudScope === 'season' && this.binaryCloud && this.binaryCloud.count > 0) {
      g_lat_arr = this.binaryCloud.g_lat;
      g_t_arr = this.binaryCloud.g_t;
      count = this.binaryCloud.count;
    } else if (this.parsedFrames && this.parsedFrames.length > 0) {
      // Combined dynamic energy gate for play frames: (s > 0.3) | (g_comb >= 0.12)
      const gated = this.parsedFrames.filter((f) => (f.s > 0.3) || (f.g_comb >= 0.12));
      const pool = gated.length >= 3 ? gated : this.parsedFrames;
      count = pool.length;
      g_lat_arr = new Float32Array(count);
      g_t_arr = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        g_lat_arr[i] = pool[i].g_lat;
        g_t_arr[i] = pool[i].g_t;
      }
    }

    if (!g_lat_arr || count === 0) {
      this.kdeGrid = null;
      this.kdeIsovalues = null;
      return;
    }

    // 1. 2D Histogram binning (O(N))
    const hist = new Float32Array(N * N);
    for (let i = 0; i < count; i++) {
      const gx = g_lat_arr[i];
      const gy = g_t_arr[i];
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
      const c = Math.floor((gx - Xmin) / delta);
      const r = Math.floor((gy - Ymin) / delta);
      if (c >= 0 && c < N && r >= 0 && r < N) {
        hist[r * N + c] += 1.0;
      }
    }

    // 2. Separable 1D Gaussian smoothing
    // Bandwidth h ≈ 0.10 g -> sigma ≈ 3.0 grid cells, radius R = 9 cells
    const sigma = 3.0;
    const radius = 9;
    const kernel = new Float32Array(2 * radius + 1);
    let kSum = 0;
    for (let k = -radius; k <= radius; k++) {
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      kernel[k + radius] = w;
      kSum += w;
    }
    for (let i = 0; i < kernel.length; i++) {
      kernel[i] /= kSum;
    }

    // Horizontal 1D pass
    const temp = new Float32Array(N * N);
    for (let r = 0; r < N; r++) {
      const rowOffset = r * N;
      for (let c = 0; c < N; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sc = Math.max(0, Math.min(N - 1, c + k));
          acc += hist[rowOffset + sc] * kernel[k + radius];
        }
        temp[rowOffset + c] = acc;
      }
    }

    // Vertical 1D pass
    const density = new Float32Array(N * N);
    let maxDensity = 0.0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sr = Math.max(0, Math.min(N - 1, r + k));
          acc += temp[sr * N + c] * kernel[k + radius];
        }
        density[r * N + c] = acc;
        if (acc > maxDensity) maxDensity = acc;
      }
    }

    // 3. Normalize into 2D [84][84] array Z[r][c] in [0, 1]
    const Z = [];
    const nonZeroVals = [];
    for (let r = 0; r < N; r++) {
      const row = new Float32Array(N);
      for (let c = 0; c < N; c++) {
        const norm = maxDensity > 0 ? density[r * N + c] / maxDensity : 0.0;
        row[c] = norm;
        if (norm > 0.04) nonZeroVals.push(norm);
      }
      Z.push(row);
    }

    // 4. Calculate contour isovalues: p50 (outer envelope), p75 (ridge), p90 (core)
    let p50 = 0.25;
    let p75 = 0.55;
    let p90 = 0.80;
    if (nonZeroVals.length >= 10) {
      nonZeroVals.sort((a, b) => a - b);
      p50 = computePercentile(nonZeroVals, 50);
      p75 = computePercentile(nonZeroVals, 75);
      p90 = computePercentile(nonZeroVals, 90);
    }

    this.kdeGrid = { N, Xmin, Ymin, delta, Z, maxDensity };
    this.kdeIsovalues = { p50, p75, p90 };
  }

  /**
   * Compute single-source-of-truth biomechanical diagnostics.
   */
  computeDiagnostics() {
    let g_lat_arr = null;
    let g_t_arr = null;
    let s_arr = null;
    let count = 0;

    if (this.cloudScope === 'season' && this.binaryCloud && this.binaryCloud.count > 0) {
      g_lat_arr = this.binaryCloud.g_lat;
      g_t_arr = this.binaryCloud.g_t;
      s_arr = this.binaryCloud.s;
      count = this.binaryCloud.count;
    } else if (this.parsedFrames && this.parsedFrames.length > 0) {
      count = this.parsedFrames.length;
      g_lat_arr = new Float32Array(count);
      g_t_arr = new Float32Array(count);
      s_arr = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        g_lat_arr[i] = this.parsedFrames[i].g_lat;
        g_t_arr[i] = this.parsedFrames[i].g_t;
        s_arr[i] = this.parsedFrames[i].s;
      }
    }

    if (!g_lat_arr || count === 0) {
      this.diagnostics = {
        gSustained: 0.0,
        gMax: 0.0,
        spikeDeltaG: 0.0,
        impulseCouplingMs: 0,
        plantToCutScore: 0,
        coastingPct: 0.0,
        totalFrames: 0
      };
      return;
    }

    // 1. G_sustained vs G_max & Spike Delta
    const activeGComb = [];
    let gMax = 0.0;
    for (let i = 0; i < count; i++) {
      const glat = g_lat_arr[i];
      const gt = g_t_arr[i];
      const gcomb = Math.hypot(glat, gt);
      if (gcomb > gMax) gMax = gcomb;
      if (gcomb >= 0.12) {
        activeGComb.push(gcomb);
      }
    }

    const gSustained = activeGComb.length >= 5 ? computePercentile(activeGComb, 95) : gMax * 0.85;
    const spikeDeltaG = Math.max(0.0, gMax - gSustained);

    // 2. Impulse Coupling (Delta t between braking plant node and lateral/propulsive cut)
    const impulseDeltas = [];
    let lastPlantIdx = -1;
    for (let i = 0; i < count; i++) {
      const gt = g_t_arr[i];
      const glat = Math.abs(g_lat_arr[i]);

      // Plant frame: sharp eccentric deceleration
      if (gt < -0.25 && lastPlantIdx < 0) {
        lastPlantIdx = i;
      } else if (lastPlantIdx >= 0) {
        // Look for cut / propulsive impulse within 10 frames (1.0 s)
        const frameDiff = i - lastPlantIdx;
        if (glat >= 0.35 || gt > 0.20) {
          impulseDeltas.push(frameDiff * 100); // 100 ms per frame
          lastPlantIdx = -1;
        } else if (frameDiff > 10) {
          lastPlantIdx = -1; // timed out
        }
      }
    }

    let avgImpulseMs = 180;
    if (impulseDeltas.length > 0) {
      const sum = impulseDeltas.reduce((a, b) => a + b, 0);
      avgImpulseMs = Math.round(sum / impulseDeltas.length);
    }
    const plantToCutScore = Math.max(0, Math.min(100, Math.round(100 - (avgImpulseMs - 150) * 0.2)));

    // 3. In-Motion Coasting % (speed >= 1.5 yd/s, but G_comb < 0.15 g)
    let inMotionCount = 0;
    let coastingCount = 0;
    for (let i = 0; i < count; i++) {
      const spd = s_arr[i];
      if (spd >= 1.5) {
        inMotionCount++;
        const gcomb = Math.hypot(g_lat_arr[i], g_t_arr[i]);
        if (gcomb < 0.15) {
          coastingCount++;
        }
      }
    }
    const coastingPct = inMotionCount > 0 ? (coastingCount / inMotionCount) * 100 : 0.0;

    this.diagnostics = {
      gSustained: Math.round(gSustained * 100) / 100,
      gMax: Math.round(gMax * 100) / 100,
      spikeDeltaG: Math.round(spikeDeltaG * 100) / 100,
      impulseCouplingMs: avgImpulseMs,
      plantToCutScore,
      coastingPct: Math.round(coastingPct * 10) / 10,
      totalFrames: count
    };
  }

  // ==========================================================================
  // RENDER PIPELINE
  // ==========================================================================

  render() {
    const { ctx } = this;
    const { cssWidth, cssHeight, dpr, cx, cy, maxRadius, scaleG, scaleYds2 } = this.layout;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // 1. Deep slate background
    ctx.fillStyle = THEME.bgPrimary;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // 2. Kamm Friction Circle Concentric Rings (0.5g, 1.0g, 1.3g)
    this.renderKammRings(cx, cy, scaleG, maxRadius);

    // 3. Asymmetric Human Biomechanical Limit Envelope
    if (this.options.showHumanLimit) {
      this.renderHumanBiomechanicalEnvelope(cx, cy, scaleG);
    }

    // 4. Shaded Overlap / Trail-Braking Quadrants (P70 Thresholds)
    this.renderOverlapQuadrants(cx, cy, scaleYds2, maxRadius);

    // 4b. 2D KDE Thermal Heatmap & Topographic Contours (Single Source of Truth)
    if (this.displayMode === 'kde' || this.displayMode === 'hybrid') {
      this.renderKDEHeatmap(cx, cy, scaleG);
      this.renderKDEContours(cx, cy, scaleG);
    }

    // 5. Crosshair Axes with Directional Labels (+Accel, -Brake, Left/Right Turn)
    this.renderCrosshairAxes(cx, cy, maxRadius);

    // 6. Trajectory Scatter & Path Trace
    if (this.cloudScope === 'play' && this.parsedFrames.length > 0) {
      if (this.options.showTrail && (this.displayMode === 'scatter' || this.displayMode === 'hybrid')) {
        this.renderTrajectoryTrail(cx, cy, scaleYds2);
      }
      if (this.options.showScatter && (this.displayMode === 'scatter' || this.displayMode === 'hybrid')) {
        this.renderScatterPoints(cx, cy, scaleYds2);
      }

      // 7. Current Frame Glowing Vector Arrow & Live Marker
      this.renderCurrentFrameVector(cx, cy, scaleYds2);
    } else if (this.cloudScope === 'season' && this.binaryCloud && this.binaryCloud.count > 0) {
      if (this.displayMode === 'scatter' || this.displayMode === 'hybrid') {
        this.renderCloudScatter(cx, cy, scaleG);
      }
    } else if (this.parsedFrames.length === 0 && !this.binaryCloud) {
      this.renderEmptyNotice(cx, cy);
    }

    // 8. Live Corner HUD Readout
    if (this.options.showHUD) {
      this.renderCornerHUD();
    }

    // 9. Legend & Title Badges
    this.renderTitleAndLegend(cssWidth, cssHeight);

    ctx.restore();
  }

  /**
   * Render 2D continuous KDE thermal heatmap.
   */
  renderKDEHeatmap(cx, cy, scaleG) {
    if (!this.kdeGrid || !this.kdeGrid.Z) return;
    const { ctx } = this;
    const { N, Xmin, Ymin, delta, Z } = this.kdeGrid;
    const { maxRadius } = this.layout;

    ctx.save();
    // Clip strictly within Kamm friction circle boundary
    ctx.beginPath();
    ctx.arc(cx, cy, maxRadius, 0, Math.PI * 2);
    ctx.clip();

    const cw = delta * scaleG;
    const ch = delta * scaleG;

    for (let r = 0; r < N; r++) {
      // Y math: gy is positive up, canvas Y is positive down
      const gy = Ymin + (r + 1) * delta;
      const py = cy - gy * scaleG;
      const row = Z[r];
      for (let c = 0; c < N; c++) {
        const val = row[c];
        if (val < 0.04) continue;
        const color = getKDEColor(val);
        if (!color) continue;
        const gx = Xmin + c * delta;
        const px = cx + gx * scaleG;
        ctx.fillStyle = color;
        ctx.fillRect(px, py, cw + 0.6, ch + 0.6);
      }
    }
    ctx.restore();
  }

  /**
   * Render Marching Squares topographic contours for 50%, 75%, 90% density levels.
   */
  renderKDEContours(cx, cy, scaleG) {
    if (!this.kdeGrid || !this.kdeIsovalues) return;
    const { ctx } = this;
    const { N, Xmin, Ymin, delta, Z } = this.kdeGrid;
    const { p50, p75, p90 } = this.kdeIsovalues;
    const { maxRadius } = this.layout;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, maxRadius, 0, Math.PI * 2);
    ctx.clip();

    const levels = [
      { val: p50, color: '#06b6d4', width: 1.2, dash: [3, 3] }, // 50% outer envelope (Cyan)
      { val: p75, color: '#f59e0b', width: 1.5, dash: [] },       // 75% active ridge (Amber)
      { val: p90, color: '#ef4444', width: 2.0, dash: [] },       // 90% core plant/cut nodes (Red)
    ];

    for (const lvl of levels) {
      const L = lvl.val;
      if (!L || L <= 0.04) continue;

      ctx.strokeStyle = lvl.color;
      ctx.lineWidth = lvl.width;
      ctx.setLineDash(lvl.dash);
      ctx.beginPath();

      for (let r = 0; r < N - 1; r++) {
        const y0 = Ymin + (r + 0.5) * delta;
        const y1 = y0 + delta;
        for (let c = 0; c < N - 1; c++) {
          const x0 = Xmin + (c + 0.5) * delta;
          const x1 = x0 + delta;

          const v0 = Z[r][c];
          const v1 = Z[r][c + 1];
          const v2 = Z[r + 1][c + 1];
          const v3 = Z[r + 1][c];

          const caseIdx =
            (v0 >= L ? 8 : 0) |
            (v1 >= L ? 4 : 0) |
            (v2 >= L ? 2 : 0) |
            (v3 >= L ? 1 : 0);

          if (caseIdx === 0 || caseIdx === 15) continue;

          // Edge interpolations
          const interp = (va, vb) => Math.abs(vb - va) > 1e-6 ? (L - va) / (vb - va) : 0.5;
          const pT = { x: x0 + interp(v0, v1) * delta, y: y0 };
          const pR = { x: x1, y: y0 + interp(v1, v2) * delta };
          const pB = { x: x0 + interp(v3, v2) * delta, y: y1 };
          const pL = { x: x0, y: y0 + interp(v0, v3) * delta };

          const toPx = (pt) => ({ x: cx + pt.x * scaleG, y: cy - pt.y * scaleG });

          const drawSeg = (a, b) => {
            const pa = toPx(a);
            const pb = toPx(b);
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
          };

          switch (caseIdx) {
            case 1: drawSeg(pL, pB); break;
            case 2: drawSeg(pB, pR); break;
            case 3: drawSeg(pL, pR); break;
            case 4: drawSeg(pT, pR); break;
            case 5: drawSeg(pL, pT); drawSeg(pB, pR); break;
            case 6: drawSeg(pT, pB); break;
            case 7: drawSeg(pL, pT); break;
            case 8: drawSeg(pL, pT); break;
            case 9: drawSeg(pT, pB); break;
            case 10: drawSeg(pT, pR); drawSeg(pL, pB); break;
            case 11: drawSeg(pT, pR); break;
            case 12: drawSeg(pL, pR); break;
            case 13: drawSeg(pB, pR); break;
            case 14: drawSeg(pL, pB); break;
          }
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Render subsampled scatter points for season/game binary cloud.
   */
  renderCloudScatter(cx, cy, scaleG) {
    if (!this.binaryCloud || !this.binaryCloud.g_lat) return;
    const { ctx } = this;
    const { g_lat, g_t, beta, count } = this.binaryCloud;
    const step = Math.max(1, Math.floor(count / 1200));

    ctx.save();
    for (let i = 0; i < count; i += step) {
      const glat = g_lat[i];
      const gt = g_t[i];
      const px = cx + glat * scaleG;
      const py = cy - gt * scaleG;
      const col = getSlipColor(beta ? beta[i] : 0.0);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Concentric Kamm Friction Circle reference rings (0.5 g, 1.0 g, 1.3 g).
   */
  renderKammRings(cx, cy, scaleG, maxRadius) {
    const { ctx } = this;

    // 0.5 g ring (dashed slate)
    const r05 = 0.5 * scaleG;
    ctx.save();
    ctx.strokeStyle = THEME.ring05g;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, r05, 0, Math.PI * 2);
    ctx.stroke();

    // 0.5 g label
    ctx.setLineDash([]);
    ctx.fillStyle = THEME.textMuted;
    ctx.font = `500 9px ${THEME.fontMono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('0.5g', cx + r05 * 0.707 + 2, cy - r05 * 0.707 - 2);

    // 1.0 g ring (dashed amber - F1 / biomechanical friction limit)
    const r10 = 1.0 * scaleG;
    ctx.strokeStyle = THEME.ring1g;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, r10, 0, Math.PI * 2);
    ctx.stroke();

    // 1.0 g label
    ctx.setLineDash([]);
    ctx.fillStyle = THEME.ring1g;
    ctx.font = `600 9px ${THEME.fontMono}`;
    ctx.fillText('1.0g Limit', cx + r10 * 0.707 + 3, cy - r10 * 0.707 - 3);

    // 1.3 g diagram outer boundary circle
    ctx.strokeStyle = THEME.outerBoundary;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, maxRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = THEME.textMuted;
    ctx.font = `500 8px ${THEME.fontMono}`;
    ctx.fillText('1.3g Max', cx + maxRadius * 0.707 + 2, cy - maxRadius * 0.707 - 2);

    ctx.restore();
  }

  /**
   * Asymmetric Human Biomechanical Limit Envelope (Critique B):
   * Forward acceleration limit: +0.92 g
   * Eccentric braking deceleration limit: -1.20 g
   * Lateral cut limit: ±1.05 g
   */
  renderHumanBiomechanicalEnvelope(cx, cy, scaleG) {
    const { ctx } = this;

    ctx.save();
    ctx.strokeStyle = THEME.humanLimit;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = THEME.humanLimitFill;

    ctx.beginPath();
    const steps = 90;
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const gx = HUMAN_LIMIT_LAT_G * cosT;
      // In math: positive is forward accel (up). In canvas: up is negative Y.
      const gy = sinT >= 0 ? HUMAN_LIMIT_FWD_G * sinT : HUMAN_LIMIT_BRAKE_G * sinT;

      const px = cx + gx * scaleG;
      const py = cy - gy * scaleG;

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // Envelope badge tag in bottom-left perimeter
    ctx.fillStyle = THEME.humanLimit;
    ctx.font = `600 8px ${THEME.fontMono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const tagX = cx - HUMAN_LIMIT_LAT_G * scaleG * 0.72;
    const tagY = cy + HUMAN_LIMIT_BRAKE_G * scaleG * 0.72 + 2;
    ctx.fillText('Human Bio-Limit', tagX, tagY);

    ctx.restore();
  }

  /**
   * Shaded Overlap Quadrants based on P70 thresholds:
   * Upper 2 Quadrants: Corner-Exit Traction Zone (Emerald/Cyan)
   * Lower 2 Quadrants: True Trail-Braking Zone (Amber/Rose)
   */
  renderOverlapQuadrants(cx, cy, scaleYds2, maxRadius) {
    if (this.p70_at <= 0.05 || this.p70_alat <= 0.05) return;

    const { ctx } = this;
    const xThresh = this.p70_alat * scaleYds2;
    const yThresh = this.p70_at * scaleYds2;

    if (xThresh >= maxRadius || yThresh >= maxRadius) return;

    ctx.save();
    // Clip strictly within the 1.3g friction circle boundary
    ctx.beginPath();
    ctx.arc(cx, cy, maxRadius, 0, Math.PI * 2);
    ctx.clip();

    // ------------------------------------------------------------------------
    // 1. Upper 2 Quadrants: Corner-Exit Traction Zone (+a_t > P70, |a_lat| > P70)
    // ------------------------------------------------------------------------
    ctx.fillStyle = THEME.cornerExitFill;
    // Top-Right: +a_lat, +a_t (up and right)
    ctx.fillRect(cx + xThresh, cy - maxRadius, maxRadius - xThresh, maxRadius - yThresh);
    // Top-Left: -a_lat, +a_t (up and left)
    ctx.fillRect(cx - maxRadius, cy - maxRadius, maxRadius - xThresh, maxRadius - yThresh);

    // ------------------------------------------------------------------------
    // 2. Lower 2 Quadrants: True Trail-Braking Zone (-a_t < -P70, |a_lat| > P70)
    // ------------------------------------------------------------------------
    ctx.fillStyle = THEME.trailBrakeFill;
    // Bottom-Right: +a_lat, -a_t (down and right)
    ctx.fillRect(cx + xThresh, cy + yThresh, maxRadius - xThresh, maxRadius - yThresh);
    // Bottom-Left: -a_lat, -a_t (down and left)
    ctx.fillRect(cx - maxRadius, cy + yThresh, maxRadius - xThresh, maxRadius - yThresh);

    // Dashed quadrant threshold dividing lines
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);

    // Top thresholds (Emerald)
    ctx.strokeStyle = THEME.cornerExitBorder;
    ctx.beginPath();
    ctx.moveTo(cx - maxRadius, cy - yThresh);
    ctx.lineTo(cx - xThresh, cy - yThresh);
    ctx.moveTo(cx + xThresh, cy - yThresh);
    ctx.lineTo(cx + maxRadius, cy - yThresh);
    ctx.stroke();

    // Bottom thresholds (Amber)
    ctx.strokeStyle = THEME.trailBrakeBorder;
    ctx.beginPath();
    ctx.moveTo(cx - maxRadius, cy + yThresh);
    ctx.lineTo(cx - xThresh, cy + yThresh);
    ctx.moveTo(cx + xThresh, cy + yThresh);
    ctx.lineTo(cx + maxRadius, cy + yThresh);
    ctx.stroke();

    // Vertical lateral thresholds
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.beginPath();
    // +a_lat boundary
    ctx.moveTo(cx + xThresh, cy - maxRadius);
    ctx.lineTo(cx + xThresh, cy - yThresh);
    ctx.moveTo(cx + xThresh, cy + yThresh);
    ctx.lineTo(cx + xThresh, cy + maxRadius);
    // -a_lat boundary
    ctx.moveTo(cx - xThresh, cy - maxRadius);
    ctx.lineTo(cx - xThresh, cy - yThresh);
    ctx.moveTo(cx - xThresh, cy + yThresh);
    ctx.lineTo(cx - xThresh, cy + maxRadius);
    ctx.stroke();

    ctx.setLineDash([]);

    // Quadrant Corner Badges
    ctx.font = `700 8px ${THEME.fontMono}`;

    // Burst Exit tags (top corners)
    ctx.fillStyle = THEME.cornerExitText;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('BURST EXIT', cx + maxRadius * 0.90, cy - maxRadius * 0.90);
    ctx.textAlign = 'left';
    ctx.fillText('BURST EXIT', cx - maxRadius * 0.90, cy - maxRadius * 0.90);

    // Cut Plant tags (bottom corners)
    ctx.fillStyle = THEME.trailBrakeText;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('CUT PLANT', cx + maxRadius * 0.90, cy + maxRadius * 0.90);
    ctx.textAlign = 'left';
    ctx.fillText('CUT PLANT', cx - maxRadius * 0.90, cy + maxRadius * 0.90);

    ctx.restore();
  }

  /**
   * Crosshair axes for a_lat = 0 and a_t = 0 with labels.
   */
  renderCrosshairAxes(cx, cy, maxRadius) {
    const { ctx } = this;

    ctx.save();
    ctx.strokeStyle = THEME.crosshair;
    ctx.lineWidth = 1;

    // Horizontal Axis (a_t = 0)
    ctx.beginPath();
    ctx.moveTo(cx - maxRadius - 10, cy);
    ctx.lineTo(cx + maxRadius + 10, cy);
    ctx.stroke();

    // Vertical Axis (a_lat = 0)
    ctx.beginPath();
    ctx.moveTo(cx, cy - maxRadius - 10);
    ctx.lineTo(cx, cy + maxRadius + 10);
    ctx.stroke();

    // Crosshair Labels
    ctx.font = `600 10px ${THEME.fontSans}`;

    // Top: +Accel
    ctx.fillStyle = THEME.textPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('▲ +Accel', cx, cy - maxRadius - 12);

    // Bottom: -Brake
    ctx.textBaseline = 'top';
    ctx.fillText('▼ -Brake', cx, cy + maxRadius + 12);

    // Left: Left Turn
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('◀ Left Turn', cx - maxRadius - 12, cy);

    // Right: Right Turn
    ctx.textAlign = 'left';
    ctx.fillText('Right Turn ▶', cx + maxRadius + 12, cy);

    ctx.restore();
  }

  /**
   * Continuous sequential trajectory connecting trail line.
   */
  renderTrajectoryTrail(cx, cy, scaleYds2) {
    const { ctx } = this;
    if (this.parsedFrames.length < 2) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.28)'; // Subtle Cyan path
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();

    for (let i = 0; i < this.parsedFrames.length; i++) {
      const pt = this.parsedFrames[i];
      const px = cx + pt.a_lat * scaleYds2;
      const py = cy - pt.a_t * scaleYds2;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Full trajectory scatter points, color-coded by Sideslip Angle |β|.
   */
  renderScatterPoints(cx, cy, scaleYds2) {
    const { ctx } = this;
    const currIdx = this.currentFrameIdx;

    ctx.save();
    for (let i = 0; i < this.parsedFrames.length; i++) {
      const pt = this.parsedFrames[i];
      const px = cx + pt.a_lat * scaleYds2;
      const py = cy - pt.a_t * scaleYds2;

      const col = getSlipColor(pt.beta_slip, pt.snap_oversteer);
      const isCurrent = (i === currIdx);
      const isPast = (i <= currIdx);

      // Distinguish current/past vs future frame opacity
      ctx.globalAlpha = isCurrent ? 1.0 : (isPast ? 0.85 : 0.40);
      ctx.fillStyle = col;

      const isOverlap = Math.abs(pt.a_t) > this.p70_at && Math.abs(pt.a_lat) > this.p70_alat && pt.s >= 0.5;
      const radius = isOverlap ? 3.0 : 2.0;

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();

      // Overlap highlight ring
      if (isOverlap && isPast) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Glowing vector arrow from origin (0, 0) to current frame's (a_lat, a_t).
   */
  renderCurrentFrameVector(cx, cy, scaleYds2) {
    const { ctx } = this;
    const curr = this.parsedFrames[this.currentFrameIdx];
    if (!curr) return;

    const px = cx + curr.a_lat * scaleYds2;
    const py = cy - curr.a_t * scaleYds2;
    const vLen = Math.hypot(px - cx, py - cy);

    ctx.save();

    // 1. Concentric magnitude circle / guide showing live G_comb
    if (vLen > 4) {
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, vLen, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 2. Glowing vector line from origin
    ctx.strokeStyle = THEME.playerCyan;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = THEME.playerCyanGlow;
    ctx.shadowBlur = 8;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(px, py);
    ctx.stroke();

    // 3. Vector Arrowhead
    if (vLen > 8) {
      const angle = Math.atan2(py - cy, px - cx);
      const headLen = 8;
      ctx.fillStyle = THEME.playerCyan;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(
        px - headLen * Math.cos(angle - Math.PI / 6),
        py - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        px - headLen * Math.cos(angle + Math.PI / 6),
        py - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    }

    // 4. Glowing target dot at (px, py)
    const slipCol = getSlipColor(curr.beta_slip, curr.snap_oversteer);
    ctx.shadowBlur = 12;
    ctx.shadowColor = slipCol;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = slipCol;
    ctx.lineWidth = 2.5;

    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 5. Center origin marker
    ctx.fillStyle = '#38bdf8';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Corner HUD Readout showing live kinematics (play mode) or aggregate KDE diagnostics (cloud mode).
   */
  renderCornerHUD() {
    const { ctx } = this;
    const curr = this.parsedFrames[this.currentFrameIdx];
    const isCloud = (this.cloudScope === 'season');

    const hudX = 12;
    const hudY = 12;
    const hudW = 184;
    const hudH = 104;

    const gCombTxt = isCloud
      ? `${this.diagnostics.gSustained.toFixed(2)}g / ${this.diagnostics.gMax.toFixed(2)}g`
      : (curr ? `${curr.g_comb.toFixed(2)} g` : '0.00 g');

    const atTxt = isCloud
      ? `ΔG: ${this.diagnostics.spikeDeltaG.toFixed(2)} g`
      : (curr ? `${curr.a_t >= 0 ? '+' : ''}${curr.a_t.toFixed(1)} yd/s²` : '0.0 yd/s²');

    const alatTxt = isCloud
      ? `${this.diagnostics.impulseCouplingMs} ms (${this.diagnostics.plantToCutScore}/100)`
      : (curr ? `${curr.a_lat >= 0 ? '+' : ''}${curr.a_lat.toFixed(1)} yd/s²` : '0.0 yd/s²');

    const olTxt = isCloud
      ? `${this.diagnostics.coastingPct.toFixed(1)}%`
      : `${(this.overlapPercent || 0).toFixed(1)}%`;

    ctx.save();

    // Glassmorphic background card
    ctx.fillStyle = THEME.bgCard;
    ctx.strokeStyle = THEME.borderLight;
    ctx.lineWidth = 1;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.roundRect(hudX, hudY, hudW, hudH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.font = `600 10px ${THEME.fontMono}`;
    ctx.textBaseline = 'middle';

    // Row 1: G_comb / G_sust
    ctx.textAlign = 'left';
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText(isCloud ? 'G_sust / G_max:' : 'G_comb:', hudX + 8, hudY + 16);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#38bdf8'; // bright cyan
    ctx.fillText(gCombTxt, hudX + hudW - 8, hudY + 16);

    // Row 2: a_t / Spike Delta
    ctx.textAlign = 'left';
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText(isCloud ? 'Spike Delta:' : 'a_t:', hudX + 8, hudY + 34);
    ctx.textAlign = 'right';
    ctx.fillStyle = isCloud && this.diagnostics.spikeDeltaG > 0.35 ? '#ef4444' : THEME.textPrimary;
    ctx.fillText(atTxt, hudX + hudW - 8, hudY + 34);

    // Row 3: a_lat / Impulse Coupling
    ctx.textAlign = 'left';
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText(isCloud ? 'Impulse Cut:' : 'a_lat:', hudX + 8, hudY + 52);
    ctx.textAlign = 'right';
    ctx.fillStyle = isCloud ? THEME.trailBrakeText : THEME.textPrimary;
    ctx.fillText(alatTxt, hudX + hudW - 8, hudY + 52);

    // Row 4: Total Overlap / Coasting %
    ctx.textAlign = 'left';
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText(isCloud ? 'Coasting %:' : 'Overlap:', hudX + 8, hudY + 70);
    ctx.textAlign = 'right';
    ctx.fillStyle = isCloud ? THEME.cornerExitText : THEME.trailBrakeText;
    ctx.fillText(olTxt, hudX + hudW - 8, hudY + 70);

    // Row 5: Split Zones / Cloud Scope details
    ctx.font = `500 9px ${THEME.fontMono}`;
    ctx.textAlign = 'left';
    if (isCloud) {
      ctx.fillStyle = THEME.textSecondary;
      ctx.fillText(`Frames: ${this.diagnostics.totalFrames.toLocaleString()}`, hudX + 8, hudY + 88);
      ctx.textAlign = 'right';
      ctx.fillStyle = THEME.playerCyan;
      ctx.fillText(`Mode: ${this.displayMode.toUpperCase()}`, hudX + hudW - 8, hudY + 88);
    } else {
      ctx.fillStyle = THEME.trailBrakeText;
      ctx.fillText(`TB: ${(this.trailBrakePercent || 0).toFixed(0)}%`, hudX + 8, hudY + 88);
      ctx.textAlign = 'right';
      ctx.fillStyle = THEME.cornerExitText;
      ctx.fillText(`Exit: ${(this.exitOverlapPercent || 0).toFixed(0)}%`, hudX + hudW - 8, hudY + 88);
    }

    ctx.restore();
  }

  /**
   * Title badge and Sideslip color legend.
   */
  renderTitleAndLegend(cssWidth, cssHeight) {
    const { ctx } = this;

    ctx.save();

    // Top-Right Title Badge
    ctx.font = `700 11px ${THEME.fontSans}`;
    ctx.fillStyle = THEME.textPrimary;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(this.options.title, cssWidth - 12, 12);

    ctx.font = `500 9px ${THEME.fontMono}`;
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText('Lateral (X) vs Longitudinal (Y) [g]', cssWidth - 12, 26);

    // Bottom Legend: Sideslip Angle Classification
    if (this.options.showLegend) {
      const legY = cssHeight - 16;
      ctx.font = `500 9px ${THEME.fontSans}`;
      ctx.textBaseline = 'middle';

      let legX = 12;
      const drawLegendItem = (color, text) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(legX + 4, legY, 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = THEME.textSecondary;
        ctx.textAlign = 'left';
        ctx.fillText(text, legX + 11, legY);
        legX += ctx.measureText(text).width + 19;
      };

      drawLegendItem(THEME.slipRails, '≤10° Rails');
      drawLegendItem(THEME.slipCut, '10-45° Cut');
      drawLegendItem(THEME.slipInstability, '>45° Slip');
    }

    ctx.restore();
  }

  renderEmptyNotice(cx, cy) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = THEME.textMuted;
    ctx.font = `500 12px ${THEME.fontSans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Awaiting telemetry frames...', cx, cy);
    ctx.restore();
  }

  /**
   * Cleanup listeners on destroy.
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', this.handleResize);
    }
    if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('click', this.handleClick);
    }
    this.parsedFrames = [];
    this.rawFrames = [];
  }
}

// Window attachment for standalone script tags
if (typeof window !== 'undefined') {
  window.GGDiagramCanvas = GGDiagramCanvas;
}
