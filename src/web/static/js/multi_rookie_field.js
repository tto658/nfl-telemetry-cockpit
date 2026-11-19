/**
 * Multi-Rookie 2D NFL Field & Synchronized Speed Timeseries Renderers
 */

const FIELD_LENGTH = 120.0;
const FIELD_WIDTH = 53.33;

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
    this.tracks = []; // Array of { nflId, name, pos, team, isOffense, color, frames }
    this.interactionPairs = []; // Pre-resolved O(1) indices: [{ type, offIdx, defIdx, label, color }]
    this.frameIdx = 0;
    this.zoomMode = 'auto'; // 'auto' | 'full'
    this.highlightedNflId = null;
    this.bounds = { xMin: 0, xMax: FIELD_LENGTH, yMin: 0, yMax: FIELD_WIDTH };
  }

  setZoomMode(mode) {
    this.zoomMode = mode;
    this._computeBounds();
    this.render();
  }

  setHighlighted(nflId) {
    this.highlightedNflId = nflId;
    this.render();
  }

  setTracks(tracks, interactionPairs = []) {
    this.tracks = tracks || [];
    this.interactionPairs = interactionPairs || [];
    this.frameIdx = 0;
    this._computeBounds();
    this.render();
  }

  setFrame(idx) {
    this.frameIdx = idx;
    this.render();
  }

  _computeBounds() {
    if (this.zoomMode === 'full' || this.tracks.length === 0) {
      this.bounds = { xMin: 0, xMax: FIELD_LENGTH, yMin: -1.5, yMax: FIELD_WIDTH + 1.5 };
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
      this.bounds = { xMin: 0, xMax: FIELD_LENGTH, yMin: -1.5, yMax: FIELD_WIDTH + 1.5 };
      return;
    }

    const padX = Math.max(8, (maxX - minX) * 0.2);
    const padY = Math.max(5, (maxY - minY) * 0.2);
    let xMin = Math.max(0, minX - padX);
    let xMax = Math.min(FIELD_LENGTH, maxX + padX);
    let yMin = Math.max(-1.5, minY - padY);
    let yMax = Math.min(FIELD_WIDTH + 1.5, maxY + padY);

    // Maintain reasonable aspect ratio matching canvas
    const canvasAspect = this.canvas.width / this.canvas.height;
    const dx = xMax - xMin;
    const dy = yMax - yMin;
    if (dx / dy < canvasAspect) {
      const targetDx = dy * canvasAspect;
      const midX = (xMin + xMax) / 2;
      xMin = Math.max(0, midX - targetDx / 2);
      xMax = Math.min(FIELD_LENGTH, midX + targetDx / 2);
    } else {
      const targetDy = dx / canvasAspect;
      const midY = (yMin + yMax) / 2;
      yMin = Math.max(-2, midY - targetDy / 2);
      yMax = Math.min(FIELD_WIDTH + 2, midY + targetDy / 2);
    }

    this.bounds = { xMin, xMax, yMin, yMax };
  }

  _toCanvas(x, y) {
    const { xMin, xMax, yMin, yMax } = this.bounds;
    const pad = 16;
    const w = this.canvas.width - pad * 2;
    const h = this.canvas.height - pad * 2;
    const cx = pad + ((x - xMin) / (xMax - xMin)) * w;
    // Flip Y so y=53.33 is top, y=0 is bottom (standard TV broadcast view)
    const cy = pad + ((yMax - y) / (yMax - yMin)) * h;
    return [cx, cy];
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background turf
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, W, H);

    this._drawFieldLines(ctx);

    if (this.tracks.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '600 15px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select a play above to render multi-rookie 10 Hz tracking', W / 2, H / 2);
      return;
    }

    // Draw ghost paths & active trails first
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

      // Active solid trail up to frameIdx
      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.25 : 0.9;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = this.highlightedNflId === tr.nflId ? 3.5 : 2.5;
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

    // Draw O(1) pre-resolved interaction tether lines between matched rookie pairs
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

    // Draw player markers & labels at frameIdx
    for (const tr of this.tracks) {
      if (tr.frames.length === 0) continue;
      const f = tr.frames[Math.min(this.frameIdx, tr.frames.length - 1)];
      if (!f || f.x == null || f.y == null) continue;

      const isHighlighted = this.highlightedNflId === tr.nflId;
      const isDimmed = this.highlightedNflId != null && !isHighlighted;
      const [cx, cy] = this._toCanvas(f.x, f.y);

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.35 : 1.0;

      // Velocity / direction arrow (NFL dir: 0=North/+Y, 90=East/+X)
      if (f.dir != null && f.s != null && f.s > 0.3) {
        const rad = ((90 - f.dir) * Math.PI) / 180;
        const arrowLen = Math.min(36, 8 + f.s * 2.6);
        const ax = cx + Math.cos(rad) * arrowLen;
        const ay = cy - Math.sin(rad) * arrowLen;
        ctx.strokeStyle = tr.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ax, ay);
        ctx.stroke();

        // Arrowhead
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

      // Outer ring by side (Offense = cyan glow, Defense = amber glow)
      const r = isHighlighted ? 9.5 : 7.5;
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

      // Label pill
      const lastName = (tr.name || '').split(' ').slice(-1)[0] || String(tr.nflId);
      const speedTxt = f.s != null ? ` ${f.s.toFixed(1)}` : '';
      const label = `${lastName} (${tr.pos})${speedTxt}`;
      ctx.font = `${isHighlighted ? '700' : '600'} 11px Inter, sans-serif`;
      const tw = ctx.measureText(label).width;
      const lx = cx + 11;
      const ly = cy - 6;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(lx - 3, ly - 10, tw + 6, 14);
      ctx.fillStyle = isHighlighted ? '#ffffff' : '#e2e8f0';
      ctx.textAlign = 'left';
      ctx.fillText(label, lx, ly + 1);

      ctx.restore();
    }
  }

  _drawFieldLines(ctx) {
    // Field boundary
    const [x0, yTop] = this._toCanvas(0, FIELD_WIDTH);
    const [x120, yBot] = this._toCanvas(FIELD_LENGTH, 0);

    // Turf grass inside field
    ctx.fillStyle = '#112233';
    ctx.fillRect(x0, yTop, x120 - x0, yBot - yTop);

    // Endzones (0..10 and 110..120)
    const [x10] = this._toCanvas(10, 0);
    const [x110] = this._toCanvas(110, 0);
    ctx.fillStyle = 'rgba(30, 41, 59, 0.75)';
    ctx.fillRect(x0, yTop, x10 - x0, yBot - yTop);
    ctx.fillRect(x110, yTop, x120 - x110, yBot - yTop);

    // Yard lines every 5 yards
    for (let x = 0; x <= 120; x += 5) {
      const [cx] = this._toCanvas(x, 0);
      if (cx < 0 || cx > this.canvas.width) continue;
      const isTen = x % 10 === 0;
      ctx.strokeStyle = x === 10 || x === 110 ? 'rgba(248, 250, 252, 0.6)' : isTen ? 'rgba(148, 163, 184, 0.28)' : 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = x === 10 || x === 110 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx, yTop);
      ctx.lineTo(cx, yBot);
      ctx.stroke();

      // Yard numbers every 10 yards (10..90 -> 10..50..10)
      if (isTen && x >= 20 && x <= 100) {
        const yd = x <= 60 ? x - 10 : 110 - x;
        ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.font = '700 11px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(yd), cx, yBot - 8);
        ctx.fillText(String(yd), cx, yTop + 16);
      }
    }

    // Sidelines
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, yTop, x120 - x0, yBot - yTop);
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
    this.events = []; // [{ idx, label }]
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

    const maxSpeed = 12.0; // yd/s

    // Grid lines (0, 3, 6, 9, 12 yd/s)
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

    // X-axis time ticks
    ctx.textAlign = 'center';
    const totalSec = (this.maxFrames - 1) * 0.1;
    const stepSec = totalSec > 8 ? 2 : 1;
    for (let sec = 0; sec <= totalSec; sec += stepSec) {
      const idx = sec * 10;
      const x = padL + (idx / (this.maxFrames - 1)) * plotW;
      ctx.fillText(`${sec.toFixed(0)}s`, x, H - 8);
    }

    // Event vertical lines
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
      ctx.fillText(ev.label, x, padT - 7);
      ctx.restore();
    }

    // Speed curves per rookie
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

    // Live playhead
    const px = padL + (Math.min(this.frameIdx, this.maxFrames - 1) / (this.maxFrames - 1)) * plotW;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + plotH);
    ctx.stroke();
  }
}
