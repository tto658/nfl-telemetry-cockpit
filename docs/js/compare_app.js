/**
 * NFL Telemetry Lab — Spatial Comparison Controller (compare_app.js)
 * Dedicated sub-page driver for Head-to-Head Spatial Comparison Lab (compare.html).
 * Supports dual player selection, F1 curvilinear arc-length resampling,
 * instant client-side computation fallback for GitHub Pages, and URL parameters.
 */

import { api } from './api.js';
import { SpatialStripCanvas } from './spatial_strip.js';
import {
  resampleCombineDrill,
  resampleGameSnap,
  alignAndCompareCurvilinear,
  computeMiniSectors,
  detectApexes,
  computeMilestones
} from './spatial_engine.js';

// Global state
const state = {
  players: [],
  spatialExplorer: {
    mode: 'combine', // 'combine' | 'snap'
    playerAId: null,
    playerBId: null,
    playerA: null,
    playerB: null,
    drillsA: [],
    drillsB: [],
    gamesA: [],
    gamesB: [],
    comparisonData: null,
    stripCanvas: null,
    overlayCanvas: null,
    scrubDistance: 0,
    isPlayingSweep: false,
    sweepTimer: null
  }
};

// DOM references
const DOM = {
  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingMessage: document.getElementById('loadingMessage'),
  toastNotification: document.getElementById('toastNotification'),
  toastMessage: document.getElementById('toastMessage'),

  spatialModeCombine: document.getElementById('spatialModeCombine'),
  spatialModeSnap: document.getElementById('spatialModeSnap'),

  spatialPlayerA: document.getElementById('spatialPlayerA'),
  spatialPlayerB: document.getElementById('spatialPlayerB'),
  spatialNameA: document.getElementById('spatialNameA'),
  spatialNameB: document.getElementById('spatialNameB'),

  spatialCombineControlsA: document.getElementById('spatialCombineControlsA'),
  spatialCombineControlsB: document.getElementById('spatialCombineControlsB'),
  spatialDrillA: document.getElementById('spatialDrillA'),
  spatialDrillB: document.getElementById('spatialDrillB'),

  spatialSnapControlsA: document.getElementById('spatialSnapControlsA'),
  spatialSnapControlsB: document.getElementById('spatialSnapControlsB'),
  spatialGameA: document.getElementById('spatialGameA'),
  spatialGameB: document.getElementById('spatialGameB'),
  spatialPlayA: document.getElementById('spatialPlayA'),
  spatialPlayB: document.getElementById('spatialPlayB'),

  spatialSwapBtn: document.getElementById('spatialSwapBtn'),
  spatialStepSelect: document.getElementById('spatialStepSelect'),
  spatialCompareBtn: document.getElementById('spatialCompareBtn'),

  spatialSummarySection: document.getElementById('spatialSummarySection'),
  spatialCommonDist: document.getElementById('spatialCommonDist'),
  spatialFinishDelta: document.getElementById('spatialFinishDelta'),
  spatialLeaderBadge: document.getElementById('spatialLeaderBadge'),
  spatialSectorScore: document.getElementById('spatialSectorScore'),
  spatialVMaxDelta: document.getElementById('spatialVMaxDelta'),
  spatialGComb: document.getElementById('spatialGComb'),
  spatialOverlapIndex: document.getElementById('spatialOverlapIndex'),
  spatialApexSpeed: document.getElementById('spatialApexSpeed'),
  spatialExitTraction: document.getElementById('spatialExitTraction'),

  spatialOverlayCanvas: document.getElementById('spatialOverlayCanvas'),
  spatialStripCanvas: document.getElementById('spatialStripCanvas'),
  btnStripLane3Toggle: document.getElementById('btnStripLane3Toggle'),
  btnLane3Sideslip: document.getElementById('btnLane3Sideslip'),
  btnLane3GForce: document.getElementById('btnLane3GForce'),

  spatialDistanceSlider: document.getElementById('spatialDistanceSlider'),
  spatialCurrentD: document.getElementById('spatialCurrentD'),
  spatialScrubReset: document.getElementById('spatialScrubReset'),
  spatialScrubPlay: document.getElementById('spatialScrubPlay'),

  spatialMilestonesTable: document.getElementById('spatialMilestonesTable'),
  spatialMilestonesBody: document.getElementById('spatialMilestonesBody'),
  spatialSectorsTable: document.getElementById('spatialSectorsTable'),
  spatialSectorsBody: document.getElementById('spatialSectorsBody')
};

// UI helpers
function showLoading(msg = 'Processing telemetry...') {
  if (DOM.loadingOverlay) {
    if (DOM.loadingMessage) DOM.loadingMessage.textContent = msg;
    DOM.loadingOverlay.style.display = 'flex';
  }
}

function hideLoading() {
  if (DOM.loadingOverlay) {
    DOM.loadingOverlay.style.display = 'none';
  }
}

function showToast(msg, duration = 3000) {
  if (DOM.toastNotification && DOM.toastMessage) {
    DOM.toastMessage.textContent = msg;
    DOM.toastNotification.style.display = 'block';
    DOM.toastNotification.classList.add('show');
    setTimeout(() => {
      DOM.toastNotification.classList.remove('show');
      setTimeout(() => { DOM.toastNotification.style.display = 'none'; }, 200);
    }, duration);
  }
}

// 2D Curvilinear Overlay Canvas Implementation
class SpatialOverlayCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.scrubDistance = 0;
    this.setupResizeObserver();
  }

  setupResizeObserver() {
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      const ro = new ResizeObserver(() => {
        this.resize();
        this.render();
      });
      ro.observe(this.canvas.parentElement);
    }
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth || 900;
    const h = 340;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  setData(data) {
    this.data = data;
    this.scrubDistance = 0;
    this.resize();
    this.render();
  }

  setScrubDistance(d) {
    this.scrubDistance = d;
    this.render();
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth || 900;
    const h = this.canvas.clientHeight || 340;

    ctx.clearRect(0, 0, w, h);

    // Dark grid background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    // Subtle grid lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let x = 40; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 30; y < h; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (!this.data) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select Prospect A & B and click "Run Spatial Comparison"', w / 2, h / 2);
      return;
    }

    const trajA = this.data.resampled_a || [];
    const trajB = this.data.resampled_b || [];
    if (trajA.length === 0 && trajB.length === 0) return;

    // Find bounding box across both trajectories
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    [...trajA, ...trajB].forEach(pt => {
      const px = pt.x ?? pt[0] ?? 0;
      const py = pt.y ?? pt[1] ?? 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    });

    const spanX = Math.max(maxX - minX, 10);
    const spanY = Math.max(maxY - minY, 5);
    const pad = 40;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);

    const toX = (x) => pad + (x - minX) * scale;
    const toY = (y) => h - pad - (y - minY) * scale;

    // Helper: draw trajectory
    const drawTraj = (traj, color, shadowColor) => {
      if (traj.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 6;
      ctx.lineWidth = 3;
      ctx.beginPath();
      traj.forEach((pt, idx) => {
        const cx = toX(pt.x ?? pt[0] ?? 0);
        const cy = toY(pt.y ?? pt[1] ?? 0);
        if (idx === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.stroke();
      ctx.restore();
    };

    // Draw Prospect B (Amber)
    drawTraj(trajB, '#f59e0b', 'rgba(245, 158, 11, 0.4)');
    // Draw Prospect A (Cyan)
    drawTraj(trajA, '#06b6d4', 'rgba(6, 182, 212, 0.4)');

    // Draw scrub position ghost runners
    const findClosestPt = (traj, d) => {
      if (!traj || traj.length === 0) return null;
      let closest = traj[0];
      let minDiff = Math.abs((closest.distance ?? 0) - d);
      for (const pt of traj) {
        const diff = Math.abs((pt.distance ?? 0) - d);
        if (diff < minDiff) {
          minDiff = diff;
          closest = pt;
        }
      }
      return closest;
    };

    const curA = findClosestPt(trajA, this.scrubDistance);
    const curB = findClosestPt(trajB, this.scrubDistance);

    if (curB) {
      const bx = toX(curB.x ?? curB[0] ?? 0);
      const by = toY(curB.y ?? curB[1] ?? 0);
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (curA) {
      const ax = toX(curA.x ?? curA[0] ?? 0);
      const ay = toY(curA.y ?? curA[1] ?? 0);
      ctx.fillStyle = '#06b6d4';
      ctx.beginPath();
      ctx.arc(ax, ay, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// Controller Initialization
export async function initCompareApp() {
  // Initialize Canvases
  if (DOM.spatialStripCanvas) {
    state.spatialExplorer.stripCanvas = new SpatialStripCanvas(DOM.spatialStripCanvas);
  }
  if (DOM.spatialOverlayCanvas) {
    state.spatialExplorer.overlayCanvas = new SpatialOverlayCanvas(DOM.spatialOverlayCanvas);
  }

  // Bind Event Listeners
  if (DOM.spatialModeCombine) {
    DOM.spatialModeCombine.addEventListener('click', () => setSpatialMode('combine'));
  }
  if (DOM.spatialModeSnap) {
    DOM.spatialModeSnap.addEventListener('click', () => setSpatialMode('snap'));
  }

  if (DOM.spatialPlayerA) {
    DOM.spatialPlayerA.addEventListener('change', () => onSpatialPlayerAChange());
  }
  if (DOM.spatialPlayerB) {
    DOM.spatialPlayerB.addEventListener('change', () => onSpatialPlayerBChange());
  }

  if (DOM.spatialSwapBtn) {
    DOM.spatialSwapBtn.addEventListener('click', () => swapSpatialPlayers());
  }

  if (DOM.spatialCompareBtn) {
    DOM.spatialCompareBtn.addEventListener('click', () => runSpatialComparison());
  }

  if (DOM.spatialDistanceSlider) {
    DOM.spatialDistanceSlider.addEventListener('input', (e) => {
      const d = parseFloat(e.target.value);
      setSpatialScrubDistance(d);
    });
  }

  if (DOM.spatialScrubReset) {
    DOM.spatialScrubReset.addEventListener('click', () => setSpatialScrubDistance(0));
  }

  if (DOM.spatialScrubPlay) {
    DOM.spatialScrubPlay.addEventListener('click', () => toggleSpatialPlaySweep());
  }

  // Lane 3 Mode Toggle
  if (DOM.btnLane3Sideslip) {
    DOM.btnLane3Sideslip.addEventListener('click', () => {
      DOM.btnLane3Sideslip.classList.add('active');
      DOM.btnLane3GForce?.classList.remove('active');
      if (state.spatialExplorer.stripCanvas) {
        state.spatialExplorer.stripCanvas.setLane3Mode('sideslip');
      }
    });
  }
  if (DOM.btnLane3GForce) {
    DOM.btnLane3GForce.addEventListener('click', () => {
      DOM.btnLane3GForce.classList.add('active');
      DOM.btnLane3Sideslip?.classList.remove('active');
      if (state.spatialExplorer.stripCanvas) {
        state.spatialExplorer.stripCanvas.setLane3Mode('gforce');
      }
    });
  }

  // Load Prospects
  showLoading('Loading prospect directory...');
  try {
    const players = await api.fetchPlayers();
    state.players = players || [];
    populateSpatialPlayerOptions();
  } catch (err) {
    console.error('Failed to load prospects:', err);
    showToast('Failed to load prospects list');
  } finally {
    hideLoading();
  }
}

function setSpatialMode(mode) {
  const se = state.spatialExplorer;
  se.mode = mode;

  if (DOM.spatialModeCombine) DOM.spatialModeCombine.classList.toggle('active', mode === 'combine');
  if (DOM.spatialModeSnap) DOM.spatialModeSnap.classList.toggle('active', mode === 'snap');

  const isCombine = mode === 'combine';
  if (DOM.spatialCombineControlsA) DOM.spatialCombineControlsA.style.display = isCombine ? 'flex' : 'none';
  if (DOM.spatialCombineControlsB) DOM.spatialCombineControlsB.style.display = isCombine ? 'flex' : 'none';
  if (DOM.spatialSnapControlsA) DOM.spatialSnapControlsA.style.display = isCombine ? 'none' : 'flex';
  if (DOM.spatialSnapControlsB) DOM.spatialSnapControlsB.style.display = isCombine ? 'none' : 'flex';

  onSpatialPlayerAChange();
  onSpatialPlayerBChange();
}

function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    playerA: params.get('player_a') || params.get('playerA'),
    drillA: params.get('drill_a') || params.get('drillA'),
    playerB: params.get('player_b') || params.get('playerB'),
    drillB: params.get('drill_b') || params.get('drillB'),
    gameA: params.get('game_a'),
    playA: params.get('play_a'),
    gameB: params.get('game_b'),
    playB: params.get('play_b'),
    mode: params.get('mode')
  };
}

function populateSpatialPlayerOptions() {
  const players = state.players || [];
  if (players.length === 0) return;

  const url = parseUrlParams();

  const optionsHtml = players.map(p => {
    const label = `${p.display_name} [${p.position || p.nfl_position || 'ATH'} • ${p.college || 'N/A'}]`;
    return `<option value="${p.nfl_id}">${label}</option>`;
  }).join('');

  if (DOM.spatialPlayerA) {
    DOM.spatialPlayerA.innerHTML = optionsHtml;
    const defaultA = url.playerA ? parseInt(url.playerA, 10) : 55867; // Will Anderson Jr.
    DOM.spatialPlayerA.value = defaultA;
  }

  if (DOM.spatialPlayerB) {
    DOM.spatialPlayerB.innerHTML = `<option value="POS_AVG">Position Benchmark Average</option>` + optionsHtml;
    const defaultB = url.playerB ? (url.playerB === 'POS_AVG' ? 'POS_AVG' : parseInt(url.playerB, 10)) : 55877; // Lukas Van Ness
    DOM.spatialPlayerB.value = defaultB;
  }

  if (url.mode === 'snap') {
    setSpatialMode('snap');
  }

  onSpatialPlayerAChange(url.drillA).then(() => {
    onSpatialPlayerBChange(url.drillB).then(() => {
      runSpatialComparison();
    });
  });
}

async function onSpatialPlayerAChange(preferredDrill = null) {
  const se = state.spatialExplorer;
  const pId = parseInt(DOM.spatialPlayerA?.value, 10);
  if (!pId) return;

  const player = (state.players || []).find(p => p.nfl_id === pId);
  se.playerAId = pId;
  se.playerA = player;
  if (DOM.spatialNameA) DOM.spatialNameA.textContent = player ? `${player.display_name} (${player.position})` : `Player ${pId}`;

  if (se.mode === 'combine') {
    const res = await api.fetchSpatialDrills(pId);
    se.drillsA = res?.drills || [];
    if (DOM.spatialDrillA) {
      if (se.drillsA.length > 0) {
        DOM.spatialDrillA.innerHTML = se.drillsA.map(d => `<option value="${d.event_id}">${d.drill_name}</option>`).join('');
        if (preferredDrill) {
          DOM.spatialDrillA.value = preferredDrill;
        } else {
          const forty = se.drillsA.find(d => d.drill_name.includes('FORTY'));
          if (forty) DOM.spatialDrillA.value = forty.event_id;
        }
      } else {
        DOM.spatialDrillA.innerHTML = `<option value="">No Combine Drills</option>`;
      }
    }
  } else {
    const gamesRes = await api.fetchGames(pId);
    se.gamesA = gamesRes?.games || [];
    if (DOM.spatialGameA) {
      if (se.gamesA.length > 0) {
        DOM.spatialGameA.innerHTML = se.gamesA.map(g => `<option value="${g.game_id}">G ${g.game_id} (${g.season})</option>`).join('');
        onSpatialGameAChange();
      } else {
        DOM.spatialGameA.innerHTML = `<option value="">No Games</option>`;
        if (DOM.spatialPlayA) DOM.spatialPlayA.innerHTML = `<option value="">No Plays</option>`;
      }
    }
  }
}

async function onSpatialGameAChange() {
  const se = state.spatialExplorer;
  const gameId = parseInt(DOM.spatialGameA?.value, 10);
  if (!gameId || !se.playerAId) return;

  const game = se.gamesA.find(g => g.game_id === gameId);
  const plays = game?.plays || [];
  if (DOM.spatialPlayA) {
    if (plays.length > 0) {
      DOM.spatialPlayA.innerHTML = plays.map(p => `<option value="${p.play_id}">Play ${p.play_id}</option>`).join('');
    } else {
      DOM.spatialPlayA.innerHTML = `<option value="">No Plays</option>`;
    }
  }
}

async function onSpatialPlayerBChange(preferredDrill = null) {
  const se = state.spatialExplorer;
  const val = DOM.spatialPlayerB?.value;
  if (!val) return;

  if (val === 'POS_AVG') {
    se.playerBId = 'POS_AVG';
    se.playerB = null;
    const pos = se.playerA?.position || 'ATH';
    if (DOM.spatialNameB) DOM.spatialNameB.textContent = `${pos} Position Benchmark Average`;
    if (DOM.spatialDrillB) {
      DOM.spatialDrillB.innerHTML = `<option value="POS_AVG">Position Benchmark Average</option>`;
    }
    return;
  }

  const pId = parseInt(val, 10);
  const player = (state.players || []).find(p => p.nfl_id === pId);
  se.playerBId = pId;
  se.playerB = player;
  if (DOM.spatialNameB) DOM.spatialNameB.textContent = player ? `${player.display_name} (${player.position})` : `Player ${pId}`;

  if (se.mode === 'combine') {
    const res = await api.fetchSpatialDrills(pId);
    se.drillsB = res?.drills || [];
    if (DOM.spatialDrillB) {
      if (se.drillsB.length > 0) {
        DOM.spatialDrillB.innerHTML = se.drillsB.map(d => `<option value="${d.event_id}">${d.drill_name}</option>`).join('');
        if (preferredDrill) {
          DOM.spatialDrillB.value = preferredDrill;
        } else {
          const drillAName = DOM.spatialDrillA?.selectedOptions[0]?.text;
          if (drillAName) {
            const match = se.drillsB.find(d => d.drill_name === drillAName);
            if (match) DOM.spatialDrillB.value = match.event_id;
          }
        }
      } else {
        DOM.spatialDrillB.innerHTML = `<option value="">No Combine Drills</option>`;
      }
    }
  } else {
    const gamesRes = await api.fetchGames(pId);
    se.gamesB = gamesRes?.games || [];
    if (DOM.spatialGameB) {
      if (se.gamesB.length > 0) {
        DOM.spatialGameB.innerHTML = se.gamesB.map(g => `<option value="${g.game_id}">G ${g.game_id} (${g.season})</option>`).join('');
        onSpatialGameBChange();
      } else {
        DOM.spatialGameB.innerHTML = `<option value="">No Games</option>`;
        if (DOM.spatialPlayB) DOM.spatialPlayB.innerHTML = `<option value="">No Plays</option>`;
      }
    }
  }
}

async function onSpatialGameBChange() {
  const se = state.spatialExplorer;
  const gameId = parseInt(DOM.spatialGameB?.value, 10);
  if (!gameId || !se.playerBId || se.playerBId === 'POS_AVG') return;

  const game = se.gamesB.find(g => g.game_id === gameId);
  const plays = game?.plays || [];
  if (DOM.spatialPlayB) {
    if (plays.length > 0) {
      DOM.spatialPlayB.innerHTML = plays.map(p => `<option value="${p.play_id}">Play ${p.play_id}</option>`).join('');
    } else {
      DOM.spatialPlayB.innerHTML = `<option value="">No Plays</option>`;
    }
  }
}

function swapSpatialPlayers() {
  const valA = DOM.spatialPlayerA?.value;
  const valB = DOM.spatialPlayerB?.value;
  if (!valA || !valB || valB === 'POS_AVG') {
    showToast('Cannot swap with Position Average');
    return;
  }

  DOM.spatialPlayerA.value = valB;
  DOM.spatialPlayerB.value = valA;

  onSpatialPlayerAChange().then(() => {
    onSpatialPlayerBChange().then(() => {
      runSpatialComparison();
    });
  });
}

async function runSpatialComparison() {
  const se = state.spatialExplorer;
  const pA = parseInt(DOM.spatialPlayerA?.value, 10);
  const valB = DOM.spatialPlayerB?.value;
  const step = parseFloat(DOM.spatialStepSelect?.value || '0.5');

  if (!pA) {
    showToast('Please select Prospect A');
    return;
  }

  showLoading('Computing curvilinear spatial resampling...');
  try {
    let comparison = null;

    if (se.mode === 'combine') {
      const drillA = DOM.spatialDrillA?.value;
      if (!drillA) {
        showToast('No combine drill available for Prospect A');
        hideLoading();
        return;
      }

      if (valB === 'POS_AVG') {
        const drillName = DOM.spatialDrillA?.selectedOptions[0]?.text || 'FORTY_YARD_DASH';
        const pos = se.playerA?.position || 'ATH';
        const pSamePos = (state.players || []).find(p => p.position === pos && p.nfl_id !== pA);
        if (pSamePos) {
          const drillsB = (await api.fetchSpatialDrills(pSamePos.nfl_id))?.drills || [];
          const matchB = drillsB.find(d => d.drill_name === drillName) || drillsB[0];
          if (matchB) {
            comparison = await api.compareSpatialCombine(pA, drillA, pSamePos.nfl_id, matchB.event_id, step);
            if (comparison) {
              comparison.player_b_name = `${pos} Benchmark (${pSamePos.display_name})`;
            }
          }
        }
      } else {
        const pB = parseInt(valB, 10);
        const drillB = DOM.spatialDrillB?.value;
        if (!pB || !drillB) {
          showToast('Please select Prospect B and Drill');
          hideLoading();
          return;
        }
        comparison = await api.compareSpatialCombine(pA, drillA, pB, drillB, step);
      }
    } else {
      const gameA = parseInt(DOM.spatialGameA?.value, 10);
      const playA = parseInt(DOM.spatialPlayA?.value, 10);
      const pB = parseInt(valB, 10);
      const gameB = parseInt(DOM.spatialGameB?.value, 10);
      const playB = parseInt(DOM.spatialPlayB?.value, 10);

      if (!gameA || !playA || !pB || !gameB || !playB) {
        showToast('Please select Game and Play for both players');
        hideLoading();
        return;
      }
      comparison = await api.compareSpatialSnap(pA, gameA, playA, pB, gameB, playB, step);
    }

    if (!comparison) {
      showToast('No spatial comparison data returned');
      return;
    }

    se.comparisonData = comparison;

    if (se.stripCanvas) se.stripCanvas.setData(comparison);
    if (se.overlayCanvas) se.overlayCanvas.setData(comparison);

    const maxD = comparison.common_max_distance || 40.0;
    if (DOM.spatialDistanceSlider) {
      DOM.spatialDistanceSlider.min = '0';
      DOM.spatialDistanceSlider.max = maxD.toString();
      DOM.spatialDistanceSlider.step = step.toString();
      DOM.spatialDistanceSlider.value = '0';
    }
    updateSpatialScrubUI(0);

    renderSpatialSummaryKPIs(comparison);
    renderSpatialMilestonesTable(comparison.milestones || []);
    renderSpatialSectorsTable(comparison.mini_sectors || []);

    if (DOM.spatialSummarySection) DOM.spatialSummarySection.style.display = 'grid';

  } catch (err) {
    console.error('Spatial comparison failed:', err);
    showToast('Failed to run spatial comparison');
  } finally {
    hideLoading();
  }
}

function renderSpatialSummaryKPIs(data) {
  const commonD = data.common_max_distance || 0;
  const finishDt = data.delta_time && data.delta_time.length > 0 ? data.delta_time[data.delta_time.length - 1] : 0;
  const nameA = data.player_a?.name || data.player_a_name || 'Prospect A';
  const nameB = data.player_b?.name || data.player_b_name || 'Prospect B';

  if (DOM.spatialCommonDist) {
    DOM.spatialCommonDist.textContent = `${commonD.toFixed(1)} yd`;
  }

  if (DOM.spatialFinishDelta) {
    const sign = finishDt < 0 ? '-' : '+';
    DOM.spatialFinishDelta.textContent = `${sign}${Math.abs(finishDt).toFixed(3)} s`;
    DOM.spatialFinishDelta.style.color = finishDt < 0 ? 'var(--color-emerald)' : finishDt > 0 ? 'var(--color-violet)' : 'var(--text-primary)';
  }

  if (DOM.spatialLeaderBadge) {
    if (finishDt < -0.005) {
      DOM.spatialLeaderBadge.textContent = `${nameA} Wins (-${Math.abs(finishDt).toFixed(3)}s)`;
      DOM.spatialLeaderBadge.className = 'badge badge-lead-a';
    } else if (finishDt > 0.005) {
      DOM.spatialLeaderBadge.textContent = `${nameB} Wins (+${Math.abs(finishDt).toFixed(3)}s)`;
      DOM.spatialLeaderBadge.className = 'badge badge-lead-b';
    } else {
      DOM.spatialLeaderBadge.textContent = 'DEAD HEAT (TIE)';
      DOM.spatialLeaderBadge.className = 'badge badge-lead-tie';
    }
  }

  const sectors = data.mini_sectors || [];
  let scoreA = 0;
  let scoreB = 0;
  sectors.forEach(s => {
    if (s.winner === 'A') scoreA++;
    else if (s.winner === 'B') scoreB++;
  });
  if (DOM.spatialSectorScore) {
    DOM.spatialSectorScore.textContent = `${scoreA} - ${scoreB} (A vs B)`;
  }

  const speedsA = data.speeds_a || [];
  const speedsB = data.speeds_b || [];
  const maxA = speedsA.length > 0 ? Math.max(...speedsA) : 0;
  const maxB = speedsB.length > 0 ? Math.max(...speedsB) : 0;
  const deltaVMax = maxA - maxB;
  if (DOM.spatialVMaxDelta) {
    const vSign = deltaVMax >= 0 ? '+' : '';
    DOM.spatialVMaxDelta.textContent = `${vSign}${deltaVMax.toFixed(2)} yd/s`;
    DOM.spatialVMaxDelta.style.color = deltaVMax >= 0 ? 'var(--color-cyan)' : 'var(--color-amber)';
  }

  if (DOM.spatialGComb) {
    const gMaxA = Number(data.g_comb_max_a || 0);
    const gMaxB = Number(data.g_comb_max_b || 0);
    DOM.spatialGComb.textContent = `A: ${gMaxA.toFixed(2)}g vs B: ${gMaxB.toFixed(2)}g`;
  }

  if (DOM.spatialOverlapIndex) {
    const olA = ((data.overlap_index_a || 0) * 100).toFixed(0);
    const olB = ((data.overlap_index_b || 0) * 100).toFixed(0);
    DOM.spatialOverlapIndex.textContent = `A: ${olA}% vs B: ${olB}%`;
  }

  if (DOM.spatialApexSpeed) {
    const apA = data.key_apex_speed_a ?? (data.apexes_a && data.apexes_a.length > 0 ? (data.apexes_a[0].v_apex ?? data.apexes_a[0].speed) : null);
    const apB = data.key_apex_speed_b ?? (data.apexes_b && data.apexes_b.length > 0 ? (data.apexes_b[0].v_apex ?? data.apexes_b[0].speed) : null);
    const strA = apA != null ? `${Number(apA).toFixed(1)} yd/s` : '--';
    const strB = apB != null ? `${Number(apB).toFixed(1)} yd/s` : '--';
    DOM.spatialApexSpeed.textContent = `A: ${strA} vs B: ${strB}`;
  }

  if (DOM.spatialExitTraction) {
    const exA = data.exit_traction_a ?? (data.apexes_a && data.apexes_a.length > 0 ? data.apexes_a[0].exit_traction : null);
    const exB = data.exit_traction_b ?? (data.apexes_b && data.apexes_b.length > 0 ? data.apexes_b[0].exit_traction : null);
    const signA = exA != null && exA >= 0 ? '+' : '';
    const signB = exB != null && exB >= 0 ? '+' : '';
    const strA = exA != null ? `${signA}${Number(exA).toFixed(1)}` : '--';
    const strB = exB != null ? `${signB}${Number(exB).toFixed(1)}` : '--';
    DOM.spatialExitTraction.textContent = `A: ${strA} vs B: ${strB} yd/s²`;
  }
}

function renderSpatialMilestonesTable(milestones) {
  if (!DOM.spatialMilestonesBody) return;

  if (!milestones || milestones.length === 0) {
    DOM.spatialMilestonesBody.innerHTML = '<tr><td colspan="8" class="text-muted text-center">No milestone splits for this drill.</td></tr>';
    return;
  }

  DOM.spatialMilestonesBody.innerHTML = milestones.map(m => {
    const dt = m.delta_time ?? 0;
    const winner = m.winner || (dt < -0.005 ? 'A' : dt > 0.005 ? 'B' : 'TIE');
    const badgeClass = winner === 'A' ? 'badge-lead-a' : winner === 'B' ? 'badge-lead-b' : 'badge-lead-tie';
    const sign = dt < 0 ? '-' : '+';
    const dtText = `${sign}${Math.abs(dt).toFixed(3)}s`;

    return `<tr>
      <td><strong>${m.name}</strong></td>
      <td class="font-mono">${Number(m.distance).toFixed(1)} yd</td>
      <td class="font-mono text-cyan">${Number(m.time_a).toFixed(3)}s</td>
      <td class="font-mono text-amber">${Number(m.time_b).toFixed(3)}s</td>
      <td class="font-mono">${dtText}</td>
      <td class="font-mono">${Number(m.speed_a).toFixed(2)} yd/s</td>
      <td class="font-mono">${Number(m.speed_b).toFixed(2)} yd/s</td>
      <td><span class="badge ${badgeClass}">${winner === 'A' ? 'Prospect A' : winner === 'B' ? 'Prospect B' : 'TIE'}</span></td>
    </tr>`;
  }).join('');
}

function renderSpatialSectorsTable(sectors) {
  if (!DOM.spatialSectorsBody) return;

  if (!sectors || sectors.length === 0) {
    DOM.spatialSectorsBody.innerHTML = '<tr><td colspan="8" class="text-muted text-center">No mini-sectors computed.</td></tr>';
    return;
  }

  DOM.spatialSectorsBody.innerHTML = sectors.map((s, idx) => {
    const dt = s.delta_time ?? 0;
    const winner = s.winner || (dt < -0.005 ? 'A' : dt > 0.005 ? 'B' : 'TIE');
    const badgeClass = winner === 'A' ? 'badge-lead-a' : winner === 'B' ? 'badge-lead-b' : 'badge-lead-tie';
    const sign = dt < 0 ? '-' : '+';
    const dtText = `${sign}${Math.abs(dt).toFixed(3)}s`;

    return `<tr>
      <td><strong>Sector ${idx + 1}</strong></td>
      <td class="font-mono">${Number(s.start_distance).toFixed(0)}-${Number(s.end_distance).toFixed(0)} yd</td>
      <td class="font-mono text-cyan">${Number(s.time_a).toFixed(3)}s</td>
      <td class="font-mono text-amber">${Number(s.time_b).toFixed(3)}s</td>
      <td class="font-mono">${dtText}</td>
      <td class="font-mono">${Number(s.avg_speed_a || 0).toFixed(2)} yd/s</td>
      <td class="font-mono">${Number(s.avg_speed_b || 0).toFixed(2)} yd/s</td>
      <td><span class="badge ${badgeClass}">${winner === 'A' ? 'Prospect A' : winner === 'B' ? 'Prospect B' : 'TIE'}</span></td>
    </tr>`;
  }).join('');
}

function updateSpatialScrubUI(distance) {
  if (DOM.spatialCurrentD) DOM.spatialCurrentD.textContent = `${distance.toFixed(1)} yd`;
  if (DOM.spatialDistanceSlider) DOM.spatialDistanceSlider.value = distance;
}

function setSpatialScrubDistance(distance) {
  const se = state.spatialExplorer;
  if (se.stripCanvas) se.stripCanvas.setScrubDistance(distance);
  if (se.overlayCanvas) se.overlayCanvas.setScrubDistance(distance);
  updateSpatialScrubUI(distance);
}

function toggleSpatialPlaySweep() {
  const se = state.spatialExplorer;
  if (se.isPlayingSweep) {
    stopSpatialPlaySweep();
  } else {
    startSpatialPlaySweep();
  }
}

function startSpatialPlaySweep() {
  const se = state.spatialExplorer;
  if (!se.comparisonData) return;

  se.isPlayingSweep = true;
  if (DOM.spatialScrubPlay) DOM.spatialScrubPlay.textContent = '||';

  const maxD = se.comparisonData.common_max_distance || 40.0;
  const step = parseFloat(DOM.spatialStepSelect?.value || '0.5');

  se.sweepTimer = setInterval(() => {
    let cur = parseFloat(DOM.spatialDistanceSlider?.value || '0');
    cur += step;
    if (cur > maxD) {
      cur = 0;
    }
    setSpatialScrubDistance(cur);
  }, 100);
}

function stopSpatialPlaySweep() {
  const se = state.spatialExplorer;
  se.isPlayingSweep = false;
  if (DOM.spatialScrubPlay) DOM.spatialScrubPlay.textContent = '>';
  if (se.sweepTimer) {
    clearInterval(se.sweepTimer);
    se.sweepTimer = null;
  }
}

// Auto-run on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  initCompareApp();
});
