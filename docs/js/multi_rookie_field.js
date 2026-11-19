/**
 * Multi-Rookie 2D NFL Field & Synchronized Speed Timeseries Renderers
 * Features interactive zoom/pan (wheel, drag, pinch, dblclick, buttons),
 * regulation NFL field geometry with hashmarks, and role halo markers.
 */

const FIELD_LENGTH = 120.0;
const FIELD_WIDTH = 53.33333;

// Distinct high-contrast palette for up to 11 rookies on a single play
export const ROOKIE_PALETTE = [
  '#06b6d4', // cyan
  '#f59e0b', // amber
  '#10b981', // emerald
  '#f43f5e', // rose
  '#8b5cf6', // violet
  '#38bdf8', // sky
  '#fb923c', // orange
  '#a3e635', // lime
  '#e879f9', // fuchsia
  '#2dd4bf', // teal
  '#facc15', // yellow
];

export class MultiRookieFieldCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tracks = []; // Array of { nflId, name, pos, team, isOffense, color, roles, frames }
    this.interactionPairs = []; // Pre-resolved O(1) indices: [{ type, offIdx, defIdx, label, color }]
    this.frameIdx = 0;
    this.zoomMode = 'auto'; // 'auto' | 'full'
    this.rotated = false; // false = horizontal (120x53), true = vertical 90° (53x120)
    this.highlightedNflId = null;
    this.visibleLabels = new Set();

    this.bounds = { xMin: 0, xMax: FIELD_LENGTH, yMin: -1.5, yMax: FIELD_WIDTH + 1.5 };
    this.baseBounds = { ...this.bounds };
    this.isUserTransformed = false;
    this.isPanning = false;
    this.panStart = null;
    this.activePointers = new Map();
    this.prevPinchDist = 0;
    this.transform = { scale: 1, offsetX: 0, offsetY: 0, cssWidth: 900, cssHeight: 440, dpr: 1 };

    this._handleResize = this._handleResize.bind(this);
    this._handleWheel = this._handleWheel.bind(this);
    this._handlePointerDown = this._handlePointerDown.bind(this);
    this._handlePointerMove = this._handlePointerMove.bind(this);
    this._handlePointerUp = this._handlePointerUp.bind(this);
    this._handleDblClick = this._handleDblClick.bind(this);

    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.resizeObserver = new ResizeObserver(() => this._handleResize());
      this.resizeObserver.observe(this.canvas.parentElement);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._handleResize);
    }

    this.canvas.addEventListener('wheel', this._handleWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this._handlePointerDown);
    this.canvas.addEventListener('pointermove', this._handlePointerMove);
    this.canvas.addEventListener('pointerup', this._handlePointerUp);
    this.canvas.addEventListener('pointercancel', this._handlePointerUp);
    this.canvas.addEventListener('dblclick', this._handleDblClick);

    this.canvas.style.cursor = 'grab';
    this.canvas.style.touchAction = 'none';
    this._handleResize();
  }

  _handleResize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0) return;
    const cssWidth = rect.width;
    const cssHeight = Math.max(340, Math.min(480, cssWidth * 0.48));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.transform.cssWidth = cssWidth;
    this.transform.cssHeight = cssHeight;
    this.transform.dpr = dpr;
    this._computeTransform();
    this.render();
  }

  setZoomMode(mode) {
    this.zoomMode = mode;
    this.isUserTransformed = false;
    this._computeBounds();
    this._computeTransform();
    this.render();
  }

  zoomIn() {
    this._zoomAtCenter(0.75);
  }

  zoomOut() {
    this._zoomAtCenter(1.33);
  }

  resetZoom() {
    this.isUserTransformed = false;
    this.bounds = { ...this.baseBounds };
    this._computeTransform();
    this.render();
  }

  toggleRotate() {
    this.rotated = !this.rotated;
    this._computeTransform();
    this.render();
    return this.rotated;
  }

  _zoomAtCenter(factor) {
    const cx = (this.bounds.xMin + this.bounds.xMax) / 2;
    const cy = (this.bounds.yMin + this.bounds.yMax) / 2;
    this._applyZoomAt(cx, cy, factor);
  }

  _applyZoomAt(yardX, yardY, factor) {
    const curSpanX = this.bounds.xMax - this.bounds.xMin;
    const curSpanY = this.bounds.yMax - this.bounds.yMin;
    const newSpanX = Math.max(8, Math.min(136, curSpanX * factor));
    const newSpanY = Math.max(4, Math.min(64, curSpanY * factor));
    const rx = (yardX - this.bounds.xMin) / curSpanX;
    const ry = (yardY - this.bounds.yMin) / curSpanY;

    this.bounds = {
      xMin: yardX - rx * newSpanX,
      xMax: yardX + (1 - rx) * newSpanX,
      yMin: yardY - ry * newSpanY,
      yMax: yardY + (1 - ry) * newSpanY,
    };
    this.isUserTransformed = true;
    this._computeTransform();
    this.render();
  }

  _handleWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [yx, yy] = this._pixelToYard(px, py);
    const factor = e.deltaY < 0 ? 0.85 : 1.18;
    this._applyZoomAt(yx, yy, factor);
  }

  _handlePointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.activePointers.size === 1) {
      this.isPanning = true;
      this.panStart = { x: e.clientX, y: e.clientY, bounds: { ...this.bounds } };
      this.canvas.style.cursor = 'grabbing';
    } else if (this.activePointers.size === 2) {
      this.isPanning = false;
      const pts = [...this.activePointers.values()];
      this.prevPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  }

  _handlePointerMove(e) {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size === 2) {
      const pts = [...this.activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.prevPinchDist > 0 && dist > 0) {
        const rect = this.canvas.getBoundingClientRect();
        const midPx = (pts[0].x + pts[1].x) / 2 - rect.left;
        const midPy = (pts[0].y + pts[1].y) / 2 - rect.top;
        const [yx, yy] = this._pixelToYard(midPx, midPy);
        this._applyZoomAt(yx, yy, this.prevPinchDist / dist);
      }
      this.prevPinchDist = dist;
      return;
    }

    if (this.isPanning && this.panStart) {
      const dxPx = e.clientX - this.panStart.x;
      const dyPx = e.clientY - this.panStart.y;
      const dxYd = dxPx / this.transform.scale;
      const dyYd = dyPx / this.transform.scale;
      const b = this.panStart.bounds;
      if (this.rotated) {
        this.bounds = {
          xMin: b.xMin + dyYd,
          xMax: b.xMax + dyYd,
          yMin: b.yMin - dxYd,
          yMax: b.yMax - dxYd,
        };
      } else {
        this.bounds = {
          xMin: b.xMin - dxYd,
          xMax: b.xMax - dxYd,
          yMin: b.yMin + dyYd,
          yMax: b.yMax + dyYd,
        };
      }
      this.isUserTransformed = true;
      this._computeTransform();
      this.render();
    }
  }

  _handlePointerUp(e) {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) this.prevPinchDist = 0;
    if (this.activePointers.size === 0) {
      this.isPanning = false;
      this.panStart = null;
      this.canvas.style.cursor = 'grab';
    }
  }

  _handleDblClick(e) {
    e.preventDefault();
    this.resetZoom();
  }

  setHighlighted(nflId) {
    this.highlightedNflId = nflId;
    this.render();
  }

  setVisibleLabels(nflIdSet) {
    this.visibleLabels = nflIdSet instanceof Set ? nflIdSet : new Set(nflIdSet || []);
    this.render();
  }

  setTracks(tracks, interactionPairs = []) {
    this.tracks = tracks || [];
    this.interactionPairs = interactionPairs || [];
    this.frameIdx = 0;
    this.isUserTransformed = false;
    this._computeBounds();
    this._computeTransform();
    this.render();
  }

  setFrame(idx) {
    this.frameIdx = idx;
    this.render();
  }

  _computeBounds() {
    if (this.zoomMode === 'full' || this.tracks.length === 0) {
      this.bounds = { xMin: -4, xMax: FIELD_LENGTH + 4, yMin: -2.5, yMax: FIELD_WIDTH + 2.5 };
      this.baseBounds = { ...this.bounds };
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const tr of this.tracks) {
      for (const f of tr.frames) {
        if (f.x == null || f.y == null) continue;
        if (f.x < minX) minX = f.x;
        if (f.x > maxX) maxX = f.x;
        if (f.y < minY) minY = f.y;
        if (f.y > maxY) maxY = f.y;
      }
    }

    if (!Number.isFinite(minX)) {
      this.bounds = { xMin: -4, xMax: FIELD_LENGTH + 4, yMin: -2.5, yMax: FIELD_WIDTH + 2.5 };
      this.baseBounds = { ...this.bounds };
      return;
    }

    const padX = Math.max(8, (maxX - minX) * 0.2);
    const padY = Math.max(5, (maxY - minY) * 0.2);
    const b = {
      xMin: Math.max(-4, minX - padX),
      xMax: Math.min(FIELD_LENGTH + 4, maxX + padX),
      yMin: Math.max(-2.5, minY - padY),
      yMax: Math.min(FIELD_WIDTH + 2.5, maxY + padY),
    };
    this.baseBounds = { ...b };
    if (!this.isUserTransformed) {
      this.bounds = b;
    }
  }

  _computeTransform() {
    const pad = 16;
    const w = Math.max(100, this.transform.cssWidth - pad * 2);
    const h = Math.max(100, this.transform.cssHeight - pad * 2);
    const spanX = Math.max(1, this.bounds.xMax - this.bounds.xMin);
    const spanY = Math.max(1, this.bounds.yMax - this.bounds.yMin);
    const spanH = this.rotated ? spanY : spanX;
    const spanV = this.rotated ? spanX : spanY;
    const scale = Math.min(w / spanH, h / spanV);
    const offsetX = pad + (w - spanH * scale) / 2;
    const offsetY = pad + (h - spanV * scale) / 2;
    this.transform.scale = scale;
    this.transform.offsetX = offsetX;
    this.transform.offsetY = offsetY;
  }

  _toCanvas(x, y) {
    const { scale, offsetX, offsetY, cssHeight } = this.transform;
    if (this.rotated) {
      const cx = offsetX + (y - this.bounds.yMin) * scale;
      const cy = cssHeight - offsetY - (x - this.bounds.xMin) * scale;
      return [cx, cy];
    }
    const cx = offsetX + (x - this.bounds.xMin) * scale;
    const cy = cssHeight - offsetY - (y - this.bounds.yMin) * scale;
    return [cx, cy];
  }

  _pixelToYard(px, py) {
    const { scale, offsetX, offsetY, cssHeight } = this.transform;
    if (this.rotated) {
      const y = this.bounds.yMin + (px - offsetX) / scale;
      const x = this.bounds.xMin + (cssHeight - offsetY - py) / scale;
      return [x, y];
    }
    const x = this.bounds.xMin + (px - offsetX) / scale;
    const y = this.bounds.yMin + (cssHeight - offsetY - py) / scale;
    return [x, y];
  }

  render() {
    const ctx = this.ctx;
    const dpr = this.transform.dpr || 1;
    const W = this.transform.cssWidth;
    const H = this.transform.cssHeight;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, W, H);

    this._drawFieldLines(ctx);

    if (this.tracks.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '600 15px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select a play above to render multi-rookie 10 Hz tracking', W / 2, H / 2);
      ctx.restore();
      return;
    }

    // Ghost paths & active trails
    for (const tr of this.tracks) {
      const isDimmed = this.highlightedNflId != null && this.highlightedNflId !== tr.nflId;
      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.18 : 0.35;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = isDimmed ? 1.5 : 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      let started = false;
      for (const f of tr.frames) {
        if (f.x == null || f.y == null) continue;
        const [cx, cy] = this._toCanvas(f.x, f.y);
        if (!started) {
          ctx.moveTo(cx, cy);
          started = true;
        } else {
          ctx.lineTo(cx, cy);
        }
      }
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.25 : 0.9;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = this.highlightedNflId === tr.nflId ? 3.5 : 2.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      started = false;
      const limit = Math.min(this.frameIdx, tr.frames.length - 1);
      for (let i = 0; i <= limit; i++) {
        const f = tr.frames[i];
        if (f.x == null || f.y == null) continue;
        const [cx, cy] = this._toCanvas(f.x, f.y);
        if (!started) {
          ctx.moveTo(cx, cy);
          started = true;
        } else {
          ctx.lineTo(cx, cy);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // O(1) pre-resolved interaction tether lines
    for (const pair of this.interactionPairs) {
      const trOff = this.tracks[pair.offIdx];
      const trDef = this.tracks[pair.defIdx];
      if (!trOff || !trDef || trOff.frames.length === 0 || trDef.frames.length === 0) continue;
      const fOff = trOff.frames[Math.min(this.frameIdx, trOff.frames.length - 1)];
      const fDef = trDef.frames[Math.min(this.frameIdx, trDef.frames.length - 1)];
      if (!fOff || !fDef || fOff.x == null || fOff.y == null || fDef.x == null || fDef.y == null) continue;

      const [x1, y1] = this._toCanvas(fOff.x, fOff.y);
      const [x2, y2] = this._toCanvas(fDef.x, fDef.y);
      const distYd = Math.hypot(fOff.x - fDef.x, fOff.y - fDef.y);

      ctx.save();
      ctx.strokeStyle = pair.color || '#38bdf8';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const txt = `${pair.label} ${distYd.toFixed(1)}yd`;
      ctx.font = '700 10px JetBrains Mono, monospace';
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(mx - tw / 2 - 4, my - 8, tw + 8, 14);
      ctx.fillStyle = pair.color || '#38bdf8';
      ctx.textAlign = 'center';
      ctx.fillText(txt, mx, my + 2);
      ctx.restore();
    }

    // Player markers, role halos & offset callout labels
    const LABEL_OFFSETS = [
      [26, -24],
      [-26, -24],
      [26, 24],
      [-26, 24],
    ];
    for (let trIdx = 0; trIdx < this.tracks.length; trIdx++) {
      const tr = this.tracks[trIdx];
      if (tr.frames.length === 0) continue;
      const f = tr.frames[Math.min(this.frameIdx, tr.frames.length - 1)];
      if (!f || f.x == null || f.y == null) continue;

      const isHighlighted = this.highlightedNflId === tr.nflId;
      const isDimmed = this.highlightedNflId != null && !isHighlighted;
      const [cx, cy] = this._toCanvas(f.x, f.y);

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.35 : 1.0;

      // Velocity / direction arrow
      if (f.dir != null && f.s != null && f.s > 0.3) {
        const rad = ((90 - f.dir) * Math.PI) / 180 + (this.rotated ? Math.PI / 2 : 0);
        const arrowLen = Math.min(36, 8 + f.s * 2.6);
        const ax = cx + Math.cos(rad) * arrowLen;
        const ay = cy - Math.sin(rad) * arrowLen;
        ctx.strokeStyle = tr.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ax, ay);
        ctx.stroke();

        const headLen = 6;
        ctx.fillStyle = tr.color;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(
          ax - headLen * Math.cos(rad - Math.PI / 6),
          ay + headLen * Math.sin(rad - Math.PI / 6)
        );
        ctx.lineTo(
          ax - headLen * Math.cos(rad + Math.PI / 6),
          ay + headLen * Math.sin(rad + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
      }

      const r = isHighlighted ? 9.5 : 7.5;
      const roles = tr.roles || [];

      // Distinct role halo ring (REC/RUSH = emerald, SACK = amber-gold, TKL = rose)
      if (roles.length > 0) {
        const roleColor = roles.includes('SACK')
          ? '#fbbf24'
          : roles.includes('TKL')
            ? '#f43f5e'
            : '#10b981';
        ctx.beginPath();
        ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = roleColor;
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }

      // Outer side ring
      ctx.beginPath();
      ctx.arc(cx, cy, r + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = tr.isOffense ? 'rgba(6, 182, 212, 0.35)' : 'rgba(245, 158, 11, 0.35)';
      ctx.fill();

      // Core dot
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = tr.color;
      ctx.fill();
      ctx.lineWidth = isHighlighted ? 2.5 : 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Offset callout label with thin leader line (only if checked or highlighted)
      if (this.visibleLabels.has(tr.nflId) || isHighlighted) {
        let icon = '';
        if (roles.includes('SACK')) icon = '⚡';
        else if (roles.includes('REC') || roles.includes('RUSH')) icon = '🏈';
        else if (roles.includes('TGT')) icon = '🎯';
        else if (roles.includes('TKL')) icon = '💥';

        const alignPos = tr.align && tr.align !== '--' ? tr.align : tr.pos;
        const label = `${icon ? icon + ' ' : ''}${alignPos} (${tr.pos})`;
        ctx.font = `${isHighlighted || roles.length ? '700' : '600'} 10.5px Inter, sans-serif`;
        const tw = ctx.measureText(label).width;
        const [ox, oy] = LABEL_OFFSETS[trIdx % LABEL_OFFSETS.length];
        const alignLeft = ox >= 0;
        const lx = cx + ox;
        const ly = cy + oy;

        // Subtle leader line
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(lx, ly);
        ctx.stroke();

        const boxX = alignLeft ? lx : lx - tw - 6;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(boxX, ly - 10, tw + 6, 14);
        ctx.fillStyle = isHighlighted || roles.length ? '#ffffff' : '#e2e8f0';
        ctx.textAlign = 'left';
        ctx.fillText(label, boxX + 3, ly + 1);
      }

      ctx.restore();
    }

    ctx.restore();
  }

  _drawFieldLines(ctx) {
    const [x0, yTop] = this._toCanvas(0, FIELD_WIDTH);
    const [x120, yBot] = this._toCanvas(FIELD_LENGTH, 0);
    const left = Math.min(x0, x120);
    const top = Math.min(yTop, yBot);
    const fw = Math.abs(x120 - x0);
    const fh = Math.abs(yBot - yTop);

    ctx.fillStyle = '#112233';
    ctx.fillRect(left, top, fw, fh);

    // Endzones (0..10 and 110..120)
    const [ex10, ey10] = this._toCanvas(10, 0);
    const [ex110, ey110] = this._toCanvas(110, FIELD_WIDTH);
    ctx.fillStyle = 'rgba(30, 41, 59, 0.75)';
    if (this.rotated) {
      const [ez0x, ez0y] = this._toCanvas(0, 0);
      const [ez10x, ez10y] = this._toCanvas(10, FIELD_WIDTH);
      ctx.fillRect(Math.min(ez0x, ez10x), Math.min(ez0y, ez10y), Math.abs(ez10x - ez0x), Math.abs(ez10y - ez0y));
      const [ez110x, ez110y] = this._toCanvas(110, 0);
      const [ez120x, ez120y] = this._toCanvas(120, FIELD_WIDTH);
      ctx.fillRect(Math.min(ez110x, ez120x), Math.min(ez110y, ez120y), Math.abs(ez120x - ez110x), Math.abs(ez120y - ez110y));
    } else {
      ctx.fillRect(x0, yTop, ex10 - x0, yBot - yTop);
      ctx.fillRect(ex110, yTop, x120 - ex110, yBot - yTop);
    }

    // Yard lines every 5 yards
    for (let x = 0; x <= 120; x += 5) {
      const [lx1, ly1] = this._toCanvas(x, 0);
      const [lx2, ly2] = this._toCanvas(x, FIELD_WIDTH);
      const isTen = x % 10 === 0;
      ctx.strokeStyle =
        x === 10 || x === 110
          ? 'rgba(248, 250, 252, 0.6)'
          : isTen
            ? 'rgba(148, 163, 184, 0.28)'
            : 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = x === 10 || x === 110 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(lx1, ly1);
      ctx.lineTo(lx2, ly2);
      ctx.stroke();

      if (isTen && x >= 20 && x <= 100) {
        const yd = x <= 60 ? x - 10 : 110 - x;
        ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.font = '700 11px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        if (this.rotated) {
          ctx.fillText(String(yd), lx1 + 14, ly1 + 4);
          ctx.fillText(String(yd), lx2 - 14, ly2 + 4);
        } else {
          ctx.fillText(String(yd), lx1, ly1 - 8);
          ctx.fillText(String(yd), lx2, ly2 + 16);
        }
      }
    }

    // Regulation NFL hashmarks (23.58 yd from sidelines) every 1 yard
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 11; x <= 109; x++) {
      if (x % 5 === 0) continue;
      const [hx1, hy1] = this._toCanvas(x, 23.58);
      const [hx2, hy2] = this._toCanvas(x, FIELD_WIDTH - 23.58);
      if (this.rotated) {
        ctx.moveTo(hx1 - 3, hy1);
        ctx.lineTo(hx1 + 3, hy1);
        ctx.moveTo(hx2 - 3, hy2);
        ctx.lineTo(hx2 + 3, hy2);
      } else {
        ctx.moveTo(hx1, hy1 - 3);
        ctx.lineTo(hx1, hy1 + 3);
        ctx.moveTo(hx2, hy2 - 3);
        ctx.lineTo(hx2, hy2 + 3);
      }
    }
    ctx.stroke();

    // Sidelines
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, fw, fh);
  }
}

export class MultiRookieTimeseriesCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tracks = [];
    this.frameIdx = 0;
    this.maxFrames = 0;
    this.highlightedNflId = null;
    this.events = [];
  }

  setTracks(tracks, maxFrames, events = []) {
    this.tracks = tracks || [];
    this.maxFrames = maxFrames || 0;
    this.events = events || [];
    this.frameIdx = 0;
    this.render();
  }

  setFrame(idx) {
    this.frameIdx = idx;
    this.render();
  }

  setHighlighted(nflId) {
    this.highlightedNflId = nflId;
    this.render();
  }

  setVisibleLabels(nflIdSet) {
    this.visibleLabels = nflIdSet instanceof Set ? nflIdSet : new Set(nflIdSet || []);
    this.render();
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1322';
    ctx.fillRect(0, 0, W, H);

    const padL = 42, padR = 14, padT = 24, padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    if (this.tracks.length === 0 || this.maxFrames < 2) {
      ctx.fillStyle = '#64748b';
      ctx.font = '600 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Speed timeseries will appear when a play is loaded', W / 2, H / 2);
      return;
    }

    const maxSpeed = 12.0;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '500 10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    for (let s = 0; s <= maxSpeed; s += 3) {
      const y = padT + plotH - (s / maxSpeed) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${s}`, padL - 6, y + 3);
    }

    ctx.textAlign = 'center';
    const totalSec = (this.maxFrames - 1) * 0.1;
    const stepSec = totalSec > 8 ? 2 : 1;
    for (let sec = 0; sec <= totalSec; sec += stepSec) {
      const idx = sec * 10;
      const x = padL + (idx / (this.maxFrames - 1)) * plotW;
      ctx.fillText(`${sec.toFixed(0)}s`, x, H - 8);
    }

    for (const ev of this.events) {
      const x = padL + (ev.idx / (this.maxFrames - 1)) * plotW;
      ctx.save();
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.55)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = '#c4b5fd';
      ctx.font = '600 9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(ev.shortLabel || ev.label, x, padT - 7);
      ctx.restore();
    }

    for (const tr of this.tracks) {
      const isHighlighted = this.highlightedNflId === tr.nflId;
      const isDimmed = this.highlightedNflId != null && !isHighlighted;

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.2 : 0.92;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = isHighlighted ? 2.8 : 1.7;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < tr.frames.length; i++) {
        const s = tr.frames[i].s;
        if (s == null) continue;
        const x = padL + (i / (this.maxFrames - 1)) * plotW;
        const y = padT + plotH - (Math.min(maxSpeed, Math.max(0, s)) / maxSpeed) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    const px = padL + (Math.min(this.frameIdx, this.maxFrames - 1) / (this.maxFrames - 1)) * plotW;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + plotH);
    ctx.stroke();
  }
}
