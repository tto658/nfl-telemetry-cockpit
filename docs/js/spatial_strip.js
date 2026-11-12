/**
 * ============================================================================
 * spatial_strip.js - Curvilinear Kinematics & Spatial Telemetry Canvas Engine
 * NFL Motion Tracking & Formula 1-Style Telemetry Comparison
 * ============================================================================
 * 
 * Zero external JS dependencies. Pure Vanilla ES6 and HTML5 Canvas 2D context.
 * 
 * Exports:
 * 1. SpatialStripCanvas:
 *    - 3 stacked horizontal telemetry lanes along curvilinear distance d (yards):
 *      * Top Mini-Sector ribbon (5-yd blocks: Green = A won, Purple/Red = B won, delta labels)
 *      * Lane 1: Delta Time ΔTime(d) [sec] with zero-line and F1-style clipped area fills
 *      * Lane 2: Dual speed traces s(d) [yd/s] (Cyan A vs Amber B) with V-max & apex markers
 *      * Lane 3: Sideslip β(d) [deg] & rate dβ/dt / Jerk with snap oversteer warning zones
 *    - Vertical dashed milestone lines with labels across all lanes
 *    - Synchronized crosshair, HUD readout, and scrubbing (onScrub / setScrubDistance)
 * 
 * 2. SpatialOverlayCanvas:
 *    - 2D trajectory overlay (Cyan Player A vs Amber Player B)
 *    - Dynamic alignment (start at (0,0) or field coordinates) with 1:1 aspect ratio
 *    - Start & finish pins, apex curvature markers, and scrub position player dots
 *    - Body orientation (o) vs velocity direction (dir) vectors visualizing slip angle β
 *    - Spatial separation line (Δpos) between players
 * ============================================================================
 */

// ============================================================================
// 1. Theme Configuration & Styling Constants
// ============================================================================
const THEME = {
  bgPrimary: '#0f172a',      // Slate-900
  bgSecondary: '#1e293b',    // Slate-800
  bgTertiary: '#334155',     // Slate-700
  bgCard: 'rgba(15, 23, 42, 0.94)',
  border: '#334155',
  borderLight: '#475569',
  borderSubtle: 'rgba(51, 65, 85, 0.5)',

  textPrimary: '#f8fafc',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',

  // Player A (Cyan)
  playerA: '#06b6d4',
  playerAGlow: 'rgba(6, 182, 212, 0.4)',
  playerAFill: 'rgba(6, 182, 212, 0.12)',

  // Player B (Amber)
  playerB: '#f59e0b',
  playerBGlow: 'rgba(245, 158, 11, 0.4)',
  playerBFill: 'rgba(245, 158, 11, 0.12)',

  // Delta Time: A is Ahead/Faster (Δt < 0) -> Emerald Green
  leadA: '#10b981',
  leadAGlow: 'rgba(16, 185, 129, 0.4)',
  leadAFill: 'rgba(16, 185, 129, 0.28)',

  // Delta Time: B is Ahead/Faster (Δt > 0) -> Purple/Violet
  leadB: '#a855f7',
  leadBGlow: 'rgba(168, 85, 247, 0.4)',
  leadBFill: 'rgba(168, 85, 247, 0.28)',

  // Alerts & Oversteer Warnings
  warningRed: '#ef4444',
  warningRedGlow: 'rgba(239, 68, 68, 0.45)',
  warningRedFill: 'rgba(239, 68, 68, 0.22)',

  // Crosshair & Grid
  crosshair: 'rgba(255, 255, 255, 0.9)',
  crosshairGlow: 'rgba(255, 255, 255, 0.35)',
  gridLine: 'rgba(51, 65, 85, 0.45)',
  zeroLine: 'rgba(148, 163, 184, 0.75)',

  // Typography
  fontSans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontMono: "'JetBrains Mono', 'Fira Code', 'Roboto Mono', monospace"
};

// ============================================================================
// 2. Numerical & Kinematics Helper Utilities
// ============================================================================

/**
 * Binary search (bisect) for index i such that array[i] <= target <= array[i + 1].
 */
function bisectLeft(arr, target, accessor = (v) => v) {
  if (!arr || arr.length === 0) return -1;
  if (arr.length === 1) return 0;
  let low = 0;
  let high = arr.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (accessor(arr[mid]) < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return Math.max(0, Math.min(arr.length - 2, low > 0 && accessor(arr[low]) > target ? low - 1 : low));
}

/**
 * Linearly interpolate between two scalar values.
 */
function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Interpolate angle in degrees using shortest circular arc.
 */
function lerpAngleDeg(a, b, t) {
  let diff = (b - a) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (a + diff * Math.max(0, Math.min(1, t)) + 360) % 360;
}

/**
 * Sample or interpolate an array of values over distance grid.
 */
function sampleSeries(gridDistances, values, targetD) {
  if (!gridDistances || !values || gridDistances.length === 0 || values.length === 0) {
    return 0;
  }
  if (gridDistances.length === 1) return Number.isFinite(values[0]) ? values[0] : 0;

  const idx = bisectLeft(gridDistances, targetD);
  const d0 = gridDistances[idx];
  const d1 = gridDistances[idx + 1] ?? d0;
  const v0 = Number.isFinite(values[idx]) ? values[idx] : 0;
  const v1 = Number.isFinite(values[idx + 1]) ? values[idx + 1] : v0;

  if (Math.abs(d1 - d0) < 1e-6) return v0;
  const t = (targetD - d0) / (d1 - d0);
  return lerp(v0, v1, t);
}

/**
 * Interpolate a point object from resampled points array along curvilinear distance.
 */
function samplePointAtDistance(points, targetD) {
  if (!points || points.length === 0) return null;
  if (points.length === 1) {
    const p = points[0];
    const s = p.s ?? 0;
    const a = p.a ?? 0;
    const a_lat = p.a_lat ?? (s * s * (p.curvature ?? p.kappa ?? 0));
    const a_comb = p.a_comb ?? Math.hypot(a, a_lat);
    const g_comb = p.g_comb ?? (a_comb / 10.7247);
    return { ...p, a_lat, a_comb, g_comb };
  }

  const idx = bisectLeft(points, targetD, (p) => p.distance ?? 0);
  const p0 = points[idx];
  const p1 = points[idx + 1] ?? p0;

  const d0 = p0.distance ?? 0;
  const d1 = p1.distance ?? d0;
  const t = Math.abs(d1 - d0) < 1e-6 ? 0 : Math.max(0, Math.min(1, (targetD - d0) / (d1 - d0)));

  const s = lerp(p0.s ?? 0, p1.s ?? 0, t);
  const a = lerp(p0.a ?? 0, p1.a ?? 0, t);
  const curv = lerp(p0.curvature ?? p0.kappa ?? 0, p1.curvature ?? p1.kappa ?? 0, t);
  const a_lat = (p0.a_lat != null && p1.a_lat != null) ? lerp(p0.a_lat, p1.a_lat, t) : (s * s * curv);
  const a_comb = (p0.a_comb != null && p1.a_comb != null) ? lerp(p0.a_comb, p1.a_comb, t) : Math.hypot(a, a_lat);
  const g_comb = (p0.g_comb != null && p1.g_comb != null) ? lerp(p0.g_comb, p1.g_comb, t) : (a_comb / 10.7247);

  return {
    distance: targetD,
    time: lerp(p0.time ?? 0, p1.time ?? 0, t),
    x: lerp(p0.x ?? 0, p1.x ?? 0, t),
    y: lerp(p0.y ?? 0, p1.y ?? 0, t),
    s,
    a,
    a_lat,
    a_comb,
    g_comb,
    dir: lerpAngleDeg(p0.dir ?? 0, p1.dir ?? 0, t),
    o: lerpAngleDeg(p0.o ?? p0.dir ?? 0, p1.o ?? p1.dir ?? 0, t),
    curvature: curv,
    beta_slip: lerp(p0.beta_slip ?? 0, p1.beta_slip ?? 0, t),
    beta_rate: lerp(p0.beta_rate ?? 0, p1.beta_rate ?? 0, t),
    jerk: lerp(p0.jerk ?? 0, p1.jerk ?? 0, t),
    snap_oversteer: p0.snap_oversteer || p1.snap_oversteer || false
  };
}

/**
 * Format time delta with explicit sign and 3 decimals (e.g. "-0.142s" or "+0.085s").
 */
function formatDeltaTime(dt) {
  if (!Number.isFinite(dt)) return '0.000s';
  const sign = dt < 0 ? '-' : '+';
  return `${sign}${Math.abs(dt).toFixed(3)}s`;
}

// ============================================================================
// 3. SpatialStripCanvas Class
// ============================================================================
export class SpatialStripCanvas {
  /**
   * @param {HTMLCanvasElement|string} canvasElement
   * @param {Object} options
   */
  constructor(canvasElement, options = {}) {
    this.canvas = typeof canvasElement === 'string'
      ? document.getElementById(canvasElement)
      : canvasElement;

    if (!this.canvas) {
      throw new Error('SpatialStripCanvas: Canvas element not found.');
    }

    this.ctx = this.canvas.getContext('2d');
    this.options = {
      paddingLeft: 64,
      paddingRight: 32,
      paddingTop: 10,
      paddingBottom: 28,
      miniSectorHeight: 20,
      laneGap: 10,
      speedUnit: options.speedUnit || 'yd/s', // 'yd/s' or 'mph'
      speedMultiplier: options.speedUnit === 'mph' ? 2.04545 : 1.0,
      snapThresholdBeta: 18.0, // deg
      snapThresholdRate: 60.0, // deg/s
      ...options
    };

    // Data model state
    this.data = null;
    this.maxDistance = 40.0;
    this.scrubDistance = 0.0;
    this.isHovering = false;
    this.hoverX = null;
    this.hoverY = null;
    this.onScrubCallbacks = new Set();
    this.lane3Mode = options.lane3Mode || 'sideslip';

    if (typeof options.onScrub === 'function') {
      this.onScrubCallbacks.add(options.onScrub);
    }

    // Geometry layout metrics
    this.layout = {
      cssWidth: 800,
      cssHeight: 450,
      dpr: 1,
      plotLeft: 64,
      plotRight: 768,
      plotWidth: 704,
      miniSector: { top: 10, height: 20, bottom: 30 },
      lane1: { top: 40, height: 110, bottom: 150, midY: 95 },
      lane2: { top: 160, height: 130, bottom: 290, midY: 225 },
      lane3: { top: 300, height: 110, bottom: 410, midY: 355 },
      axisTop: 416
    };

    // Bind event handlers
    this.handleResize = this.handleResize.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseEnter = this.handleMouseEnter.bind(this);
    this.handleMouseLeave = this.handleMouseLeave.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);

    // Setup High-DPI canvas & ResizeObserver
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.canvas.parentElement);
    }
    window.addEventListener('resize', this.handleResize);

    // Mouse & Touch scrub events
    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mouseenter', this.handleMouseEnter);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('touchstart', this.handleTouchMove, { passive: false });
    this.canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.handleMouseLeave);

    this.handleResize();
  }

  /**
   * High-DPI buffer scaling and layout partition calculations.
   */
  handleResize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(300, Math.floor(rect.width || this.canvas.clientWidth || 800));
    const cssHeight = Math.max(260, Math.floor(rect.height || this.canvas.clientHeight || 450));

    const bufW = Math.round(cssWidth * dpr);
    const bufH = Math.round(cssHeight * dpr);

    if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
      this.canvas.width = bufW;
      this.canvas.height = bufH;
    }

    const { paddingLeft, paddingRight, paddingTop, paddingBottom, miniSectorHeight, laneGap } = this.options;
    const plotLeft = paddingLeft;
    const plotRight = cssWidth - paddingRight;
    const plotWidth = Math.max(10, plotRight - plotLeft);

    const miniSecTop = paddingTop;
    const miniSecBottom = miniSecTop + miniSectorHeight;

    const availableLaneHeight = Math.max(90, (cssHeight - paddingBottom) - (miniSecBottom + laneGap) - (2 * laneGap));
    
    // Partition: Lane 1 (Delta Time: 29%), Lane 2 (Speed: 42%), Lane 3 (Sideslip: 29%)
    const h1 = Math.round(availableLaneHeight * 0.29);
    const h2 = Math.round(availableLaneHeight * 0.42);
    const h3 = Math.max(30, availableLaneHeight - h1 - h2);

    const l1Top = miniSecBottom + laneGap;
    const l1Bottom = l1Top + h1;

    const l2Top = l1Bottom + laneGap;
    const l2Bottom = l2Top + h2;

    const l3Top = l2Bottom + laneGap;
    const l3Bottom = l3Top + h3;

    this.layout = {
      cssWidth,
      cssHeight,
      dpr,
      plotLeft,
      plotRight,
      plotWidth,
      miniSector: { top: miniSecTop, height: miniSectorHeight, bottom: miniSecBottom },
      lane1: { top: l1Top, height: h1, bottom: l1Bottom, midY: l1Top + h1 / 2 },
      lane2: { top: l2Top, height: h2, bottom: l2Bottom, midY: l2Top + h2 / 2 },
      lane3: { top: l3Top, height: h3, bottom: l3Bottom, midY: l3Top + h3 / 2 },
      axisTop: l3Bottom + 6
    };

    this.render();
  }

  /**
   * Set comparison telemetry data payload.
   * @param {Object} comparisonData
   */
  setData(comparisonData) {
    if (!comparisonData || typeof comparisonData !== 'object') {
      this.data = null;
      this.render();
      return;
    }

    this.data = comparisonData;
    
    // Fallback detection for common_max_distance
    let maxDist = Number(comparisonData.common_max_distance);
    if (!Number.isFinite(maxDist) || maxDist <= 0) {
      if (Array.isArray(comparisonData.grid_distance) && comparisonData.grid_distance.length > 0) {
        maxDist = Math.max(...comparisonData.grid_distance.filter(Number.isFinite));
      } else if (comparisonData.resampled_a?.points?.length > 0) {
        maxDist = Math.max(...comparisonData.resampled_a.points.map((p) => p.distance ?? 0));
      } else {
        maxDist = 40.0;
      }
    }
    this.maxDistance = Math.max(1.0, maxDist);

    // Clamp scrub distance
    this.scrubDistance = Math.max(0, Math.min(this.maxDistance, this.scrubDistance || 0));

    this.render();
  }

  /**
   * External scrub setter.
   * @param {number} distanceYards
   */
  setScrubDistance(distanceYards) {
    if (!Number.isFinite(distanceYards)) return;
    this.scrubDistance = Math.max(0, Math.min(this.maxDistance, distanceYards));
    this.render();
  }

  /**
   * Set Lane 3 visualization mode ('sideslip' or 'g_force').
   * @param {string} mode
   * @returns {string} current lane3Mode
   */
  setLane3Mode(mode) {
    if (mode === 'g_force' || mode === 'sideslip') {
      this.lane3Mode = mode;
      this.render();
    }
    return this.lane3Mode;
  }

  /**
   * Toggle Lane 3 visualization mode between 'sideslip' and 'g_force'.
   * @returns {string} current lane3Mode
   */
  toggleLane3Mode() {
    this.lane3Mode = this.lane3Mode === 'g_force' ? 'sideslip' : 'g_force';
    this.render();
    return this.lane3Mode;
  }

  /**
   * Register scrub listener callback.
   * @param {Function} callback (distanceYards, closestIndex)
   */
  onScrub(callback) {
    if (typeof callback === 'function') {
      this.onScrubCallbacks.add(callback);
    }
    return () => this.onScrubCallbacks.delete(callback);
  }

  _dispatchScrub(distanceYards) {
    let closestIndex = 0;
    if (this.data?.grid_distance?.length) {
      closestIndex = bisectLeft(this.data.grid_distance, distanceYards);
    }
    for (const cb of this.onScrubCallbacks) {
      try {
        cb(distanceYards, closestIndex);
      } catch (err) {
        console.error('SpatialStripCanvas onScrub callback error:', err);
      }
    }
  }

  // --- Coordinate conversions ---
  distanceToX(dist) {
    const norm = Math.max(0, Math.min(this.maxDistance, dist)) / this.maxDistance;
    return this.layout.plotLeft + norm * this.layout.plotWidth;
  }

  xToDistance(x) {
    const rel = Math.max(0, Math.min(this.layout.plotWidth, x - this.layout.plotLeft));
    return (rel / this.layout.plotWidth) * this.maxDistance;
  }

  // --- Event Handlers ---
  handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    this.isHovering = true;
    this.hoverX = x;
    this.hoverY = y;

    if (x >= this.layout.plotLeft && x <= this.layout.plotRight) {
      this.scrubDistance = this.xToDistance(x);
      this._dispatchScrub(this.scrubDistance);
    }
    this.render();
  }

  handleMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x >= this.layout.plotLeft && x <= this.layout.plotRight) {
      this.scrubDistance = this.xToDistance(x);
      this._dispatchScrub(this.scrubDistance);
      this.render();
    }
  }

  handleTouchMove(e) {
    if (!e.touches || e.touches.length === 0) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const touch = e.touches[0];
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    this.isHovering = true;
    this.hoverX = x;
    this.hoverY = y;

    if (x >= this.layout.plotLeft && x <= this.layout.plotRight) {
      this.scrubDistance = this.xToDistance(x);
      this._dispatchScrub(this.scrubDistance);
    }
    this.render();
  }

  handleMouseEnter() {
    this.isHovering = true;
  }

  handleMouseLeave() {
    this.isHovering = false;
    this.hoverX = null;
    this.hoverY = null;
    this.render();
  }

  // ==========================================================================
  // RENDER PIPELINE
  // ==========================================================================
  render() {
    const { ctx } = this;
    const { cssWidth, cssHeight, dpr } = this.layout;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Deep dark background
    ctx.fillStyle = THEME.bgPrimary;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    if (!this.data || !Array.isArray(this.data.grid_distance) || this.data.grid_distance.length === 0) {
      this.renderEmptyState();
      ctx.restore();
      return;
    }

    // 1. Draw Lane Backgrounds & Structural Borders
    this.renderLaneContainers();

    // 2. Draw Mini-Sector ribbon (Top)
    this.renderMiniSectors();

    // 3. Lane 1: Delta Time ΔTime(d) with F1 clipped gradient fills
    this.renderLaneDeltaTime();

    // 4. Lane 2: Dual Speed Traces & V-max markers
    this.renderLaneSpeed();

    // 5. Lane 3: Sideslip β or Combined G-Force
    if (this.lane3Mode === 'g_force') {
      this.renderLaneGForce();
    } else {
      this.renderLaneSideslip();
    }

    // 6. Vertical Milestones across all lanes
    this.renderMilestones();

    // 7. Curvilinear Track Distance Axis (Bottom)
    this.renderCurvilinearAxis();

    // 8. Crosshair & Telemetry HUD Overlay
    this.renderCrosshairAndHUD();

    ctx.restore();
  }

  renderEmptyState() {
    const { ctx } = this;
    const { cssWidth, cssHeight } = this.layout;
    ctx.fillStyle = THEME.textMuted;
    ctx.font = `500 13px ${THEME.fontSans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Awaiting telemetry comparison payload...', cssWidth / 2, cssHeight / 2);
  }

  renderLaneContainers() {
    const { ctx } = this;
    const { plotLeft, plotWidth, lane1, lane2, lane3 } = this.layout;

    ctx.fillStyle = THEME.bgSecondary;
    ctx.strokeStyle = THEME.border;
    ctx.lineWidth = 1;

    [lane1, lane2, lane3].forEach((lane) => {
      ctx.fillRect(plotLeft, lane.top, plotWidth, lane.height);
      ctx.strokeRect(plotLeft, lane.top, plotWidth, lane.height);
    });
  }

  /**
   * Top Mini-Sector Ribbon (5-yard F1 segments).
   */
  renderMiniSectors() {
    const { ctx } = this;
    const { miniSector, plotLeft, plotWidth } = this.layout;
    const sectors = this.data.mini_sectors || [];

    ctx.save();
    // Background bar
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(plotLeft, miniSector.top, plotWidth, miniSector.height);
    ctx.strokeStyle = THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotLeft, miniSector.top, plotWidth, miniSector.height);

    if (sectors.length === 0) {
      // Draw 5-yd synthetic sectors if not explicitly provided
      const step = 5.0;
      for (let d = 0; d < this.maxDistance; d += step) {
        const x1 = this.distanceToX(d);
        const x2 = this.distanceToX(Math.min(this.maxDistance, d + step));
        ctx.strokeStyle = THEME.borderLight;
        ctx.strokeRect(x1 + 0.5, miniSector.top + 0.5, x2 - x1 - 1, miniSector.height - 1);
      }
      ctx.restore();
      return;
    }

    sectors.forEach((sec, idx) => {
      const startD = Number(sec.start_distance ?? idx * 5);
      const endD = Number(sec.end_distance ?? (idx + 1) * 5);
      const x1 = this.distanceToX(startD);
      const x2 = this.distanceToX(Math.min(this.maxDistance, endD));
      const w = Math.max(2, x2 - x1);

      const dt = Number(sec.delta_time ?? 0);
      const winner = (sec.winner || (dt < -0.005 ? 'A' : dt > 0.005 ? 'B' : 'TIE')).toUpperCase();

      let fill = '#334155';
      let stroke = '#475569';
      let glow = null;

      if (winner === 'A' || dt < -0.005) {
        fill = '#059669'; // Emerald
        stroke = THEME.leadA;
        glow = THEME.leadAGlow;
      } else if (winner === 'B' || dt > 0.005) {
        fill = '#7c3aed'; // Purple
        stroke = THEME.leadB;
        glow = THEME.leadBGlow;
      }

      // Check if current scrub is inside this sector
      const isScrubInSector = this.scrubDistance >= startD && this.scrubDistance < endD;

      ctx.fillStyle = fill;
      ctx.fillRect(x1 + 1, miniSector.top + 1, w - 2, miniSector.height - 2);

      if (isScrubInSector) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1 + 0.5, miniSector.top + 0.5, w - 1, miniSector.height - 1);
      } else {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 1, miniSector.top + 1, w - 2, miniSector.height - 2);
      }

      // Delta text inside block if width permits
      if (w > 32) {
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 10px ${THEME.fontMono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const txt = Math.abs(dt) < 0.001 ? '0.00s' : `${dt > 0 ? '+' : ''}${dt.toFixed(2)}s`;
        ctx.fillText(txt, x1 + w / 2, miniSector.top + miniSector.height / 2);
      }
    });

    // Badge label on left
    ctx.fillStyle = THEME.textSecondary;
    ctx.font = `600 10px ${THEME.fontSans}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('MINI-SECTORS', plotLeft - 8, miniSector.top + miniSector.height / 2);

    ctx.restore();
  }

  /**
   * Lane 1: Delta Time ΔTime(d) with F1 zero line & clipped area fills.
   */
  renderLaneDeltaTime() {
    const { ctx } = this;
    const { plotLeft, plotWidth, lane1 } = this.layout;
    const distances = this.data.grid_distance || [];
    const deltaTimes = this.data.delta_time || [];

    if (distances.length < 2 || deltaTimes.length < 2) return;

    ctx.save();

    // Determine symmetric Y scale for Delta Time
    let maxAbs = 0.15;
    for (const dt of deltaTimes) {
      if (Number.isFinite(dt) && Math.abs(dt) > maxAbs) maxAbs = Math.abs(dt);
    }
    const limitDt = Math.max(0.1, Math.ceil(maxAbs * 10) / 10); // e.g. 0.2, 0.4s
    const halfH = lane1.height * 0.42;

    // Mapping: Δt < 0 (A ahead) -> Y is UP (midY - offset)
    //          Δt > 0 (B ahead) -> Y is DOWN (midY + offset)
    const dtToY = (dt) => lane1.midY + (dt / limitDt) * halfH;

    // 1. Zero Line
    ctx.strokeStyle = THEME.zeroLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, lane1.midY);
    ctx.lineTo(plotLeft + plotWidth, lane1.midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Grid ticks for ±limitDt
    ctx.strokeStyle = THEME.gridLine;
    ctx.lineWidth = 0.75;
    [-limitDt, limitDt].forEach((tickVal) => {
      const y = dtToY(tickVal);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
    });

    // 2. F1 Clipped Area Fills:
    // Clip top half for Player A (dt < 0) -> Emerald Green Fill
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, lane1.top, plotWidth, lane1.midY - lane1.top);
    ctx.clip();

    ctx.beginPath();
    ctx.moveTo(this.distanceToX(distances[0]), lane1.midY);
    for (let i = 0; i < distances.length; i++) {
      ctx.lineTo(this.distanceToX(distances[i]), dtToY(deltaTimes[i]));
    }
    ctx.lineTo(this.distanceToX(distances[distances.length - 1]), lane1.midY);
    ctx.closePath();
    ctx.fillStyle = THEME.leadAFill;
    ctx.fill();
    ctx.restore();

    // Clip bottom half for Player B (dt > 0) -> Purple Fill
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, lane1.midY, plotWidth, lane1.bottom - lane1.midY);
    ctx.clip();

    ctx.beginPath();
    ctx.moveTo(this.distanceToX(distances[0]), lane1.midY);
    for (let i = 0; i < distances.length; i++) {
      ctx.lineTo(this.distanceToX(distances[i]), dtToY(deltaTimes[i]));
    }
    ctx.lineTo(this.distanceToX(distances[distances.length - 1]), lane1.midY);
    ctx.closePath();
    ctx.fillStyle = THEME.leadBFill;
    ctx.fill();
    ctx.restore();

    // 3. Stroke Delta Time Trace
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowBlur = 6;

    // Segmented coloring along zero line
    for (let i = 0; i < distances.length - 1; i++) {
      const x1 = this.distanceToX(distances[i]);
      const y1 = dtToY(deltaTimes[i]);
      const x2 = this.distanceToX(distances[i + 1]);
      const y2 = dtToY(deltaTimes[i + 1]);

      const avgDt = (deltaTimes[i] + deltaTimes[i + 1]) / 2;
      const strokeColor = avgDt <= 0 ? THEME.leadA : THEME.leadB;

      ctx.strokeStyle = strokeColor;
      ctx.shadowColor = avgDt <= 0 ? THEME.leadAGlow : THEME.leadBGlow;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();

    // 4. Axis Y Labels & Telemetry Badges
    ctx.font = `600 10px ${THEME.fontMono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // Top: A ahead
    ctx.fillStyle = THEME.leadA;
    ctx.fillText(`▲ A Ahead (-${limitDt.toFixed(1)}s)`, plotLeft - 8, dtToY(-limitDt));

    // Zero
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText('0.0s', plotLeft - 8, lane1.midY);

    // Bottom: B ahead
    ctx.fillStyle = THEME.leadB;
    ctx.fillText(`▼ B Ahead (+${limitDt.toFixed(1)}s)`, plotLeft - 8, dtToY(limitDt));

    // Lane Title Badge
    ctx.fillStyle = THEME.textPrimary;
    ctx.font = `700 11px ${THEME.fontSans}`;
    ctx.textAlign = 'left';
    ctx.fillText('Δ TIME (s)', plotLeft + 10, lane1.top + 14);

    ctx.restore();
  }

  /**
   * Lane 2: Dual Speed Traces s(d) [yd/s] & V-max markers.
   */
  renderLaneSpeed() {
    const { ctx } = this;
    const { plotLeft, plotWidth, lane2 } = this.layout;
    const mult = this.options.speedMultiplier;
    const unit = this.options.speedUnit;

    const distances = this.data.grid_distance || [];
    const speedsA = (this.data.speeds_a || []).map((s) => s * mult);
    const speedsB = (this.data.speeds_b || []).map((s) => s * mult);

    if (distances.length < 2) return;

    ctx.save();

    // Max speed calculation
    let maxSpeed = 10.0 * mult;
    speedsA.forEach((s) => { if (Number.isFinite(s) && s > maxSpeed) maxSpeed = s; });
    speedsB.forEach((s) => { if (Number.isFinite(s) && s > maxSpeed) maxSpeed = s; });
    maxSpeed = Math.ceil(maxSpeed * 1.15); // +15% head room for tags

    const minSpeed = 0.0;
    const speedToY = (spd) => lane2.bottom - 8 - ((spd - minSpeed) / (maxSpeed - minSpeed)) * (lane2.height - 24);

    // Grid lines for speed
    ctx.strokeStyle = THEME.gridLine;
    ctx.lineWidth = 0.75;
    const step = maxSpeed >= 20 ? 5 : 2;
    for (let spd = step; spd < maxSpeed; spd += step) {
      const y = speedToY(spd);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();

      ctx.fillStyle = THEME.textMuted;
      ctx.font = `500 9px ${THEME.fontMono}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${spd.toFixed(0)}`, plotLeft - 8, y);
    }

    // Gradient Area under Player B
    if (speedsB.length === distances.length) {
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(distances[0]), lane2.bottom - 1);
      for (let i = 0; i < distances.length; i++) {
        ctx.lineTo(this.distanceToX(distances[i]), speedToY(speedsB[i]));
      }
      ctx.lineTo(this.distanceToX(distances[distances.length - 1]), lane2.bottom - 1);
      ctx.closePath();
      ctx.fillStyle = THEME.playerBFill;
      ctx.fill();
    }

    // Gradient Area under Player A
    if (speedsA.length === distances.length) {
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(distances[0]), lane2.bottom - 1);
      for (let i = 0; i < distances.length; i++) {
        ctx.lineTo(this.distanceToX(distances[i]), speedToY(speedsA[i]));
      }
      ctx.lineTo(this.distanceToX(distances[distances.length - 1]), lane2.bottom - 1);
      ctx.closePath();
      ctx.fillStyle = THEME.playerAFill;
      ctx.fill();
    }

    // Trace Player B (Amber)
    if (speedsB.length === distances.length) {
      ctx.save();
      ctx.strokeStyle = THEME.playerB;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.shadowColor = THEME.playerBGlow;
      ctx.shadowBlur = 5;
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(distances[0]), speedToY(speedsB[0]));
      for (let i = 1; i < distances.length; i++) {
        ctx.lineTo(this.distanceToX(distances[i]), speedToY(speedsB[i]));
      }
      ctx.stroke();
      ctx.restore();
    }

    // Trace Player A (Cyan)
    if (speedsA.length === distances.length) {
      ctx.save();
      ctx.strokeStyle = THEME.playerA;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.shadowColor = THEME.playerAGlow;
      ctx.shadowBlur = 5;
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(distances[0]), speedToY(speedsA[0]));
      for (let i = 1; i < distances.length; i++) {
        ctx.lineTo(this.distanceToX(distances[i]), speedToY(speedsA[i]));
      }
      ctx.stroke();
      ctx.restore();
    }

    // V-max Markers
    this.renderVMaxMarker(distances, speedsA, speedToY, THEME.playerA, 'A');
    this.renderVMaxMarker(distances, speedsB, speedToY, THEME.playerB, 'B');

    // Apex Markers (v_apex & Corner Exit Traction)
    this.renderApexMarkersInSpeedLane(speedToY);

    // Title & Legend
    ctx.fillStyle = THEME.textPrimary;
    ctx.font = `700 11px ${THEME.fontSans}`;
    ctx.textAlign = 'left';
    ctx.fillText(`SPEED (${unit})`, plotLeft + 10, lane2.top + 14);

    const nameA = this.data.player_a_name || 'Player A';
    const nameB = this.data.player_b_name || 'Player B';

    ctx.font = `600 11px ${THEME.fontSans}`;
    let legX = plotLeft + 110;
    
    // Player A dot & text
    ctx.fillStyle = THEME.playerA;
    ctx.beginPath();
    ctx.arc(legX, lane2.top + 10, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(nameA, legX + 8, lane2.top + 13);
    legX += ctx.measureText(nameA).width + 24;

    // Player B dot & text
    ctx.fillStyle = THEME.playerB;
    ctx.beginPath();
    ctx.arc(legX, lane2.top + 10, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(nameB, legX + 8, lane2.top + 13);

    ctx.restore();
  }

  renderApexMarkersInSpeedLane(speedToY) {
    const { ctx } = this;
    const apexesA = this.data.apexes_a || [];
    const apexesB = this.data.apexes_b || [];

    const drawApexGroup = (apexList, color, label, yOffset) => {
      apexList.forEach((ap, idx) => {
        const d = ap.distance ?? 0;
        if (!Number.isFinite(d) || d < 0 || d > this.maxDistance) return;

        const vApex = ap.v_apex ?? ap.apex_speed ?? ap.speed ?? 0;
        const exitTraction = ap.exit_traction != null ? ap.exit_traction : 0;
        const exitSign = exitTraction >= 0 ? '+' : '';

        const x = this.distanceToX(d);
        const y = speedToY(vApex);

        ctx.save();
        // Diamond marker on speed trace
        ctx.fillStyle = color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Apex badge tag
        const tagText = `Apex ${label}${idx + 1}: v_apex: ${vApex.toFixed(1)} yd/s | Exit: ${exitSign}${exitTraction.toFixed(1)} yd/s²`;
        ctx.font = `600 9px ${THEME.fontMono}`;
        const tagW = ctx.measureText(tagText).width + 12;
        const tagH = 17;

        let tagX = x - tagW / 2;
        tagX = Math.max(this.layout.plotLeft + 4, Math.min(this.layout.plotRight - tagW - 4, tagX));
        let tagY = y - 24 + yOffset;
        if (tagY < this.layout.lane2.top + 4) {
          tagY = y + 8;
        }

        ctx.fillStyle = THEME.bgCard;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tagX, tagY, tagW, tagH, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tagText, tagX + tagW / 2, tagY + tagH / 2);

        ctx.restore();
      });
    };

    drawApexGroup(apexesA, THEME.playerA, 'A', 0);
    drawApexGroup(apexesB, THEME.playerB, 'B', -16);
  }

  renderVMaxMarker(distances, speeds, speedToY, color, label) {
    if (!speeds || speeds.length === 0) return;
    const { ctx } = this;
    const unit = this.options.speedUnit;

    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let i = 0; i < speeds.length; i++) {
      if (speeds[i] > maxVal) {
        maxVal = speeds[i];
        maxIdx = i;
      }
    }
    if (!Number.isFinite(maxVal) || maxVal <= 0) return;

    const x = this.distanceToX(distances[maxIdx]);
    const y = speedToY(maxVal);

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Vmax pill tag
    const txt = `Vmax ${label}: ${maxVal.toFixed(1)} ${unit}`;
    ctx.font = `600 9px ${THEME.fontMono}`;
    const txtW = ctx.measureText(txt).width;
    const pillW = txtW + 10;
    const pillH = 16;
    const pillX = Math.max(this.layout.plotLeft + 4, Math.min(this.layout.plotRight - pillW - 4, x - pillW / 2));
    const pillY = Math.max(this.layout.lane2.top + 4, y - 20);

    ctx.fillStyle = THEME.bgCard;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, pillX + pillW / 2, pillY + pillH / 2);

    ctx.restore();
  }

  /**
   * Lane 3: Sideslip β(d) [deg] & Snap Oversteer Highlights.
   */
  renderLaneSideslip() {
    const { ctx } = this;
    const { plotLeft, plotWidth, lane3 } = this.layout;
    const pointsA = this.data.resampled_a?.points || [];
    const pointsB = this.data.resampled_b?.points || [];

    ctx.save();

    // Neutral bounds & threshold
    const maxBetaLimit = 35.0; // deg
    const halfH = lane3.height * 0.42;
    const betaToY = (beta) => lane3.midY - (Math.max(-maxBetaLimit, Math.min(maxBetaLimit, beta)) / maxBetaLimit) * halfH;

    // 1. Shaded Controlled Envelope [-10°, +10°]
    const ySafeTop = betaToY(10.0);
    const ySafeBottom = betaToY(-10.0);
    ctx.fillStyle = 'rgba(30, 41, 59, 0.4)';
    ctx.fillRect(plotLeft, ySafeTop, plotWidth, ySafeBottom - ySafeTop);

    // 2. Zero Slip Centerline (Inline motion)
    ctx.strokeStyle = THEME.zeroLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, lane3.midY);
    ctx.lineTo(plotLeft + plotWidth, lane3.midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. Snap Oversteer Warning Zones (Threshold ±18°)
    const yWarnPos = betaToY(this.options.snapThresholdBeta);
    const yWarnNeg = betaToY(-this.options.snapThresholdBeta);
    ctx.strokeStyle = THEME.warningRed;
    ctx.lineWidth = 0.75;
    ctx.setLineDash([2, 4]);
    [yWarnPos, yWarnNeg].forEach((y) => {
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // 4. Highlight Snap Oversteer Incidents (vertical luminous warning columns)
    const highlightIncidents = (points, color) => {
      points.forEach((pt) => {
        const isSnap = pt.snap_oversteer || Math.abs(pt.beta_slip ?? 0) >= this.options.snapThresholdBeta;
        if (isSnap && Number.isFinite(pt.distance)) {
          const x = this.distanceToX(pt.distance);
          ctx.fillStyle = THEME.warningRedFill;
          ctx.fillRect(x - 2, lane3.top, 4, lane3.height);

          ctx.strokeStyle = THEME.warningRed;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, lane3.top);
          ctx.lineTo(x, lane3.bottom);
          ctx.stroke();
        }
      });
    };
    highlightIncidents(pointsA, THEME.playerA);
    highlightIncidents(pointsB, THEME.playerB);

    // 5. Trace Sideslip β Traces
    const drawBetaPath = (points, strokeColor, glowColor) => {
      if (points.length < 2) return;
      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.0;
      ctx.lineJoin = 'round';
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 4;
      ctx.beginPath();
      let started = false;
      points.forEach((p) => {
        const d = p.distance ?? 0;
        const b = p.beta_slip ?? 0;
        const x = this.distanceToX(d);
        const y = betaToY(b);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
      ctx.restore();
    };

    drawBetaPath(pointsB, THEME.playerB, THEME.playerBGlow);
    drawBetaPath(pointsA, THEME.playerA, THEME.playerAGlow);

    // Axis Labels
    ctx.font = `600 10px ${THEME.fontMono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = THEME.warningRed;
    ctx.fillText(`+${this.options.snapThresholdBeta.toFixed(0)}°`, plotLeft - 8, yWarnPos);
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText('0° β', plotLeft - 8, lane3.midY);
    ctx.fillStyle = THEME.warningRed;
    ctx.fillText(`-${this.options.snapThresholdBeta.toFixed(0)}°`, plotLeft - 8, yWarnNeg);

    // Lane Title Badge
    ctx.fillStyle = THEME.textPrimary;
    ctx.font = `700 11px ${THEME.fontSans}`;
    ctx.textAlign = 'left';
    ctx.fillText('SIDESLIP ANGLE β & INSTABILITY (deg)', plotLeft + 10, lane3.top + 14);

    ctx.restore();
  }

  /**
   * Lane 3 (Alternative Mode): Combined G-Force G_comb(d) [g] & Traction Load.
   */
  renderLaneGForce() {
    const { ctx } = this;
    const { plotLeft, plotWidth, lane3 } = this.layout;
    const pointsA = this.data.resampled_a?.points || [];
    const pointsB = this.data.resampled_b?.points || [];

    ctx.save();

    // 0 to 1.4 g mapping to Y coordinates
    const maxG = 1.4;
    const bottomPad = 8;
    const topPad = 16;
    const plotH = lane3.height - bottomPad - topPad;
    const gToY = (g) => lane3.bottom - bottomPad - (Math.max(0, Math.min(maxG, g)) / maxG) * plotH;

    // Helper to safely extract g_comb in g from a telemetry point
    const extractG = (pt) => {
      if (!pt) return 0;
      if (pt.g_comb != null && Number.isFinite(pt.g_comb)) return pt.g_comb;
      if (pt.a_comb != null && Number.isFinite(pt.a_comb)) return pt.a_comb / 10.7247;
      const s = pt.s ?? 0;
      const a = pt.a ?? 0;
      const curv = pt.curvature ?? pt.kappa ?? 0;
      const a_lat = pt.a_lat != null && Number.isFinite(pt.a_lat) ? pt.a_lat : (s * s * curv);
      const a_comb = Math.hypot(a, a_lat);
      return a_comb / 10.7247;
    };

    // 1. Grid reference lines
    ctx.strokeStyle = THEME.gridLine;
    ctx.lineWidth = 0.75;
    [0.5, 1.0].forEach((gVal) => {
      const y = gToY(gVal);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
    });

    // 2. 1.0 g Dashed Amber Reference Line (Traction Limit)
    const y1g = gToY(1.0);
    ctx.save();
    ctx.strokeStyle = '#f59e0b'; // Amber
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y1g);
    ctx.lineTo(plotLeft + plotWidth, y1g);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Baseline 0.0g centerline/bottom axis
    const y0g = gToY(0.0);
    ctx.strokeStyle = THEME.zeroLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y0g);
    ctx.lineTo(plotLeft + plotWidth, y0g);
    ctx.stroke();

    // 3. Shaded Area Fill under Player B (Amber)
    if (pointsB.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(pointsB[0].distance ?? 0), y0g);
      for (let i = 0; i < pointsB.length; i++) {
        const d = pointsB[i].distance ?? 0;
        const gVal = extractG(pointsB[i]);
        ctx.lineTo(this.distanceToX(d), gToY(gVal));
      }
      ctx.lineTo(this.distanceToX(pointsB[pointsB.length - 1].distance ?? 0), y0g);
      ctx.closePath();
      ctx.fillStyle = THEME.playerBFill;
      ctx.fill();
    }

    // 4. Shaded Area Fill under Player A (Cyan)
    if (pointsA.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(pointsA[0].distance ?? 0), y0g);
      for (let i = 0; i < pointsA.length; i++) {
        const d = pointsA[i].distance ?? 0;
        const gVal = extractG(pointsA[i]);
        ctx.lineTo(this.distanceToX(d), gToY(gVal));
      }
      ctx.lineTo(this.distanceToX(pointsA[pointsA.length - 1].distance ?? 0), y0g);
      ctx.closePath();
      ctx.fillStyle = THEME.playerAFill;
      ctx.fill();
    }

    // 5. Trace Player B curve (Amber)
    if (pointsB.length >= 2) {
      ctx.save();
      ctx.strokeStyle = THEME.playerB;
      ctx.lineWidth = 2.0;
      ctx.lineJoin = 'round';
      ctx.shadowColor = THEME.playerBGlow;
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(pointsB[0].distance ?? 0), gToY(extractG(pointsB[0])));
      for (let i = 1; i < pointsB.length; i++) {
        ctx.lineTo(this.distanceToX(pointsB[i].distance ?? 0), gToY(extractG(pointsB[i])));
      }
      ctx.stroke();
      ctx.restore();
    }

    // 6. Trace Player A curve (Cyan)
    if (pointsA.length >= 2) {
      ctx.save();
      ctx.strokeStyle = THEME.playerA;
      ctx.lineWidth = 2.0;
      ctx.lineJoin = 'round';
      ctx.shadowColor = THEME.playerAGlow;
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.moveTo(this.distanceToX(pointsA[0].distance ?? 0), gToY(extractG(pointsA[0])));
      for (let i = 1; i < pointsA.length; i++) {
        ctx.lineTo(this.distanceToX(pointsA[i].distance ?? 0), gToY(extractG(pointsA[i])));
      }
      ctx.stroke();
      ctx.restore();
    }

    // 7. Y-Axis Scale Labels
    ctx.font = `600 10px ${THEME.fontMono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('1.0g', plotLeft - 8, y1g);
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText('0.5g', plotLeft - 8, gToY(0.5));
    ctx.fillText('0.0g', plotLeft - 8, y0g);

    // 8. Header Title & Legend
    ctx.fillStyle = THEME.textPrimary;
    ctx.font = `700 11px ${THEME.fontSans}`;
    ctx.textAlign = 'left';
    ctx.fillText('COMBINED G-FORCE G_comb(d) [g] & TRACTION LOAD', plotLeft + 10, lane3.top + 14);

    const nameA = this.data.player_a_name || 'Player A';
    const nameB = this.data.player_b_name || 'Player B';

    ctx.font = `600 11px ${THEME.fontSans}`;
    let legX = plotLeft + ctx.measureText('COMBINED G-FORCE G_comb(d) [g] & TRACTION LOAD').width + 24;

    if (legX + 160 < plotLeft + plotWidth) {
      // Player A dot & text
      ctx.fillStyle = THEME.playerA;
      ctx.beginPath();
      ctx.arc(legX, lane3.top + 10, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(nameA, legX + 8, lane3.top + 13);
      legX += ctx.measureText(nameA).width + 20;

      // Player B dot & text
      ctx.fillStyle = THEME.playerB;
      ctx.beginPath();
      ctx.arc(legX, lane3.top + 10, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(nameB, legX + 8, lane3.top + 13);
    }

    // Peak G badges on right side if space permits
    const maxGA = this.data.g_comb_max_a ?? (pointsA.length ? Math.max(...pointsA.map(extractG)) : 0);
    const maxGB = this.data.g_comb_max_b ?? (pointsB.length ? Math.max(...pointsB.map(extractG)) : 0);
    if (maxGA > 0 || maxGB > 0) {
      ctx.font = `600 9px ${THEME.fontMono}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = THEME.textSecondary;
      ctx.fillText(`Peak G: A ${maxGA.toFixed(2)}g | B ${maxGB.toFixed(2)}g`, plotLeft + plotWidth - 10, lane3.top + 14);
    }

    ctx.restore();
  }

  /**
   * Vertical Milestones Across All 3 Lanes (10 yd, 20 yd, 40 yd, 3-Cone Turnarounds).
   */
  renderMilestones() {
    const { ctx } = this;
    const { lane1, lane3 } = this.layout;
    const milestones = this.data.milestones || [];

    if (milestones.length === 0) return;

    ctx.save();
    milestones.forEach((m) => {
      const d = Number(m.distance);
      if (!Number.isFinite(d) || d < 0 || d > this.maxDistance) return;

      const x = this.distanceToX(d);
      const dt = Number(m.delta_time ?? 0);
      const winner = (m.winner || (dt < -0.005 ? 'A' : dt > 0.005 ? 'B' : 'TIE')).toUpperCase();
      const accent = winner === 'A' ? THEME.leadA : winner === 'B' ? THEME.leadB : THEME.textSecondary;

      // Dashed vertical guide line across all 3 lanes
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, lane1.top);
      ctx.lineTo(x, lane3.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Milestone Flag Pill at Top
      const tagText = `${m.name || `${d.toFixed(0)} YD`} (${formatDeltaTime(dt)})`;
      ctx.font = `600 9px ${THEME.fontMono}`;
      const tagW = ctx.measureText(tagText).width + 8;
      const tagH = 15;
      const tagX = Math.max(this.layout.plotLeft, Math.min(this.layout.plotRight - tagW, x - tagW / 2));
      const tagY = lane1.top - 18;

      ctx.fillStyle = THEME.bgCard;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, tagW, tagH, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, tagX + tagW / 2, tagY + tagH / 2);
    });
    ctx.restore();
  }

  /**
   * Bottom Curvilinear Track Distance Axis.
   */
  renderCurvilinearAxis() {
    const { ctx } = this;
    const { plotLeft, plotWidth, axisTop } = this.layout;
    const maxD = this.maxDistance;

    ctx.save();
    ctx.strokeStyle = THEME.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, axisTop);
    ctx.lineTo(plotLeft + plotWidth, axisTop);
    ctx.stroke();

    // Determine tick interval: 5 or 10 yards
    const tickStep = maxD <= 45 ? 5 : 10;
    ctx.font = `600 10px ${THEME.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let d = 0; d <= maxD; d += tickStep) {
      const x = this.distanceToX(d);
      ctx.strokeStyle = THEME.borderLight;
      ctx.beginPath();
      ctx.moveTo(x, axisTop);
      ctx.lineTo(x, axisTop + 5);
      ctx.stroke();

      ctx.fillStyle = THEME.textSecondary;
      ctx.fillText(`${d} yd`, x, axisTop + 7);
    }

    // Title label
    ctx.fillStyle = THEME.textMuted;
    ctx.font = `600 10px ${THEME.fontSans}`;
    ctx.textAlign = 'right';
    ctx.fillText('CURVILINEAR TRACK DISTANCE d (YARDS)', plotLeft + plotWidth, axisTop + 8);

    ctx.restore();
  }

  /**
   * Crosshair & Interactive Telemetry Tooltip HUD.
   */
  renderCrosshairAndHUD() {
    const { ctx } = this;
    const { plotLeft, plotRight, lane1, lane2, lane3, miniSector } = this.layout;
    const d = this.scrubDistance;

    if (!Number.isFinite(d) || d < 0 || d > this.maxDistance) return;

    const crossX = this.distanceToX(d);

    ctx.save();

    // 1. Vertical Glowing Crosshair Line
    ctx.strokeStyle = THEME.crosshair;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = THEME.crosshairGlow;
    ctx.shadowBlur = 6;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    ctx.moveTo(crossX, miniSector.top);
    ctx.lineTo(crossX, lane3.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Sample telemetry at distance d
    const dt = sampleSeries(this.data.grid_distance, this.data.delta_time, d);
    const speedA = sampleSeries(this.data.grid_distance, this.data.speeds_a, d) * this.options.speedMultiplier;
    const speedB = sampleSeries(this.data.grid_distance, this.data.speeds_b, d) * this.options.speedMultiplier;
    const ptA = samplePointAtDistance(this.data.resampled_a?.points, d);
    const ptB = samplePointAtDistance(this.data.resampled_b?.points, d);

    // 2. Dots at Lane Intersections
    const drawDot = (y, color) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(crossX, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    // Lane 1 Dot
    const limitDt = Math.max(0.1, Math.ceil((Math.abs(dt) || 0.15) * 10) / 10);
    const yDt = lane1.midY + (dt / limitDt) * (lane1.height * 0.42);
    drawDot(yDt, dt <= 0 ? THEME.leadA : THEME.leadB);

    // Lane 2 Dots (Speeds)
    let maxSpeed = Math.max(10, speedA, speedB) * 1.15;
    const speedToY = (spd) => lane2.bottom - 8 - (spd / maxSpeed) * (lane2.height - 24);
    drawDot(speedToY(speedA), THEME.playerA);
    drawDot(speedToY(speedB), THEME.playerB);

    // Lane 3 Dots (Sideslip or Combined G-Force)
    if (this.lane3Mode === 'g_force') {
      const bottomPad = 8;
      const topPad = 16;
      const plotH = lane3.height - bottomPad - topPad;
      const gToY = (g) => lane3.bottom - bottomPad - (Math.max(0, Math.min(1.4, g)) / 1.4) * plotH;
      if (ptA) drawDot(gToY(ptA.g_comb ?? 0), THEME.playerA);
      if (ptB) drawDot(gToY(ptB.g_comb ?? 0), THEME.playerB);
    } else {
      const betaToY = (beta) => lane3.midY - (Math.max(-35, Math.min(35, beta)) / 35.0) * (lane3.height * 0.42);
      if (ptA) drawDot(betaToY(ptA.beta_slip ?? 0), THEME.playerA);
      if (ptB) drawDot(betaToY(ptB.beta_slip ?? 0), THEME.playerB);
    }

    // 3. Floating HUD Tooltip (Vehicle Dynamics & Kinematics)
    const hudW = 270;
    const hudH = 120;
    // Smart placement: keep inside canvas bounds
    let hudX = crossX + 14;
    if (hudX + hudW > plotRight + 20) {
      hudX = crossX - hudW - 14;
    }
    const hudY = Math.max(lane1.top, Math.min(lane3.bottom - hudH, (this.hoverY || lane1.top + 30) - hudH / 2));

    ctx.save();
    // Glassmorphism Box
    ctx.fillStyle = THEME.bgCard;
    ctx.strokeStyle = THEME.borderLight;
    ctx.lineWidth = 1;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.roundRect(hudX, hudY, hudW, hudH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Header: Distance & Delta Time
    ctx.font = `700 11px ${THEME.fontMono}`;
    ctx.fillStyle = THEME.textPrimary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`d = ${d.toFixed(1)} yd`, hudX + 10, hudY + 8);

    const deltaSignColor = dt <= 0 ? THEME.leadA : THEME.leadB;
    const deltaLeader = dt <= 0 ? (this.data.player_a_name || 'A') : (this.data.player_b_name || 'B');
    ctx.fillStyle = deltaSignColor;
    ctx.textAlign = 'right';
    ctx.fillText(`Δt: ${formatDeltaTime(dt)} (${deltaLeader})`, hudX + hudW - 10, hudY + 8);

    // Divider Line
    ctx.strokeStyle = THEME.border;
    ctx.beginPath();
    ctx.moveTo(hudX + 8, hudY + 24);
    ctx.lineTo(hudX + hudW - 8, hudY + 24);
    ctx.stroke();

    // Player A Telemetry Row (Speed, Combined G, Sideslip)
    const unit = this.options.speedUnit;
    ctx.font = `600 10px ${THEME.fontSans}`;
    ctx.fillStyle = THEME.playerA;
    ctx.textAlign = 'left';
    ctx.fillText(this.data.player_a_name || 'Player A', hudX + 10, hudY + 30);

    ctx.font = `500 10px ${THEME.fontMono}`;
    ctx.fillStyle = THEME.textPrimary;
    ctx.textAlign = 'right';
    const aSlip = ptA?.beta_slip ? `${ptA.beta_slip.toFixed(1)}°` : '0.0°';
    const aG = ptA?.g_comb ? `${ptA.g_comb.toFixed(2)}g` : '0.00g';
    ctx.fillText(`${speedA.toFixed(1)} ${unit} | G: ${aG} | β: ${aSlip}`, hudX + hudW - 10, hudY + 30);

    // Player B Telemetry Row (Speed, Combined G, Sideslip)
    ctx.font = `600 10px ${THEME.fontSans}`;
    ctx.fillStyle = THEME.playerB;
    ctx.textAlign = 'left';
    ctx.fillText(this.data.player_b_name || 'Player B', hudX + 10, hudY + 46);

    ctx.font = `500 10px ${THEME.fontMono}`;
    ctx.fillStyle = THEME.textPrimary;
    ctx.textAlign = 'right';
    const bSlip = ptB?.beta_slip ? `${ptB.beta_slip.toFixed(1)}°` : '0.0°';
    const bG = ptB?.g_comb ? `${ptB.g_comb.toFixed(2)}g` : '0.00g';
    ctx.fillText(`${speedB.toFixed(1)} ${unit} | G: ${bG} | β: ${bSlip}`, hudX + hudW - 10, hudY + 46);

    // Trail-Braking Overlap Index row
    ctx.font = `600 9px ${THEME.fontSans}`;
    ctx.fillStyle = THEME.textSecondary;
    ctx.textAlign = 'left';
    const olA = ((this.data.overlap_index_a || 0) * 100).toFixed(0);
    const olB = ((this.data.overlap_index_b || 0) * 100).toFixed(0);
    ctx.fillText(`Trail-Braking Overlap: A ${olA}% vs B ${olB}%`, hudX + 10, hudY + 64);

    // Apex Speed & Exit Traction or Status Alert
    const nearApex = (this.data.apexes_a || []).concat(this.data.apexes_b || []).find(ap => Math.abs((ap.distance ?? 0) - d) <= 1.5);
    if (nearApex) {
      const vApex = nearApex.v_apex ?? nearApex.apex_speed ?? nearApex.speed ?? 0;
      const exitTrac = nearApex.exit_traction ?? 0;
      const signExit = exitTrac >= 0 ? '+' : '';
      ctx.fillStyle = '#38bdf8';
      ctx.textAlign = 'left';
      ctx.fillText(`Apex: v_apex: ${vApex.toFixed(1)} yd/s | Exit: ${signExit}${exitTrac.toFixed(1)} yd/s²`, hudX + 10, hudY + 80);
    } else {
      const hasSnap = ptA?.snap_oversteer || ptB?.snap_oversteer || Math.abs(ptA?.beta_slip || 0) >= 18 || Math.abs(ptB?.beta_slip || 0) >= 18;
      ctx.font = `600 9px ${THEME.fontSans}`;
      ctx.textAlign = 'left';
      if (hasSnap) {
        ctx.fillStyle = THEME.warningRed;
        ctx.fillText('⚡ SNAP DRIFT / BALANCE INSTABILITY', hudX + 10, hudY + 80);
      } else {
        ctx.fillStyle = THEME.leadA;
        ctx.fillText('✓ CONTROLLED KINEMATIC TRACTION', hudX + 10, hudY + 80);
      }
    }

    // Mini Sector Delta if available
    const activeSec = (this.data.mini_sectors || []).find((s) => d >= s.start_distance && d <= s.end_distance);
    if (activeSec) {
      ctx.fillStyle = THEME.textSecondary;
      ctx.font = `500 9px ${THEME.fontMono}`;
      ctx.textAlign = 'left';
      ctx.fillText(`Sector: ${formatDeltaTime(activeSec.delta_time)}`, hudX + 10, hudY + 98);
    }

    ctx.restore();
  }

  /**
   * Cleanup listeners on destroy.
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mouseenter', this.handleMouseEnter);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    this.canvas.removeEventListener('touchstart', this.handleTouchMove);
    this.canvas.removeEventListener('touchmove', this.handleTouchMove);
    this.canvas.removeEventListener('touchend', this.handleMouseLeave);
    this.onScrubCallbacks.clear();
  }
}

// ============================================================================
// 4. SpatialOverlayCanvas Class
// ============================================================================
export class SpatialOverlayCanvas {
  /**
   * @param {HTMLCanvasElement|string} canvasElement
   * @param {Object} options
   */
  constructor(canvasElement, options = {}) {
    this.canvas = typeof canvasElement === 'string'
      ? document.getElementById(canvasElement)
      : canvasElement;

    if (!this.canvas) {
      throw new Error('SpatialOverlayCanvas: Canvas element not found.');
    }

    this.ctx = this.canvas.getContext('2d');
    this.options = {
      padding: options.padding || 36,
      alignStart: options.alignStart !== false, // align start points to (0,0)
      showGrid: options.showGrid !== false,
      showVectors: options.showVectors !== false,
      ...options
    };

    this.data = null;
    this.pointsA = [];
    this.pointsB = [];
    this.maxDistance = 40.0;
    this.scrubDistance = 0.0;
    this.isDragging = false;
    this.onScrubCallbacks = new Set();

    if (typeof options.onScrub === 'function') {
      this.onScrubCallbacks.add(options.onScrub);
    }

    // Affine transform & viewport bounding box
    this.transform = {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      cssWidth: 600,
      cssHeight: 400,
      minX: -5,
      maxX: 45,
      minY: -10,
      maxY: 10
    };

    // Bind event handlers
    this.handleResize = this.handleResize.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);

    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.canvas.parentElement);
    }
    window.addEventListener('resize', this.handleResize);

    this.canvas.addEventListener('mousedown', this.handlePointerDown);
    window.addEventListener('mousemove', this.handlePointerMove);
    window.addEventListener('mouseup', this.handlePointerUp);

    this.handleResize();
  }

  handleResize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(200, Math.floor(rect.width || this.canvas.clientWidth || 600));
    const cssHeight = Math.max(200, Math.floor(rect.height || this.canvas.clientHeight || 400));

    const bufW = Math.round(cssWidth * dpr);
    const bufH = Math.round(cssHeight * dpr);

    if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
      this.canvas.width = bufW;
      this.canvas.height = bufH;
    }

    this.computeTransform(cssWidth, cssHeight);
    this.render();
  }

  setData(comparisonData) {
    if (!comparisonData || typeof comparisonData !== 'object') {
      this.data = null;
      this.pointsA = [];
      this.pointsB = [];
      this.render();
      return;
    }

    this.data = comparisonData;
    let rawA = comparisonData.resampled_a?.points || [];
    let rawB = comparisonData.resampled_b?.points || [];

    // Optional trajectory alignment: shift start to (0, 0)
    if (this.options.alignStart && rawA.length > 0) {
      const startAx = rawA[0].x ?? 0;
      const startAy = rawA[0].y ?? 0;
      this.pointsA = rawA.map((p) => ({ ...p, x: (p.x ?? 0) - startAx, y: (p.y ?? 0) - startAy }));
    } else {
      this.pointsA = rawA.slice();
    }

    if (this.options.alignStart && rawB.length > 0) {
      const startBx = rawB[0].x ?? 0;
      const startBy = rawB[0].y ?? 0;
      this.pointsB = rawB.map((p) => ({ ...p, x: (p.x ?? 0) - startBx, y: (p.y ?? 0) - startBy }));
    } else {
      this.pointsB = rawB.slice();
    }

    // Determine max curvilinear distance
    let maxDist = Number(comparisonData.common_max_distance);
    if (!Number.isFinite(maxDist) || maxDist <= 0) {
      maxDist = Math.max(
        ...this.pointsA.map((p) => p.distance ?? 0),
        ...this.pointsB.map((p) => p.distance ?? 0),
        40.0
      );
    }
    this.maxDistance = Math.max(1.0, maxDist);

    const rect = this.canvas.getBoundingClientRect();
    this.computeTransform(rect.width || 600, rect.height || 400);
    this.render();
  }

  setScrubDistance(distanceYards) {
    if (!Number.isFinite(distanceYards)) return;
    this.scrubDistance = Math.max(0, Math.min(this.maxDistance, distanceYards));
    this.render();
  }

  onScrub(callback) {
    if (typeof callback === 'function') {
      this.onScrubCallbacks.add(callback);
    }
    return () => this.onScrubCallbacks.delete(callback);
  }

  _dispatchScrub(distanceYards) {
    for (const cb of this.onScrubCallbacks) {
      try {
        cb(distanceYards);
      } catch (err) {
        console.error('SpatialOverlayCanvas onScrub error:', err);
      }
    }
  }

  /**
   * Compute aspect-ratio preserving affine transformation.
   */
  computeTransform(cssWidth, cssHeight) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    const checkPoint = (p) => {
      if (!p) return;
      if (Number.isFinite(p.x)) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
      }
      if (Number.isFinite(p.y)) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    };

    this.pointsA.forEach(checkPoint);
    this.pointsB.forEach(checkPoint);

    if (!Number.isFinite(minX)) {
      minX = -2; maxX = 42;
      minY = -6; maxY = 6;
    }

    // Enforce minimum spans to avoid zero-division
    const spanX = Math.max(10.0, maxX - minX);
    const spanY = Math.max(8.0, maxY - minY);

    // Padding in yards
    const padX = spanX * 0.12;
    const padY = spanY * 0.12;
    minX -= padX; maxX += padX;
    minY -= padY; maxY += padY;

    const paddingPx = this.options.padding;
    const availW = Math.max(10, cssWidth - 2 * paddingPx);
    const availH = Math.max(10, cssHeight - 2 * paddingPx);

    // Uniform 1:1 scale (1 yard in X = 1 yard in Y)
    const scale = Math.min(availW / (maxX - minX), availH / (maxY - minY));

    const contentW = (maxX - minX) * scale;
    const contentH = (maxY - minY) * scale;

    this.transform = {
      scale,
      offsetX: paddingPx + (availW - contentW) / 2,
      offsetY: paddingPx + (availH - contentH) / 2,
      cssWidth,
      cssHeight,
      minX,
      maxX,
      minY,
      maxY
    };
  }

  // Bijective projection helpers (NFL Field Y is inverted in screen space)
  yardToPixel(x, y) {
    const t = this.transform;
    return {
      px: t.offsetX + (x - t.minX) * t.scale,
      py: (t.cssHeight - t.offsetY) - (y - t.minY) * t.scale
    };
  }

  pixelToYard(px, py) {
    const t = this.transform;
    return {
      x: t.minX + (px - t.offsetX) / t.scale,
      y: t.minY + ((t.cssHeight - t.offsetY) - py) / t.scale
    };
  }

  // --- Pointer scrubbing on 2D trajectory ---
  handlePointerDown(e) {
    this.isDragging = true;
    this.scrubNearestToCursor(e);
  }

  handlePointerMove(e) {
    if (!this.isDragging) return;
    this.scrubNearestToCursor(e);
  }

  handlePointerUp() {
    this.isDragging = false;
  }

  scrubNearestToCursor(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const yardCoord = this.pixelToYard(px, py);

    let bestDist = 0;
    let minErr = Infinity;

    const testPoints = this.pointsA.length > 0 ? this.pointsA : this.pointsB;
    testPoints.forEach((p) => {
      const dx = (p.x ?? 0) - yardCoord.x;
      const dy = (p.y ?? 0) - yardCoord.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < minErr) {
        minErr = dSq;
        bestDist = p.distance ?? 0;
      }
    });

    this.setScrubDistance(bestDist);
    this._dispatchScrub(bestDist);
  }

  // ==========================================================================
  // 2D TRAJECTORY RENDER PIPELINE
  // ==========================================================================
  render() {
    const { ctx } = this;
    const { cssWidth, cssHeight } = this.transform;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Deep Turf Canvas Background
    ctx.fillStyle = THEME.bgPrimary;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    if (this.pointsA.length === 0 && this.pointsB.length === 0) {
      this.renderEmptyState();
      ctx.restore();
      return;
    }

    // 1. Metric 5-Yard Field Grid
    if (this.options.showGrid) {
      this.renderMetricGrid();
    }

    // 2. Trajectory Curves
    this.renderTrajectory(this.pointsB, THEME.playerB, THEME.playerBGlow);
    this.renderTrajectory(this.pointsA, THEME.playerA, THEME.playerAGlow);

    // 3. Directional Chevrons
    this.renderDirectionChevrons(this.pointsA, THEME.playerA);
    this.renderDirectionChevrons(this.pointsB, THEME.playerB);

    // 4. Start & Finish Pins
    this.renderStartAndFinishPins();

    // 5. Milestone & Apex Markers along 2D curve
    this.renderApexMarkers();

    // 6. Active Scrub Positions (Player Dots, Slip Vectors & Separation Line)
    this.renderScrubMarkers();

    // 7. Corner Telemetry HUD Card
    this.renderHUD();

    ctx.restore();
  }

  renderEmptyState() {
    const { ctx } = this;
    const { cssWidth, cssHeight } = this.transform;
    ctx.fillStyle = THEME.textMuted;
    ctx.font = `500 13px ${THEME.fontSans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Awaiting spatial trajectory coordinates...', cssWidth / 2, cssHeight / 2);
  }

  renderMetricGrid() {
    const { ctx } = this;
    const { minX, maxX, minY, maxY } = this.transform;

    ctx.save();
    ctx.strokeStyle = THEME.gridLine;
    ctx.lineWidth = 0.75;
    ctx.setLineDash([2, 4]);

    const step = 5.0; // yards
    const startX = Math.floor(minX / step) * step;
    const endX = Math.ceil(maxX / step) * step;
    const startY = Math.floor(minY / step) * step;
    const endY = Math.ceil(maxY / step) * step;

    // Vertical yard lines
    for (let x = startX; x <= endX; x += step) {
      const p1 = this.yardToPixel(x, minY);
      const p2 = this.yardToPixel(x, maxY);
      ctx.beginPath();
      ctx.moveTo(p1.px, p1.py);
      ctx.lineTo(p2.px, p2.py);
      ctx.stroke();

      ctx.fillStyle = THEME.textMuted;
      ctx.font = `500 9px ${THEME.fontMono}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${x.toFixed(0)}y`, p1.px, p1.py - 4);
    }

    // Horizontal yard lines
    for (let y = startY; y <= endY; y += step) {
      const p1 = this.yardToPixel(minX, y);
      const p2 = this.yardToPixel(maxX, y);
      ctx.beginPath();
      ctx.moveTo(p1.px, p1.py);
      ctx.lineTo(p2.px, p2.py);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  renderTrajectory(points, strokeColor, glowColor) {
    if (points.length < 2) return;
    const { ctx } = this;

    ctx.save();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 3.0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 8;

    ctx.beginPath();
    const start = this.yardToPixel(points[0].x ?? 0, points[0].y ?? 0);
    ctx.moveTo(start.px, start.py);

    for (let i = 1; i < points.length; i++) {
      const pt = this.yardToPixel(points[i].x ?? 0, points[i].y ?? 0);
      ctx.lineTo(pt.px, pt.py);
    }
    ctx.stroke();
    ctx.restore();
  }

  renderDirectionChevrons(points, color) {
    if (points.length < 5) return;
    const { ctx } = this;
    const stepDist = 4.0; // every 4 yards

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;

    let nextTarget = stepDist;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if ((p.distance ?? 0) >= nextTarget) {
        nextTarget += stepDist;
        const prev = points[i - 1];
        const screenP = this.yardToPixel(p.x ?? 0, p.y ?? 0);
        const screenPrev = this.yardToPixel(prev.x ?? 0, prev.y ?? 0);

        const angle = Math.atan2(screenP.py - screenPrev.py, screenP.px - screenPrev.px);
        
        ctx.save();
        ctx.translate(screenP.px, screenP.py);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.lineTo(-4, -3);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-4, 3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  renderStartAndFinishPins() {
    const { ctx } = this;
    const refPoints = this.pointsA.length > 0 ? this.pointsA : this.pointsB;
    if (refPoints.length === 0) return;

    ctx.save();

    // Start Pin (d = 0)
    const pStart = this.yardToPixel(refPoints[0].x ?? 0, refPoints[0].y ?? 0);
    ctx.fillStyle = THEME.leadA;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pStart.px, pStart.py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.font = `700 9px ${THEME.fontMono}`;
    ctx.fillStyle = THEME.leadA;
    ctx.textAlign = 'center';
    ctx.fillText('START', pStart.px, pStart.py - 10);

    // Finish Pin (d = max)
    const pEnd = this.yardToPixel(refPoints[refPoints.length - 1].x ?? 0, refPoints[refPoints.length - 1].y ?? 0);
    ctx.fillStyle = THEME.warningRed;
    ctx.beginPath();
    ctx.arc(pEnd.px, pEnd.py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = THEME.warningRed;
    ctx.fillText('FINISH', pEnd.px, pEnd.py - 10);

    ctx.restore();
  }

  renderApexMarkers() {
    const { ctx } = this;
    const apexesA = this.data?.apexes_a || [];
    const apexesB = this.data?.apexes_b || [];

    const drawApex = (apexList, points, color, label) => {
      apexList.forEach((ap, idx) => {
        const d = ap.distance ?? 0;
        const pt = samplePointAtDistance(points, d);
        if (!pt) return;

        const screenPt = this.yardToPixel(pt.x, pt.y);
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;

        // Diamond marker
        ctx.beginPath();
        ctx.moveTo(screenPt.px, screenPt.py - 5);
        ctx.lineTo(screenPt.px + 5, screenPt.py);
        ctx.lineTo(screenPt.px, screenPt.py + 5);
        ctx.lineTo(screenPt.px - 5, screenPt.py);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        const vApex = ap.v_apex ?? ap.apex_speed ?? ap.speed ?? pt.s ?? 0;
        const exitTrac = ap.exit_traction != null ? ap.exit_traction : 0;
        const exitSign = exitTrac >= 0 ? '+' : '';
        const txt = `Apex ${label}${idx + 1}: ${vApex.toFixed(1)} yd/s | Exit: ${exitSign}${exitTrac.toFixed(1)} yd/s²`;

        ctx.font = `600 9px ${THEME.fontMono}`;
        const w = ctx.measureText(txt).width + 8;
        ctx.fillStyle = THEME.bgCard;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(screenPt.px - w / 2, screenPt.py + 10, w, 16, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, screenPt.px, screenPt.py + 18);
        ctx.restore();
      });
    };

    drawApex(apexesA, this.pointsA, THEME.playerA, 'A');
    drawApex(apexesB, this.pointsB, THEME.playerB, 'B');
  }

  /**
   * Render Scrub Position Player Dots, Orientation/Velocity Vectors & Separation Line.
   */
  renderScrubMarkers() {
    const { ctx } = this;
    const d = this.scrubDistance;
    const ptA = samplePointAtDistance(this.pointsA, d);
    const ptB = samplePointAtDistance(this.pointsB, d);

    if (!ptA && !ptB) return;

    ctx.save();

    // 1. Spatial Separation Line between A and B
    if (ptA && ptB) {
      const spA = this.yardToPixel(ptA.x, ptA.y);
      const spB = this.yardToPixel(ptB.x, ptB.y);

      const dx = ptA.x - ptB.x;
      const dy = ptA.y - ptB.y;
      const sepDist = Math.hypot(dx, dy);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(spA.px, spA.py);
      ctx.lineTo(spB.px, spB.py);
      ctx.stroke();
      ctx.setLineDash([]);

      if (sepDist > 0.4) {
        const midX = (spA.px + spB.px) / 2;
        const midY = (spA.py + spB.py) / 2;
        ctx.font = `600 9px ${THEME.fontMono}`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(`Δpos: ${sepDist.toFixed(1)} yd`, midX, midY - 6);
      }
    }

    // 2. Render Player Marker Helper
    const drawPlayerDot = (pt, color, glowColor, label) => {
      if (!pt) return;
      const sp = this.yardToPixel(pt.x, pt.y);

      // Outer glow ring
      ctx.save();
      ctx.fillStyle = glowColor;
      ctx.beginPath();
      ctx.arc(sp.px, sp.py, 10, 0, Math.PI * 2);
      ctx.fill();

      // Main dot
      ctx.fillStyle = color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.px, sp.py, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Vectors: Motion (dir) vs Facing (o)
      if (this.options.showVectors) {
        const arrowLen = 22;

        // Motion direction vector (Velocity vector)
        const radDir = ((pt.dir ?? 0) * Math.PI) / 180;
        // Invert Y because canvas Y points down
        const dirVx = Math.cos(radDir) * arrowLen;
        const dirVy = -Math.sin(radDir) * arrowLen;

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sp.px, sp.py);
        ctx.lineTo(sp.px + dirVx, sp.py + dirVy);
        ctx.stroke();

        // Facing direction vector (Body orientation)
        const radO = ((pt.o ?? pt.dir ?? 0) * Math.PI) / 180;
        const oVx = Math.cos(radO) * (arrowLen * 0.85);
        const oVy = -Math.sin(radO) * (arrowLen * 0.85);

        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(sp.px, sp.py);
        ctx.lineTo(sp.px + oVx, sp.py + oVy);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();
    };

    drawPlayerDot(ptB, THEME.playerB, THEME.playerBGlow, 'B');
    drawPlayerDot(ptA, THEME.playerA, THEME.playerAGlow, 'A');

    ctx.restore();
  }

  renderHUD() {
    const { ctx } = this;
    const { cssWidth } = this.transform;
    const d = this.scrubDistance;

    const ptA = samplePointAtDistance(this.pointsA, d);
    const ptB = samplePointAtDistance(this.pointsB, d);

    ctx.save();
    const hudW = 240;
    const hudH = 92;
    const hudX = cssWidth - hudW - 14;
    const hudY = 14;

    ctx.fillStyle = THEME.bgCard;
    ctx.strokeStyle = THEME.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(hudX, hudY, hudW, hudH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.font = `700 11px ${THEME.fontMono}`;
    ctx.fillStyle = THEME.textPrimary;
    ctx.textAlign = 'left';
    ctx.fillText(`Distance: ${d.toFixed(1)} yd`, hudX + 10, hudY + 16);

    ctx.font = `600 10px ${THEME.fontSans}`;
    ctx.fillStyle = THEME.playerA;
    const aTxt = ptA ? `s: ${ptA.s.toFixed(1)} yd/s | ${(ptA.g_comb ?? 0).toFixed(2)}g | β: ${ptA.beta_slip.toFixed(1)}°` : '--';
    ctx.fillText(`A: ${aTxt}`, hudX + 10, hudY + 36);

    ctx.fillStyle = THEME.playerB;
    const bTxt = ptB ? `s: ${ptB.s.toFixed(1)} yd/s | ${(ptB.g_comb ?? 0).toFixed(2)}g | β: ${ptB.beta_slip.toFixed(1)}°` : '--';
    ctx.fillText(`B: ${bTxt}`, hudX + 10, hudY + 54);

    ctx.font = `500 9px ${THEME.fontMono}`;
    ctx.fillStyle = THEME.textSecondary;
    const olA = ((this.data?.overlap_index_a ?? 0) * 100).toFixed(0);
    const olB = ((this.data?.overlap_index_b ?? 0) * 100).toFixed(0);
    ctx.fillText(`Overlap Index: A ${olA}% | B ${olB}%`, hudX + 10, hudY + 72);

    ctx.restore();
  }

  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('mousedown', this.handlePointerDown);
    window.removeEventListener('mousemove', this.handlePointerMove);
    window.removeEventListener('mouseup', this.handlePointerUp);
    this.onScrubCallbacks.clear();
  }
}

// Window attachment for standalone script tags
if (typeof window !== 'undefined') {
  window.SpatialStripCanvas = SpatialStripCanvas;
  window.SpatialOverlayCanvas = SpatialOverlayCanvas;
}
