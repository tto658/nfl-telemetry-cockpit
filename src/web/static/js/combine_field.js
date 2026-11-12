/**
 * CombineFieldCanvas - 2D Combine Field Canvas Renderer
 * Milestone M3: NFL Combine & Game Tracking Platform
 * 
 * Fulfills F5, F9, F10 requirements:
 * - High-DPI / Retina buffer scaling via devicePixelRatio.
 * - Dynamic bounding box calculation with 10% margins and minSpan guard (player + ball union).
 * - Affine context transformation matrix (scale, -scale) matching test_f9.
 * - Continuous speed-colored player trajectory gradient.
 * - Dashed ball trajectory separation (Trap 2 prevention) with mandatory dash reset.
 * - Active player marker with proportional cyan motion arrow (compass heading).
 * - Upright text, yard numbers, and HUD telemetry post-restore.
 */

export class CombineFieldCanvas {
    constructor(canvas, options = {}) {
        this.canvas = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
        if (!this.canvas) throw new Error('CombineFieldCanvas: canvas element not found');

        this.ctx = this.canvas.getContext('2d');
        this.options = {
            padding: options.padding || 36,
            minSpan: options.minSpan || 10.0,
            marginRatio: options.marginRatio || 0.10,
            maxSpeedCap: options.maxSpeedCap || 11.0,
            showGrid: options.showGrid !== false,
            showLegend: options.showLegend !== false,
            showHud: options.showHud !== false,
            ...options,
        };

        // State
        this.drillData = null;
        this.playerFrames = [];
        this.ballFrames = [];
        this.currentFrameIdx = 0;
        this.bounds = null;
        this.baseBounds = null;
        this.isUserTransformed = false;
        this.isPanning = false;
        this.panStart = null;
        this.activePointers = new Map();
        this.prevPinchDist = 0;
        this.maxSpeed = 11.0;
        this.transform = { scale: 1, offsetX: 0, offsetY: 0, cssWidth: 800, cssHeight: 450, dpr: 1 };

        // Bindings & Observer
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
     * Load drill telemetry payload from /api/player/{id}/combine/{event_id}
     * or raw arrays (playerFrames, ballFrames)
     */
    loadDrill(drillData, maybeBallFrames = null) {
        if (Array.isArray(drillData)) {
            // Called with raw array: loadDrill(playerFrames, ballFrames)
            this.drillData = { player_frames: drillData, ball_frames: maybeBallFrames || [] };
            this.playerFrames = drillData;
            this.ballFrames = maybeBallFrames || [];
        } else {
            this.drillData = drillData || {};
            this.playerFrames = this.drillData.player_frames || this.drillData.player_trajectory || [];
            this.ballFrames = this.drillData.ball_frames || this.drillData.ball_trajectory || [];
        }

        this.currentFrameIdx = 0;

        // Dynamic speed cap based on recorded maximum
        let recordedMax = this.drillData.metrics?.s_max || this.drillData.s_max || 0;
        if (!recordedMax && this.playerFrames.length > 0) {
            for (const f of this.playerFrames) {
                if (f && f.s > recordedMax) recordedMax = f.s;
            }
        }
        this.maxSpeed = Math.max(10.0, recordedMax);

        this.bounds = this.computeBoundingBox(this.playerFrames, this.ballFrames);
        this.baseBounds = { ...this.bounds };
        this.isUserTransformed = false;
        this.computeTransform();
        this.render();
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
        if (!this.bounds) return;
        const midX = (this.bounds.minX + this.bounds.maxX) / 2;
        const midY = (this.bounds.minY + this.bounds.maxY) / 2;
        this.zoomAt(midX, midY, 1.25);
    }

    /**
     * Zoom Out by fixed factor 1 / 1.25x
     */
    zoomOut() {
        if (!this.bounds) return;
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
        } else if (this.playerFrames.length > 0) {
            this.bounds = this.computeBoundingBox(this.playerFrames, this.ballFrames);
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

        // Hard limits: 2.0 yards up to 200.0 yards
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

    setCurrentFrame(frameIndex) {
        this.setFrame(frameIndex);
    }

    /**
     * Compute dynamic bounding box for player and ball frames with 10% margins
     * Evaluates the UNION of player and ball points with minimum 10-yard span guard.
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
        if (bFrames && bFrames.length > 0) {
            bFrames.forEach(checkPoint);
        }

        if (!isFinite(minX)) {
            return { minX: 0, maxX: 120, minY: 0, maxY: 53.33333, spanX: 120, spanY: 53.33333 };
        }

        let spanX = maxX - minX;
        let spanY = maxY - minY;

        // Minimum span safeguard around centroid (prevents flatline squishing on 40-yd dash)
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

        // 10% margins (min 2.0 yards)
        const marginX = Math.max(spanX * this.options.marginRatio, 2.0);
        const marginY = Math.max(spanY * this.options.marginRatio, 2.0);

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
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const cssWidth = Math.max(50, rect.width || this.canvas.clientWidth || 800);
        const cssHeight = Math.max(50, rect.height || this.canvas.clientHeight || 420);

        // Resize buffer if changed
        const bufW = Math.round(cssWidth * dpr);
        const bufH = Math.round(cssHeight * dpr);
        if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
            this.canvas.width = bufW;
            this.canvas.height = bufH;
        }

        if (!this.bounds) {
            this.bounds = { minX: 0, maxX: 120, minY: 0, maxY: 53.33333, spanX: 120, spanY: 53.33333 };
        }

        const padding = this.options.padding;
        const availW = Math.max(10, cssWidth - 2 * padding);
        const availH = Math.max(10, cssHeight - 2 * padding);

        const scale = Math.min(availW / this.bounds.spanX, availH / this.bounds.spanY);
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
     * Yard coordinates to logical CSS pixel coordinates
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
     * Logical CSS pixel coordinates to yard coordinates
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
     * Main Render Loop
     */
    render() {
        const ctx = this.ctx;
        const t = this.transform;
        const b = this.bounds;

        // Guard against zero dimensions
        if (t.cssWidth <= 0 || t.cssHeight <= 0 || !b) return;

        // Reset and clear buffer
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // DPR Transform
        ctx.save();
        ctx.scale(t.dpr, t.dpr);

        // Background Turf (Slate-950 deep navy)
        ctx.fillStyle = '#0b1120';
        ctx.fillRect(0, 0, t.cssWidth, t.cssHeight);

        // ---------------------------------------------------------------------
        // 1. TRANSFORMED YARD COORDINATE SPACE
        // ---------------------------------------------------------------------
        ctx.save();
        ctx.translate(t.offsetX, t.cssHeight - t.offsetY);
        ctx.scale(t.scale, -t.scale);
        ctx.translate(-b.minX, -b.minY);

        this.drawYardField(ctx, b, t.scale);
        this.drawPlayerTrajectory(ctx, this.playerFrames, this.currentFrameIdx, t.scale);
        this.drawBallTrajectory(ctx, this.ballFrames, this.currentFrameIdx, t.scale);
        this.drawActivePlayer(ctx, this.playerFrames[this.currentFrameIdx], t.scale);

        ctx.restore(); // END TRANSFORMED YARD SPACE

        // ---------------------------------------------------------------------
        // 2. UPRIGHT POST-RESTORE SCREEN ELEMENTS (F9 invariant)
        // ---------------------------------------------------------------------
        this.drawUprightYardMarkers(ctx, b);
        if (this.options.showHud) this.drawTelemetryHud(ctx);
        if (this.options.showLegend) this.drawSpeedLegend(ctx);

        ctx.restore(); // END DPR TRANSFORM
    }

    /**
     * Draw subtle yard lines, sidelines, and hash marks in yard space
     */
    drawYardField(ctx, b, scale) {
        if (!this.options.showGrid) return;

        // Outer field boundary box (if within view)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
        ctx.lineWidth = 1.8 / scale;
        ctx.strokeRect(0, 0, 120, 53.33333);

        // 5-yard lines
        const startYard = Math.max(0, Math.floor(b.minX / 5) * 5);
        const endYard = Math.min(120, Math.ceil(b.maxX / 5) * 5);

        for (let yd = startYard; yd <= endYard; yd += 5) {
            const isTen = yd % 10 === 0;
            ctx.strokeStyle = isTen ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)';
            ctx.lineWidth = (isTen ? 1.4 : 0.8) / scale;

            ctx.beginPath();
            ctx.moveTo(yd, Math.max(0, b.minY));
            ctx.lineTo(yd, Math.min(53.33333, b.maxY));
            ctx.stroke();

            // Hashmarks at 23.58 and 29.75 yards
            if (b.minY <= 24 && b.maxY >= 23) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
                ctx.lineWidth = 1.0 / scale;
                ctx.beginPath();
                ctx.moveTo(yd, 23.08);
                ctx.lineTo(yd, 24.08);
                ctx.stroke();
            }
            if (b.minY <= 30 && b.maxY >= 29) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
                ctx.lineWidth = 1.0 / scale;
                ctx.beginPath();
                ctx.moveTo(yd, 29.25);
                ctx.lineTo(yd, 30.25);
                ctx.stroke();
            }
        }
    }

    /**
     * Draw speed-colored player trajectory with linear gradients
     */
    drawPlayerTrajectory(ctx, frames, currentIdx, scale) {
        if (!frames || frames.length < 2) return;

        const strokeWidth = 3.2 / scale;
        ctx.lineWidth = strokeWidth;
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
                ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)'; // Faint context future path
            }

            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
        }
    }

    /**
     * Draw dashed ball trajectory (Trap 2 prevention)
     */
    drawBallTrajectory(ctx, frames, currentIdx, scale) {
        if (!frames || frames.length < 2) return;

        ctx.save();
        ctx.lineWidth = 2.4 / scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([6 / scale, 6 / scale]); // Dashed ball trail (Trap 2)

        const maxIdx = Math.min(currentIdx, frames.length - 1);
        if (maxIdx > 0) {
            ctx.strokeStyle = '#f59e0b'; // Vibrant amber
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

        ctx.setLineDash([]); // MANDATORY RESET LINE DASH
        ctx.restore();

        // Active ball marker at current frame
        const ballPoint = frames[Math.min(currentIdx, frames.length - 1)];
        if (ballPoint) {
            const r = 4.5 / scale;
            ctx.fillStyle = '#b45309'; // Rich pigskin brown
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.6 / scale;
            ctx.beginPath();
            ctx.arc(ballPoint.x, ballPoint.y, r, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();

            // Center white lace tick mark
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.2 / scale;
            ctx.beginPath();
            ctx.moveTo(ballPoint.x, ballPoint.y - r * 0.5);
            ctx.lineTo(ballPoint.x, ballPoint.y + r * 0.5);
            ctx.stroke();
        }
    }

    /**
     * Draw active player marker and motion direction vector arrow
     */
    drawActivePlayer(ctx, player, scale) {
        if (!player) return;

        const x = player.x;
        const y = player.y;
        const s = player.s || 0.0;
        const dir = player.dir || 0.0;

        // 1. Motion direction arrow (Cyan #00f0ff, length L = s * 0.8 yd)
        if (s > 0.15) {
            const length = s * 0.8;
            const rad = (dir * Math.PI) / 180.0;
            const tipX = x + length * Math.sin(rad);
            const tipY = y + length * Math.cos(rad);

            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 2.4 / scale;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(tipX, tipY);
            ctx.stroke();

            // Arrowhead wings
            const wingLen = Math.min(1.2, Math.max(0.4, length * 0.28));
            const wingAngle = Math.PI / 6.0; // 30 degrees
            const backRad = rad + Math.PI;

            const w1X = tipX + wingLen * Math.sin(backRad - wingAngle);
            const w1Y = tipY + wingLen * Math.cos(backRad - wingAngle);
            const w2X = tipX + wingLen * Math.sin(backRad + wingAngle);
            const w2Y = tipY + wingLen * Math.cos(backRad + wingAngle);

            ctx.fillStyle = '#00f0ff';
            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(w1X, w1Y);
            ctx.lineTo(w2X, w2Y);
            ctx.closePath();
            ctx.fill();
        }

        // 2. Dual-Ring Active Player Marker
        const r = 5.5 / scale;
        const haloR = 8.5 / scale;

        // Outer glow halo
        ctx.fillStyle = 'rgba(0, 240, 255, 0.25)';
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, 2 * Math.PI);
        ctx.fill();

        // Core circle with speed color and crisp white border
        ctx.fillStyle = this.getSpeedColor(s);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.0 / scale;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
    }

    /**
     * Draw upright yard numbers post-restore
     */
    drawUprightYardMarkers(ctx, b) {
        ctx.save();
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.40)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const startYard = Math.max(10, Math.ceil(b.minX / 10) * 10);
        const endYard = Math.min(110, Math.floor(b.maxX / 10) * 10);

        for (let yd = startYard; yd <= endYard; yd += 10) {
            const label = yd <= 60 ? yd : 120 - yd;
            const pt = this.yardToPixel(yd, Math.max(b.minY, 2.0));
            ctx.fillText(`${label}`, pt.px, Math.min(this.transform.cssHeight - 14, pt.py + 16));
        }
        ctx.restore();
    }

    /**
     * Draw HUD pill above active player
     */
    drawTelemetryHud(ctx) {
        const cur = this.playerFrames[this.currentFrameIdx];
        if (!cur) return;

        const pt = this.yardToPixel(cur.x, cur.y);
        ctx.save();

        const sVal = (cur.s || 0).toFixed(1);
        const tVal = (cur.time || this.currentFrameIdx * 0.1).toFixed(1);
        const label = `s: ${sVal} yd/s | t: ${tVal}s`;
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(label).width;

        const px = Math.max(tw / 2 + 10, Math.min(this.transform.cssWidth - tw / 2 - 10, pt.px));
        const py = Math.max(22, pt.py - 22);

        // Pill background
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(px - tw / 2 - 8, py - 10, tw + 16, 20, 6);
        } else {
            ctx.rect(px - tw / 2 - 8, py - 10, tw + 16, 20);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, px, py);
        ctx.restore();
    }

    /**
     * Draw speed gradient legend in bottom-left
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
        window.removeEventListener('resize', this.handleResize);
    }
}

// Global window registration and helper factory
if (typeof window !== 'undefined') {
    window.CombineFieldCanvas = CombineFieldCanvas;
    window.initCombineField = function(canvas, pFrames = [], bFrames = []) {
        const c = new CombineFieldCanvas(canvas);
        c.loadDrill(pFrames, bFrames);
        return c;
    };
}
