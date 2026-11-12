/**
 * GameFieldCanvas - 2D NFL Regulation Field Canvas Renderer
 * Milestone M4: Tab 2 Game Explorer & 10 Hz Playback
 * 
 * Fulfills F9 & F10 requirements:
 * 1. 120 x 53.33333 yard regulation NFL field geometry (endzones, yardlines, 23.58 yd hashmarks).
 * 2. Inverted-Y Affine Canvas Transformation:
 *    ctx.save() -> ctx.translate(offsetX, H - offsetY) -> ctx.scale(scale, -scale) -> ctx.translate(-minX, -minY)
 * 3. Bijective projection helpers: yardToPixel(x, y) & pixelToYard(px, py).
 * 4. Upright yard numbers (10..50..10) and directional arrows rendered post-ctx.restore().
 * 5. Dual viewport framing: 'full' (120x53.33 yd) vs 'snap' (trajectory extents + 12% padding).
 * 6. Continuous speed heatmap player trajectory & dashed ball trail (Trap 2 prevention with setLineDash([]) reset).
 * 7. Active player marker with dual vector arrows (cyan dir, amber o) and parametric slip angle arc.
 * 8. Upright post-restore floating badge |β|: XX.X° and telemetry HUD.
 */

export class GameFieldCanvas {
    constructor(canvas, options = {}) {
        this.canvas = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
        if (!this.canvas) throw new Error('GameFieldCanvas: canvas element not found');

        this.ctx = this.canvas.getContext('2d');
        this.options = {
            padding: options.padding || 32,
            minSpan: options.minSpan || 15.0,
            marginRatio: options.marginRatio || 0.12,
            maxSpeedCap: options.maxSpeedCap || 11.0,
            showGrid: options.showGrid !== false,
            showNumbers: options.showNumbers !== false,
            showHud: options.showHud !== false,
            showLegend: options.showLegend !== false,
            viewMode: options.viewMode || 'full', // 'full' | 'snap'
            ...options,
        };

        // State
        this.snapData = null;
        this.playerFrames = [];
        this.ballFrames = [];
        this.events = [];
        this.currentFrameIdx = 0;
        this.viewMode = this.options.viewMode;
        this.bounds = this.getFullFieldBounds();
        this.baseBounds = { ...this.bounds };
        this.isUserTransformed = false;
        this.isPanning = false;
        this.panStart = null;
        this.activePointers = new Map();
        this.prevPinchDist = 0;
        this.maxSpeed = 11.0;
        this.transform = { scale: 1, offsetX: 0, offsetY: 0, cssWidth: 800, cssHeight: 420, dpr: 1 };

        // Bindings & Resize Observation
        this.handleResize = this.handleResize.bind(this);
        this.handleWheel = this.handleWheel.bind(this);
        this.handlePointerDown = this.handlePointerDown.bind(this);
        this.handlePointerMove = this.handlePointerMove.bind(this);
        this.handlePointerUp = this.handlePointerUp.bind(this);
        this.handleDblClick = this.handleDblClick.bind(this);

        if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
            this.resizeObserver = new ResizeObserver(() => this.handleResize());
            this.resizeObserver.observe(this.canvas.parentElement);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', this.handleResize);
        }

        // Attach Interactive Zoom & Pan Listeners
        if (typeof this.canvas.addEventListener === 'function') {
            this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
            this.canvas.addEventListener('pointerdown', this.handlePointerDown);
            this.canvas.addEventListener('pointermove', this.handlePointerMove);
            this.canvas.addEventListener('pointerup', this.handlePointerUp);
            this.canvas.addEventListener('pointercancel', this.handlePointerUp);
            this.canvas.addEventListener('dblclick', this.handleDblClick);
        }

        if (this.canvas.style) {
            this.canvas.style.cursor = 'grab';
            this.canvas.style.touchAction = 'none';
        }

        this.handleResize();
    }

    /**
     * Standard Full Field Bounding Box covering 120 x 53.33333 yards plus safety margins
     */
    getFullFieldBounds() {
        return {
            minX: -6.0,
            maxX: 126.0,
            minY: -4.0,
            maxY: 57.33333,
            spanX: 132.0,
            spanY: 61.33333
        };
    }

    /**
     * Load snap telemetry payload from /api/player/{id}/snap/{game_id}/{play_id}
     */
    loadSnap(snapData, maybeBallFrames = null) {
        this.snapData = snapData || {};
        this.playerFrames = this.snapData.frames || this.snapData.player_frames || (Array.isArray(snapData) ? snapData : []);
        this.ballFrames = maybeBallFrames || this.snapData.ball_frames || [];
        this.events = this.snapData.events || [];
        this.currentFrameIdx = 0;

        // Dynamic speed cap based on recorded max speed in snap
        let recordedMax = 0;
        for (const f of this.playerFrames) {
            if (f && typeof f.s === 'number' && f.s > recordedMax) recordedMax = f.s;
        }
        this.maxSpeed = Math.max(10.0, recordedMax);

        this.updateBounds();
        this.computeTransform();
        this.render();
    }

    /**
     * Switch viewport framing mode: 'full' or 'snap'
     */
    setViewMode(mode) {
        if (mode !== 'full' && mode !== 'snap') return;
        this.viewMode = mode;
        this.updateBounds();
        this.computeTransform();
        this.render();
    }

    toggleViewMode() {
        this.setViewMode(this.viewMode === 'full' ? 'snap' : 'full');
    }

    getViewMode() {
        return this.viewMode;
    }

    /**
     * Set active playback frame index [0, totalFrames - 1]
     */
    setFrame(frameIndex) {
        if (!this.playerFrames.length) return;
        this.currentFrameIdx = Math.max(0, Math.min(frameIndex, this.playerFrames.length - 1));
        this.render();
    }

    seek(frameIndex) {
        this.setFrame(frameIndex);
    }

    /**
     * Update active bounds based on viewMode
     */
    updateBounds() {
        if (this.viewMode === 'full' || !this.playerFrames.length) {
            this.bounds = this.getFullFieldBounds();
        } else {
            this.bounds = this.computeBoundingBox(this.playerFrames, this.ballFrames);
        }
        this.baseBounds = { ...this.bounds };
        this.isUserTransformed = false;
    }

    /**
     * Interactive Mouse Wheel Zoom centered at pointer position
     */
    handleWheel(e) {
        if (!this.bounds || !this.bounds.spanX) return;
        if (typeof e.preventDefault === 'function') {
            e.preventDefault();
        }

        const rect = (typeof this.canvas.getBoundingClientRect === 'function')
            ? this.canvas.getBoundingClientRect()
            : { left: 0, top: 0 };
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;

        const centerPt = this.pixelToYard(px, py);
        const factor = e.deltaY < 0 ? 1.15 : (1.0 / 1.15);
        this.zoomAt(centerPt.x, centerPt.y, factor);
    }

    /**
     * Pointer Down: Start Drag / Pan or Multi-touch Pinch
     */
    handlePointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        this.activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

        if (this.activePointers.size === 1) {
            this.isPanning = true;
            this.panStart = {
                clientX: e.clientX,
                clientY: e.clientY,
                minX: this.bounds.minX,
                maxX: this.bounds.maxX,
                minY: this.bounds.minY,
                maxY: this.bounds.maxY,
            };
            if (typeof this.canvas.setPointerCapture === 'function') {
                try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
            }
            if (this.canvas.style) {
                this.canvas.style.cursor = 'grabbing';
            }
        } else if (this.activePointers.size === 2) {
            this.isPanning = false;
            const pts = Array.from(this.activePointers.values());
            const dx = pts[0].clientX - pts[1].clientX;
            const dy = pts[0].clientY - pts[1].clientY;
            this.prevPinchDist = Math.hypot(dx, dy);
        }
    }

    /**
     * Pointer Move: Pan View or Pinch-Zoom
     */
    handlePointerMove(e) {
        if (!this.activePointers.has(e.pointerId)) return;
        this.activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

        if (this.activePointers.size === 2) {
            // Pinch-to-zoom
            const pts = Array.from(this.activePointers.values());
            const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
            if (this.prevPinchDist > 0 && dist > 0) {
                const factor = dist / this.prevPinchDist;
                const rect = (typeof this.canvas.getBoundingClientRect === 'function')
                    ? this.canvas.getBoundingClientRect()
                    : { left: 0, top: 0 };
                const midPx = (pts[0].clientX + pts[1].clientX) / 2 - rect.left;
                const midPy = (pts[0].clientY + pts[1].clientY) / 2 - rect.top;
                const centerPt = this.pixelToYard(midPx, midPy);
                this.zoomAt(centerPt.x, centerPt.y, factor);
            }
            this.prevPinchDist = dist;
            return;
        }

        if (!this.isPanning || !this.panStart) return;

        const dxPix = e.clientX - this.panStart.clientX;
        const dyPix = e.clientY - this.panStart.clientY;

        const scale = Math.max(0.001, this.transform.scale);
        const dxYard = -dxPix / scale;
        const dyYard = dyPix / scale;

        this.bounds.minX = this.panStart.minX + dxYard;
        this.bounds.maxX = this.panStart.maxX + dxYard;
        this.bounds.minY = this.panStart.minY + dyYard;
        this.bounds.maxY = this.panStart.maxY + dyYard;
        this.isUserTransformed = true;

        this.computeTransform();
        this.render();
    }

    /**
     * Pointer Up / Cancel: End Pan or Pinch
     */
    handlePointerUp(e) {
        if (this.activePointers.has(e.pointerId)) {
            this.activePointers.delete(e.pointerId);
            if (typeof this.canvas.releasePointerCapture === 'function') {
                try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
            }
        }

        if (this.activePointers.size === 1) {
            const remaining = Array.from(this.activePointers.values())[0];
            this.isPanning = true;
            this.panStart = {
                clientX: remaining.clientX,
                clientY: remaining.clientY,
                minX: this.bounds.minX,
                maxX: this.bounds.maxX,
                minY: this.bounds.minY,
                maxY: this.bounds.maxY,
            };
        } else if (this.activePointers.size === 0) {
            this.isPanning = false;
            this.panStart = null;
            this.prevPinchDist = 0;
            if (this.canvas.style) {
                this.canvas.style.cursor = 'grab';
            }
        }
    }

    /**
     * Double Click: Reset Zoom & Pan
     */
    handleDblClick(e) {
        this.resetZoom();
    }

    /**
     * Zoom In by fixed factor 1.25x
     */
    zoomIn() {
        const midX = (this.bounds.minX + this.bounds.maxX) / 2;
        const midY = (this.bounds.minY + this.bounds.maxY) / 2;
        this.zoomAt(midX, midY, 1.25);
    }

    /**
     * Zoom Out by fixed factor 1 / 1.25x
     */
    zoomOut() {
        const midX = (this.bounds.minX + this.bounds.maxX) / 2;
        const midY = (this.bounds.minY + this.bounds.maxY) / 2;
        this.zoomAt(midX, midY, 1 / 1.25);
    }

    /**
     * Reset Viewport to Base Framing
     */
    resetZoom() {
        if (this.baseBounds) {
            this.bounds = { ...this.baseBounds };
        } else {
            this.updateBounds();
        }
        this.isUserTransformed = false;
        this.computeTransform();
        this.render();
    }

    /**
     * Zoom centered at yard coordinates (yardX, yardY)
     */
    zoomAt(yardX, yardY, factor) {
        if (!this.bounds || !factor || factor <= 0) return;

        const currentSpanX = this.bounds.spanX;
        const currentSpanY = this.bounds.spanY;
        const newSpanX = currentSpanX / factor;
        const newSpanY = currentSpanY / factor;

        // Hard limits: 2.0 yards (tight zoom) up to 200.0 yards (panoramic)
        if (newSpanX < 2.0 || newSpanX > 200.0) return;
        if (newSpanY < 2.0 || newSpanY > 150.0) return;

        const u = (yardX - this.bounds.minX) / currentSpanX;
        const v = (yardY - this.bounds.minY) / currentSpanY;

        this.bounds.minX = yardX - u * newSpanX;
        this.bounds.maxX = this.bounds.minX + newSpanX;
        this.bounds.minY = yardY - v * newSpanY;
        this.bounds.maxY = this.bounds.minY + newSpanY;
        this.bounds.spanX = newSpanX;
        this.bounds.spanY = newSpanY;
        this.isUserTransformed = true;

        this.computeTransform();
        this.render();
    }

    /**
     * Compute dynamic bounding box for play frames with 15-yard minSpan safeguard and 12% margins
     */
    computeBoundingBox(pFrames = [], bFrames = []) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        const checkPoint = (pt) => {
            if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return;
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        };

        pFrames.forEach(checkPoint);
        if (bFrames && bFrames.length > 0) bFrames.forEach(checkPoint);

        if (!isFinite(minX)) {
            return this.getFullFieldBounds();
        }

        let spanX = maxX - minX;
        let spanY = maxY - minY;

        // Minimum span safeguard around centroid (15.0 yd)
        const minSpan = this.options.minSpan;
        if (spanX < minSpan) {
            const midX = (minX + maxX) / 2;
            minX = midX - minSpan / 2;
            maxX = midX + minSpan / 2;
            spanX = minSpan;
        }
        if (spanY < minSpan) {
            const midY = (minY + maxY) / 2;
            minY = midY - minSpan / 2;
            maxY = midY + minSpan / 2;
            spanY = minSpan;
        }

        // Proportional margins (12%, min 3.0 yards)
        const marginX = Math.max(spanX * this.options.marginRatio, 3.0);
        const marginY = Math.max(spanY * this.options.marginRatio, 3.0);

        const bMinX = minX - marginX;
        const bMaxX = maxX + marginX;
        const bMinY = minY - marginY;
        const bMaxY = maxY + marginY;

        return {
            minX: bMinX,
            maxX: bMaxX,
            minY: bMinY,
            maxY: bMaxY,
            spanX: bMaxX - bMinX,
            spanY: bMaxY - bMinY,
        };
    }

    /**
     * Compute uniform affine scale and centering offsets
     */
    computeTransform() {
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        const rect = this.canvas.getBoundingClientRect();
        const cssWidth = Math.max(0, rect.width || this.canvas.clientWidth || 800);
        const cssHeight = Math.max(0, rect.height || this.canvas.clientHeight || 420);

        // Resize buffer if dimensions changed
        const bufW = Math.round(cssWidth * dpr);
        const bufH = Math.round(cssHeight * dpr);
        if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
            this.canvas.width = bufW;
            this.canvas.height = bufH;
        }

        if (!this.bounds) {
            this.bounds = this.getFullFieldBounds();
        }

        const padding = this.options.padding;
        const availW = Math.max(10, cssWidth - 2 * padding);
        const availH = Math.max(10, cssHeight - 2 * padding);

        // Safeguard against zero canvas dimensions
        let scale = 1.0;
        if (cssWidth > 0 && cssHeight > 0 && this.bounds.spanX > 0 && this.bounds.spanY > 0) {
            scale = Math.min(availW / this.bounds.spanX, availH / this.bounds.spanY);
        }

        const contentW = this.bounds.spanX * scale;
        const contentH = this.bounds.spanY * scale;

        this.transform = {
            scale: scale,
            offsetX: padding + (availW - contentW) / 2,
            offsetY: padding + (availH - contentH) / 2,
            cssWidth: cssWidth,
            cssHeight: cssHeight,
            dpr: dpr,
        };
    }

    handleResize() {
        this.computeTransform();
        this.render();
    }

    /**
     * Forward projection: Yard coordinates -> Screen CSS pixel coordinates
     */
    yardToPixel(x, y) {
        const t = this.transform;
        const b = this.bounds;
        return {
            px: t.offsetX + (x - b.minX) * t.scale,
            py: (t.cssHeight - t.offsetY) - (y - b.minY) * t.scale,
        };
    }

    /**
     * Inverse projection: Screen CSS pixel coordinates -> Yard coordinates
     */
    pixelToYard(px, py) {
        const t = this.transform;
        const b = this.bounds;
        return {
            x: b.minX + (px - t.offsetX) / t.scale,
            y: b.minY + ((t.cssHeight - t.offsetY) - py) / t.scale,
        };
    }

    /**
     * Normalize angular difference to [-180, +180] degrees
     */
    normalizeSlipAngle(diff) {
        if (diff === null || diff === undefined || isNaN(diff)) return 0;
        let d = ((diff + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
        if (d === -180.0 && diff > 0) d = 180.0;
        return d;
    }

    /**
     * Categorize slip angle severity: 'normal' (< 30°), 'moderate' (30°..60°), 'high' (> 60°)
     */
    getSlipSeverity(beta) {
        const absBeta = Math.abs(typeof beta === 'number' ? beta : 0);
        if (absBeta > 60.0) return 'high';
        if (absBeta >= 30.0) return 'moderate';
        return 'normal';
    }

    /**
     * Main Render Loop
     */
    render() {
        const ctx = this.ctx;
        const t = this.transform;
        const b = this.bounds;

        if (t.cssWidth <= 0 || t.cssHeight <= 0 || !b) return;

        // Reset and clear buffer
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // DPR Transform
        ctx.save();
        ctx.scale(t.dpr, t.dpr);

        // Dark Sports Turf Background
        ctx.fillStyle = '#080d1a';
        ctx.fillRect(0, 0, t.cssWidth, t.cssHeight);

        // =====================================================================
        // 1. TRANSFORMED YARD COORDINATE SPACE (Affine Inverted-Y)
        // =====================================================================
        ctx.save();
        ctx.translate(t.offsetX, t.cssHeight - t.offsetY);
        ctx.scale(t.scale, -t.scale);
        ctx.translate(-b.minX, -b.minY);

        this.drawFieldGeometry(ctx, b, t.scale);
        this.drawPlayerTrajectory(ctx, this.playerFrames, this.currentFrameIdx, t.scale);
        this.drawBallTrajectory(ctx, this.ballFrames, this.currentFrameIdx, t.scale);
        this.drawEventPinsYard(ctx, this.events, this.playerFrames, t.scale);
        this.drawActivePlayer(ctx, this.playerFrames[this.currentFrameIdx], t.scale);

        ctx.restore(); // END TRANSFORMED YARD SPACE (F9 invariant)

        // =====================================================================
        // 2. UPRIGHT POST-RESTORE SCREEN ELEMENTS (F9 invariant)
        // =====================================================================
        if (this.options.showNumbers) {
            this.drawUprightYardNumbers(ctx, b);
            this.drawEndzoneTitles(ctx, b);
        }
        this.drawEventPinsScreenBadges(ctx, this.events, this.playerFrames);
        this.drawSlipAngleBadgeScreen(ctx, this.playerFrames[this.currentFrameIdx]);
        if (this.options.showHud) {
            this.drawTelemetryHud(ctx);
        }
        if (this.options.showLegend) {
            this.drawSpeedLegend(ctx);
        }
        this.drawViewportBadge(ctx);

        ctx.restore(); // END DPR TRANSFORM
    }

    /**
     * Draw 120 x 53.33 Regulation NFL Field in Yard Space
     */
    drawFieldGeometry(ctx, b, scale) {
        const FIELD_W = 53.33333;

        // 1. Alternating 5-yard grass shading across active playing field (10 to 110)
        for (let yd = 10; yd < 110; yd += 10) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
            ctx.fillRect(yd, 0, 5, FIELD_W);
        }

        // 2. Home Endzone [0, 10] & Visitor Endzone [110, 120]
        ctx.fillStyle = 'rgba(30, 58, 138, 0.28)'; // Royal blue tint
        ctx.fillRect(0, 0, 10, FIELD_W);

        ctx.fillStyle = 'rgba(79, 70, 229, 0.22)'; // Indigo visitor tint
        ctx.fillRect(110, 0, 10, FIELD_W);

        // Endzone diagonal hash stripes
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = 1.0 / scale;
        for (let offset = -50; offset <= 60; offset += 6) {
            // Home endzone diagonal lines
            ctx.beginPath();
            ctx.moveTo(Math.max(0, offset), 0);
            ctx.lineTo(Math.min(10, offset + 10), FIELD_W);
            ctx.stroke();

            // Visitor endzone diagonal lines
            ctx.beginPath();
            ctx.moveTo(110 + Math.max(0, offset), 0);
            ctx.lineTo(110 + Math.min(10, offset + 10), FIELD_W);
            ctx.stroke();
        }

        // 3. Goal lines (X=10 and X=110) & Endlines (X=0 and X=120)
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.4 / scale;
        ctx.beginPath();
        ctx.moveTo(10, 0); ctx.lineTo(10, FIELD_W);
        ctx.moveTo(110, 0); ctx.lineTo(110, FIELD_W);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 2.0 / scale;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(0, FIELD_W);
        ctx.moveTo(120, 0); ctx.lineTo(120, FIELD_W);
        ctx.stroke();

        // 4. Sidelines (Y=0 and Y=53.33333)
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(120, 0);
        ctx.moveTo(0, FIELD_W); ctx.lineTo(120, FIELD_W);
        ctx.stroke();

        // 5. Yard lines every 5 yards and 10 yards
        for (let yd = 15; yd <= 105; yd += 5) {
            const isTen = yd % 10 === 0;
            ctx.strokeStyle = isTen ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = (isTen ? 1.4 : 0.8) / scale;

            ctx.beginPath();
            ctx.moveTo(yd, 0);
            ctx.lineTo(yd, FIELD_W);
            ctx.stroke();
        }

        // 6. Inbound Hash marks & Sideline Ticks at EVERY integer yard (X = 11 to 109)
        // Rule 1 Section 2: 70 ft 9 in = 23.58333 yd
        const HASH_SOUTH = 23.58333;
        const HASH_NORTH = 29.75000;
        const TICK_LEN = 0.66667; // 2 feet

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
        ctx.lineWidth = 1.0 / scale;

        ctx.beginPath();
        for (let yd = 11; yd <= 109; yd++) {
            if (yd % 5 === 0) continue; // Major/minor lines drawn above

            // Sideline ticks
            ctx.moveTo(yd, 0); ctx.lineTo(yd, TICK_LEN);
            ctx.moveTo(yd, FIELD_W - TICK_LEN); ctx.lineTo(yd, FIELD_W);

            // Inbound hash marks (centered at 23.58 yd and 29.75 yd)
            ctx.moveTo(yd, HASH_SOUTH - TICK_LEN / 2);
            ctx.lineTo(yd, HASH_SOUTH + TICK_LEN / 2);

            ctx.moveTo(yd, HASH_NORTH - TICK_LEN / 2);
            ctx.lineTo(yd, HASH_NORTH + TICK_LEN / 2);
        }
        ctx.stroke();
    }

    /**
     * Draw Speed-Colored Player Trajectory
     */
    drawPlayerTrajectory(ctx, frames, currentIdx, scale) {
        if (!frames || frames.length < 2) return;

        ctx.lineWidth = 3.2 / scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (let i = 0; i < frames.length - 1; i++) {
            const p0 = frames[i];
            const p1 = frames[i + 1];

            if (i <= currentIdx) {
                const grad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
                grad.addColorStop(0, this.getSpeedColor(p0.s));
                grad.addColorStop(1, this.getSpeedColor(p1.s));
                ctx.strokeStyle = grad;
            } else {
                ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)'; // Faint ghost future path
            }

            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
        }
    }

    /**
     * Draw Dashed Ball Trajectory (Trap 2 Prevention)
     */
    drawBallTrajectory(ctx, frames, currentIdx, scale) {
        if (!frames || frames.length < 2) return;

        ctx.save();
        ctx.lineWidth = 2.4 / scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([6.0 / scale, 6.0 / scale]); // Dashed ball trail (Trap 2 prevention)

        const maxIdx = Math.min(currentIdx, frames.length - 1);
        if (maxIdx > 0) {
            ctx.strokeStyle = '#f59e0b'; // Amber
            ctx.beginPath();
            ctx.moveTo(frames[0].x, frames[0].y);
            for (let i = 1; i <= maxIdx; i++) {
                ctx.lineTo(frames[i].x, frames[i].y);
            }
            ctx.stroke();
        }

        if (maxIdx < frames.length - 1) {
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.25)'; // Faint future path
            ctx.beginPath();
            ctx.moveTo(frames[maxIdx].x, frames[maxIdx].y);
            for (let i = maxIdx + 1; i < frames.length; i++) {
                ctx.lineTo(frames[i].x, frames[i].y);
            }
            ctx.stroke();
        }

        ctx.setLineDash([]); // MANDATORY RESET LINE DASH (Trap 2 prevention)
        ctx.restore();

        // Active ball marker at current frame
        const ballPoint = frames[Math.min(currentIdx, frames.length - 1)];
        if (ballPoint) {
            const r = 4.5 / scale;
            ctx.fillStyle = '#b45309'; // Pigskin brown
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.6 / scale;
            ctx.beginPath();
            ctx.arc(ballPoint.x, ballPoint.y, r, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();

            // Center lace tick
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.2 / scale;
            ctx.beginPath();
            ctx.moveTo(ballPoint.x, ballPoint.y - r * 0.5);
            ctx.lineTo(ballPoint.x, ballPoint.y + r * 0.5);
            ctx.stroke();
        }
    }

    /**
     * Draw Event Pins in Yard Space
     */
    drawEventPinsYard(ctx, events, frames, scale) {
        if (!events || !events.length || !frames || !frames.length) return;

        for (const ev of events) {
            const fIdx = ev.frameId !== undefined ? ev.frameId : null;
            const pt = fIdx !== null && frames[fIdx] ? frames[fIdx] : null;
            if (!pt) continue;

            const isCurrent = Math.abs(this.currentFrameIdx - fIdx) <= 1;
            const haloR = (isCurrent ? 7.0 : 4.5) / scale;
            const r = 3.0 / scale;

            ctx.fillStyle = isCurrent ? 'rgba(255, 255, 255, 0.35)' : 'rgba(16, 185, 129, 0.3)';
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, haloR, 0, 2 * Math.PI);
            ctx.fill();

            ctx.fillStyle = '#10b981'; // Emerald pin
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.4 / scale;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
        }
    }

    /**
     * Draw Active Player Marker with Dual Vector Arrows (dir & o) and Parametric Slip Angle Arc
     */
    drawActivePlayer(ctx, player, scale) {
        if (!player) return;

        const x = player.x;
        const y = player.y;
        const s = typeof player.s === 'number' ? player.s : 0.0;
        const dir = typeof player.dir === 'number' ? player.dir : 0.0;
        const o = typeof player.o === 'number' && !isNaN(player.o) ? player.o : null;

        // 1. Amber Body Orientation Vector (Fixed length 1.5 yd)
        if (o !== null) {
            const lenO = 1.5;
            const radO = (o * Math.PI) / 180.0;
            const tipOx = x + lenO * Math.sin(radO);
            const tipOy = y + lenO * Math.cos(radO);

            ctx.strokeStyle = '#f59e0b'; // Amber
            ctx.lineWidth = 2.2 / scale;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(tipOx, tipOy);
            ctx.stroke();

            // Amber Arrowhead Wings
            const wingLenO = 0.45;
            const wingAngle = Math.PI / 6.0; // 30 degrees
            const backRadO = radO + Math.PI;

            ctx.fillStyle = '#f59e0b';
            ctx.beginPath();
            ctx.moveTo(tipOx, tipOy);
            ctx.lineTo(tipOx + wingLenO * Math.sin(backRadO - wingAngle), tipOy + wingLenO * Math.cos(backRadO - wingAngle));
            ctx.lineTo(tipOx + wingLenO * Math.sin(backRadO + wingAngle), tipOy + wingLenO * Math.cos(backRadO + wingAngle));
            ctx.closePath();
            ctx.fill();
        }

        // 2. Cyan Motion Direction Vector (length L = s * 0.8 yd, clamped [0.5, 8.0] or hidden if s <= 0.15)
        if (s > 0.15) {
            const lenDir = Math.max(0.5, Math.min(8.0, s * 0.8));
            const radDir = (dir * Math.PI) / 180.0;
            const tipDirX = x + lenDir * Math.sin(radDir);
            const tipDirY = y + lenDir * Math.cos(radDir);

            ctx.strokeStyle = '#00f0ff'; // Electric Cyan
            ctx.lineWidth = 2.4 / scale;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(tipDirX, tipDirY);
            ctx.stroke();

            // Cyan Arrowhead Wings
            const wingLenDir = Math.min(1.2, Math.max(0.4, lenDir * 0.28));
            const wingAngle = Math.PI / 6.0;
            const backRadDir = radDir + Math.PI;

            ctx.fillStyle = '#00f0ff';
            ctx.beginPath();
            ctx.moveTo(tipDirX, tipDirY);
            ctx.lineTo(tipDirX + wingLenDir * Math.sin(backRadDir - wingAngle), tipDirY + wingLenDir * Math.cos(backRadDir - wingAngle));
            ctx.lineTo(tipDirX + wingLenDir * Math.sin(backRadDir + wingAngle), tipDirY + wingLenDir * Math.cos(backRadDir + wingAngle));
            ctx.closePath();
            ctx.fill();
        }

        // 3. Visual Parametric Slip Angle Arc (Connecting orientation vector to motion vector)
        if (o !== null && s > 0.15) {
            const beta = this.normalizeSlipAngle(dir - o);
            const absBeta = Math.abs(beta);
            const severity = this.getSlipSeverity(beta);
            const rArc = 1.0; // 1.0 yard radius

            if (absBeta > 1.5) {
                let strokeColor = '#06b6d4'; // Normal
                let fillColor = 'rgba(6, 182, 212, 0.15)';
                let arcWidth = 2.0 / scale;

                if (player.snap_oversteer) {
                    strokeColor = '#f43f5e'; // Snap oversteer / loss of balance
                    fillColor = 'rgba(244, 63, 94, 0.35)';
                    arcWidth = 3.5 / scale;
                } else if (severity === 'high') {
                    strokeColor = '#f43f5e'; // High slip / backpedal (> 60 deg)
                    fillColor = 'rgba(244, 63, 94, 0.22)';
                    arcWidth = 3.0 / scale;
                } else if (severity === 'moderate') {
                    strokeColor = '#f59e0b'; // Moderate cut (30..60 deg)
                    fillColor = 'rgba(245, 158, 11, 0.18)';
                    arcWidth = 2.5 / scale;
                }

                // Generate parametric arc points in yard space: theta(u) = o + u * beta
                const steps = Math.max(12, Math.round(absBeta / 6.0));
                const arcPoints = [];
                for (let i = 0; i <= steps; i++) {
                    const u = i / steps;
                    const thetaDeg = o + u * beta;
                    const thetaRad = (thetaDeg * Math.PI) / 180.0;
                    arcPoints.push({
                        x: x + rArc * Math.sin(thetaRad),
                        y: y + rArc * Math.cos(thetaRad),
                    });
                }

                // Semi-Transparent Wedge
                ctx.fillStyle = fillColor;
                ctx.beginPath();
                ctx.moveTo(x, y);
                for (const pt of arcPoints) {
                    ctx.lineTo(pt.x, pt.y);
                }
                ctx.closePath();
                ctx.fill();

                // Arc Perimeter Stroke
                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = arcWidth;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(arcPoints[0].x, arcPoints[0].y);
                for (let i = 1; i < arcPoints.length; i++) {
                    ctx.lineTo(arcPoints[i].x, arcPoints[i].y);
                }
                ctx.stroke();

                // Directional End-cap Dot at motion vector boundary
                const endPt = arcPoints[arcPoints.length - 1];
                ctx.fillStyle = strokeColor;
                ctx.beginPath();
                ctx.arc(endPt.x, endPt.y, 1.8 / scale, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // 4. Dual-Ring Active Player Core Marker
        const r = 5.5 / scale;
        const haloR = 8.5 / scale;

        ctx.fillStyle = 'rgba(0, 240, 255, 0.25)';
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, 2 * Math.PI);
        ctx.fill();

        ctx.fillStyle = this.getSpeedColor(s);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.0 / scale;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
    }

    /**
     * Upright Yard Numbers and Directional Arrows rendered in Screen Pixel Space Post-Restore
     */
    drawUprightYardNumbers(ctx, b) {
        ctx.save();
        ctx.font = '700 12px Inter, monospace, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const yardMarkers = [
            { x: 20, label: '10', arrow: 'left' },
            { x: 30, label: '20', arrow: 'left' },
            { x: 40, label: '30', arrow: 'left' },
            { x: 50, label: '40', arrow: 'left' },
            { x: 60, label: '50', arrow: 'none' },
            { x: 70, label: '40', arrow: 'right' },
            { x: 80, label: '30', arrow: 'right' },
            { x: 90, label: '20', arrow: 'right' },
            { x: 100, label: '10', arrow: 'right' },
        ];

        for (const ym of yardMarkers) {
            if (ym.x < b.minX || ym.x > b.maxX) continue;

            const isBotInView = (b.minY <= 14.0);
            const isTopInView = (b.maxY >= 39.0);

            if (isBotInView) {
                const pBot = this.yardToPixel(ym.x, 12.0);
                this.renderYardNumberWithArrow(ctx, ym.label, ym.arrow, pBot.px, pBot.py);
            }
            if (isTopInView) {
                const pTop = this.yardToPixel(ym.x, 41.33333);
                this.renderYardNumberWithArrow(ctx, ym.label, ym.arrow, pTop.px, pTop.py);
            }

            // In zoomed snap view where both standard rows are off-screen, render near bottom boundary
            if (!isBotInView && !isTopInView) {
                const pMid = this.yardToPixel(ym.x, b.minY + 1.2);
                this.renderYardNumberWithArrow(ctx, ym.label, ym.arrow, pMid.px, pMid.py);
            }
        }

        ctx.restore();
    }

    renderYardNumberWithArrow(ctx, label, arrow, px, py) {
        const textWidth = ctx.measureText(label).width;

        if (arrow === 'left') {
            ctx.fillText(label, px + 5, py);
            ctx.beginPath();
            ctx.moveTo(px - textWidth / 2 - 3, py);
            ctx.lineTo(px - textWidth / 2 + 3, py - 4);
            ctx.lineTo(px - textWidth / 2 + 3, py + 4);
            ctx.closePath();
            ctx.fill();
        } else if (arrow === 'right') {
            ctx.fillText(label, px - 5, py);
            ctx.beginPath();
            ctx.moveTo(px + textWidth / 2 + 3, py);
            ctx.lineTo(px + textWidth / 2 - 3, py - 4);
            ctx.lineTo(px + textWidth / 2 - 3, py + 4);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillText(label, px, py);
        }
    }

    /**
     * Draw Endzone Titles in Screen Pixel Space Post-Restore
     */
    drawEndzoneTitles(ctx, b) {
        ctx.save();
        ctx.font = '800 16px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Home Endzone at X = 5.0, Y = 26.67
        if (b.minX <= 10 && b.maxX >= 0) {
            const pHome = this.yardToPixel(5.0, 26.66667);
            ctx.save();
            ctx.translate(pHome.px, pHome.py);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText('HOME ENDZONE', 0, 0);
            ctx.restore();
        }

        // Visitor Endzone at X = 115.0, Y = 26.67
        if (b.minX <= 120 && b.maxX >= 110) {
            const pVis = this.yardToPixel(115.0, 26.66667);
            ctx.save();
            ctx.translate(pVis.px, pVis.py);
            ctx.rotate(Math.PI / 2);
            ctx.fillText('VISITOR ENDZONE', 0, 0);
            ctx.restore();
        }

        ctx.restore();
    }

    /**
     * Draw Event Screen Badges Post-Restore
     */
    drawEventPinsScreenBadges(ctx, events, frames) {
        if (!events || !events.length || !frames || !frames.length) return;

        ctx.save();
        for (const ev of events) {
            const fIdx = ev.frameId !== undefined ? ev.frameId : null;
            const ptYard = fIdx !== null && frames[fIdx] ? frames[fIdx] : null;
            if (!ptYard) continue;

            const isCurrent = Math.abs(this.currentFrameIdx - fIdx) <= 1;
            const pt = this.yardToPixel(ptYard.x, ptYard.y);
            const labelText = (ev.event || 'EVENT').toUpperCase().replace(/_/g, ' ');

            ctx.font = '600 9px Inter, system-ui, sans-serif';
            const lw = ctx.measureText(labelText).width;
            const lPillW = lw + 8;
            const lPillH = 14;
            const lx = pt.px - lPillW / 2;
            const ly = pt.py - 14 - lPillH;

            ctx.fillStyle = isCurrent ? 'rgba(16, 185, 129, 0.95)' : 'rgba(15, 23, 42, 0.85)';
            ctx.strokeStyle = isCurrent ? '#ffffff' : '#10b981';
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(lx, ly, lPillW, lPillH, 3);
            } else {
                ctx.rect(lx, ly, lPillW, lPillH);
            }
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#f8fafc';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(labelText, pt.px, ly + lPillH / 2);
        }
        ctx.restore();
    }

    /**
     * Draw Floating Degree Badge Post-Restore in Screen Pixel Space
     */
    drawSlipAngleBadgeScreen(ctx, player) {
        if (!player || player.o === null || player.o === undefined || isNaN(player.o)) return;

        const dir = typeof player.dir === 'number' ? player.dir : 0.0;
        const o = player.o;
        const beta = this.normalizeSlipAngle(dir - o);
        const absBeta = Math.abs(beta);
        const isSnap = Boolean(player.snap_oversteer);
        const dynState = player.dynamics_state || (absBeta <= 10.0 ? 'ON_RAILS' : (absBeta <= 45.0 ? 'CONTROLLED_DRIFT' : 'LATERAL_BACKPEDAL'));

        let severityColor = '#06b6d4';
        let badgeText = `|β|: ${absBeta.toFixed(1)}°`;

        if (isSnap) {
            severityColor = '#f43f5e';
            badgeText = `⚡ SNAP OVERSTEER! |β|: ${absBeta.toFixed(1)}°`;
        } else if (dynState === 'ON_RAILS' || absBeta <= 10.0) {
            severityColor = '#06b6d4';
            badgeText = `ON RAILS |β|: ${absBeta.toFixed(1)}°`;
        } else if (dynState === 'CONTROLLED_DRIFT' || absBeta <= 45.0) {
            severityColor = '#10b981';
            badgeText = `CONTROLLED |β|: ${absBeta.toFixed(1)}°`;
        } else {
            severityColor = '#f59e0b';
            badgeText = `LATERAL/BACK |β|: ${absBeta.toFixed(1)}°`;
        }

        const pt = this.yardToPixel(player.x, player.y);
        ctx.save();

        ctx.font = '700 11px monospace, Inter, system-ui, sans-serif';
        const tw = ctx.measureText(badgeText).width;
        const badgeW = tw + 24;
        const badgeH = 22;

        let bx = pt.px + 16;
        let by = pt.py - 26;

        // Viewport bounds clamping
        bx = Math.max(8, Math.min(this.transform.cssWidth - badgeW - 8, bx));
        by = Math.max(8, Math.min(this.transform.cssHeight - badgeH - 8, by));

        ctx.fillStyle = isSnap ? 'rgba(244, 63, 94, 0.28)' : 'rgba(15, 23, 42, 0.92)';
        ctx.strokeStyle = severityColor;
        ctx.lineWidth = isSnap ? 2.0 : 1.5;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(bx, by, badgeW, badgeH, 6);
        } else {
            ctx.rect(bx, by, badgeW, badgeH);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = severityColor;
        ctx.beginPath();
        ctx.arc(bx + 9, by + badgeH / 2, 3.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = isSnap ? '#fda4af' : '#f8fafc';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, bx + 18, by + badgeH / 2);

        ctx.restore();
    }

    /**
     * Draw Floating Telemetry HUD in Screen Pixel Space Post-Restore
     */
    drawTelemetryHud(ctx) {
        const cur = this.playerFrames[this.currentFrameIdx];
        if (!cur) return;

        const pt = this.yardToPixel(cur.x, cur.y);
        ctx.save();

        const sVal = (cur.s || 0).toFixed(1);
        const aVal = (cur.a || 0).toFixed(1);
        const betaVal = Math.abs(cur.slip_angle !== undefined ? cur.slip_angle : (cur.beta_slip || 0)).toFixed(1);
        const bDotVal = Math.abs(cur.beta_rate !== undefined ? cur.beta_rate : (cur.slip_rate || 0)).toFixed(0);
        const jerkVal = Math.abs(cur.jerk || 0).toFixed(1);
        const tVal = (cur.time || this.currentFrameIdx * 0.1).toFixed(1);

        const stateTag = cur.snap_oversteer
            ? '⚡ SNAP OVERSTEER'
            : (cur.dynamics_state || (Number(betaVal) <= 10.0 ? 'ON RAILS' : 'CONTROLLED'));

        const label = `s: ${sVal} yd/s | a: ${aVal} yd/s² | |β|: ${betaVal}° | |β̇|: ${bDotVal}°/s | j: ${jerkVal} yd/s³ [${stateTag}]`;
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(label).width;

        const px = Math.max(tw / 2 + 10, Math.min(this.transform.cssWidth - tw / 2 - 10, pt.px));
        const py = Math.max(22, pt.py - 24);

        ctx.fillStyle = cur.snap_oversteer ? 'rgba(30, 10, 20, 0.94)' : 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle = cur.snap_oversteer ? '#f43f5e' : 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = cur.snap_oversteer ? 1.5 : 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(px - tw / 2 - 8, py - 10, tw + 16, 20, 6);
        } else {
            ctx.rect(px - tw / 2 - 8, py - 10, tw + 16, 20);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = cur.snap_oversteer ? '#fda4af' : '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, px, py);
        ctx.restore();
    }

    /**
     * Draw Speed Colormap Legend in Screen Space
     */
    drawSpeedLegend(ctx) {
        ctx.save();
        const x = 16;
        const y = this.transform.cssHeight - 22;
        const w = 120;
        const h = 6;

        const grad = ctx.createLinearGradient(x, 0, x + w, 0);
        grad.addColorStop(0.00, '#06b6d4');
        grad.addColorStop(0.32, '#0ea5e9');
        grad.addColorStop(0.64, '#eab308');
        grad.addColorStop(0.84, '#f97316');
        grad.addColorStop(1.00, '#ef4444');

        ctx.fillStyle = grad;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(x, y, w, h, 3);
        } else {
            ctx.rect(x, y, w, h);
        }
        ctx.fill();

        ctx.font = '500 9px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.textAlign = 'left';
        ctx.fillText('0 yd/s', x, y - 4);
        ctx.textAlign = 'right';
        ctx.fillText(`${this.maxSpeed.toFixed(0)} yd/s`, x + w, y - 4);

        ctx.restore();
    }

    /**
     * Draw Viewport Mode Indicator Badge (Top-Right)
     */
    drawViewportBadge(ctx) {
        ctx.save();
        let label = this.viewMode === 'full' ? 'FULL FIELD (120×53 yd)' : 'SNAP EXTENTS (ZOOMED)';
        if (this.isUserTransformed && this.baseBounds && this.baseBounds.spanX && this.bounds.spanX) {
            const zFactor = (this.baseBounds.spanX / this.bounds.spanX).toFixed(1);
            label = `ZOOM ${zFactor}x (DBL-CLICK RESET)`;
        }
        ctx.font = '700 10px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(label).width;

        const px = this.transform.cssWidth - tw / 2 - 16;
        const py = 18;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.80)';
        ctx.strokeStyle = this.isUserTransformed
            ? 'rgba(6, 182, 212, 0.6)'
            : (this.viewMode === 'full' ? 'rgba(6, 182, 212, 0.4)' : 'rgba(234, 179, 8, 0.4)');
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(px - tw / 2 - 6, py - 9, tw + 12, 18, 4);
        } else {
            ctx.rect(px - tw / 2 - 6, py - 9, tw + 12, 18);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = this.isUserTransformed ? '#38bdf8' : (this.viewMode === 'full' ? '#38bdf8' : '#fbbf24');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, px, py);

        ctx.restore();
    }

    /**
     * Map speed value to RGB color
     */
    getSpeedColor(speed) {
        const s = Math.max(0, Math.min(speed || 0, this.maxSpeed));
        const u = s / this.maxSpeed;

        const stops = [
            [0.00, 6, 182, 212],   // #06b6d4 cyan
            [0.32, 14, 165, 233],  // #0ea5e9 sky
            [0.64, 234, 179, 8],   // #eab308 yellow
            [0.84, 249, 115, 22],  // #f97316 orange
            [1.00, 239, 68, 68],   // #ef4444 red/magenta
        ];

        let i = 0;
        while (i < stops.length - 1 && u > stops[i + 1][0]) i++;
        if (i >= stops.length - 1) {
            const last = stops[stops.length - 1];
            return `rgb(${last[1]}, ${last[2]}, ${last[3]})`;
        }

        const s0 = stops[i];
        const s1 = stops[i + 1];
        const t = (u - s0[0]) / (s1[0] - s0[0]);

        const r = Math.round(s0[1] + t * (s1[1] - s0[1]));
        const g = Math.round(s0[2] + t * (s1[2] - s0[2]));
        const b = Math.round(s0[3] + t * (s1[3] - s0[3]));

        return `rgb(${r}, ${g}, ${b})`;
    }

    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', this.handleResize);
        }
    }
}

// Global window registration and helper factory
if (typeof window !== 'undefined') {
    window.GameFieldCanvas = GameFieldCanvas;
    window.initGameField = function(canvas, snapData) {
        const g = new GameFieldCanvas(canvas);
        g.loadSnap(snapData);
        return g;
    };
}
