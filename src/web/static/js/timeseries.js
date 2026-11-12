/**
 * timeseries.js - 10 Hz Kinematics Timeseries Canvas & Playback Synchronizer
 * Milestone M3: NFL Combine & Game Tracking Platform
 *
 * Exposes:
 * - PlaybackEngine: High-precision 10 Hz rAF playback controller with delta timing.
 * - TimeseriesCanvas: 4-metric stacked telemetry canvas with interactive scrubbing.
 */

// ============================================================================
// 1. High-Precision 10 Hz Playback Engine
// ============================================================================

export class PlaybackEngine {
    constructor(options = {}) {
        this.frames = [];
        this.totalFrames = options.totalFrames || 0;
        this.currentFrameIdx = 0;
        this.playbackRate = 1.0; // 0.5, 1.0, 2.0
        this.isPlaying = false;
        this.rafId = null;
        this.lastTimestamp = null;
        this.accumulator = 0.0;

        // Callback registries
        this.frameListeners = new Set();
        this.stateListeners = new Set();
        this.endedListeners = new Set();

        if (typeof options.onFrame === 'function') {
            this.onFrame(options.onFrame);
        }
        if (typeof options.onStateChange === 'function') {
            this.onStateChange(options.onStateChange);
        }
    }

    /**
     * Load telemetry frames (FrameDTO array) and reset playback state.
     * @param {Array<Object>|number} framesOrCount - Array of FrameDTO objects or count
     */
    loadFrames(framesOrCount = []) {
        this.pause();
        if (typeof framesOrCount === 'number') {
            this.totalFrames = framesOrCount;
            this.frames = [];
        } else {
            this.frames = Array.isArray(framesOrCount) ? framesOrCount : [];
            this.totalFrames = this.frames.length;
        }
        this.currentFrameIdx = 0;
        this.accumulator = 0.0;
        this.lastTimestamp = null;

        this._dispatchFrame(0);
        this._dispatchState();
    }

    /**
     * Start continuous playback using requestAnimationFrame with delta accumulation.
     */
    play() {
        if (this.totalFrames <= 1) return;

        // Replay from start if at end of drill
        if (this.currentFrameIdx >= this.totalFrames - 1) {
            this.currentFrameIdx = 0;
            this._dispatchFrame(0);
        }

        if (this.isPlaying) return;

        this.isPlaying = true;
        this.lastTimestamp = null;
        this.accumulator = 0.0;
        this._dispatchState();

        const loop = (timestamp) => {
            if (!this.isPlaying) return;

            if (this.lastTimestamp === null) {
                this.lastTimestamp = timestamp;
            }

            const deltaMs = timestamp - this.lastTimestamp;
            this.lastTimestamp = timestamp;

            // Guard against background tab throttling lag spikes (> 500ms)
            if (deltaMs > 500.0) {
                this.accumulator = 0.0;
                this.rafId = requestAnimationFrame(loop);
                return;
            }

            // Interval in ms based on playback rate (100ms at 1.0x)
            const frameIntervalMs = 100.0 / this.playbackRate;
            this.accumulator += deltaMs;

            const framesToAdvance = Math.floor(this.accumulator / frameIntervalMs);
            if (framesToAdvance > 0) {
                this.accumulator -= framesToAdvance * frameIntervalMs;
                const nextIdx = this.currentFrameIdx + framesToAdvance;

                if (nextIdx >= this.totalFrames - 1) {
                    // Reached end of drill -> auto pause (F11 invariant)
                    this.currentFrameIdx = this.totalFrames - 1;
                    this.isPlaying = false;
                    this._dispatchFrame(this.currentFrameIdx);
                    this._dispatchState();
                    this._dispatchEnded();
                    return;
                } else {
                    this.currentFrameIdx = nextIdx;
                    this._dispatchFrame(this.currentFrameIdx);
                }
            }

            if (this.isPlaying) {
                this.rafId = requestAnimationFrame(loop);
            }
        };

        this.rafId = requestAnimationFrame(loop);
    }

    /**
     * Pause playback.
     */
    pause() {
        if (!this.isPlaying) return;
        this.isPlaying = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.lastTimestamp = null;
        this.accumulator = 0.0;
        this._dispatchState();
    }

    /**
     * Toggle play/pause state.
     */
    togglePlay() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    /**
     * Seek to a specific frame index with boundary clamping in [0, totalFrames - 1].
     * @param {number} frameIdx
     */
    seek(frameIdx) {
        if (this.totalFrames <= 0) return;
        const clamped = Math.max(0, Math.min(this.totalFrames - 1, Math.round(frameIdx)));
        if (clamped === this.currentFrameIdx) return;

        this.currentFrameIdx = clamped;
        this.accumulator = 0.0;
        this._dispatchFrame(this.currentFrameIdx);

        if (this.currentFrameIdx >= this.totalFrames - 1 && this.isPlaying) {
            this.pause();
            this._dispatchEnded();
        }
    }

    /**
     * Step forward by exactly 1 frame (+0.1s).
     */
    stepForward() {
        this.pause();
        this.seek(this.currentFrameIdx + 1);
    }

    /**
     * Step backward by exactly 1 frame (-0.1s).
     */
    stepBackward() {
        this.pause();
        this.seek(this.currentFrameIdx - 1);
    }

    /**
     * Step by offset (+1 or -1).
     */
    step(delta = 1) {
        this.pause();
        this.seek(this.currentFrameIdx + delta);
    }

    /**
     * Reset to start.
     */
    reset() {
        this.pause();
        this.seek(0);
    }

    /**
     * Set playback rate multiplier.
     * @param {number} rate - 0.5, 1.0, or 2.0
     */
    setPlaybackRate(rate) {
        const validRates = [0.5, 1.0, 2.0];
        if (!validRates.includes(rate)) return;
        this.playbackRate = rate;
        this.accumulator = 0.0;
        this._dispatchState();
    }

    destroy() {
        this.pause();
        this.frameListeners.clear();
        this.stateListeners.clear();
        this.endedListeners.clear();
    }

    // ------------------------------------------------------------------------
    // Event Observer Subscription
    // ------------------------------------------------------------------------

    onFrame(callback) {
        this.frameListeners.add(callback);
        return () => this.frameListeners.delete(callback);
    }

    onStateChange(callback) {
        this.stateListeners.add(callback);
        return () => this.stateListeners.delete(callback);
    }

    onEnded(callback) {
        this.endedListeners.add(callback);
        return () => this.endedListeners.delete(callback);
    }

    _dispatchFrame(idx) {
        const frame = this.frames[idx] || null;
        for (const cb of this.frameListeners) {
            try { cb(idx, frame, this.totalFrames); } catch (e) { console.error(e); }
        }
    }

    _dispatchState() {
        const state = {
            isPlaying: this.isPlaying,
            playbackRate: this.playbackRate,
            currentFrameIdx: this.currentFrameIdx,
            totalFrames: this.totalFrames,
            currentTime: round2(this.currentFrameIdx * 0.1),
            totalDuration: round2(Math.max(0, (this.totalFrames - 1) * 0.1)),
        };
        for (const cb of this.stateListeners) {
            try { cb(state.isPlaying, state); } catch (e) { console.error(e); }
        }
    }

    _dispatchEnded() {
        for (const cb of this.endedListeners) {
            try { cb(); } catch (e) { console.error(e); }
        }
    }
}


// ============================================================================
// 2. Multi-Metric 10 Hz Timeseries Canvas
// ============================================================================

export class TimeseriesCanvas {
    constructor(canvasElement, playbackEngine = null) {
        this.canvas = typeof canvasElement === 'string' ? document.getElementById(canvasElement) : canvasElement;
        if (!this.canvas) throw new Error('TimeseriesCanvas: canvas element not found');

        this.ctx = this.canvas.getContext('2d');
        this.options = {};
        if (playbackEngine && typeof playbackEngine.onFrame === 'function') {
            this.playbackEngine = playbackEngine;
            this.playbackEngine.onFrame((idx) => {
                this.currentFrameIdx = idx;
                this.render();
            });
        } else if (playbackEngine && typeof playbackEngine === 'object') {
            this.options = playbackEngine;
            this.playbackEngine = playbackEngine.playbackEngine || null;
            if (this.playbackEngine && typeof this.playbackEngine.onFrame === 'function') {
                this.playbackEngine.onFrame((idx) => {
                    this.currentFrameIdx = idx;
                    this.render();
                });
            }
        } else {
            this.playbackEngine = null;
        }

        this.frames = [];
        this.events = [];
        this.totalFrames = 0;
        this.currentFrameIdx = 0;
        this.cursorFrameIdx = 0;

        // Visual Layout Geometry (CSS pixels)
        this.margins = { top: 22, right: 20, bottom: 26, left: 65 };
        this.width = 600;
        this.height = 420;

        // Dynamic Metric Definitions
        const wantSlip = Boolean(
            this.options.numLanes === 5 ||
            this.options.includeSlipAngle ||
            (this.options.lanes && this.options.lanes.length === 5)
        );
        this._configureMetrics(wantSlip);

        // Interaction state
        this.isScrubbing = false;
        this.hoverFrameIdx = null;

        this._setupInteractions();
        this._setupResizeObserver();
    }

    /**
     * Configure metric lanes: 4 lanes for Combine, 5 lanes for Game Snaps with slip_angle
     */
    _configureMetrics(includeSlipAngle = false) {
        const baseMetrics = [
            {
                key: 's',
                label: 'SPEED',
                unit: 'yd/s',
                color: '#06b6d4', // Cyan
                gradientStart: 'rgba(6, 182, 212, 0.25)',
                minHeadroom: 4.0,
                symmetric: false,
                decimals: 1,
            },
            {
                key: 'a',
                label: 'ACCEL',
                unit: 'yd/s²',
                color: '#8b5cf6', // Violet
                gradientStart: 'rgba(139, 92, 246, 0.25)',
                minHeadroom: 2.0,
                symmetric: true, // Signed, zero baseline
                decimals: 1,
            },
            {
                key: 'omega',
                label: 'ANG VEL',
                unit: '°/s',
                color: '#f59e0b', // Amber
                gradientStart: 'rgba(245, 158, 11, 0.25)',
                minHeadroom: 45.0,
                symmetric: false,
                decimals: 0,
            },
            {
                key: 'curvature',
                alias: 'kappa',
                label: 'CURVATURE',
                unit: 'rad/yd',
                color: '#10b981', // Emerald
                gradientStart: 'rgba(16, 185, 129, 0.25)',
                minHeadroom: 0.3,
                symmetric: false,
                decimals: 3,
            },
        ];

        if (includeSlipAngle) {
            baseMetrics.push({
                key: 'slip_angle',
                alias: 'beta_slip',
                label: 'SLIP ANGLE',
                unit: '°',
                color: '#f43f5e', // Rose
                gradientStart: 'rgba(244, 63, 94, 0.25)',
                minHeadroom: 60.0,
                fixedRange: [-180.0, 180.0],
                symmetric: true,
                decimals: 1,
                hasCenterLine: true,
                hasBands: true,
            });
        }

        this.metrics = baseMetrics;
    }

    /**
     * Load telemetry frames into the canvas.
     * @param {Array<Object>} frames - FrameDTO list
     * @param {Array<Object>} events - EventMarker list
     */
    loadFrames(frames = [], events = []) {
        this.frames = Array.isArray(frames) ? frames : [];
        this.events = Array.isArray(events) ? events : [];
        this.totalFrames = this.frames.length;
        this.currentFrameIdx = 0;

        // Detect if telemetry has valid orientation / slip_angle data
        const hasSlipAngle = this.frames.some(
            f => f && (typeof f.slip_angle === 'number' || typeof f.beta_slip === 'number')
        );

        this._configureMetrics(hasSlipAngle);
        this._computeMetricScales();
        this.render();
    }

    get lanes() {
        return this.metrics;
    }

    loadData(frames = [], events = []) {
        return this.loadFrames(frames, events);
    }

    setFrame(frameIndex) {
        if (this.totalFrames === 0) return;
        this.currentFrameIdx = Math.max(0, Math.min(this.totalFrames - 1, frameIndex));
        this.render();
    }

    setCursor(frameIndex) {
        this.cursorFrameIdx = frameIndex;
        this.setFrame(frameIndex);
    }

    seek(frameIndex) {
        this.setFrame(frameIndex);
    }

    _setupResizeObserver() {
        if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
            const ro = new ResizeObserver(() => this.resize());
            ro.observe(this.canvas.parentElement);
        }
        window.addEventListener('resize', () => this.resize());
        this.resize();
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.width = rect.width > 0 ? rect.width : (this.canvas.parentElement?.clientWidth || 600);
        this.height = rect.height > 0 ? rect.height : 420;

        const bufW = Math.floor(this.width * dpr);
        const bufH = Math.floor(this.height * dpr);
        if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
            this.canvas.width = bufW;
            this.canvas.height = bufH;
        }

        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);

        this.render();
    }

    _computeMetricScales() {
        if (this.totalFrames === 0) return;

        for (const m of this.metrics) {
            if (m.fixedRange) {
                m.yMin = m.fixedRange[0];
                m.yMax = m.fixedRange[1];
                continue;
            }

            const vals = this.frames.map((f) => {
                const v = f[m.key] ?? (m.alias ? f[m.alias] : undefined);
                return typeof v === 'number' && !isNaN(v) ? v : 0.0;
            });

            if (m.symmetric) {
                // Symmetrical around 0: [-maxAbs, +maxAbs]
                const maxAbs = Math.max(m.minHeadroom, ...vals.map(Math.abs));
                m.yMin = -maxAbs * 1.15;
                m.yMax = maxAbs * 1.15;
            } else {
                // Positive metrics: [0, max * 1.15]
                const maxVal = Math.max(m.minHeadroom, ...vals);
                m.yMin = 0.0;
                m.yMax = maxVal * 1.15;
            }
        }
    }

    /**
     * Main rendering loop
     */
    render() {
        const { ctx, width, height, margins, metrics, totalFrames, currentFrameIdx } = this;
        ctx.clearRect(0, 0, width, height);

        // Canvas dark background
        ctx.fillStyle = '#0f172a'; // slate-900
        ctx.fillRect(0, 0, width, height);

        if (totalFrames === 0) {
            this._renderEmptyState();
            return;
        }

        const plotWidth = Math.max(10, width - margins.left - margins.right);
        const plotHeight = Math.max(10, height - margins.top - margins.bottom);
        const laneCount = metrics.length;
        const laneHeight = plotHeight / laneCount;
        const totalDuration = Math.max(0.1, (totalFrames - 1) * 0.1);

        // 1. Draw Lane Backgrounds, Separators, Severity Bands, and Zero-baselines
        for (let i = 0; i < laneCount; i++) {
            const laneTop = margins.top + i * laneHeight;
            const laneBottom = laneTop + laneHeight;
            const m = metrics[i];

            // Slip Angle Reference Severity Bands
            if (m.hasBands) {
                const yCenter = laneBottom - 0.5 * laneHeight;
                const bandHeight20 = (20.0 / 180.0) * (laneHeight / 2);
                const bandHeight45 = (45.0 / 180.0) * (laneHeight / 2);

                // Normal [-20°, +20°] band
                ctx.fillStyle = 'rgba(6, 182, 212, 0.05)';
                ctx.fillRect(margins.left, yCenter - bandHeight20, plotWidth, bandHeight20 * 2);

                // Cut bands [-45°, -20°] and [+20°, +45°]
                ctx.fillStyle = 'rgba(245, 158, 11, 0.05)';
                ctx.fillRect(margins.left, yCenter - bandHeight45, plotWidth, bandHeight45 - bandHeight20);
                ctx.fillRect(margins.left, yCenter + bandHeight20, plotWidth, bandHeight45 - bandHeight20);

                // High slip bands
                ctx.fillStyle = 'rgba(244, 63, 94, 0.05)';
                ctx.fillRect(margins.left, laneTop, plotWidth, Math.max(0, (laneHeight / 2) - bandHeight45));
                ctx.fillRect(margins.left, yCenter + bandHeight45, plotWidth, Math.max(0, (laneHeight / 2) - bandHeight45));
            }

            // Horizontal separator
            ctx.strokeStyle = '#1e293b'; // slate-800
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(margins.left, laneBottom);
            ctx.lineTo(margins.left + plotWidth, laneBottom);
            ctx.stroke();

            // Zero reference baseline for signed metrics (acceleration & slip angle)
            if (m.symmetric || m.hasCenterLine) {
                const zeroY = laneBottom - ((0.0 - m.yMin) / (m.yMax - m.yMin)) * laneHeight;
                ctx.strokeStyle = '#334155'; // slate-700
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(margins.left, zeroY);
                ctx.lineTo(margins.left + plotWidth, zeroY);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Lane Title & Unit Label (Left header)
            ctx.font = '600 10px Inter, system-ui, sans-serif';
            ctx.fillStyle = m.color;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`${m.label} (${m.unit})`, margins.left + 6, laneTop + 3);

            // Min and Max Axis Labels (Left gutter)
            ctx.font = '500 9px monospace, sans-serif';
            ctx.fillStyle = '#64748b'; // slate-500
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(m.yMax.toFixed(m.decimals === 0 ? 0 : 1), margins.left - 6, laneTop + 6);
            ctx.fillText(m.yMin.toFixed(m.decimals === 0 ? 0 : 1), margins.left - 6, laneBottom - 6);

            // Active Value Readout (Right header)
            const curFrame = this.frames[currentFrameIdx];
            if (curFrame) {
                const curVal = curFrame[m.key] ?? (m.alias ? curFrame[m.alias] : 0.0);
                const prefix = m.symmetric && curVal > 0 ? '+' : '';
                let textVal = `${prefix}${(Number(curVal) || 0).toFixed(m.decimals)} ${m.unit}`;

                // Add descriptive tag for slip angle with beta_dot, jerk, and snap oversteer
                if (m.key === 'slip_angle') {
                    const absBeta = Math.abs(Number(curVal) || 0);
                    const bDot = Math.abs(Number(curFrame.beta_rate !== undefined ? curFrame.beta_rate : (curFrame.slip_rate || 0)) || 0);
                    const jerkVal = Math.abs(Number(curFrame.jerk) || 0);
                    const isSnap = Boolean(curFrame.snap_oversteer);

                    let tag = ' [ON RAILS]';
                    if (isSnap) {
                        tag = ' [⚡ SNAP OVERSTEER / LOSS OF BALANCE]';
                    } else if (absBeta > 45) {
                        tag = ' [LATERAL / BACKPEDAL]';
                    } else if (absBeta >= 10) {
                        tag = ' [CONTROLLED DRIFT]';
                    }
                    textVal += ` | β̇: ${bDot.toFixed(0)}°/s | j: ${jerkVal.toFixed(1)} yd/s³${tag}`;
                }

                ctx.font = '600 11px monospace, sans-serif';
                ctx.fillStyle = '#f8fafc';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'top';
                ctx.fillText(textVal, margins.left + plotWidth - 6, laneTop + 3);
            }
        }

        // 2. Vertical Time Gridlines & X-Axis Ticks
        const timeStep = totalDuration > 4.0 ? 1.0 : 0.5;
        ctx.font = '500 9px monospace, sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        for (let t = 0.0; t <= totalDuration + 0.01; t += timeStep) {
            const gx = margins.left + (t / totalDuration) * plotWidth;
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(gx, margins.top);
            ctx.lineTo(gx, margins.top + plotHeight);
            ctx.stroke();

            // X-axis time label at bottom
            ctx.fillText(`${t.toFixed(1)}s`, gx, margins.top + plotHeight + 6);
        }

        // 3. Render Metric Curves
        for (let k = 0; k < laneCount; k++) {
            const m = metrics[k];
            const laneTop = margins.top + k * laneHeight;
            const laneBottom = laneTop + laneHeight;
            const ySpan = m.yMax - m.yMin || 1.0;

            const getY = (val) => {
                const norm = (val - m.yMin) / ySpan;
                return laneBottom - norm * (laneHeight - 6) - 3;
            };

            // Area Gradient Fill
            ctx.beginPath();
            ctx.moveTo(margins.left, laneBottom);
            for (let i = 0; i < totalFrames; i++) {
                const f = this.frames[i];
                const rawVal = f[m.key] ?? (m.alias ? f[m.alias] : 0.0);
                const val = typeof rawVal === 'number' && !isNaN(rawVal) ? rawVal : 0.0;
                const px = margins.left + (i / Math.max(1, totalFrames - 1)) * plotWidth;
                const py = getY(val);
                ctx.lineTo(px, py);
            }
            ctx.lineTo(margins.left + plotWidth, laneBottom);
            ctx.closePath();

            const grad = ctx.createLinearGradient(0, laneTop, 0, laneBottom);
            grad.addColorStop(0, m.gradientStart);
            grad.addColorStop(1, 'rgba(15, 23, 42, 0.0)');
            ctx.fillStyle = grad;
            ctx.fill();

            // Line Stroke
            ctx.beginPath();
            for (let i = 0; i < totalFrames; i++) {
                const f = this.frames[i];
                const rawVal = f[m.key] ?? (m.alias ? f[m.alias] : 0.0);
                const val = typeof rawVal === 'number' && !isNaN(rawVal) ? rawVal : 0.0;
                const px = margins.left + (i / Math.max(1, totalFrames - 1)) * plotWidth;
                const py = getY(val);

                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.strokeStyle = m.color;
            ctx.lineWidth = 1.75;
            ctx.stroke();

            // Active Frame Point Marker
            const curFrame = this.frames[currentFrameIdx];
            if (curFrame) {
                const curVal = curFrame[m.key] ?? (m.alias ? curFrame[m.alias] : 0.0);
                const val = typeof curVal === 'number' && !isNaN(curVal) ? curVal : 0.0;
                const curX = margins.left + (currentFrameIdx / Math.max(1, totalFrames - 1)) * plotWidth;
                const curY = getY(val);

                ctx.fillStyle = m.color;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(curX, curY, 3.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        // 3b. Render Snap Oversteer / Loss of Balance Warning Bands
        ctx.save();
        for (let i = 0; i < totalFrames; i++) {
            const f = this.frames[i];
            if (f && f.snap_oversteer) {
                const fx1 = margins.left + (Math.max(0, i - 0.5) / Math.max(1, totalFrames - 1)) * plotWidth;
                const fx2 = margins.left + (Math.min(totalFrames - 1, i + 0.5) / Math.max(1, totalFrames - 1)) * plotWidth;
                const fw = Math.max(2, fx2 - fx1);

                ctx.fillStyle = 'rgba(244, 63, 94, 0.22)';
                ctx.fillRect(fx1, margins.top, fw, plotHeight);

                // Small red warning tick at top
                ctx.fillStyle = '#f43f5e';
                ctx.fillRect(fx1, margins.top, fw, 3);
            }
        }
        ctx.restore();

        // 4. Render Event Milestone Vertical Dashed Lines across all lanes
        if (this.events && this.events.length > 0) {
            ctx.save();
            for (const ev of this.events) {
                const evTime = ev.time !== undefined ? ev.time : (ev.frameId * 0.1);
                const ex = margins.left + (evTime / totalDuration) * plotWidth;

                const evKey = (ev.event || '').toLowerCase();
                const evColor = (evKey === 'ball_snap' || evKey === 'snap') ? '#10b981'
                    : (evKey.includes('pass')) ? '#0284c7'
                    : (evKey.includes('tackle')) ? '#f43f5e'
                    : (evKey.includes('contact')) ? '#f97316'
                    : '#f59e0b';

                // Vertical Dashed Milestone Line
                ctx.strokeStyle = evColor;
                ctx.lineWidth = 1.2;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(ex, margins.top);
                ctx.lineTo(ex, margins.top + plotHeight);
                ctx.stroke();

                // Milestone Label Badge at Top
                const labelText = (ev.event || 'EVENT').toUpperCase().replace(/_/g, ' ');
                ctx.font = '600 8px monospace, sans-serif';
                const ew = ctx.measureText(labelText).width + 6;
                ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
                ctx.fillRect(ex - ew / 2, margins.top - 15, ew, 12);
                ctx.strokeStyle = evColor;
                ctx.strokeRect(ex - ew / 2, margins.top - 15, ew, 12);

                ctx.fillStyle = evColor;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(labelText, ex, margins.top - 9);
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        // 5. Synchronized Vertical Playhead Scrub Line
        const playheadX = margins.left + (currentFrameIdx / Math.max(1, totalFrames - 1)) * plotWidth;

        ctx.strokeStyle = '#f8fafc'; // White playhead
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(playheadX, margins.top);
        ctx.lineTo(playheadX, margins.top + plotHeight);
        ctx.stroke();

        // Playhead Time Badge Pill at Top
        const timeSec = (currentFrameIdx * 0.1).toFixed(1);
        const pillText = `${timeSec}s`;
        ctx.font = '600 10px monospace, sans-serif';
        const pillWidth = ctx.measureText(pillText).width + 10;
        const pillHeight = 16;
        const pillX = Math.max(margins.left, Math.min(margins.left + plotWidth - pillWidth, playheadX - pillWidth / 2));
        const pillY = 3;

        ctx.fillStyle = '#0284c7'; // Sky-600
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 3);
        } else {
            ctx.rect(pillX, pillY, pillWidth, pillHeight);
        }
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pillText, pillX + pillWidth / 2, pillY + pillHeight / 2);
    }

    _renderEmptyState() {
        const { ctx, width, height } = this;
        ctx.font = '500 13px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#64748b'; // slate-500
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Select a Combine drill to inspect 10 Hz telemetry curves', width / 2, height / 2);
    }

    // ------------------------------------------------------------------------
    // User Interactions: Click & Drag Scrubbing
    // ------------------------------------------------------------------------

    _setupInteractions() {
        const getXProgress = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const clientX = e.clientX;
            const xRel = clientX - rect.left - this.margins.left;
            const plotWidth = rect.width - this.margins.left - this.margins.right;
            return Math.max(0, Math.min(1, xRel / Math.max(1, plotWidth)));
        };

        const updateFrameFromPointer = (e) => {
            if (this.totalFrames <= 0) return;
            const progress = getXProgress(e);
            const targetIdx = Math.round(progress * (this.totalFrames - 1));
            if (this.playbackEngine) {
                this.playbackEngine.seek(targetIdx);
            } else {
                this.currentFrameIdx = targetIdx;
                this.render();
            }
        };

        this.canvas.addEventListener('pointerdown', (e) => {
            if (this.totalFrames <= 0) return;
            this.isScrubbing = true;
            try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}

            // Check if clicking near an event milestone line (within 10px)
            if (this.events && this.events.length > 0) {
                const rect = this.canvas.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const plotWidth = rect.width - this.margins.left - this.margins.right;
                const totalDuration = Math.max(0.1, (this.totalFrames - 1) * 0.1);

                for (const ev of this.events) {
                    const evTime = ev.time !== undefined ? ev.time : (ev.frameId * 0.1);
                    const ex = this.margins.left + (evTime / totalDuration) * plotWidth;
                    if (Math.abs(clickX - ex) <= 10 && ev.frameId !== undefined) {
                        if (this.playbackEngine) {
                            this.playbackEngine.seek(ev.frameId);
                        } else {
                            this.currentFrameIdx = ev.frameId;
                            this.render();
                        }
                        return;
                    }
                }
            }

            updateFrameFromPointer(e);
        });

        this.canvas.addEventListener('pointermove', (e) => {
            if (this.isScrubbing) {
                updateFrameFromPointer(e);
            }
        });

        const endScrub = (e) => {
            if (this.isScrubbing) {
                this.isScrubbing = false;
                try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
            }
        };

        this.canvas.addEventListener('pointerup', endScrub);
        this.canvas.addEventListener('pointercancel', endScrub);
    }
}

function round2(v) {
    return Math.round(v * 100) / 100;
}

// Global window registration and helper factories
if (typeof window !== 'undefined') {
    window.PlaybackEngine = PlaybackEngine;
    window.TimeseriesCanvas = TimeseriesCanvas;

    window.initTimeseries = function(canvas, pFrames = []) {
        const ts = new TimeseriesCanvas(canvas);
        ts.loadFrames(pFrames);
        return ts;
    };

    window.createPlaybackEngine = function(options = {}) {
        const pe = new PlaybackEngine(options);
        return pe;
    };
}
