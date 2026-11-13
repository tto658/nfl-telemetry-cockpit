/**
 * NFL Tracking Dashboard — Main Application Controller
 * Milestone M3: Frontend Base & Tab 1 Combine Explorer
 */

import { api } from './api.js';
import { CombineFieldCanvas } from './combine_field.js';
import { GameFieldCanvas } from './game_field.js';
import { PlaybackEngine, TimeseriesCanvas } from './timeseries.js';
import { SpatialStripCanvas, SpatialOverlayCanvas } from './spatial_strip.js';
import { GGDiagramCanvas } from './gg_diagram.js';
import {
  CockpitGGController,
  updateBioArchetypeBadge,
  updateNavBridgeBar,
  setupLane3ModeToggle,
} from './telemetry_cockpit.js';

// Global state container
const state = {
  metadata: null,
  players: [],
  selectedPlayerId: null,
  selectedPlayer: null,
  summary: null,
  combineData: null,
  selectedDrillId: null,
  drillData: null,
  filters: {
    draft_year: '',
    pos: '',
    team_abbr: '',
    q: ''
  },
  activeTab: 'tab-combine',
  searchDebounceTimer: null,
  playbackEngine: null,
  combineFieldCanvas: null,
  timeseriesCanvas: null,
  combineGGCanvas: null,
  gameGGCanvas: null,
  cockpitGG: new CockpitGGController(),
  // Tab 2 Game Explorer state
  gameExplorer: {
    games: [],
    filteredGames: [],
    selectedGameId: null,
    selectedGame: null,
    plays: [],
    filteredPlays: [],
    selectedPlayId: null,
    selectedPlay: null,
    snapData: null,
    filters: {
      season: '',
      play_type: '',
      lined_up_position: ''
    },
    playbackEngine: null,
    gameFieldCanvas: null,
    gameTimeseriesCanvas: null
  },
  // Tab 3 Spatial Benchmark & Overlay state
  spatialExplorer: {
    mode: 'combine', // 'combine' | 'snap'
    playerAId: null,
    playerBId: null, // or 'POS_AVG'
    playerA: null,
    playerB: null,
    drillsA: [],
    drillsB: [],
    selectedDrillA: null,
    selectedDrillB: null,
    gamesA: [],
    gamesB: [],
    selectedGameA: null,
    selectedGameB: null,
    playsA: [],
    playsB: [],
    selectedPlayA: null,
    selectedPlayB: null,
    step: 0.5,
    comparisonData: null,
    stripCanvas: null,
    overlayCanvas: null,
    isPlayingSweep: false,
    sweepIntervalId: null,
    isInitialized: false
  }
};
state.spatial = state.spatialExplorer;

// DOM Element References Cache
const DOM = {};

function cacheDOMElements() {
  // Tab 3 elements
  DOM.tabBtnSpatial = document.getElementById('tabBtnSpatial');
  DOM.tabSpatial = document.getElementById('tab-spatial');
  DOM.spatialModeCombine = document.getElementById('spatialModeCombine');
  DOM.spatialModeSnap = document.getElementById('spatialModeSnap');
  DOM.spatialPlayerA = document.getElementById('spatialPlayerA');
  DOM.spatialPlayerB = document.getElementById('spatialPlayerB');
  DOM.spatialDrillA = document.getElementById('spatialDrillA');
  DOM.spatialDrillB = document.getElementById('spatialDrillB');
  DOM.spatialGameA = document.getElementById('spatialGameA');
  DOM.spatialGameB = document.getElementById('spatialGameB');
  DOM.spatialPlayA = document.getElementById('spatialPlayA');
  DOM.spatialPlayB = document.getElementById('spatialPlayB');
  DOM.spatialNameA = document.getElementById('spatialNameA');
  DOM.spatialNameB = document.getElementById('spatialNameB');
  DOM.spatialCombineControlsA = document.getElementById('spatialCombineControlsA');
  DOM.spatialCombineControlsB = document.getElementById('spatialCombineControlsB');
  DOM.spatialSnapControlsA = document.getElementById('spatialSnapControlsA');
  DOM.spatialSnapControlsB = document.getElementById('spatialSnapControlsB');
  DOM.spatialSwapBtn = document.getElementById('spatialSwapBtn');
  DOM.spatialStepSelect = document.getElementById('spatialStepSelect');
  DOM.spatialCompareBtn = document.getElementById('spatialCompareBtn');
  DOM.spatialSummarySection = document.getElementById('spatialSummarySection');
  DOM.spatialCommonDist = document.getElementById('spatialCommonDist');
  DOM.spatialFinishDelta = document.getElementById('spatialFinishDelta');
  DOM.spatialLeaderBadge = document.getElementById('spatialLeaderBadge');
  DOM.spatialSectorScore = document.getElementById('spatialSectorScore');
  DOM.spatialVMaxDelta = document.getElementById('spatialVMaxDelta');
  DOM.spatialOverlayCanvas = document.getElementById('spatialOverlayCanvas');
  DOM.spatialStripCanvas = document.getElementById('spatialStripCanvas');
  DOM.spatialScrubReset = document.getElementById('spatialScrubReset');
  DOM.spatialScrubPlay = document.getElementById('spatialScrubPlay');
  DOM.spatialCurrentD = document.getElementById('spatialCurrentD');
  DOM.spatialDistanceSlider = document.getElementById('spatialDistanceSlider');
  DOM.spatialMilestonesTable = document.getElementById('spatialMilestonesTable');
  DOM.spatialMilestonesBody = document.getElementById('spatialMilestonesBody');
  DOM.spatialSectorsTable = document.getElementById('spatialSectorsTable');
  DOM.spatialSectorsBody = document.getElementById('spatialSectorsBody');

  // Mission Control & Telemetry Cockpit Elements
  DOM.btnSendDrillToSpatial = document.getElementById('btnSendDrillToSpatial');
  DOM.combineGGCanvas = document.getElementById('combineGGCanvas');
  DOM.btnSendSnapToSpatial = document.getElementById('btnSendSnapToSpatial');
  DOM.gameGGCanvas = document.getElementById('gameGGCanvas');
  DOM.btnStripLane3Toggle = document.getElementById('btnStripLane3Toggle');
  DOM.btnLane3Sideslip = document.getElementById('btnLane3Sideslip');
  DOM.btnLane3GForce = document.getElementById('btnLane3GForce');
  DOM.bioArchetypeBadge = document.getElementById('bioArchetypeBadge');
  DOM.navBridgeProspectName = document.getElementById('navBridgeProspectName');
  DOM.navBridgeProspectMeta = document.getElementById('navBridgeProspectMeta');

  DOM.draftYearFilter = document.getElementById('draftYearFilter');
  DOM.positionFilter = document.getElementById('positionFilter');
  DOM.teamFilter = document.getElementById('teamFilter');
  DOM.searchInput = document.getElementById('searchInput');
  DOM.searchClearBtn = document.getElementById('searchClearBtn');
  DOM.playerSelect = document.getElementById('playerSelect');
  DOM.playerCountBadge = document.getElementById('playerCountBadge');

  // Bio Banner Elements
  DOM.bioName = document.getElementById('bioName');
  DOM.bioPosition = document.getElementById('bioPosition');
  DOM.bioDraftPick = document.getElementById('bioDraftPick');
  DOM.bioCollege = document.getElementById('bioCollege');
  DOM.bioHeight = document.getElementById('bioHeight');
  DOM.bioWeight = document.getElementById('bioWeight');
  DOM.bioTeams = document.getElementById('bioTeams');
  DOM.bioTotalSnaps = document.getElementById('bioTotalSnaps');
  DOM.bioSnapBreakdown = document.getElementById('bioSnapBreakdown');
  DOM.bioGamesActive = document.getElementById('bioGamesActive');
  DOM.bioAccoladesContainer = document.getElementById('bioAccoladesContainer');
  DOM.bioAccolades = document.getElementById('bioAccolades');
  DOM.playerBioBanner = document.getElementById('playerBioBanner');
  DOM.btnToggleBioStrip = document.getElementById('btnToggleBioStrip');
  DOM.bioToggleIcon = document.getElementById('bioToggleIcon');

  // Tabs
  DOM.tabBtnCombine = document.getElementById('tabBtnCombine');
  DOM.tabBtnGame = document.getElementById('tabBtnGame');
  DOM.tabCombine = document.getElementById('tab-combine') || document.getElementById('tabCombine');
  DOM.tabGame = document.getElementById('tab-game') || document.getElementById('tabGame');

  // Combine Metrics
  DOM.metricForty = document.getElementById('metricForty');
  DOM.badgeForty = document.getElementById('badgeForty');
  DOM.metricVertical = document.getElementById('metricVertical');
  DOM.badgeVertical = document.getElementById('badgeVertical');
  DOM.metricBroad = document.getElementById('metricBroad');
  DOM.badgeBroad = document.getElementById('badgeBroad');
  DOM.metricThreeCone = document.getElementById('metricThreeCone');
  DOM.badgeThreeCone = document.getElementById('badgeThreeCone');
  DOM.metricShuttle = document.getElementById('metricShuttle');
  DOM.badgeShuttle = document.getElementById('badgeShuttle');
  DOM.metricBench = document.getElementById('metricBench');
  DOM.badgeBench = document.getElementById('badgeBench');
  DOM.metricAthleticism = document.getElementById('metricAthleticism');
  DOM.badgeAthleticism = document.getElementById('badgeAthleticism');
  DOM.metricProduction = document.getElementById('metricProduction');
  DOM.badgeProduction = document.getElementById('badgeProduction');
  DOM.metricFinalScore = document.getElementById('metricFinalScore');
  DOM.badgeFinalScore = document.getElementById('badgeFinalScore');

  // Drill Elements
  DOM.drillSelect = document.getElementById('drillSelect');
  DOM.drillDuration = document.getElementById('drillDuration');
  DOM.drillSMax = document.getElementById('drillSMax');
  DOM.drillAMax = document.getElementById('drillAMax');
  DOM.drillKappa90 = document.getElementById('drillKappa90');
  DOM.drillGCombMax = document.getElementById('drillGCombMax');
  DOM.drillOverlapIndex = document.getElementById('drillOverlapIndex');
  DOM.drillApexSpeed = document.getElementById('drillApexSpeed');
  DOM.drillExitTraction = document.getElementById('drillExitTraction');

  DOM.vdGCombVal = document.getElementById('vdGCombVal');
  DOM.vdOverlapVal = document.getElementById('vdOverlapVal');
  DOM.vdApexVal = document.getElementById('vdApexVal');
  DOM.vdExitTractionVal = document.getElementById('vdExitTractionVal');

  DOM.spatialGComb = document.getElementById('spatialGComb');
  DOM.spatialOverlapIndex = document.getElementById('spatialOverlapIndex');
  DOM.spatialApexSpeed = document.getElementById('spatialApexSpeed');
  DOM.spatialExitTraction = document.getElementById('spatialExitTraction');

  // Canvases
  DOM.combineCanvas = document.getElementById('combineCanvas') || document.getElementById('combineFieldCanvas');
  DOM.timeseriesCanvas = document.getElementById('timeseriesCanvas');

  // Playback Controls
  DOM.btnPlayPause = document.getElementById('btnPlayPause');
  DOM.btnStepBack = document.getElementById('btnStepBack');
  DOM.btnStepForward = document.getElementById('btnStepForward');
  DOM.btnReset = document.getElementById('btnReset');
  DOM.playbackScrubber = document.getElementById('playbackScrubber');
  DOM.playbackTimeDisplay = document.getElementById('playbackTimeDisplay');
  DOM.playbackRateSelect = document.getElementById('playbackRateSelect');

  // Overlay & Toast
  DOM.loadingOverlay = document.getElementById('loadingOverlay');
  DOM.loadingMessage = document.getElementById('loadingMessage');
  DOM.toast = document.getElementById('toastNotification');
  DOM.toastMessage = document.getElementById('toastMessage');

  // Tab 2: Zero Snap Rookie
  DOM.zeroSnapCard = document.getElementById('zeroSnapCard');
  DOM.btnSwitchToCombine = document.getElementById('btnSwitchToCombine');

  // Tab 2: Content & Game Filters
  DOM.gameExplorerContent = document.getElementById('gameExplorerContent');
  DOM.gameFiltersToolbar = document.getElementById('gameFiltersToolbar');
  DOM.gameSeasonSelect = document.getElementById('gameSeasonSelect');
  DOM.gameSelect = document.getElementById('gameSelect');
  DOM.playTypeFilter = document.getElementById('playTypeFilter');
  DOM.playPositionFilter = document.getElementById('playPositionFilter');

  // Tab 2: Plays Table
  DOM.playsTableContainer = document.getElementById('playsTableContainer');
  DOM.playsTable = document.getElementById('playsTable');
  DOM.playsTableBody = document.getElementById('playsTableBody');

  // Tab 2: Play Metadata Card
  DOM.playMetadataCard = document.getElementById('playMetadataCard');
  DOM.metaSituationBadge = document.getElementById('metaSituationBadge');
  DOM.metaQuarter = document.getElementById('metaQuarter');
  DOM.metaClock = document.getElementById('metaClock');
  DOM.metaDownDistance = document.getElementById('metaDownDistance');
  DOM.metaYardline = document.getElementById('metaYardline');
  DOM.metaLinedUpPos = document.getElementById('metaLinedUpPos');
  DOM.metaPlayType = document.getElementById('metaPlayType');
  DOM.metaEpaPill = document.getElementById('metaEpaPill');
  DOM.metaEpaValue = document.getElementById('metaEpaValue');
  DOM.metaDescription = document.getElementById('metaDescription');

  // Tab 2: Vehicle Dynamics & Stability Card
  DOM.vehicleDynamicsCard = document.getElementById('vehicleDynamicsCard');
  DOM.vdStatusBadge = document.getElementById('vdStatusBadge');
  DOM.vdStatusText = document.getElementById('vdStatusText');
  DOM.vdBetaVal = document.getElementById('vdBetaVal');
  DOM.vdBetaInterpretation = document.getElementById('vdBetaInterpretation');
  DOM.vdBetaRateVal = document.getElementById('vdBetaRateVal');
  DOM.vdJerkVal = document.getElementById('vdJerkVal');
  DOM.vdSnapCount = document.getElementById('vdSnapCount');
  DOM.vdSnapPills = document.getElementById('vdSnapPills');

  // Tab 2: Canvases & View Toggle
  DOM.btnToggleGameView = document.getElementById('btnToggleGameView');
  DOM.gameFieldCanvas = document.getElementById('gameFieldCanvas') || document.getElementById('gameCanvas');
  DOM.gameTimeseriesCanvas = document.getElementById('gameTimeseriesCanvas');

  // Tab 2: Playback Controls & Jump Bar
  DOM.gamePlaybackBar = document.getElementById('gamePlaybackBar');
  DOM.btnGamePlayPause = document.getElementById('btnGamePlayPause');
  DOM.btnGameStepBack = document.getElementById('btnGameStepBack');
  DOM.btnGameStepForward = document.getElementById('btnGameStepForward');
  DOM.btnGameReset = document.getElementById('btnGameReset');
  DOM.gamePlaybackScrubber = document.getElementById('gamePlaybackScrubber');
  DOM.gamePlaybackTimeDisplay = document.getElementById('gamePlaybackTimeDisplay');
  DOM.gamePlaybackRateSelect = document.getElementById('gamePlaybackRateSelect');
  DOM.gameEventJumpBar = document.getElementById('gameEventJumpBar');
  DOM.gameEventButtons = document.getElementById('gameEventButtons');
}

/* ==========================================================================
   UI UTILITIES & FEEDBACK
   ========================================================================== */
function showLoading(msg = 'Loading telemetry...') {
  if (DOM.loadingOverlay) {
    DOM.loadingMessage.textContent = msg;
    DOM.loadingOverlay.style.display = 'flex';
  }
}

function hideLoading() {
  if (DOM.loadingOverlay) {
    DOM.loadingOverlay.style.display = 'none';
  }
}

function showToast(message, duration = 4000) {
  if (DOM.toast) {
    DOM.toastMessage.textContent = message;
    DOM.toast.style.display = 'block';
    setTimeout(() => {
      DOM.toast.style.display = 'none';
    }, duration);
  }
}

/* ==========================================================================
   METADATA & FILTERS SETUP
   ========================================================================== */
async function loadMetadata() {
  state.metadata = await api.fetchMetadata();
  if (!state.metadata) return;

  // Populate Position dropdown
  if (DOM.positionFilter && Array.isArray(state.metadata.positions)) {
    DOM.positionFilter.innerHTML = '<option value="">All Positions</option>' +
      state.metadata.positions.map(p => `<option value="${p}">${p}</option>`).join('');
  }

  // Populate Team dropdown
  if (DOM.teamFilter && Array.isArray(state.metadata.teams)) {
    DOM.teamFilter.innerHTML = '<option value="">All Teams</option>' +
      state.metadata.teams.map(t => `<option value="${t}">${t}</option>`).join('');
  }
}

/* ==========================================================================
   PLAYERS LIST & DROPDOWN MANAGEMENT
   ========================================================================== */
async function applyPlayerFilters() {
  showLoading('Filtering prospects...');
  const players = await api.fetchPlayers(state.filters);
  state.players = players;

  // Update count badge
  if (DOM.playerCountBadge) {
    DOM.playerCountBadge.textContent = players.length;
  }

  // Populate player dropdown
  if (DOM.playerSelect) {
    if (players.length === 0) {
      DOM.playerSelect.innerHTML = '<option value="">No players match current filters</option>';
      DOM.playerSelect.disabled = true;
      hideLoading();
      return;
    }

    DOM.playerSelect.disabled = false;
    DOM.playerSelect.innerHTML = players.map(p => {
      const label = p.display_label || `${p.display_name} [${p.nfl_position}]`;
      return `<option value="${p.nfl_id}">${label}</option>`;
    }).join('');

    // If currently selected player is in new list, keep selected; else select first
    const match = players.find(p => p.nfl_id === state.selectedPlayerId);
    const targetId = match ? match.nfl_id : players[0].nfl_id;
    DOM.playerSelect.value = targetId;
    await selectPlayer(targetId);
  }
  hideLoading();
}

/* ==========================================================================
   PLAYER DATA SELECTION & POPULATION
   ========================================================================== */
async function selectPlayer(nflId) {
  if (!nflId) return;
  state.selectedPlayerId = parseInt(nflId, 10);
  state.selectedPlayer = state.players.find(p => p.nfl_id === state.selectedPlayerId) || null;
  if (state.cockpitGG) {
    state.cockpitGG.setCurrentPlayerId(state.selectedPlayerId);
  }

  showLoading('Loading prospect dossier...');
  try {
    // Parallel fetch of summary and combine details
    const [summary, combine] = await Promise.all([
      api.fetchPlayerSummary(state.selectedPlayerId),
      api.fetchCombine(state.selectedPlayerId)
    ]);

    state.summary = summary;
    state.combineData = combine;

    updateBioBanner(summary);
    updateCombineMetrics(combine || (summary ? summary.combine : null));
    updateBioArchetypeBadge(state.selectedPlayerId, summary, combine);
    updateNavBridgeBar(state.selectedPlayer, summary);
    await updateTrackedDrills(combine);

    // Tab 2 games loading
    await loadPlayerGames(state.selectedPlayerId);

  } catch (err) {
    console.error('Error loading player data:', err);
    showToast('Failed to load player data');
  } finally {
    hideLoading();
  }
}

/* ==========================================================================
   BIO BANNER RENDERING
   ========================================================================== */
function updateBioBanner(summary) {
  if (!summary) return;
  const bio = summary.bio || {};
  const career = summary.career || summary.career_stats || {};

  DOM.bioName.textContent = summary.display_name || bio.display_name || '--';
  DOM.bioPosition.textContent = summary.nfl_position || bio.nfl_position || '--';
  DOM.bioDraftPick.textContent = bio.draft_pick_formatted || summary.draft_pick_formatted || 'UDFA';

  DOM.bioCollege.textContent = bio.college_name || bio.college || summary.college || 'N/A';
  DOM.bioHeight.textContent = bio.height_formatted || bio.height_display || '--';
  DOM.bioWeight.textContent = `${bio.weight_lbs || bio.weight || summary.weight_lbs || '--'} lbs`;

  const teams = bio.teams || summary.teams || [];
  DOM.bioTeams.textContent = teams.length > 0 ? teams.join('/') : 'FA';

  // Career snaps (gracefully handle 0-snap rookies)
  const off = career.career_offensive_snaps || career.offensive_snaps || 0;
  const def = career.career_defensive_snaps || career.defensive_snaps || 0;
  const st = career.career_special_teams_snaps || career.special_teams_snaps || 0;
  const tot = career.total_snaps || (off + def + st);

  DOM.bioTotalSnaps.textContent = tot.toLocaleString();
  DOM.bioSnapBreakdown.textContent = `${off} / ${def} / ${st}`;
  DOM.bioGamesActive.textContent = career.games_active || career.career_games_active || 0;

  // Accolades
  const allPro = career.all_pro_total || career.all_pro || 0;
  const proBowl = career.pro_bowl_count || career.pro_bowl || 0;
  if (allPro > 0 || proBowl > 0) {
    const accolades = [];
    if (allPro > 0) accolades.push(`${allPro}x All-Pro`);
    if (proBowl > 0) accolades.push(`${proBowl}x Pro Bowl`);
    DOM.bioAccolades.textContent = accolades.join(' • ');
    DOM.bioAccoladesContainer.style.display = 'flex';
  } else {
    DOM.bioAccoladesContainer.style.display = 'none';
  }
}

/* ==========================================================================
   COMBINE METRICS & OPT-OUT / MNAR BADGES
   ========================================================================== */
function renderMetricWithOptOut(valueElement, badgeContainer, value, unit, isOptOut) {
  if (!valueElement || !badgeContainer) return;
  if (isOptOut || value === null || value === undefined || (typeof value === 'number' && isNaN(value))) {
    valueElement.textContent = '--';
    badgeContainer.innerHTML = '<span class="badge-opt-out opt-out" title="Missing Not At Random — Player elected not to participate in this drill">Opt-Out / MNAR</span>';
  } else {
    valueElement.textContent = typeof value === 'number' ? (Number.isInteger(value) ? value : value.toFixed(2)) : value;
    badgeContainer.innerHTML = '<span class="badge-recorded">Recorded</span>';
  }
}

function updateCombineMetrics(combine) {
  if (!combine) {
    [DOM.badgeForty, DOM.badgeVertical, DOM.badgeBroad, DOM.badgeThreeCone, DOM.badgeShuttle, DOM.badgeBench, DOM.badgeAthleticism, DOM.badgeProduction, DOM.badgeFinalScore].forEach(b => {
      if (b) b.innerHTML = '<span class="badge-opt-out opt-out">Opt-Out / MNAR</span>';
    });
    return;
  }

  const tests = combine.combine_tests || {};
  const optOuts = new Set(combine.opt_outs || []);
  const ngs = combine.ngs_scores || {};

  const getTestInfo = (key) => {
    const entry = tests[key];
    if (entry && typeof entry === 'object') {
      const val = entry.value;
      const isOpt = entry.opt_out || val === null || optOuts.has(key);
      return { val, isOpt };
    }
    const val = combine[key];
    const isOpt = val === null || val === undefined || optOuts.has(key);
    return { val, isOpt };
  };

  // 1. Forty-Yard Dash
  const forty = getTestInfo('forty');
  renderMetricWithOptOut(DOM.metricForty, DOM.badgeForty, forty.val, 'sec', forty.isOpt);

  // 2. Vertical Jump
  const vert = getTestInfo('vertical');
  renderMetricWithOptOut(DOM.metricVertical, DOM.badgeVertical, vert.val, 'in', vert.isOpt);

  // 3. Broad Jump
  const broad = getTestInfo('broad_jump');
  renderMetricWithOptOut(DOM.metricBroad, DOM.badgeBroad, broad.val, 'in', broad.isOpt);

  // 4. 3-Cone Drill
  const cone = getTestInfo('three_cone');
  renderMetricWithOptOut(DOM.metricThreeCone, DOM.badgeThreeCone, cone.val, 'sec', cone.isOpt);

  // 5. Short Shuttle
  const shuttle = getTestInfo('short_shuttle');
  renderMetricWithOptOut(DOM.metricShuttle, DOM.badgeShuttle, shuttle.val, 'sec', shuttle.isOpt);

  // 6. Bench Press
  const bench = getTestInfo('bench_reps');
  renderMetricWithOptOut(DOM.metricBench, DOM.badgeBench, bench.val, 'reps', bench.isOpt);

  // 7. NGS Athleticism
  const ath = ngs.athleticism_score !== undefined ? ngs.athleticism_score : combine.athleticism_score;
  renderMetricWithOptOut(DOM.metricAthleticism, DOM.badgeAthleticism, ath, '', ath === null);

  // 8. NGS Production
  const prod = ngs.college_production_score !== undefined ? ngs.college_production_score : null;
  renderMetricWithOptOut(DOM.metricProduction, DOM.badgeProduction, prod, '', prod === null);

  // 9. NGS Final Score
  const fin = ngs.final_score !== undefined ? ngs.final_score : null;
  renderMetricWithOptOut(DOM.metricFinalScore, DOM.badgeFinalScore, fin, '', fin === null);
}

/* ==========================================================================
   TRACKED DRILL SELECTION & TELEMETRY
   ========================================================================== */
async function updateTrackedDrills(combine) {
  if (!DOM.drillSelect) return;

  const drills = (combine && Array.isArray(combine.drills)) ? combine.drills : [];

  if (drills.length === 0) {
    DOM.drillSelect.innerHTML = '<option value="">No tracked combine drills available</option>';
    DOM.drillSelect.disabled = true;
    resetDrillMetrics();
    if (state.combineFieldCanvas) state.combineFieldCanvas.loadDrill([]);
    if (state.timeseriesCanvas) state.timeseriesCanvas.loadFrames([]);
    if (state.playbackEngine) state.playbackEngine.loadFrames([]);
    return;
  }

  DOM.drillSelect.disabled = false;
  DOM.drillSelect.innerHTML = drills.map(d => {
    const label = `${d.drill_name} (${d.event_id.slice(-12)})`;
    return `<option value="${d.event_id}">${label}</option>`;
  }).join('');

  // Automatically select and load first drill
  const firstEventId = drills[0].event_id;
  DOM.drillSelect.value = firstEventId;
  await selectDrill(firstEventId);
}

function resetDrillMetrics() {
  if (DOM.drillDuration) DOM.drillDuration.textContent = '-- s';
  if (DOM.drillSMax) DOM.drillSMax.textContent = '-- yd/s';
  if (DOM.drillAMax) DOM.drillAMax.textContent = '-- yd/s²';
  if (DOM.drillKappa90) DOM.drillKappa90.textContent = '-- 1/yd';
  if (DOM.drillGCombMax) DOM.drillGCombMax.textContent = '-- g';
  if (DOM.drillOverlapIndex) DOM.drillOverlapIndex.textContent = '-- %';
  if (DOM.drillApexSpeed) DOM.drillApexSpeed.textContent = '-- yd/s';
  if (DOM.drillExitTraction) DOM.drillExitTraction.textContent = '-- yd/s²';
}

async function selectDrill(eventId) {
  if (!eventId) return;
  state.selectedDrillId = eventId;

  showLoading('Loading 10 Hz drill telemetry...');
  try {
    const drillData = await api.fetchCombineDrill(state.selectedPlayerId, eventId);
    state.drillData = drillData;

    if (!drillData) {
      showToast('Drill telemetry not found');
      resetDrillMetrics();
      return;
    }

    // Populate summary card
    const m = drillData.metrics || drillData;
    if (DOM.drillDuration) DOM.drillDuration.textContent = `${(m.duration || 0).toFixed(2)} s`;
    if (DOM.drillSMax) DOM.drillSMax.textContent = `${(m.s_max || 0).toFixed(2)} yd/s`;
    if (DOM.drillAMax) DOM.drillAMax.textContent = `${(m.a_max || 0).toFixed(2)} yd/s²`;
    if (DOM.drillKappa90) DOM.drillKappa90.textContent = `${(m.kappa_90 || 0).toFixed(4)} 1/yd`;
    if (DOM.drillGCombMax) DOM.drillGCombMax.textContent = `${(m.g_comb_max || 0).toFixed(2)} g`;
    if (DOM.drillOverlapIndex) DOM.drillOverlapIndex.textContent = `${((m.overlap_index || 0) * 100).toFixed(1)}%`;
    if (DOM.drillApexSpeed) {
      const vApex = m.v_apex ?? (m.apex_metrics && m.apex_metrics.length > 0 ? m.apex_metrics[0].v_apex : null);
      DOM.drillApexSpeed.textContent = vApex != null ? `${Number(vApex).toFixed(1)} yd/s` : '-- yd/s';
    }
    if (DOM.drillExitTraction) {
      const exitTrac = m.corner_exit_traction ?? (m.apex_metrics && m.apex_metrics.length > 0 ? m.apex_metrics[0].exit_traction : null);
      if (exitTrac != null) {
        const sign = exitTrac >= 0 ? '+' : '';
        DOM.drillExitTraction.textContent = `${sign}${Number(exitTrac).toFixed(1)} yd/s²`;
      } else {
        DOM.drillExitTraction.textContent = '-- yd/s²';
      }
    }

    // Connect to 2D Combine Field and 10 Hz Timeseries Canvases
    initCanvasesAndPlayback(drillData);

  } catch (err) {
    console.error('Error loading drill attempt:', err);
    showToast('Failed to load drill kinematics');
  } finally {
    hideLoading();
  }
}

/* ==========================================================================
   CANVAS & PLAYBACK SYNCHRONIZER INTEGRATION
   ========================================================================== */
function initCanvasesAndPlayback(drillData) {
  const pFrames = drillData.player_frames || drillData.player_trajectory || [];

  if (state.combineFieldCanvas) {
    state.combineFieldCanvas.loadDrill(drillData);
  }
  if (state.timeseriesCanvas) {
    state.timeseriesCanvas.loadFrames(pFrames);
  }
  if (state.playbackEngine) {
    state.playbackEngine.loadFrames(pFrames);
  }

  // Instantiate and wire combineGGCanvas
  if (DOM.combineGGCanvas) {
    if (!state.combineGGCanvas && typeof GGDiagramCanvas === 'function') {
      try {
        state.combineGGCanvas = new GGDiagramCanvas(DOM.combineGGCanvas);
      } catch (err) {
        console.warn('Could not instantiate combine GGDiagramCanvas:', err);
      }
    }
    if (state.combineGGCanvas && typeof state.combineGGCanvas.setFrames === 'function') {
      state.combineGGCanvas.setFrames(pFrames, drillData.metrics || drillData);
    }
  }
  if (state.cockpitGG) {
    state.cockpitGG.initCombineGG(DOM.combineGGCanvas);
    state.cockpitGG.updateCombineData(pFrames, drillData.metrics || drillData);
  }

  const totalFrames = pFrames.length;
  if (DOM.playbackScrubber) {
    DOM.playbackScrubber.min = 0;
    DOM.playbackScrubber.max = Math.max(0, totalFrames - 1);
    DOM.playbackScrubber.value = 0;
  }
  updatePlaybackReadout(0, totalFrames);
}

function updatePlaybackReadout(frameIdx, totalFrames) {
  if (!DOM.playbackTimeDisplay) return;
  const curTime = (frameIdx * 0.1).toFixed(2);
  const totTime = (Math.max(0, totalFrames - 1) * 0.1).toFixed(2);
  DOM.playbackTimeDisplay.textContent = `Frame ${frameIdx} / ${Math.max(0, totalFrames - 1)} (${curTime}s / ${totTime}s)`;
}

/* ==========================================================================
   TAB 2: GAME EXPLORER WORKFLOW & CONTROLLER
   ========================================================================== */

/**
 * Load games list for selected player and handle 0-snap rookie state.
 */
async function loadPlayerGames(nflId) {
  if (!nflId) return;

  const res = await api.getPlayerGames(nflId);
  const games = (res && Array.isArray(res.games)) ? res.games : (Array.isArray(res) ? res : []);
  state.gameExplorer.games = games;

  // 13 Zero-snap rookie vs unavailable check
  if (games.length === 0) {
    const totalSnaps = state.playerSummary?.career?.total_snaps ?? 0;
    const isUnavailable = Boolean(res?.unavailable) || (!res?.zeroSnap && totalSnaps > 0);
    renderZeroSnapRookieState({ isUnavailable, totalSnaps });
    return;
  }

  // Active player with game snaps
  if (DOM.zeroSnapCard) DOM.zeroSnapCard.style.display = 'none';
  if (DOM.gameExplorerContent) DOM.gameExplorerContent.style.display = 'block';

  // Populate Season Filter
  populateGameSeasons(games);

  // Populate Games Dropdown
  await applyGameSeasonFilter();
}

function renderZeroSnapRookieState({ isUnavailable = false, totalSnaps = 0 } = {}) {
  if (DOM.zeroSnapCard) {
    DOM.zeroSnapCard.style.display = 'flex';
    const titleEl = DOM.zeroSnapCard.querySelector('.zero-snap-title');
    const descEl = DOM.zeroSnapCard.querySelector('.zero-snap-description');
    const subtextEl = DOM.zeroSnapCard.querySelector('.zero-snap-subtext');
    if (isUnavailable) {
      if (titleEl) titleEl.textContent = 'Game Tracking Telemetry Unavailable';
      if (descEl) {
        descEl.textContent = totalSnaps > 0
          ? `Game tracking telemetry failed to load for this player (${totalSnaps.toLocaleString()} career NFL regular season snaps recorded).`
          : 'Game tracking telemetry could not be loaded right now.';
      }
      if (subtextEl) {
        subtextEl.textContent = 'Please check your connection or reload the page. Official NFL Scouting Combine measurements and 10 Hz tracked combine drills remain accessible on Tab 1.';
      }
    } else {
      if (titleEl) titleEl.textContent = 'No Game Tracking Telemetry Recorded';
      if (descEl) {
        descEl.textContent = 'No game tracking telemetry recorded for this player (0 career NFL regular season snaps).';
      }
      if (subtextEl) {
        subtextEl.textContent = 'This prospect has not logged active regular season playing time in the 2023–2025 Next Gen Stats database. Official NFL Scouting Combine testing measurements, NGS athleticism scores, and 10 Hz tracked combine drills remain fully accessible on Tab 1.';
      }
    }
  }
  if (DOM.gameExplorerContent) DOM.gameExplorerContent.style.display = 'none';
  
  if (state.gameExplorer.playbackEngine) {
    state.gameExplorer.playbackEngine.pause();
    state.gameExplorer.playbackEngine.loadFrames([]);
  }
}

function populateGameSeasons(games) {
  if (!DOM.gameSeasonSelect) return;
  const seasons = [...new Set(games.map(g => g.season).filter(Boolean))].sort((a, b) => b - a);
  DOM.gameSeasonSelect.innerHTML = '<option value="">All Seasons</option>' +
    seasons.map(s => `<option value="${s}">${s}</option>`).join('');
  DOM.gameSeasonSelect.value = state.gameExplorer.filters.season;
}

async function applyGameSeasonFilter() {
  const season = state.gameExplorer.filters.season;
  const games = state.gameExplorer.games;
  
  const filtered = season 
    ? games.filter(g => String(g.season) === String(season))
    : games;
    
  state.gameExplorer.filteredGames = filtered;

  if (!DOM.gameSelect) return;

  if (filtered.length === 0) {
    DOM.gameSelect.innerHTML = '<option value="">No games found for season</option>';
    DOM.gameSelect.disabled = true;
    renderEmptyPlaysTable();
    return;
  }

  DOM.gameSelect.disabled = false;
  DOM.gameSelect.innerHTML = filtered.map(g => {
    const opp = g.opponent || (g.home_away === 'home' ? g.visitor_team : g.home_team) || 'OPP';
    const haSymbol = g.home_away === 'away' ? '@' : 'vs';
    const haIndicator = g.home_away ? (g.home_away === 'home' ? 'H' : 'A') : 'H';
    const weekStr = g.week ? `Week ${g.week}` : `${g.season}`;
    const playCount = g.total_plays || (g.plays ? g.plays.length : 0);
    const label = `${weekStr} ${haSymbol} ${opp} (${haIndicator}) - ${playCount} plays`;
    return `<option value="${g.game_id}">${label}</option>`;
  }).join('');

  // Auto-select first game
  const firstGameId = filtered[0].game_id;
  DOM.gameSelect.value = firstGameId;
  await selectGame(firstGameId);
}

/**
 * Handle game selection and fetch plays.
 */
async function selectGame(gameId) {
  if (!gameId) return;
  const gId = parseInt(gameId, 10);
  state.gameExplorer.selectedGameId = gId;
  state.gameExplorer.selectedGame = state.gameExplorer.games.find(g => g.game_id === gId) || null;

  showLoading('Loading game plays...');
  try {
    const plays = await api.getPlayerPlays(state.selectedPlayerId, gId);
    state.gameExplorer.plays = Array.isArray(plays) ? plays : [];

    // Populate Position Filter options dynamically
    populatePlayPositionFilter(state.gameExplorer.plays);

    // Apply filters and render plays table
    await filterAndRenderPlaysTable();

  } catch (err) {
    console.error('Error loading plays:', err);
    showToast('Failed to load game plays');
  } finally {
    hideLoading();
  }
}

function populatePlayPositionFilter(plays) {
  if (!DOM.playPositionFilter) return;
  const positions = [...new Set(plays.map(p => p.lined_up_position).filter(Boolean))].sort();
  DOM.playPositionFilter.innerHTML = '<option value="">All Alignments</option>' +
    positions.map(pos => `<option value="${pos}">${pos}</option>`).join('');
  DOM.playPositionFilter.value = state.gameExplorer.filters.lined_up_position;
}

async function filterAndRenderPlaysTable() {
  const { play_type, lined_up_position } = state.gameExplorer.filters;
  let filtered = state.gameExplorer.plays;

  if (play_type) {
    filtered = filtered.filter(p => (p.play_type || '').toUpperCase() === play_type.toUpperCase());
  }
  if (lined_up_position) {
    filtered = filtered.filter(p => (p.lined_up_position || '').toUpperCase() === lined_up_position.toUpperCase());
  }

  state.gameExplorer.filteredPlays = filtered;
  renderPlaysTable(filtered);

  if (filtered.length > 0) {
    const match = filtered.find(p => p.play_id === state.gameExplorer.selectedPlayId);
    const targetPlayId = match ? match.play_id : filtered[0].play_id;
    await selectPlay(targetPlayId);
  } else {
    resetPlayMetadataCard();
  }
}

function renderEmptyPlaysTable() {
  if (DOM.playsTableBody) {
    DOM.playsTableBody.innerHTML = '<tr><td colspan="7" class="table-empty">No plays match the selected filters.</td></tr>';
  }
  resetPlayMetadataCard();
}

function renderPlaysTable(plays) {
  if (!DOM.playsTableBody) return;

  if (plays.length === 0) {
    renderEmptyPlaysTable();
    return;
  }

  DOM.playsTableBody.innerHTML = plays.map(p => {
    const epa = Number(p.epa ?? p.expected_points_added ?? 0);
    const epaClass = epa > 0.0 ? 'text-emerald' : (epa < 0.0 ? 'text-rose' : 'text-muted');
    const epaSign = epa > 0.0 ? '+' : '';
    const desc = p.description || p.play_description || '--';
    const isSelected = p.play_id === state.gameExplorer.selectedPlayId;

    return `
      <tr data-play-id="${p.play_id}" class="${isSelected ? 'selected-row' : ''}">
        <td class="font-mono">${p.play_id}</td>
        <td>Q${p.quarter || 1}</td>
        <td class="font-mono">${p.game_clock || '--'}</td>
        <td><span class="badge ${p.play_type === 'RUN' ? 'badge-pick' : 'badge-position'}">${p.play_type || 'PASS'}</span></td>
        <td><span class="badge">${p.lined_up_position || '--'}</span></td>
        <td class="font-mono ${epaClass}">${epaSign}${epa.toFixed(2)}</td>
        <td class="play-desc-col" title="${escapeHtml(desc)}">${escapeHtml(truncate(desc, 80))}</td>
      </tr>
    `;
  }).join('');

  // Row click listeners
  DOM.playsTableBody.querySelectorAll('tr[data-play-id]').forEach(row => {
    row.addEventListener('click', async () => {
      const pid = parseInt(row.dataset.playId, 10);
      await selectPlay(pid);
    });
  });
}

/**
 * Handle play selection, metadata card update, and snap telemetry loading.
 */
async function selectPlay(playId) {
  if (!playId) return;
  const pId = parseInt(playId, 10);
  state.gameExplorer.selectedPlayId = pId;

  // Highlight selected row
  if (DOM.playsTableBody) {
    DOM.playsTableBody.querySelectorAll('tr').forEach(r => {
      r.classList.toggle('selected-row', parseInt(r.dataset.playId, 10) === pId);
    });
  }

  const play = state.gameExplorer.plays.find(p => p.play_id === pId) || null;
  state.gameExplorer.selectedPlay = play;

  // Update Metadata Card immediately
  updatePlayMetadataCard(play);

  // Fetch 10 Hz snap tracking telemetry
  showLoading('Loading 10 Hz game snap telemetry...');
  try {
    const snapData = await api.getPlayerSnap(state.selectedPlayerId, state.gameExplorer.selectedGameId, pId);
    state.gameExplorer.snapData = snapData;

    if (!snapData) {
      showToast('Snap telemetry not found');
      return;
    }

    initGameCanvasesAndPlayback(snapData);

  } catch (err) {
    console.error('Error loading snap telemetry:', err);
    showToast('Failed to load snap telemetry');
  } finally {
    hideLoading();
  }
}

function updatePlayMetadataCard(play) {
  if (!play) {
    resetPlayMetadataCard();
    return;
  }

  if (DOM.metaQuarter) DOM.metaQuarter.textContent = `Q${play.quarter || 1}`;
  if (DOM.metaClock) DOM.metaClock.textContent = play.game_clock || '--';
  
  // Down and distance
  const desc = play.description || play.play_description || '';
  if (DOM.metaDownDistance) {
    if (play.down && play.yards_to_go) {
      const dStr = formatDown(play.down);
      DOM.metaDownDistance.textContent = `${dStr} & ${play.yards_to_go <= 0 ? 'Goal' : play.yards_to_go}`;
    } else {
      const ddMatch = desc.match(/(\d)(?:st|nd|rd|th)\s*&\s*(\d+|goal)/i);
      if (ddMatch) {
        DOM.metaDownDistance.textContent = `${formatDown(ddMatch[1])} & ${ddMatch[2].toLowerCase() === 'goal' ? 'Goal' : ddMatch[2]}`;
      } else {
        DOM.metaDownDistance.textContent = '--';
      }
    }
  }

  // Yardline
  if (DOM.metaYardline) {
    if (play.yardline_side && play.yardline_number) {
      DOM.metaYardline.textContent = `${play.yardline_side} ${play.yardline_number}`;
    } else {
      const ylMatch = desc.match(/(?:at|to)\s+([A-Z]{2,3}\s+\d+)/i);
      DOM.metaYardline.textContent = ylMatch ? ylMatch[1] : '--';
    }
  }

  if (DOM.metaLinedUpPos) {
    DOM.metaLinedUpPos.textContent = play.lined_up_position || (state.selectedPlayer ? state.selectedPlayer.nfl_position : 'ATH');
  }
  if (DOM.metaPlayType) {
    const pType = play.play_type || 'PASS';
    DOM.metaPlayType.textContent = pType;
    DOM.metaPlayType.className = `badge badge-play-type type-${pType.toLowerCase()}`;
  }

  // EPA pill
  const epa = Number(play.epa ?? play.expected_points_added ?? 0);
  if (DOM.metaEpaPill && DOM.metaEpaValue) {
    DOM.metaEpaValue.textContent = `${epa > 0 ? '+' : ''}${epa.toFixed(2)}`;
    DOM.metaEpaPill.className = `epa-pill ${epa > 0 ? 'positive' : (epa < 0 ? 'negative' : 'neutral')}`;
  }

  // Description
  if (DOM.metaDescription) {
    DOM.metaDescription.textContent = desc || 'No description available.';
  }
}

function resetPlayMetadataCard() {
  if (DOM.metaQuarter) DOM.metaQuarter.textContent = 'Q1';
  if (DOM.metaClock) DOM.metaClock.textContent = '--';
  if (DOM.metaDownDistance) DOM.metaDownDistance.textContent = '--';
  if (DOM.metaYardline) DOM.metaYardline.textContent = '--';
  if (DOM.metaLinedUpPos) DOM.metaLinedUpPos.textContent = '--';
  if (DOM.metaPlayType) DOM.metaPlayType.textContent = '--';
  if (DOM.metaEpaValue) DOM.metaEpaValue.textContent = '+0.00';
  if (DOM.metaEpaPill) DOM.metaEpaPill.className = 'epa-pill neutral';
  if (DOM.metaDescription) DOM.metaDescription.textContent = 'Select a play to inspect telemetry description.';
}

/**
 * Initialize 2D field canvas, 10 Hz timeseries canvas, and playback engine for Tab 2.
 */
function renderSnapVisualization(snapData) {
  initGameCanvasesAndPlayback(snapData);
}

function initGameCanvasesAndPlayback(snapData) {
  const frames = snapData.frames || snapData.player_frames || [];
  const events = snapData.events || [];

  if (state.gameExplorer.gameFieldCanvas) {
    if (state.gameExplorer.gameFieldCanvas.getViewMode() !== 'full') {
      state.gameExplorer.gameFieldCanvas.setViewMode('snap');
    }
    state.gameExplorer.gameFieldCanvas.loadSnap(snapData);
    updateGameViewToggleBtn();
  }
  if (state.gameExplorer.gameTimeseriesCanvas) {
    state.gameExplorer.gameTimeseriesCanvas.loadFrames(frames, events);
  }
  if (state.gameExplorer.playbackEngine) {
    state.gameExplorer.playbackEngine.loadFrames(frames);
  }

  // Instantiate and wire gameGGCanvas
  if (DOM.gameGGCanvas) {
    if (!state.gameGGCanvas && !state.gameExplorer.gameGGCanvas && typeof GGDiagramCanvas === 'function') {
      try {
        state.gameExplorer.gameGGCanvas = new GGDiagramCanvas(DOM.gameGGCanvas);
        state.gameGGCanvas = state.gameExplorer.gameGGCanvas;
      } catch (err) {
        console.warn('Could not instantiate game GGDiagramCanvas:', err);
      }
    }
    const gCanvas = state.gameGGCanvas || state.gameExplorer.gameGGCanvas;
    if (gCanvas && typeof gCanvas.setFrames === 'function') {
      gCanvas.setFrames(frames, snapData);
    }
  }
  if (state.cockpitGG) {
    state.cockpitGG.initGameGG(DOM.gameGGCanvas);
    state.cockpitGG.updateGameData(frames, snapData);
  }

  const totalFrames = frames.length;
  if (DOM.gamePlaybackScrubber) {
    DOM.gamePlaybackScrubber.min = 0;
    DOM.gamePlaybackScrubber.max = Math.max(0, totalFrames - 1);
    DOM.gamePlaybackScrubber.value = 0;
  }
  updateGamePlaybackReadout(0, totalFrames);

  // Initialize Vehicle Dynamics Stability HUD
  initVehicleDynamics(snapData);

  // Render Event Milestone Jump Buttons
  renderEventJumpButtons(events);
}

function updateGameViewToggleBtn() {
  if (!DOM.btnToggleGameView || !state.gameExplorer.gameFieldCanvas) return;
  const isSnap = state.gameExplorer.gameFieldCanvas.getViewMode() === 'snap';
  DOM.btnToggleGameView.textContent = isSnap ? 'Zoom: Play' : 'Zoom: Full Field';
  DOM.btnToggleGameView.title = isSnap ? 'Click to show full 120-yd field' : 'Click to zoom into play trajectory';
  if (isSnap) {
    DOM.btnToggleGameView.classList.add('active');
  } else {
    DOM.btnToggleGameView.classList.remove('active');
  }
}

function renderEventJumpButtons(events) {
  if (!DOM.gameEventJumpBar || !DOM.gameEventButtons) return;

  if (!events || events.length === 0) {
    DOM.gameEventJumpBar.style.display = 'none';
    DOM.gameEventButtons.innerHTML = '';
    return;
  }

  DOM.gameEventJumpBar.style.display = 'flex';
  DOM.gameEventButtons.innerHTML = events.map(ev => {
    const label = formatEventName(ev.event);
    const time = (ev.frameId * 0.1).toFixed(1);
    return `<button class="btn btn-event-jump" data-frame="${ev.frameId}">${label} (${time}s)</button>`;
  }).join('');

  DOM.gameEventButtons.querySelectorAll('button[data-frame]').forEach(btn => {
    btn.addEventListener('click', () => {
      const fId = parseInt(btn.dataset.frame, 10);
      if (state.gameExplorer.playbackEngine) {
        state.gameExplorer.playbackEngine.seek(fId);
      }
    });
  });
}

function updateGamePlaybackReadout(frameIdx, totalFrames) {
  if (!DOM.gamePlaybackTimeDisplay) return;
  const curTime = (frameIdx * 0.1).toFixed(1);
  const totTime = (Math.max(0, totalFrames - 1) * 0.1).toFixed(1);
  DOM.gamePlaybackTimeDisplay.textContent = `Frame: ${frameIdx} / ${Math.max(0, totalFrames - 1)} | Time: ${curTime}s / ${totTime}s`;
}

function initVehicleDynamics(snapData) {
  state.gameExplorer.currentSnapData = snapData;

  // Set Overlap Index, Apex Speed & Exit Traction from play summary
  if (DOM.vdOverlapVal) {
    const ol = snapData.overlap_pct !== undefined ? snapData.overlap_pct : ((snapData.overlap_index || 0) * 100);
    DOM.vdOverlapVal.textContent = `${Number(ol).toFixed(1)}%`;
  }
  if (DOM.vdApexVal) {
    const vApex = snapData.v_apex ?? (snapData.apex_metrics && snapData.apex_metrics.length > 0 ? snapData.apex_metrics[0].v_apex : null);
    DOM.vdApexVal.textContent = vApex != null ? `${Number(vApex).toFixed(1)} yd/s` : '-- yd/s';
  }
  if (DOM.vdExitTractionVal) {
    const exitTrac = snapData.corner_exit_traction ?? (snapData.apex_metrics && snapData.apex_metrics.length > 0 ? snapData.apex_metrics[0].exit_traction : null);
    if (exitTrac != null) {
      const sign = exitTrac >= 0 ? '+' : '';
      DOM.vdExitTractionVal.textContent = `${sign}${Number(exitTrac).toFixed(1)} yd/s²`;
    } else {
      DOM.vdExitTractionVal.textContent = '-- yd/s²';
    }
  }
  const incidents = snapData.snap_oversteer_frames || [];
  const incidentCount = incidents.length;

  if (DOM.vdSnapCount) {
    DOM.vdSnapCount.textContent = incidentCount;
    DOM.vdSnapCount.style.color = incidentCount > 0 ? 'var(--color-rose)' : 'var(--color-emerald)';
  }

  if (DOM.vdSnapPills) {
    if (incidentCount === 0) {
      DOM.vdSnapPills.innerHTML = '<span class="no-incidents">Egyensúlyban (0 kibillenés / tüske)</span>';
    } else {
      DOM.vdSnapPills.innerHTML = incidents.map(inc => {
        const t = (inc.time !== undefined ? inc.time : inc.frameId * 0.1).toFixed(1);
        const b = Math.abs(inc.beta || 0).toFixed(0);
        return `<button class="btn-snap-pill" data-frame="${inc.frameId}" title="Ugrás az egyensúlyvesztés pillanatához (t=${t}s, |β|=${b}°)">⚡ ${t}s (|β|:${b}°)</button>`;
      }).join('');

      DOM.vdSnapPills.querySelectorAll('button[data-frame]').forEach(btn => {
        btn.addEventListener('click', () => {
          const fId = parseInt(btn.dataset.frame, 10);
          if (state.gameExplorer.playbackEngine) {
            state.gameExplorer.playbackEngine.seek(fId);
          }
        });
      });
    }
  }

  // Update initial frame telemetry
  const frames = snapData.frames || [];
  if (frames.length > 0) {
    updateVehicleDynamicsTelemetry(frames[0]);
  }
}

function updateVehicleDynamicsTelemetry(frame) {
  if (!frame) return;

  const beta = Number(frame.slip_angle !== undefined ? frame.slip_angle : (frame.beta_slip || 0));
  const absBeta = Math.abs(beta);
  const betaRate = Number(frame.beta_rate !== undefined ? frame.beta_rate : (frame.slip_rate || 0));
  const absBetaRate = Math.abs(betaRate);
  const jerk = Number(frame.jerk || 0);
  const absJerk = Math.abs(jerk);
  const isSnap = Boolean(frame.snap_oversteer);
  const dynState = frame.dynamics_state || (isSnap ? 'SNAP_OVERSTEER' : (absBeta <= 10 ? 'ON_RAILS' : 'CONTROLLED_DRIFT'));

  if (DOM.vdBetaVal) {
    const prefix = beta > 0 ? '+' : '';
    DOM.vdBetaVal.textContent = `${prefix}${beta.toFixed(1)}°`;
  }

  if (DOM.vdBetaInterpretation) {
    if (absBeta <= 10) {
      DOM.vdBetaInterpretation.textContent = 'Tiszta előrehaladás („sínen autózik”)';
      DOM.vdBetaInterpretation.style.color = 'var(--color-cyan)';
    } else if (absBeta <= 45) {
      DOM.vdBetaInterpretation.textContent = 'Kontrollált ívmenet (5° - 45°)';
      DOM.vdBetaInterpretation.style.color = 'var(--color-emerald)';
    } else {
      DOM.vdBetaInterpretation.textContent = 'Oldalazás / hátrálás (90° - 180°)';
      DOM.vdBetaInterpretation.style.color = 'var(--color-amber)';
    }
  }

  if (DOM.vdBetaRateVal) {
    const prefix = betaRate > 0 ? '+' : '';
    DOM.vdBetaRateVal.textContent = `${prefix}${betaRate.toFixed(1)}°/s`;
  }

  if (DOM.vdJerkVal) {
    const prefix = jerk > 0 ? '+' : '';
    DOM.vdJerkVal.textContent = `${prefix}${jerk.toFixed(1)} yd/s³`;
  }

  // Live Combined G-Force (Tangential + Lateral)
  if (DOM.vdGCombVal) {
    let gComb = frame.g_comb;
    let aComb = frame.a_comb;
    if (gComb == null) {
      const s = Number(frame.s !== undefined ? frame.s : (frame.speed || 0));
      const a_t = Number(frame.a !== undefined ? frame.a : (frame.accel || 0));
      const omega = Number(frame.omega || 0);
      const a_lat = frame.a_lat !== undefined ? Number(frame.a_lat) : (s * (omega * Math.PI / 180));
      aComb = Math.hypot(a_t, a_lat);
      gComb = aComb / 10.7247;
    }
    const gVal = Number(gComb || 0);
    const aVal = Number(aComb || 0);
    DOM.vdGCombVal.textContent = `${gVal.toFixed(2)} g (${aVal.toFixed(1)} yd/s²)`;
  }

  if (DOM.vehicleDynamicsCard) {
    if (isSnap) {
      DOM.vehicleDynamicsCard.classList.add('alert-snap-oversteer');
    } else {
      DOM.vehicleDynamicsCard.classList.remove('alert-snap-oversteer');
    }
  }

  if (DOM.vdStatusBadge && DOM.vdStatusText) {
    DOM.vdStatusBadge.className = 'vd-status-badge';
    if (isSnap) {
      DOM.vdStatusBadge.classList.add('status-snap-oversteer');
      DOM.vdStatusText.textContent = '⚡ SHARP CUT REDIRECT (ERŐS IRÁNYVÁLTÁS)';
    } else if (dynState === 'ON_RAILS' || absBeta <= 10) {
      DOM.vdStatusBadge.classList.add('status-on-rails');
      DOM.vdStatusText.textContent = 'INLINE SPRINT (STABIL FUTÁS)';
    } else if (dynState === 'CONTROLLED_DRIFT' || absBeta <= 45) {
      DOM.vdStatusBadge.classList.add('status-controlled');
      DOM.vdStatusText.textContent = 'KONTROLLÁLT EGYENSÚLY';
    } else {
      DOM.vdStatusBadge.classList.add('status-backpedal');
      DOM.vdStatusText.textContent = 'OLDALAZÁS / HÁTRÁLÁS';
    }
  }
}

function formatDown(d) {
  const n = parseInt(d, 10);
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  if (n === 4) return '4th';
  return `${d}`;
}

function formatEventName(ev) {
  if (!ev) return 'Event';
  return ev.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ==========================================================================
   EVENT LISTENERS & LIFECYCLE
   ========================================================================== */
function setupEventListeners() {
  // 1. Draft Year Filter
  if (DOM.draftYearFilter) {
    DOM.draftYearFilter.addEventListener('change', (e) => {
      state.filters.draft_year = e.target.value;
      applyPlayerFilters();
    });
  }

  // 2. Position Filter
  if (DOM.positionFilter) {
    DOM.positionFilter.addEventListener('change', (e) => {
      state.filters.pos = e.target.value;
      applyPlayerFilters();
    });
  }

  // 3. Team Filter
  if (DOM.teamFilter) {
    DOM.teamFilter.addEventListener('change', (e) => {
      state.filters.team_abbr = e.target.value;
      applyPlayerFilters();
    });
  }

  // 4. Debounced Search Input (250ms)
  if (DOM.searchInput) {
    DOM.searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (DOM.searchClearBtn) DOM.searchClearBtn.style.display = val ? 'block' : 'none';

      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        state.filters.q = val;
        applyPlayerFilters();
      }, 250);
    });
  }

  // Clear Search Button
  if (DOM.searchClearBtn) {
    DOM.searchClearBtn.addEventListener('click', () => {
      DOM.searchInput.value = '';
      DOM.searchClearBtn.style.display = 'none';
      state.filters.q = '';
      applyPlayerFilters();
    });
  }

  // 5. Authoritative Player Dropdown
  if (DOM.playerSelect) {
    DOM.playerSelect.addEventListener('change', (e) => {
      selectPlayer(e.target.value);
    });
  }

  // 6. Drill Select Dropdown (Tab 1)
  if (DOM.drillSelect) {
    DOM.drillSelect.addEventListener('change', (e) => {
      selectDrill(e.target.value);
    });
  }

  // 7. Tab Switching
  if (DOM.tabBtnCombine) {
    DOM.tabBtnCombine.addEventListener('click', () => switchTab('tab-combine'));
  }
  if (DOM.tabBtnGame) {
    DOM.tabBtnGame.addEventListener('click', () => switchTab('tab-game'));
  }
  if (DOM.tabBtnSpatial) {
    DOM.tabBtnSpatial.addEventListener('click', () => switchTab('tab-spatial'));
  }
  if (DOM.btnSwitchToCombine) {
    DOM.btnSwitchToCombine.addEventListener('click', () => switchTab('tab-combine'));
  }

  // Bio Ribbon Collapse/Expand Toggle
  if (DOM.btnToggleBioStrip && DOM.playerBioBanner) {
    DOM.btnToggleBioStrip.addEventListener('click', () => {
      const isCollapsed = DOM.playerBioBanner.classList.toggle('collapsed');
      if (DOM.bioToggleIcon) {
        DOM.bioToggleIcon.innerHTML = isCollapsed ? '&#43;' : '&minus;';
      }
      DOM.btnToggleBioStrip.title = isCollapsed ? 'Expand Bio Banner' : 'Collapse Bio Banner';
    });
  }

  // 1-Click Cross-Page Spatial Lab Bridges
  if (DOM.btnSendDrillToSpatial) {
    DOM.btnSendDrillToSpatial.addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.selectedPlayerId) return;
      const params = new URLSearchParams({
        mode: 'combine',
        player_a: state.selectedPlayerId
      });
      if (state.selectedDrillId) {
        params.set('drill_a', state.selectedDrillId);
      }
      window.location.href = `compare.html?${params.toString()}`;
    });
  }

  if (DOM.btnSendSnapToSpatial) {
    DOM.btnSendSnapToSpatial.addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.selectedPlayerId) return;
      const params = new URLSearchParams({
        mode: 'snap',
        player_a: state.selectedPlayerId
      });
      if (state.gameExplorer.selectedGameId) {
        params.set('game_a', state.gameExplorer.selectedGameId);
      }
      if (state.gameExplorer.selectedPlayId) {
        params.set('play_a', state.gameExplorer.selectedPlayId);
      }
      window.location.href = `compare.html?${params.toString()}`;
    });
  }

  // Lane 3 Telemetry Mode Toggle
  if (DOM.btnLane3Sideslip) {
    DOM.btnLane3Sideslip.addEventListener('click', () => {
      if (DOM.btnLane3Sideslip) DOM.btnLane3Sideslip.classList.add('active');
      if (DOM.btnLane3GForce) DOM.btnLane3GForce.classList.remove('active');
      const strip = state.spatial?.stripCanvas || state.spatialExplorer?.stripCanvas;
      if (strip && typeof strip.setLane3Mode === 'function') {
        strip.setLane3Mode('sideslip');
      }
    });
  }

  if (DOM.btnLane3GForce) {
    DOM.btnLane3GForce.addEventListener('click', () => {
      if (DOM.btnLane3GForce) DOM.btnLane3GForce.classList.add('active');
      if (DOM.btnLane3Sideslip) DOM.btnLane3Sideslip.classList.remove('active');
      const strip = state.spatial?.stripCanvas || state.spatialExplorer?.stripCanvas;
      if (strip && typeof strip.setLane3Mode === 'function') {
        strip.setLane3Mode('g_force');
      }
    });
  }

  // 8. Tab 1 Playback Controls
  if (DOM.btnPlayPause) {
    DOM.btnPlayPause.addEventListener('click', () => {
      if (state.playbackEngine) state.playbackEngine.togglePlay();
    });
  }

  if (DOM.btnStepBack) {
    DOM.btnStepBack.addEventListener('click', () => {
      if (state.playbackEngine) state.playbackEngine.stepBackward();
    });
  }

  if (DOM.btnStepForward) {
    DOM.btnStepForward.addEventListener('click', () => {
      if (state.playbackEngine) state.playbackEngine.stepForward();
    });
  }

  if (DOM.btnReset) {
    DOM.btnReset.addEventListener('click', () => {
      if (state.playbackEngine) state.playbackEngine.reset();
    });
  }

  if (DOM.playbackScrubber) {
    DOM.playbackScrubber.addEventListener('input', (e) => {
      const frameIdx = parseInt(e.target.value, 10);
      if (state.playbackEngine) {
        state.playbackEngine.seek(frameIdx);
      }
    });
  }

  if (DOM.playbackRateSelect) {
    DOM.playbackRateSelect.addEventListener('change', (e) => {
      const rate = parseFloat(e.target.value);
      if (state.playbackEngine) {
        state.playbackEngine.setPlaybackRate(rate);
      }
    });
  }

  // 9. Tab 2 Game Explorer Controls
  if (DOM.gameSeasonSelect) {
    DOM.gameSeasonSelect.addEventListener('change', async (e) => {
      state.gameExplorer.filters.season = e.target.value;
      await applyGameSeasonFilter();
    });
  }

  if (DOM.gameSelect) {
    DOM.gameSelect.addEventListener('change', async (e) => {
      await selectGame(e.target.value);
    });
  }

  if (DOM.playTypeFilter) {
    DOM.playTypeFilter.addEventListener('change', async (e) => {
      state.gameExplorer.filters.play_type = e.target.value;
      await filterAndRenderPlaysTable();
    });
  }

  if (DOM.playPositionFilter) {
    DOM.playPositionFilter.addEventListener('change', async (e) => {
      state.gameExplorer.filters.lined_up_position = e.target.value;
      await filterAndRenderPlaysTable();
    });
  }

  if (DOM.btnToggleGameView) {
    DOM.btnToggleGameView.addEventListener('click', () => {
      if (state.gameExplorer.gameFieldCanvas) {
        state.gameExplorer.gameFieldCanvas.toggleViewMode();
        updateGameViewToggleBtn();
      }
    });
  }

  // Interactive Zoom & Pan Controls for 2D Field Canvases
  const btnGameZoomIn = document.getElementById('btnGameZoomIn');
  const btnGameZoomOut = document.getElementById('btnGameZoomOut');
  const btnGameZoomReset = document.getElementById('btnGameZoomReset');
  if (btnGameZoomIn) {
    btnGameZoomIn.addEventListener('click', () => {
      if (state.gameExplorer.gameFieldCanvas) state.gameExplorer.gameFieldCanvas.zoomIn();
    });
  }
  if (btnGameZoomOut) {
    btnGameZoomOut.addEventListener('click', () => {
      if (state.gameExplorer.gameFieldCanvas) state.gameExplorer.gameFieldCanvas.zoomOut();
    });
  }
  if (btnGameZoomReset) {
    btnGameZoomReset.addEventListener('click', () => {
      if (state.gameExplorer.gameFieldCanvas) state.gameExplorer.gameFieldCanvas.resetZoom();
    });
  }

  const btnCombineZoomIn = document.getElementById('btnCombineZoomIn');
  const btnCombineZoomOut = document.getElementById('btnCombineZoomOut');
  const btnCombineZoomReset = document.getElementById('btnCombineZoomReset');
  if (btnCombineZoomIn) {
    btnCombineZoomIn.addEventListener('click', () => {
      if (state.combineFieldCanvas) state.combineFieldCanvas.zoomIn();
    });
  }
  if (btnCombineZoomOut) {
    btnCombineZoomOut.addEventListener('click', () => {
      if (state.combineFieldCanvas) state.combineFieldCanvas.zoomOut();
    });
  }
  if (btnCombineZoomReset) {
    btnCombineZoomReset.addEventListener('click', () => {
      if (state.combineFieldCanvas) state.combineFieldCanvas.resetZoom();
    });
  }

  // Tab 2 Playback Controls
  if (DOM.btnGamePlayPause) {
    DOM.btnGamePlayPause.addEventListener('click', () => {
      if (state.gameExplorer.playbackEngine) state.gameExplorer.playbackEngine.togglePlay();
    });
  }

  if (DOM.btnGameStepBack) {
    DOM.btnGameStepBack.addEventListener('click', () => {
      if (state.gameExplorer.playbackEngine) state.gameExplorer.playbackEngine.stepBackward();
    });
  }

  if (DOM.btnGameStepForward) {
    DOM.btnGameStepForward.addEventListener('click', () => {
      if (state.gameExplorer.playbackEngine) state.gameExplorer.playbackEngine.stepForward();
    });
  }

  if (DOM.btnGameReset) {
    DOM.btnGameReset.addEventListener('click', () => {
      if (state.gameExplorer.playbackEngine) state.gameExplorer.playbackEngine.reset();
    });
  }

  if (DOM.gamePlaybackScrubber) {
    DOM.gamePlaybackScrubber.addEventListener('input', (e) => {
      const frameIdx = parseInt(e.target.value, 10);
      if (state.gameExplorer.playbackEngine) {
        state.gameExplorer.playbackEngine.seek(frameIdx);
      }
    });
  }

  if (DOM.gamePlaybackRateSelect) {
    DOM.gamePlaybackRateSelect.addEventListener('change', (e) => {
      const rate = parseFloat(e.target.value);
      if (state.gameExplorer.playbackEngine) {
        state.gameExplorer.playbackEngine.setPlaybackRate(rate);
      }
    });
  }

  // 10. Keyboard Shortcuts (Routes to active tab's PlaybackEngine)
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    const isTabGame = state.activeTab === 'tab-game' || state.activeTab === 'tabGame';
    const activeEngine = isTabGame ? state.gameExplorer.playbackEngine : state.playbackEngine;

    if (e.code === 'Space') {
      e.preventDefault();
      if (activeEngine) activeEngine.togglePlay();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      if (activeEngine) activeEngine.stepBackward();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      if (activeEngine) activeEngine.stepForward();
    } else if (e.code === 'Home') {
      e.preventDefault();
      if (activeEngine) activeEngine.reset();
    }
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;

  const isCombine = tabId === 'tab-combine' || tabId === 'tabCombine';
  const isGame = tabId === 'tab-game' || tabId === 'tabGame';
  const isSpatial = tabId === 'tab-spatial' || tabId === 'tabSpatial';

  if (DOM.tabBtnCombine) DOM.tabBtnCombine.classList.toggle('active', isCombine);
  if (DOM.tabBtnGame) DOM.tabBtnGame.classList.toggle('active', isGame);
  if (DOM.tabBtnSpatial) DOM.tabBtnSpatial.classList.toggle('active', isSpatial);

  if (DOM.tabCombine) DOM.tabCombine.classList.toggle('active', isCombine);
  if (DOM.tabGame) DOM.tabGame.classList.toggle('active', isGame);
  if (DOM.tabSpatial) DOM.tabSpatial.classList.toggle('active', isSpatial);

  if (isCombine) {
    if (state.gameExplorer.playbackEngine) state.gameExplorer.playbackEngine.pause();
    stopSpatialPlaySweep();
    if (state.combineFieldCanvas) state.combineFieldCanvas.handleResize();
    if (state.timeseriesCanvas) state.timeseriesCanvas.resize();
  } else if (isGame) {
    if (state.playbackEngine) state.playbackEngine.pause();
    stopSpatialPlaySweep();
    if (state.gameExplorer.gameFieldCanvas) state.gameExplorer.gameFieldCanvas.handleResize();
    if (state.gameExplorer.gameTimeseriesCanvas) state.gameExplorer.gameTimeseriesCanvas.resize();
  } else if (isSpatial) {
    if (state.playbackEngine) state.playbackEngine.pause();
    if (state.gameExplorer.playbackEngine) state.gameExplorer.playbackEngine.pause();
    ensureSpatialInitialized();
    if (state.spatialExplorer.stripCanvas) state.spatialExplorer.stripCanvas.handleResize();
    if (state.spatialExplorer.overlayCanvas) state.spatialExplorer.overlayCanvas.handleResize();
  }
}


/* ==========================================================================
   TAB 3: SPATIAL BENCHMARK & OVERLAY CONTROLLER
   ========================================================================== */

function ensureSpatialInitialized() {
  const se = state.spatialExplorer;
  if (se.isInitialized) return;
  se.isInitialized = true;

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

  // Setup Tab 3 UI event handlers
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

  populateSpatialPlayerOptions();
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

  // Reload options for current mode
  onSpatialPlayerAChange();
  onSpatialPlayerBChange();
}

function populateSpatialPlayerOptions() {
  const se = state.spatialExplorer;
  const players = state.players || [];
  if (players.length === 0) return;

  const optionsHtml = players.map(p => {
    const label = `${p.display_name} [${p.position || p.nfl_position || 'ATH'}]`;
    return `<option value="${p.nfl_id}">${label}</option>`;
  }).join('');

  if (DOM.spatialPlayerA) {
    DOM.spatialPlayerA.innerHTML = optionsHtml;
    // Default Player A to selectedPlayerId or Will Anderson (55867) or first
    const defaultA = state.selectedPlayerId || 55867;
    DOM.spatialPlayerA.value = defaultA;
  }

  if (DOM.spatialPlayerB) {
    DOM.spatialPlayerB.innerHTML = `<option value="POS_AVG">Position Benchmark Average</option>` + optionsHtml;
    // Default Player B to Lukas Van Ness (55877) or POS_AVG
    const vanNess = players.find(p => p.nfl_id === 55877);
    DOM.spatialPlayerB.value = vanNess ? '55877' : 'POS_AVG';
  }

  onSpatialPlayerAChange().then(() => {
    onSpatialPlayerBChange().then(() => {
      // Run initial comparison automatically
      runSpatialComparison();
    });
  });
}

async function onSpatialPlayerAChange() {
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
        // Prefer Forty Yard Dash if present
        const forty = se.drillsA.find(d => d.drill_name.includes('FORTY'));
        if (forty) DOM.spatialDrillA.value = forty.event_id;
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

async function onSpatialPlayerBChange() {
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
        // Match Player A's drill if possible
        const drillAName = DOM.spatialDrillA?.selectedOptions[0]?.text;
        if (drillAName) {
          const match = se.drillsB.find(d => d.drill_name === drillAName);
          if (match) DOM.spatialDrillB.value = match.event_id;
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
        const avgRes = await api.fetchSpatialPositionAvg(pos, drillName, step);
        if (!avgRes || !avgRes.trajectory) {
          showToast(`No position average data for ${pos}`);
          hideLoading();
          return;
        }

        // Load drill A data directly
        const drillAData = await api.fetchCombineDrill(pA, drillA);
        if (!drillAData || !drillAData.player_frames) {
          showToast('Failed to load drill data for Prospect A');
          hideLoading();
          return;
        }

        // Compare in-browser via direct payload structure
        const pBData = {
          display_name: `${pos} Benchmark`,
          position: pos,
          drill_name: drillName
        };

        // We can call /api/spatial/compare/combine by using another player or synthesize payload
        // If needed, find a representative player or use first matched player in position
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
      // Snap mode
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

    // Pass data to Canvases
    if (se.stripCanvas) se.stripCanvas.setData(comparison);
    if (se.overlayCanvas) se.overlayCanvas.setData(comparison);

    // Update Slider
    const maxD = comparison.common_max_distance || 40.0;
    if (DOM.spatialDistanceSlider) {
      DOM.spatialDistanceSlider.min = '0';
      DOM.spatialDistanceSlider.max = maxD.toString();
      DOM.spatialDistanceSlider.step = step.toString();
      DOM.spatialDistanceSlider.value = '0';
    }
    updateSpatialScrubUI(0);

    // Update KPI Summary Cards
    renderSpatialSummaryKPIs(comparison);

    // Update Tables
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

  // Mini-Sector score: count sectors won
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

  // V-Max differential
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

  // 1. Combined G-Force (G_comb, max)
  if (DOM.spatialGComb) {
    const gMaxA = Number(data.g_comb_max_a || 0);
    const gMaxB = Number(data.g_comb_max_b || 0);
    DOM.spatialGComb.textContent = `A: ${gMaxA.toFixed(2)}g vs B: ${gMaxB.toFixed(2)}g`;
  }

  // 2. Trail-Braking / Overlap Index
  if (DOM.spatialOverlapIndex) {
    const olA = ((data.overlap_index_a || 0) * 100).toFixed(0);
    const olB = ((data.overlap_index_b || 0) * 100).toFixed(0);
    DOM.spatialOverlapIndex.textContent = `A: ${olA}% vs B: ${olB}%`;
  }

  // 3. Key Apex Speed (v_apex)
  if (DOM.spatialApexSpeed) {
    const apA = data.key_apex_speed_a ?? (data.apexes_a && data.apexes_a.length > 0 ? (data.apexes_a[0].v_apex ?? data.apexes_a[0].speed) : null);
    const apB = data.key_apex_speed_b ?? (data.apexes_b && data.apexes_b.length > 0 ? (data.apexes_b[0].v_apex ?? data.apexes_b[0].speed) : null);
    const strA = apA != null ? `${Number(apA).toFixed(1)} yd/s` : '--';
    const strB = apB != null ? `${Number(apB).toFixed(1)} yd/s` : '--';
    DOM.spatialApexSpeed.textContent = `A: ${strA} vs B: ${strB}`;
  }

  // 4. Corner Exit Traction
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
  stopSpatialPlaySweep();
  se.isPlayingSweep = true;
  if (DOM.spatialScrubPlay) {
    DOM.spatialScrubPlay.textContent = '||';
    DOM.spatialScrubPlay.title = 'Pause Distance Sweep';
  }

  const maxD = se.comparisonData?.common_max_distance || 40.0;
  let currentD = parseFloat(DOM.spatialDistanceSlider?.value || '0');
  if (currentD >= maxD - 0.2) currentD = 0;

  se.sweepIntervalId = setInterval(() => {
    currentD += 0.5;
    if (currentD > maxD) {
      currentD = maxD;
      setSpatialScrubDistance(currentD);
      stopSpatialPlaySweep();
    } else {
      setSpatialScrubDistance(currentD);
    }
  }, 100);
}

function stopSpatialPlaySweep() {
  const se = state.spatialExplorer;
  if (se.sweepIntervalId) {
    clearInterval(se.sweepIntervalId);
    se.sweepIntervalId = null;
  }
  se.isPlayingSweep = false;
  if (DOM.spatialScrubPlay) {
    DOM.spatialScrubPlay.textContent = '>';
    DOM.spatialScrubPlay.title = 'Play Distance Sweep';
  }
}


/* ==========================================================================
   APPLICATION ENTRYPOINT
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  cacheDOMElements();
  setupEventListeners();

  // Initialize Tab 1 Canvases and Playback Engine instances
  if (DOM.combineCanvas) {
    state.combineFieldCanvas = new CombineFieldCanvas(DOM.combineCanvas);
  }
  state.playbackEngine = new PlaybackEngine();
  if (DOM.timeseriesCanvas) {
    state.timeseriesCanvas = new TimeseriesCanvas(DOM.timeseriesCanvas, state.playbackEngine);
  }

  state.playbackEngine.onFrame((frameIdx, frame, totalFrames) => {
    if (state.combineFieldCanvas) {
      state.combineFieldCanvas.setFrame(frameIdx);
    }
    if (state.combineGGCanvas && typeof state.combineGGCanvas.setFrame === 'function') {
      state.combineGGCanvas.setFrame(frameIdx);
    }
    if (state.cockpitGG) {
      state.cockpitGG.setCombineFrame(frameIdx);
    }
    if (DOM.playbackScrubber) {
      DOM.playbackScrubber.value = frameIdx;
    }
    updatePlaybackReadout(frameIdx, totalFrames);
  });

  state.playbackEngine.onStateChange((isPlaying) => {
    if (DOM.btnPlayPause) {
      DOM.btnPlayPause.innerHTML = isPlaying
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Pause</span>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg><span>Play</span>';
    }
  });

  // Initialize Tab 2 Canvases and Playback Engine instances
  if (DOM.gameFieldCanvas) {
    state.gameExplorer.gameFieldCanvas = new GameFieldCanvas(DOM.gameFieldCanvas, { viewMode: 'snap' });
    updateGameViewToggleBtn();
  }
  state.gameExplorer.playbackEngine = new PlaybackEngine();
  if (DOM.gameTimeseriesCanvas) {
    state.gameExplorer.gameTimeseriesCanvas = new TimeseriesCanvas(DOM.gameTimeseriesCanvas, state.gameExplorer.playbackEngine);
  }

  state.gameExplorer.playbackEngine.onFrame((frameIdx, frame, totalFrames) => {
    if (state.gameExplorer.gameFieldCanvas) {
      state.gameExplorer.gameFieldCanvas.setFrame(frameIdx);
    }
    const gCanvas = state.gameGGCanvas || state.gameExplorer.gameGGCanvas;
    if (gCanvas && typeof gCanvas.setFrame === 'function') {
      gCanvas.setFrame(frameIdx);
    }
    if (state.cockpitGG) {
      state.cockpitGG.setGameFrame(frameIdx);
    }
    if (DOM.gamePlaybackScrubber) {
      DOM.gamePlaybackScrubber.value = frameIdx;
    }
    updateGamePlaybackReadout(frameIdx, totalFrames);
    updateVehicleDynamicsTelemetry(frame);
  });

  state.gameExplorer.playbackEngine.onStateChange((isPlaying) => {
    if (DOM.btnGamePlayPause) {
      DOM.btnGamePlayPause.innerHTML = isPlaying
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Pause</span>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg><span>Play</span>';
    }
  });

  showLoading('Initializing NFL Tracking Lab...');
  try {
    // Step 1: Load metadata
    await loadMetadata();

    // Step 2: Load initial players list
    const players = await api.fetchPlayers();
    state.players = players;
    if (DOM.playerCountBadge) DOM.playerCountBadge.textContent = players.length;

    // Populate dropdown
    if (DOM.playerSelect && players.length > 0) {
      DOM.playerSelect.innerHTML = players.map(p => {
        const label = p.display_label || `${p.display_name} [${p.nfl_position}]`;
        return `<option value="${p.nfl_id}">${label}</option>`;
      }).join('');

      // Select default: Puka Nacua (56042) or first player
      const puka = players.find(p => p.nfl_id === 56042);
      const defaultId = puka ? puka.nfl_id : players[0].nfl_id;
      DOM.playerSelect.value = defaultId;
      await selectPlayer(defaultId);
    }
  } catch (err) {
    console.error('Fatal initialization error:', err);
    showToast('Failed to initialize application');
  } finally {
    hideLoading();
  }
});

// Also expose globally on window
if (typeof window !== 'undefined') {
  window.appState = state;
}
