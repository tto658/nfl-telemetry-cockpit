/**
 * NFL Telemetry Lab — Head-to-Head Movement Comparison Controller (compare_app.js)
 * Dedicated sub-page driver for Head-to-Head Comparison (compare.html).
 * Enforces:
 *  1. Live Game -> Play dropdown cascading & sequence-safe async updates
 *  2. Same-position comparison lock (with combine_position fallback only for singleton NFL positions)
 *  3. Same-drill synchronization in Combine Drill mode (shared drills & rep matching)
 *  4. Clear Football & Sports-Science terminology (5-Yard Split Intervals, etc.)
 */

import { api } from './api.js';
import { SpatialStripCanvas, SpatialOverlayCanvas } from './spatial_strip.js';

export const BENCHMARK_AVG_DRILLS = ['FORTY_YARD_DASH', 'THREE_CONE', 'SHUTTLE'];

const POSITION_POS_AVG_DRILLS = {
  DB: ['FORTY_YARD_DASH'],
  MLB: ['FORTY_YARD_DASH'],
  RB: ['FORTY_YARD_DASH'],
  NT: ['FORTY_YARD_DASH', 'THREE_CONE']
};

export function getPlayerPosition(player) {
  return String(player?.position || player?.nfl_position || 'ATH').toUpperCase();
}

/**
 * Build sorted position group list with player counts: [{ position, count }]
 */
export function getPositionGroups(players) {
  const counts = new Map();
  for (const p of (players || [])) {
    const pos = getPlayerPosition(p);
    counts.set(pos, (counts.get(pos) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([position, count]) => ({ position, count }))
    .sort((a, b) => (b.count - a.count) || a.position.localeCompare(b.position));
}

/**
 * Find Player B candidates locked to the same NFL position as Player A.
 * Only if the NFL position has zero other peers in the dataset (singleton RB/MLB/FB),
 * gracefully falls back to matching combine_position.
 */
export function getSamePositionPeers(players, playerA, excludeId = null) {
  if (!Array.isArray(players) || players.length === 0) {
    return { peers: [], position: 'WR', usedCombineFallback: false };
  }
  const targetPos = getPlayerPosition(playerA);
  const exId = excludeId != null ? Number(excludeId) : (playerA?.nfl_id ?? null);

  const exactPeers = players.filter(p => getPlayerPosition(p) === targetPos && p.nfl_id !== exId);
  if (exactPeers.length > 0) {
    return { peers: exactPeers, position: targetPos, usedCombineFallback: false };
  }

  const combPos = String(playerA?.combine_position || '').toUpperCase();
  if (combPos) {
    const combPeers = players.filter(
      p => String(p.combine_position || '').toUpperCase() === combPos && p.nfl_id !== exId
    );
    if (combPeers.length > 0) {
      return { peers: combPeers, position: targetPos, combineGroup: combPos, usedCombineFallback: true };
    }
  }

  return { peers: [], position: targetPos, usedCombineFallback: false };
}

/**
 * Check if two players are compatible for comparison (same NFL position, or allowed combine fallback).
 */
export function arePositionsCompatible(players, playerA, playerB) {
  if (!playerA || !playerB) return false;
  if (getPlayerPosition(playerA) === getPlayerPosition(playerB)) return true;
  const { peers, usedCombineFallback } = getSamePositionPeers(players, playerA, playerA.nfl_id);
  return usedCombineFallback && peers.some(p => p.nfl_id === playerB.nfl_id);
}

/**
 * Annotate drills with Rep numbers when a player performed multiple attempts of the same drill.
 */
export function annotateDrillReps(drills) {
  const list = Array.isArray(drills) ? drills : [];
  const totals = new Map();
  for (const d of list) {
    totals.set(d.drill_name, (totals.get(d.drill_name) || 0) + 1);
  }
  const seen = new Map();
  return list.map(d => {
    const n = (seen.get(d.drill_name) || 0) + 1;
    seen.set(d.drill_name, n);
    const total = totals.get(d.drill_name) || 1;
    return {
      ...d,
      repIndex: n,
      repTotal: total,
      displayLabel: total > 1 ? `${d.drill_name} (Rep ${n})` : d.drill_name
    };
  });
}

/**
 * Synchronize Drill A choices with Player B's drills (or Position Average supported drills)
 * so mismatched combine drills can never be compared.
 */
export function getSynchronizedDrillOptions(drillsA, drillsB, { isPosAvg = false, position = 'WR' } = {}) {
  const annotatedA = annotateDrillReps(drillsA);
  let allowedNames;
  let unavailableSuffix;

  if (isPosAvg) {
    const posDrills = POSITION_POS_AVG_DRILLS[position] || BENCHMARK_AVG_DRILLS;
    allowedNames = new Set(posDrills);
    unavailableSuffix = 'No Position Average';
  } else {
    allowedNames = new Set((drillsB || []).map(d => d.drill_name));
    unavailableSuffix = 'Not run by Player B';
  }

  const optionsA = annotatedA.map(d => ({
    ...d,
    compatible: allowedNames.has(d.drill_name),
    optionText: allowedNames.has(d.drill_name) ? d.displayLabel : `${d.displayLabel} — (${unavailableSuffix})`
  }));

  const commonCount = optionsA.filter(o => o.compatible).length;
  return { optionsA, commonCount };
}

/**
 * Return only Player B drill attempts that match Player A's selected drill_name.
 */
export function getMatchingRepsForDrill(drillsB, targetDrillName) {
  if (!targetDrillName) return [];
  const annotatedB = annotateDrillReps(drillsB);
  return annotatedB.filter(d => d.drill_name === targetDrillName);
}

/**
 * Format Game dropdown option cleanly: "2023 Wk 2 vs CHI (18 plays)"
 */
export function formatGameOptionLabel(g) {
  if (!g) return 'Unknown Game';
  const opp = g.opponent || (g.home_away === 'home' ? g.visitor_team : g.home_team) || 'OPP';
  const haSymbol = g.home_away === 'away' ? '@' : 'vs';
  const wk = g.week ? `Wk ${g.week}` : `${g.season || ''}`;
  const playCnt = g.total_plays ?? g.play_count ?? (Array.isArray(g.plays) ? g.plays.length : 0);
  return `${g.season || ''} ${wk} ${haSymbol} ${opp} (${playCnt} plays)`.trim();
}

/**
 * Format Play dropdown option cleanly: "Q1 3&4 • PASS — ... [#1877]"
 */
export function formatPlayOptionLabel(p) {
  if (!p) return 'Unknown Play';
  const qtr = p.quarter ? `Q${p.quarter}` : 'Q1';
  const dd = (p.down && p.yards_to_go != null) ? `${p.down}&${p.yards_to_go}` : '';
  const type = p.play_type || (p.is_run ? 'RUN' : 'PASS');
  const rawDesc = String(p.description || p.play_description || '').replace(/\s+/g, ' ').trim();
  const shortDesc = rawDesc.length > 28 ? `${rawDesc.slice(0, 27)}…` : rawDesc;
  const parts = [qtr, dd].filter(Boolean).join(' ');
  return shortDesc
    ? `${parts} • ${type} — ${shortDesc} [#${p.play_id}]`
    : `${parts} • ${type} [#${p.play_id}]`;
}

// ============================================================================
// Controller State & Safe DOM Access
// ============================================================================

const state = {
  players: [],
  spatialExplorer: {
    mode: 'combine', // 'combine' | 'snap'
    selectedPosition: 'WR',
    playerAId: null,
    playerBId: null,
    playerA: null,
    playerB: null,
    usedCombineFallback: false,
    drillsA: [],
    drillsB: [],
    gamesA: [],
    gamesB: [],
    seqA: 0,
    seqB: 0,
    gameSeqA: 0,
    gameSeqB: 0,
    comparisonData: null,
    stripCanvas: null,
    overlayCanvas: null,
    scrubDistance: 0,
    isPlayingSweep: false,
    sweepTimer: null
  }
};

function getDomRefs() {
  if (typeof document === 'undefined') return {};
  const byId = (id) => document.getElementById(id);
  return {
    loadingOverlay: byId('loadingOverlay'),
    loadingMessage: byId('loadingMessage'),
    toastNotification: byId('toastNotification'),
    toastMessage: byId('toastMessage'),

    spatialModeCombine: byId('spatialModeCombine'),
    spatialModeSnap: byId('spatialModeSnap'),

    spatialPositionSelect: byId('spatialPositionSelect'),
    spatialPositionLockBadge: byId('spatialPositionLockBadge'),

    spatialPlayerA: byId('spatialPlayerA'),
    spatialPlayerB: byId('spatialPlayerB'),
    spatialNameA: byId('spatialNameA'),
    spatialNameB: byId('spatialNameB'),

    spatialCombineControlsA: byId('spatialCombineControlsA'),
    spatialCombineControlsB: byId('spatialCombineControlsB'),
    spatialDrillA: byId('spatialDrillA'),
    spatialDrillB: byId('spatialDrillB'),
    spatialDrillSyncNote: byId('spatialDrillSyncNote'),

    spatialSnapControlsA: byId('spatialSnapControlsA'),
    spatialSnapControlsB: byId('spatialSnapControlsB'),
    spatialGameA: byId('spatialGameA'),
    spatialGameB: byId('spatialGameB'),
    spatialPlayA: byId('spatialPlayA'),
    spatialPlayB: byId('spatialPlayB'),

    spatialSwapBtn: byId('spatialSwapBtn'),
    spatialStepSelect: byId('spatialStepSelect'),
    spatialCompareBtn: byId('spatialCompareBtn'),

    spatialSummarySection: byId('spatialSummarySection'),
    spatialCommonDist: byId('spatialCommonDist'),
    spatialFinishDelta: byId('spatialFinishDelta'),
    spatialLeaderBadge: byId('spatialLeaderBadge'),
    spatialSectorScore: byId('spatialSectorScore'),
    spatialVMaxDelta: byId('spatialVMaxDelta'),
    spatialGComb: byId('spatialGComb'),
    spatialOverlapIndex: byId('spatialOverlapIndex'),
    spatialApexSpeed: byId('spatialApexSpeed'),
    spatialExitTraction: byId('spatialExitTraction'),

    spatialOverlayCanvas: byId('spatialOverlayCanvas'),
    spatialStripCanvas: byId('spatialStripCanvas'),
    btnLane3Sideslip: byId('btnLane3Sideslip'),
    btnLane3GForce: byId('btnLane3GForce'),

    spatialDistanceSlider: byId('spatialDistanceSlider'),
    spatialCurrentD: byId('spatialCurrentD'),
    spatialScrubReset: byId('spatialScrubReset'),
    spatialScrubPlay: byId('spatialScrubPlay'),

    spatialMilestonesBody: byId('spatialMilestonesBody'),
    spatialSectorsBody: byId('spatialSectorsBody')
  };
}

let DOM = {};

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

function showToast(msg, duration = 3500) {
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

// ============================================================================
// Controller Initialization
// ============================================================================

export async function initCompareApp() {
  DOM = getDomRefs();
  const se = state.spatialExplorer;

  if (DOM.spatialStripCanvas) {
    se.stripCanvas = new SpatialStripCanvas(DOM.spatialStripCanvas, {
      onScrub: (d) => {
        if (se.overlayCanvas) se.overlayCanvas.setScrubDistance(d);
        updateSpatialScrubUI(d);
      }
    });
  }
  if (DOM.spatialOverlayCanvas) {
    se.overlayCanvas = new SpatialOverlayCanvas(DOM.spatialOverlayCanvas, {
      onScrub: (d) => {
        if (se.stripCanvas) se.stripCanvas.setScrubDistance(d);
        updateSpatialScrubUI(d);
      }
    });
  }

  // Bind Event Listeners (including Game -> Play and Drill A -> Drill B cascades)
  if (DOM.spatialModeCombine) {
    DOM.spatialModeCombine.addEventListener('click', () => setSpatialMode('combine'));
  }
  if (DOM.spatialModeSnap) {
    DOM.spatialModeSnap.addEventListener('click', () => setSpatialMode('snap'));
  }
  if (DOM.spatialPositionSelect) {
    DOM.spatialPositionSelect.addEventListener('change', () => onSpatialPositionChange());
  }
  if (DOM.spatialPlayerA) {
    DOM.spatialPlayerA.addEventListener('change', () => onSpatialPlayerAChange());
  }
  if (DOM.spatialPlayerB) {
    DOM.spatialPlayerB.addEventListener('change', () => onSpatialPlayerBChange());
  }
  if (DOM.spatialDrillA) {
    DOM.spatialDrillA.addEventListener('change', () => onSpatialDrillAChange());
  }
  if (DOM.spatialGameA) {
    DOM.spatialGameA.addEventListener('change', () => onSpatialGameAChange());
  }
  if (DOM.spatialGameB) {
    DOM.spatialGameB.addEventListener('change', () => onSpatialGameBChange());
  }
  if (DOM.spatialSwapBtn) {
    DOM.spatialSwapBtn.addEventListener('click', () => swapSpatialPlayers());
  }
  if (DOM.spatialCompareBtn) {
    DOM.spatialCompareBtn.addEventListener('click', () => runSpatialComparison());
  }
  if (DOM.spatialDistanceSlider) {
    DOM.spatialDistanceSlider.addEventListener('input', (e) => {
      setSpatialScrubDistance(parseFloat(e.target.value));
    });
  }
  if (DOM.spatialScrubReset) {
    DOM.spatialScrubReset.addEventListener('click', () => setSpatialScrubDistance(0));
  }
  if (DOM.spatialScrubPlay) {
    DOM.spatialScrubPlay.addEventListener('click', () => toggleSpatialPlaySweep());
  }

  if (DOM.btnLane3Sideslip) {
    DOM.btnLane3Sideslip.addEventListener('click', () => {
      DOM.btnLane3Sideslip.classList.add('active');
      DOM.btnLane3GForce?.classList.remove('active');
      se.stripCanvas?.setLane3Mode('sideslip');
    });
  }
  if (DOM.btnLane3GForce) {
    DOM.btnLane3GForce.addEventListener('click', () => {
      DOM.btnLane3GForce.classList.add('active');
      DOM.btnLane3Sideslip?.classList.remove('active');
      se.stripCanvas?.setLane3Mode('gforce');
    });
  }

  showLoading('Loading player directory...');
  try {
    const players = await api.fetchPlayers();
    state.players = players || [];
    await populateInitialSelections();
  } catch (err) {
    console.error('Failed to load prospects:', err);
    showToast('Failed to load players list');
  } finally {
    hideLoading();
  }
}

export function parseUrlParams() {
  if (typeof window === 'undefined') return {};
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

function updateModeVisibilityUI(mode) {
  if (DOM.spatialModeCombine) DOM.spatialModeCombine.classList.toggle('active', mode === 'combine');
  if (DOM.spatialModeSnap) DOM.spatialModeSnap.classList.toggle('active', mode === 'snap');

  const isCombine = mode === 'combine';
  if (DOM.spatialCombineControlsA) DOM.spatialCombineControlsA.style.display = isCombine ? 'flex' : 'none';
  if (DOM.spatialCombineControlsB) DOM.spatialCombineControlsB.style.display = isCombine ? 'flex' : 'none';
  if (DOM.spatialSnapControlsA) DOM.spatialSnapControlsA.style.display = isCombine ? 'none' : 'flex';
  if (DOM.spatialSnapControlsB) DOM.spatialSnapControlsB.style.display = isCombine ? 'none' : 'flex';
}

async function setSpatialMode(mode) {
  const se = state.spatialExplorer;
  if (se.mode === mode) return;
  se.mode = mode;
  updateModeVisibilityUI(mode);

  // Repopulate Player B so POS_AVG is hidden in Game Snap mode and visible in Combine mode
  populatePlayerBOptions(se.playerA, null);

  await onSpatialPlayerAChange();
  await onSpatialPlayerBChange();
}

function populatePositionDropdown(selectedPos) {
  if (!DOM.spatialPositionSelect) return;
  const groups = getPositionGroups(state.players);
  DOM.spatialPositionSelect.innerHTML = groups
    .map(({ position, count }) => `<option value="${position}">${position} (${count} players)</option>`)
    .join('');
  if (selectedPos && groups.some(g => g.position === selectedPos)) {
    DOM.spatialPositionSelect.value = selectedPos;
  } else if (groups.length > 0) {
    DOM.spatialPositionSelect.value = groups[0].position;
  }
  state.spatialExplorer.selectedPosition = DOM.spatialPositionSelect.value;
}

function populatePlayerAOptions(pos, preferredId = null) {
  if (!DOM.spatialPlayerA) return;
  const matching = state.players.filter(p => getPlayerPosition(p) === pos);
  const pool = matching.length > 0 ? matching : state.players;

  DOM.spatialPlayerA.innerHTML = pool
    .map(p => `<option value="${p.nfl_id}">${p.display_name} [${getPlayerPosition(p)} • ${p.college || 'N/A'}]</option>`)
    .join('');

  if (preferredId != null && pool.some(p => p.nfl_id === Number(preferredId))) {
    DOM.spatialPlayerA.value = String(preferredId);
  } else if (pool.length > 0) {
    DOM.spatialPlayerA.value = String(pool[0].nfl_id);
  }
}

function populatePlayerBOptions(playerA, preferredB = null) {
  if (!DOM.spatialPlayerB || !playerA) return;
  const se = state.spatialExplorer;
  const { peers, position, combineGroup, usedCombineFallback } = getSamePositionPeers(
    state.players,
    playerA,
    playerA.nfl_id
  );
  se.usedCombineFallback = usedCombineFallback;

  if (DOM.spatialPositionLockBadge) {
    DOM.spatialPositionLockBadge.textContent = usedCombineFallback
      ? `Position Lock: ${position} (Solo NFL Pos -> Combine Group: ${combineGroup})`
      : `Same-Position Lock: ${position} (${peers.length} peers)`;
  }

  // Prefer peers with active teams (snaps) first when in Snap mode
  const sortedPeers = se.mode === 'snap'
    ? [...peers].sort((a, b) => ((b.teams?.length || 0) > 0 ? 1 : 0) - ((a.teams?.length || 0) > 0 ? 1 : 0))
    : peers;

  const peersHtml = sortedPeers
    .map(p => {
      const noSnapTag = se.mode === 'snap' && (!p.teams || p.teams.length === 0) ? ' (0 snaps)' : '';
      return `<option value="${p.nfl_id}">${p.display_name} [${getPlayerPosition(p)} • ${p.college || 'N/A'}]${noSnapTag}</option>`;
    })
    .join('');

  // Position Average applies to Combine Drills only, not Game Snaps
  const posAvgHtml = se.mode === 'combine'
    ? `<option value="POS_AVG">${position} Position Average (Benchmark)</option>`
    : '';

  DOM.spatialPlayerB.innerHTML = posAvgHtml + peersHtml;

  if (se.mode === 'combine' && (preferredB === 'POS_AVG' || preferredB == null)) {
    DOM.spatialPlayerB.value = 'POS_AVG';
  } else if (preferredB && preferredB !== 'POS_AVG' && sortedPeers.some(p => p.nfl_id === Number(preferredB))) {
    DOM.spatialPlayerB.value = String(preferredB);
  } else if (sortedPeers.length > 0) {
    DOM.spatialPlayerB.value = String(sortedPeers[0].nfl_id);
  } else if (posAvgHtml) {
    DOM.spatialPlayerB.value = 'POS_AVG';
  }
}

async function populateInitialSelections() {
  const players = state.players || [];
  if (players.length === 0) return;

  const url = parseUrlParams();
  const se = state.spatialExplorer;

  const mode = url.mode === 'snap' ? 'snap' : 'combine';
  se.mode = mode;
  updateModeVisibilityUI(mode);

  const requestedA = url.playerA ? parseInt(url.playerA, 10) : 56056; // Trey Palmer (WR) default
  const initialPlayerA = players.find(p => p.nfl_id === requestedA) || players.find(p => getPlayerPosition(p) === 'WR') || players[0];
  const initialPos = getPlayerPosition(initialPlayerA);

  populatePositionDropdown(initialPos);
  populatePlayerAOptions(initialPos, initialPlayerA.nfl_id);

  const requestedB = url.playerB
    ? (url.playerB === 'POS_AVG' ? 'POS_AVG' : parseInt(url.playerB, 10))
    : (mode === 'combine' ? 'POS_AVG' : null);

  populatePlayerBOptions(initialPlayerA, requestedB);

  await onSpatialPlayerAChange({
    preferredDrill: url.drillA,
    preferredGame: url.gameA,
    preferredPlay: url.playA
  });
  await onSpatialPlayerBChange({
    preferredDrill: url.drillB,
    preferredGame: url.gameB,
    preferredPlay: url.playB
  });

  await runSpatialComparison();
}

async function onSpatialPositionChange() {
  const se = state.spatialExplorer;
  const pos = DOM.spatialPositionSelect?.value;
  if (!pos) return;
  se.selectedPosition = pos;

  populatePlayerAOptions(pos, null);
  const newAId = parseInt(DOM.spatialPlayerA?.value, 10);
  const newPlayerA = state.players.find(p => p.nfl_id === newAId) || null;
  populatePlayerBOptions(newPlayerA, se.mode === 'combine' ? 'POS_AVG' : null);

  await onSpatialPlayerAChange();
  await onSpatialPlayerBChange();
}

function renderSynchronizedCombineDropdowns(preferredDrillA = null, preferredDrillB = null) {
  const se = state.spatialExplorer;
  if (se.mode !== 'combine') return;

  const isPosAvg = se.playerBId === 'POS_AVG';
  const pos = getPlayerPosition(se.playerA);

  // Build Drill A options constrained to drills shared with Player B (or POS_AVG benchmarks)
  const { optionsA, commonCount } = getSynchronizedDrillOptions(se.drillsA, se.drillsB, {
    isPosAvg,
    position: pos
  });

  if (DOM.spatialDrillA) {
    if (optionsA.length === 0) {
      DOM.spatialDrillA.innerHTML = '<option value="">No Combine Drills Recorded</option>';
    } else {
      DOM.spatialDrillA.innerHTML = optionsA
        .map(o => `<option value="${o.event_id}" ${o.compatible ? '' : 'disabled'}>${o.optionText}</option>`)
        .join('');

      const compatibleOpts = optionsA.filter(o => o.compatible);
      const preferredCompatible = preferredDrillA
        ? compatibleOpts.find(o => o.event_id === preferredDrillA)
        : null;
      const fortyCompatible = compatibleOpts.find(o => o.drill_name.includes('FORTY'));

      if (preferredCompatible) {
        DOM.spatialDrillA.value = preferredCompatible.event_id;
      } else if (fortyCompatible) {
        DOM.spatialDrillA.value = fortyCompatible.event_id;
      } else if (compatibleOpts.length > 0) {
        DOM.spatialDrillA.value = compatibleOpts[0].event_id;
      } else {
        DOM.spatialDrillA.value = '';
      }
    }
  }

  syncDrillBToDrillA(preferredDrillB, commonCount);
}

function syncDrillBToDrillA(preferredDrillB = null, commonCount = null) {
  const se = state.spatialExplorer;
  if (se.mode !== 'combine' || !DOM.spatialDrillB) return;

  const selectedEventA = DOM.spatialDrillA?.value;
  const drillObjA = se.drillsA.find(d => d.event_id === selectedEventA);
  const targetDrillName = drillObjA?.drill_name || '';

  if (se.playerBId === 'POS_AVG') {
    const pos = getPlayerPosition(se.playerA);
    DOM.spatialDrillB.innerHTML = targetDrillName
      ? `<option value="${targetDrillName}">${pos} Average — ${targetDrillName}</option>`
      : `<option value="">No matching Position Average drill</option>`;
    if (DOM.spatialDrillSyncNote) {
      DOM.spatialDrillSyncNote.textContent = targetDrillName
        ? `Locked to ${pos} Position Average for ${targetDrillName}`
        : 'Only 40-Yard Dash, 3-Cone, and Shuttle have multi-player position averages';
    }
    return;
  }

  if (!targetDrillName) {
    DOM.spatialDrillB.innerHTML = '<option value="">No shared Combine drill</option>';
    if (DOM.spatialDrillSyncNote) {
      DOM.spatialDrillSyncNote.textContent = commonCount === 0
        ? 'No Combine drills in common between these two players'
        : 'Select a Combine drill for Player A';
    }
    return;
  }

  const matchingRepsB = getMatchingRepsForDrill(se.drillsB, targetDrillName);
  if (matchingRepsB.length > 0) {
    DOM.spatialDrillB.innerHTML = matchingRepsB
      .map(d => `<option value="${d.event_id}">${d.displayLabel}</option>`)
      .join('');
    if (preferredDrillB && matchingRepsB.some(d => d.event_id === preferredDrillB)) {
      DOM.spatialDrillB.value = preferredDrillB;
    } else {
      DOM.spatialDrillB.value = matchingRepsB[0].event_id;
    }
    if (DOM.spatialDrillSyncNote) {
      DOM.spatialDrillSyncNote.textContent = `Locked to matching ${targetDrillName} rep (${matchingRepsB.length} available)`;
    }
  } else {
    DOM.spatialDrillB.innerHTML = `<option value="">No ${targetDrillName} for Player B</option>`;
    if (DOM.spatialDrillSyncNote) {
      DOM.spatialDrillSyncNote.textContent = `Player B has no ${targetDrillName} recorded`;
    }
  }
}

function onSpatialDrillAChange() {
  syncDrillBToDrillA();
}

async function onSpatialPlayerAChange({ preferredDrill = null, preferredGame = null, preferredPlay = null } = {}) {
  const se = state.spatialExplorer;
  const pId = parseInt(DOM.spatialPlayerA?.value, 10);
  if (!pId) return;

  const seq = ++se.seqA;
  const player = state.players.find(p => p.nfl_id === pId) || null;
  se.playerAId = pId;
  se.playerA = player;

  const posA = getPlayerPosition(player);
  if (DOM.spatialPositionSelect && DOM.spatialPositionSelect.value !== posA) {
    DOM.spatialPositionSelect.value = posA;
    se.selectedPosition = posA;
  }
  if (DOM.spatialNameA) {
    DOM.spatialNameA.textContent = player ? `${player.display_name} (${posA})` : `Player ${pId}`;
  }

  // Keep Player B strictly locked to the same position when Player A changes
  const curBVal = DOM.spatialPlayerB?.value;
  const curBPlayer = curBVal && curBVal !== 'POS_AVG'
    ? state.players.find(p => p.nfl_id === parseInt(curBVal, 10))
    : null;
  if (!curBPlayer || !arePositionsCompatible(state.players, player, curBPlayer) || curBPlayer.nfl_id === pId) {
    populatePlayerBOptions(player, se.mode === 'combine' ? (curBVal === 'POS_AVG' ? 'POS_AVG' : null) : null);
    // Fire Player B load for the new peer asynchronously afterwards
    var needReloadB = true;
  }

  if (se.mode === 'combine') {
    const res = await api.fetchSpatialDrills(pId);
    if (seq !== se.seqA) return;
    se.drillsA = res?.drills || [];
    renderSynchronizedCombineDropdowns(preferredDrill, null);
    if (needReloadB) {
      await onSpatialPlayerBChange();
    }
  } else {
    const gamesRes = await api.fetchGames(pId);
    if (seq !== se.seqA) return;
    se.gamesA = gamesRes?.games || [];
    if (DOM.spatialGameA) {
      if (se.gamesA.length > 0) {
        DOM.spatialGameA.innerHTML = se.gamesA
          .map(g => `<option value="${g.game_id}">${formatGameOptionLabel(g)}</option>`)
          .join('');
        if (preferredGame && se.gamesA.some(g => String(g.game_id) === String(preferredGame))) {
          DOM.spatialGameA.value = String(preferredGame);
        } else {
          DOM.spatialGameA.value = String(se.gamesA[0].game_id);
        }
        await onSpatialGameAChange(preferredPlay);
      } else {
        DOM.spatialGameA.innerHTML = '<option value="">No Games Recorded</option>';
        if (DOM.spatialPlayA) DOM.spatialPlayA.innerHTML = '<option value="">No Plays</option>';
      }
    }
    if (needReloadB) {
      await onSpatialPlayerBChange();
    }
  }
}

export async function onSpatialGameAChange(preferredPlay = null) {
  const se = state.spatialExplorer;
  const seq = ++se.gameSeqA;
  const rawGameVal = DOM.spatialGameA?.value;
  const gameId = parseInt(rawGameVal, 10);

  if (!DOM.spatialPlayA) return;
  if (!gameId || !se.playerAId) {
    DOM.spatialPlayA.innerHTML = '<option value="">No Plays</option>';
    return;
  }

  const game = se.gamesA.find(g => Number(g.game_id) === gameId);
  let plays = game?.plays;
  if (!Array.isArray(plays) || plays.length === 0) {
    const playsRes = await api.fetchPlays(se.playerAId, gameId);
    if (seq !== se.gameSeqA) return;
    plays = playsRes?.plays || [];
    if (game) game.plays = plays;
  }

  if (plays.length > 0) {
    DOM.spatialPlayA.innerHTML = plays
      .map(p => `<option value="${p.play_id}">${formatPlayOptionLabel(p)}</option>`)
      .join('');
    if (preferredPlay && plays.some(p => String(p.play_id) === String(preferredPlay))) {
      DOM.spatialPlayA.value = String(preferredPlay);
    } else {
      DOM.spatialPlayA.value = String(plays[0].play_id);
    }
  } else {
    DOM.spatialPlayA.innerHTML = '<option value="">No Plays in Game</option>';
  }
}

async function onSpatialPlayerBChange({ preferredDrill = null, preferredGame = null, preferredPlay = null } = {}) {
  const se = state.spatialExplorer;
  const val = DOM.spatialPlayerB?.value;
  if (!val) return;

  const seq = ++se.seqB;

  if (val === 'POS_AVG') {
    se.playerBId = 'POS_AVG';
    se.playerB = null;
    se.drillsB = [];
    se.gamesB = [];
    const pos = getPlayerPosition(se.playerA);
    if (DOM.spatialNameB) DOM.spatialNameB.textContent = `${pos} Position Average`;
    renderSynchronizedCombineDropdowns(DOM.spatialDrillA?.value || null, null);
    return;
  }

  const pId = parseInt(val, 10);
  const player = state.players.find(p => p.nfl_id === pId) || null;
  se.playerBId = pId;
  se.playerB = player;
  const posB = getPlayerPosition(player);
  if (DOM.spatialNameB) DOM.spatialNameB.textContent = player ? `${player.display_name} (${posB})` : `Player ${pId}`;

  if (se.mode === 'combine') {
    const res = await api.fetchSpatialDrills(pId);
    if (seq !== se.seqB) return;
    se.drillsB = res?.drills || [];
    renderSynchronizedCombineDropdowns(DOM.spatialDrillA?.value || null, preferredDrill);
  } else {
    const gamesRes = await api.fetchGames(pId);
    if (seq !== se.seqB) return;
    se.gamesB = gamesRes?.games || [];
    if (DOM.spatialGameB) {
      if (se.gamesB.length > 0) {
        DOM.spatialGameB.innerHTML = se.gamesB
          .map(g => `<option value="${g.game_id}">${formatGameOptionLabel(g)}</option>`)
          .join('');
        if (preferredGame && se.gamesB.some(g => String(g.game_id) === String(preferredGame))) {
          DOM.spatialGameB.value = String(preferredGame);
        } else {
          DOM.spatialGameB.value = String(se.gamesB[0].game_id);
        }
        await onSpatialGameBChange(preferredPlay);
      } else {
        DOM.spatialGameB.innerHTML = '<option value="">No Games Recorded</option>';
        if (DOM.spatialPlayB) DOM.spatialPlayB.innerHTML = '<option value="">No Plays</option>';
      }
    }
  }
}

export async function onSpatialGameBChange(preferredPlay = null) {
  const se = state.spatialExplorer;
  const seq = ++se.gameSeqB;
  const rawGameVal = DOM.spatialGameB?.value;
  const gameId = parseInt(rawGameVal, 10);

  if (!DOM.spatialPlayB) return;
  if (!gameId || !se.playerBId || se.playerBId === 'POS_AVG') {
    DOM.spatialPlayB.innerHTML = '<option value="">No Plays</option>';
    return;
  }

  const game = se.gamesB.find(g => Number(g.game_id) === gameId);
  let plays = game?.plays;
  if (!Array.isArray(plays) || plays.length === 0) {
    const playsRes = await api.fetchPlays(se.playerBId, gameId);
    if (seq !== se.gameSeqB) return;
    plays = playsRes?.plays || [];
    if (game) game.plays = plays;
  }

  if (plays.length > 0) {
    DOM.spatialPlayB.innerHTML = plays
      .map(p => `<option value="${p.play_id}">${formatPlayOptionLabel(p)}</option>`)
      .join('');
    if (preferredPlay && plays.some(p => String(p.play_id) === String(preferredPlay))) {
      DOM.spatialPlayB.value = String(preferredPlay);
    } else {
      DOM.spatialPlayB.value = String(plays[0].play_id);
    }
  } else {
    DOM.spatialPlayB.innerHTML = '<option value="">No Plays in Game</option>';
  }
}

async function swapSpatialPlayers() {
  const valA = DOM.spatialPlayerA?.value;
  const valB = DOM.spatialPlayerB?.value;
  if (!valA || !valB || valB === 'POS_AVG') {
    showToast('Cannot swap with Position Average');
    return;
  }

  const prevDrillA = DOM.spatialDrillA?.value;
  const prevDrillB = DOM.spatialDrillB?.value;
  const prevGameA = DOM.spatialGameA?.value;
  const prevPlayA = DOM.spatialPlayA?.value;
  const prevGameB = DOM.spatialGameB?.value;
  const prevPlayB = DOM.spatialPlayB?.value;

  DOM.spatialPlayerA.value = valB;
  populatePlayerBOptions(state.players.find(p => p.nfl_id === parseInt(valB, 10)), valA);
  DOM.spatialPlayerB.value = valA;

  await onSpatialPlayerAChange({
    preferredDrill: prevDrillB,
    preferredGame: prevGameB,
    preferredPlay: prevPlayB
  });
  await onSpatialPlayerBChange({
    preferredDrill: prevDrillA,
    preferredGame: prevGameA,
    preferredPlay: prevPlayA
  });
  await runSpatialComparison();
}

async function runSpatialComparison() {
  const se = state.spatialExplorer;
  const pA = parseInt(DOM.spatialPlayerA?.value, 10);
  const valB = DOM.spatialPlayerB?.value;
  const step = parseFloat(DOM.spatialStepSelect?.value || '0.5');

  if (!pA) {
    showToast('Please select Player A');
    return;
  }

  const playerA = state.players.find(p => p.nfl_id === pA);
  if (valB && valB !== 'POS_AVG') {
    const playerB = state.players.find(p => p.nfl_id === parseInt(valB, 10));
    if (!arePositionsCompatible(state.players, playerA, playerB)) {
      showToast('Players must share the same position group for comparison');
      return;
    }
  }

  showLoading('Aligning yard-by-yard movement...');
  try {
    let comparison = null;

    if (se.mode === 'combine') {
      const drillA = DOM.spatialDrillA?.value;
      if (!drillA) {
        showToast('No matching Combine drill available for both players');
        return;
      }
      const drillObjA = se.drillsA.find(d => d.event_id === drillA);
      const drillNameA = drillObjA?.drill_name || '';

      if (valB === 'POS_AVG') {
        comparison = await api.compareSpatialCombine(pA, drillA, 'POS_AVG', drillNameA, step);
        if (comparison) {
          const pos = getPlayerPosition(se.playerA);
          comparison.player_b_name = `${pos} Position Average`;
        }
      } else {
        const pB = parseInt(valB, 10);
        const drillB = DOM.spatialDrillB?.value;
        const drillObjB = se.drillsB.find(d => d.event_id === drillB);
        if (!pB || !drillB) {
          showToast('Player B does not have a matching rep for this Combine drill');
          return;
        }
        if (drillNameA && drillObjB?.drill_name && drillNameA !== drillObjB.drill_name) {
          showToast(`Combine drills must match (${drillNameA} vs ${drillObjB.drill_name})`);
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
        showToast('Please select a Game and Play for both players');
        return;
      }
      comparison = await api.compareSpatialSnap(pA, gameA, playA, pB, gameB, playB, step);
    }

    if (!comparison) {
      showToast('No comparison data available for this selection');
      return;
    }

    if (!comparison.player_a_name && se.playerA) {
      comparison.player_a_name = `${se.playerA.display_name} (${getPlayerPosition(se.playerA)})`;
    }
    if (!comparison.player_b_name && se.playerB) {
      comparison.player_b_name = `${se.playerB.display_name} (${getPlayerPosition(se.playerB)})`;
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
    console.error('Head-to-head comparison failed:', err);
    showToast('Failed to run comparison');
  } finally {
    hideLoading();
  }
}

function renderSpatialSummaryKPIs(data) {
  const commonD = data.common_max_distance || 0;
  const finishDt = data.delta_time && data.delta_time.length > 0 ? data.delta_time[data.delta_time.length - 1] : 0;
  const nameA = data.player_a?.name || data.player_a_name || 'Player A';
  const nameB = data.player_b?.name || data.player_b_name || 'Player B';

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
      DOM.spatialLeaderBadge.textContent = `${nameA} Faster (-${Math.abs(finishDt).toFixed(3)}s)`;
      DOM.spatialLeaderBadge.className = 'badge badge-lead-a';
    } else if (finishDt > 0.005) {
      DOM.spatialLeaderBadge.textContent = `${nameB} Faster (-${Math.abs(finishDt).toFixed(3)}s)`;
      DOM.spatialLeaderBadge.className = 'badge badge-lead-b';
    } else {
      DOM.spatialLeaderBadge.textContent = 'EVEN (TIE)';
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
    const rawOlA = Number(data.overlap_index_a || 0);
    const rawOlB = Number(data.overlap_index_b || 0);
    const olA = (rawOlA > 1 ? rawOlA : rawOlA * 100).toFixed(0);
    const olB = (rawOlB > 1 ? rawOlB : rawOlB * 100).toFixed(0);
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

export function renderSpatialMilestonesTable(milestones, targetBody = DOM.spatialMilestonesBody) {
  if (!targetBody) return;

  if (!milestones || milestones.length === 0) {
    targetBody.innerHTML = '<tr><td colspan="8" class="text-muted text-center">No checkpoint splits for this selection.</td></tr>';
    return;
  }

  targetBody.innerHTML = milestones.map(m => {
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
      <td><span class="badge ${badgeClass}">${winner === 'A' ? 'Player A' : winner === 'B' ? 'Player B' : 'TIE'}</span></td>
    </tr>`;
  }).join('');
}

export function renderSpatialSectorsTable(sectors, targetBody = DOM.spatialSectorsBody) {
  if (!targetBody) return;

  if (!sectors || sectors.length === 0) {
    targetBody.innerHTML = '<tr><td colspan="8" class="text-muted text-center">No 5-yard split intervals computed.</td></tr>';
    return;
  }

  targetBody.innerHTML = sectors.map((s, idx) => {
    const dt = s.delta_time ?? 0;
    const winner = s.winner || (dt < -0.005 ? 'A' : dt > 0.005 ? 'B' : 'TIE');
    const badgeClass = winner === 'A' ? 'badge-lead-a' : winner === 'B' ? 'badge-lead-b' : 'badge-lead-tie';
    const sign = dt < 0 ? '-' : '+';
    const dtText = `${sign}${Math.abs(dt).toFixed(3)}s`;
    const startYd = Number(s.start_distance).toFixed(0);
    const endYd = Number(s.end_distance).toFixed(0);

    return `<tr>
      <td><strong>Split ${idx + 1}</strong></td>
      <td class="font-mono">${startYd}&ndash;${endYd} yd</td>
      <td class="font-mono text-cyan">${Number(s.time_a).toFixed(3)}s</td>
      <td class="font-mono text-amber">${Number(s.time_b).toFixed(3)}s</td>
      <td class="font-mono">${dtText}</td>
      <td class="font-mono">${Number(s.speed_a_avg ?? s.avg_speed_a ?? 0).toFixed(2)} yd/s</td>
      <td class="font-mono">${Number(s.speed_b_avg ?? s.avg_speed_b ?? 0).toFixed(2)} yd/s</td>
      <td><span class="badge ${badgeClass}">${winner === 'A' ? 'Player A' : winner === 'B' ? 'Player B' : 'TIE'}</span></td>
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

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initCompareApp();
  });
}
