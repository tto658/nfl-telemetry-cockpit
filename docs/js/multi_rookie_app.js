/**
 * NFL Multi-Rookie Play Lab — Main Application Controller
 * Filters and visualizes all plays with >= 2 cohort rookies at 10 Hz.
 */

import { parquetReadObjects, compressors } from './vendor/hyparquet.bundle.mjs';
import {
  MultiRookieFieldCanvas,
  MultiRookieTimeseriesCanvas,
  ROOKIE_PALETTE,
} from './multi_rookie_field.js?v=8';

const STATIC_BASE = './data';
const DATA_VERSION = 'v5';
const MAX_PARQUET_CACHE = 80;

const EVENT_LABELS = {
  ball_snap: 'Snap',
  snap_direct: 'Snap',
  play_action: 'Play Action',
  autoevent_playaction: 'Play Action',
  handoff: 'Handoff',
  pass_forward: 'Pass',
  pass_shovel: 'Shovel',
  pass_arrived: 'Arrived',
  pass_outcome_caught: 'Catch',
  pass_outcome_incomplete: 'Incomplete',
  pass_outcome_interception: 'INT',
  pass_outcome_touchdown: 'Pass TD',
  pass_tipped: 'Tipped',
  dropped_pass: 'Drop',
  first_contact: 'Contact',
  tackle: 'Tackle',
  qb_sack: 'Sack',
  qb_strip_sack: 'Strip Sack',
  qb_slide: 'Slide',
  qb_scramble: 'Scramble',
  fumble: 'Fumble',
  out_of_bounds: 'OOB',
  touchdown: 'TD',
};
const parquetCache = new Map();

const state = {
  allPlays: [],
  filteredPlays: [],
  playersById: new Map(),
  gamesById: new Map(),
  page: 1,
  pageSize: 25,
  sortCol: 'n_rookies',
  sortDir: 'desc',
  filters: {
    minRookies: 2,
    season: '',
    playType: '',
    matchup: '',
    team: '',
    position: '',
    rookieId: '',
    gameId: '',
    search: '',
    assignEnabled: false,
    assignMaxDy: 2.5,
    trenchEnabled: false,
    trenchMinFrames: 15,
    mirrorEnabled: false,
    mirrorMinFrames: 15,
    interactionLogic: 'AND',
  },
  selectedPlay: null,
  tracks: [],
  maxFrames: 0,
  events: [],
  frameIdx: 0,
  isPlaying: false,
  playbackSpeed: 1.0,
  rafId: null,
  lastTickMs: 0,
  highlightedNflId: null,
  visibleLabels: new Set(),
  fieldCanvas: null,
  tsCanvas: null,
};

const DOM = {};

function cacheDOM() {
  const ids = [
    'loadingBanner', 'loadingStatusText',
    'statFilteredCount', 'statTotalCount', 'statMaxRookies',
    'btnToggleHeader', 'btnShowHeader',
    'filterMinRookies', 'filterSeason', 'filterPlayType', 'filterMatchup',
    'filterTeam', 'filterPosition', 'filterRookie', 'filterGame', 'filterSearch',
    'btnFilterAssign', 'assignDySelect', 'countAssign',
    'btnFilterTrench', 'trenchSecSelect', 'countTrench',
    'btnFilterMirror', 'mirrorSecSelect', 'countMirror',
    'btnLogicAnd', 'btnLogicOr',
    'btnResetFilters', 'tableSubtitle', 'pageSizeSelect', 'btnPrevPage',
    'btnNextPage', 'pageInfoText', 'mrPlaysTable', 'mrPlaysBody',
    'stageMatchupBadge', 'stageSituationBadge', 'stageTypeBadge',
    'stageFormationBadge', 'stageCoverageBadge', 'stageEpaPill',
    'stageEpaVal', 'stageYdsVal', 'stageRookieCountVal', 'stageDescription', 'stageInteractionPills',
    'btnPlayPause', 'btnPlayReset', 'btnStepBack', 'btnStepFwd',
    'playbackSpeedSelect', 'playbackTimeLabel', 'playbackScrubber',
    'playbackEventBadge', 'btnZoomAuto', 'btnZoomFull', 'eventTimelineStrip',
    'btnFieldZoomIn', 'btnFieldZoomOut', 'btnFieldZoomReset',
    'multiFieldCanvas', 'multiTimeseriesCanvas', 'fieldLoadingOverlay',
    'fieldLoadingText', 'mrRosterBody', 'chkAllLabels',
  ];
  for (const id of ids) {
    DOM[id] = document.getElementById(id);
  }
}

async function fetchParquetCached(relPath, fetchOptions = undefined) {
  if (parquetCache.has(relPath)) {
    const val = parquetCache.get(relPath);
    parquetCache.delete(relPath);
    parquetCache.set(relPath, val);
    return val;
  }
  const res = await fetch(`${STATIC_BASE}/${relPath}`, fetchOptions);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
  const ab = await res.arrayBuffer();
  const rows = await parquetReadObjects({ file: ab, compressors });
  if (parquetCache.size >= MAX_PARQUET_CACHE) {
    const oldest = parquetCache.keys().next().value;
    parquetCache.delete(oldest);
  }
  parquetCache.set(relPath, rows);
  return rows;
}

function formatDownDist(down, ytg) {
  if (!down || down <= 0) return '--';
  const ord = down === 1 ? '1st' : down === 2 ? '2nd' : down === 3 ? '3rd' : `${down}th`;
  return `${ord} & ${ytg ?? '--'}`;
}

function formatEpa(epa) {
  if (epa == null || Number.isNaN(epa)) return '--';
  return (epa >= 0 ? '+' : '') + Number(epa).toFixed(2);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function populateFilterOptions() {
  // Teams
  const teams = new Set();
  const positions = new Set();
  for (const p of state.allPlays) {
    if (p.home_team_abbr) teams.add(p.home_team_abbr);
    if (p.visitor_team_abbr) teams.add(p.visitor_team_abbr);
    if (p.rookie_positions) {
      for (const pos of p.rookie_positions.split(',')) {
        if (pos) positions.add(pos);
      }
    }
  }

  for (const t of [...teams].sort()) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    DOM.filterTeam.appendChild(opt);
  }

  for (const pos of [...positions].sort()) {
    const opt = document.createElement('option');
    opt.value = pos;
    opt.textContent = pos;
    DOM.filterPosition.appendChild(opt);
  }

  // Rookies
  const sortedPlayers = [...state.playersById.values()].sort((a, b) =>
    (a.display_name || '').localeCompare(b.display_name || '')
  );
  for (const pl of sortedPlayers) {
    const opt = document.createElement('option');
    opt.value = String(pl.nfl_id);
    opt.textContent = `${pl.display_name} (${pl.nfl_position || '--'} • '${String(pl.draft_year || '').slice(-2)})`;
    DOM.filterRookie.appendChild(opt);
  }

  refreshGameDropdown();
}

function refreshGameDropdown() {
  const season = state.filters.season;
  const team = state.filters.team;
  const prevVal = DOM.filterGame.value;

  const games = [...state.gamesById.values()]
    .filter((g) => (!season || String(g.season) === season))
    .filter((g) => (!team || g.home_team_abbr === team || g.visitor_team_abbr === team))
    .sort((a, b) => (b.season - a.season) || (a.week - b.week) || (a.game_id - b.game_id));

  DOM.filterGame.innerHTML = '<option value="">All Games</option>';
  for (const g of games) {
    const opt = document.createElement('option');
    opt.value = String(g.game_id);
    opt.textContent = `${g.season} Wk ${g.week}: ${g.visitor_team_abbr} @ ${g.home_team_abbr}`;
    DOM.filterGame.appendChild(opt);
  }
  if (games.some((g) => String(g.game_id) === prevVal)) {
    DOM.filterGame.value = prevVal;
  } else {
    state.filters.gameId = '';
  }
}

function applyFiltersAndSort() {
  const f = state.filters;
  const searchLower = f.search.trim().toLowerCase();
  const rookieToken = f.rookieId ? `,${f.rookieId},` : '';
  const posToken = f.position ? `,${f.position},` : '';
  const teamToken = f.team ? `,${f.team},` : '';

  const hasInteractionFilter = f.assignEnabled || f.trenchEnabled || f.mirrorEnabled;

  let cntAssign = 0;
  let cntTrench = 0;
  let cntMirror = 0;
  const filtered = [];
  for (const p of state.allPlays) {
    if (p.n_rookies < f.minRookies) continue;
    if (f.season && String(p.season) !== f.season) continue;
    if (f.playType && p.play_type !== f.playType) continue;
    if (f.matchup === 'h2h' && p.n_teams < 2) continue;
    if (f.matchup === 'same' && p.n_teams !== 1) continue;
    if (f.gameId && String(p.game_id) !== f.gameId) continue;
    if (teamToken && !`,${p.rookie_teams},`.includes(teamToken) && p.home_team_abbr !== f.team && p.visitor_team_abbr !== f.team) continue;
    if (posToken && !`,${p.rookie_positions},`.includes(posToken)) continue;
    if (rookieToken && !`,${p.rookie_ids},`.includes(rookieToken)) continue;
    if (searchLower) {
      const hay = `${p.play_description || ''} ${p.rookie_summary || ''}`.toLowerCase();
      if (!hay.includes(searchLower)) continue;
    }

    const matchAssign = p.assign_min_dy != null && p.assign_min_dy <= f.assignMaxDy;
    const matchTrench = p.trench_comove_frames >= f.trenchMinFrames;
    const matchMirror = p.mirror_frames >= f.mirrorMinFrames;
    if (matchAssign) cntAssign++;
    if (matchTrench) cntTrench++;
    if (matchMirror) cntMirror++;

    if (hasInteractionFilter) {
      if (f.interactionLogic === 'AND') {
        if (f.assignEnabled && !matchAssign) continue;
        if (f.trenchEnabled && !matchTrench) continue;
        if (f.mirrorEnabled && !matchMirror) continue;
      } else {
        const anyMatch =
          (f.assignEnabled && matchAssign) ||
          (f.trenchEnabled && matchTrench) ||
          (f.mirrorEnabled && matchMirror);
        if (!anyMatch) continue;
      }
    }
    filtered.push(p);
  }

  DOM.countAssign.textContent = cntAssign.toLocaleString();
  DOM.countTrench.textContent = cntTrench.toLocaleString();
  DOM.countMirror.textContent = cntMirror.toLocaleString();

  const col = state.sortCol;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const va = a[col] ?? -999999;
    const vb = b[col] ?? -999999;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return (b.game_id - a.game_id) || (a.play_id - b.play_id);
  });

  state.filteredPlays = filtered;
  state.page = 1;
  DOM.statFilteredCount.textContent = filtered.length.toLocaleString();
  renderTable();
}

function renderTable() {
  const total = state.filteredPlays.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;

  const start = (state.page - 1) * state.pageSize;
  const end = Math.min(total, start + state.pageSize);
  const slice = state.filteredPlays.slice(start, end);

  DOM.pageInfoText.textContent = `${state.page} / ${totalPages}`;
  DOM.btnPrevPage.disabled = state.page <= 1;
  DOM.btnNextPage.disabled = state.page >= totalPages;
  DOM.tableSubtitle.textContent =
    total === 0
      ? 'No plays match the current filters.'
      : `Showing ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} matching plays`;

  if (slice.length === 0) {
    const f = state.filters;
    const activeCount = (f.assignEnabled ? 1 : 0) + (f.trenchEnabled ? 1 : 0) + (f.mirrorEnabled ? 1 : 0);
    const msg =
      activeCount >= 2 && f.interactionLogic === 'AND'
        ? 'No plays match all selected interaction filters. Try switching to OR mode or unchecking a filter.'
        : 'No plays match your filters.';
    DOM.mrPlaysBody.innerHTML = `<tr><td colspan="11" class="table-empty">${msg}</td></tr>`;
    return;
  }

  const f = state.filters;
  const selKey = state.selectedPlay ? `${state.selectedPlay.game_id}_${state.selectedPlay.play_id}` : '';
  const rowsHtml = slice.map((p) => {
    const key = `${p.game_id}_${p.play_id}`;
    const isSel = key === selKey;
    const epaCls = (p.expected_points_added ?? 0) >= 0 ? 'text-emerald' : 'text-rose';
    const highCls = p.n_rookies >= 5 ? 'high' : '';
    const badges = [];
    const anyFilter = f.assignEnabled || f.trenchEnabled || f.mirrorEnabled;
    if (p.assign_min_dy != null && p.assign_min_dy <= f.assignMaxDy) {
      const cls = f.assignEnabled ? 'is-matched-filter' : (anyFilter ? 'is-passive' : '');
      const prefix = f.assignEnabled ? '&#10003; ' : '';
      badges.push(`<span class="mr-int-badge assign ${cls}" title="Pre-snap Δy=${p.assign_min_dy.toFixed(1)} yd">${prefix}ASSIGN</span>`);
    }
    if (p.trench_comove_frames >= f.trenchMinFrames) {
      const cls = f.trenchEnabled ? 'is-matched-filter' : (anyFilter ? 'is-passive' : '');
      const prefix = f.trenchEnabled ? '&#10003; ' : '';
      badges.push(`<span class="mr-int-badge trench ${cls}" title="Trench co-move ${(p.trench_comove_frames * 0.1).toFixed(1)}s">${prefix}TRENCH</span>`);
    }
    if (p.mirror_frames >= f.mirrorMinFrames) {
      const cls = f.mirrorEnabled ? 'is-matched-filter' : (anyFilter ? 'is-passive' : '');
      const prefix = f.mirrorEnabled ? '&#10003; ' : '';
      badges.push(`<span class="mr-int-badge mirror ${cls}" title="Coverage mirror ${(p.mirror_frames * 0.1).toFixed(1)}s">${prefix}MIRROR</span>`);
    }
    const badgesHtml = badges.length > 0 ? `<div class="mr-int-badges-cell">${badges.join('')}</div>` : '<span style="color:var(--text-muted);">—</span>';

    return `<tr data-gid="${p.game_id}" data-pid="${p.play_id}" class="${isSel ? 'selected-row' : ''}">
      <td class="font-mono">${p.season} W${p.week}</td>
      <td class="font-mono">${escapeHtml(p.visitor_team_abbr)}@${escapeHtml(p.home_team_abbr)}</td>
      <td class="font-mono">Q${p.quarter ?? '-'} ${escapeHtml(p.game_clock || '')}</td>
      <td class="font-mono">${formatDownDist(p.down, p.yards_to_go)}</td>
      <td><span class="badge badge-play-type">${escapeHtml(p.play_type)}</span></td>
      <td><span class="mr-rookie-count-badge ${highCls}">${p.n_rookies}</span></td>
      <td>${badgesHtml}</td>
      <td class="mr-rookies-cell" title="${escapeHtml(p.rookie_summary)}">${escapeHtml(p.rookie_summary)}</td>
      <td class="font-mono ${epaCls}">${formatEpa(p.expected_points_added)}</td>
      <td class="font-mono">${p.yards_gained != null ? Math.round(p.yards_gained) : '--'}</td>
      <td class="mr-desc-cell" title="${escapeHtml(p.play_description)}">${escapeHtml(p.play_description)}</td>
    </tr>`;
  }).join('');

  DOM.mrPlaysBody.innerHTML = rowsHtml;
}

async function selectPlay(play) {
  stopPlayback();
  state.selectedPlay = play;
  state.highlightedNflId = null;
  renderTable(); // update selected row highlight

  // Update stage header
  DOM.stageMatchupBadge.textContent = `${play.season} Wk ${play.week} • ${play.visitor_team_abbr} @ ${play.home_team_abbr}`;
  const ydStr = play.yardline_side && play.yardline_number ? `${play.yardline_side} ${play.yardline_number}` : '--';
  DOM.stageSituationBadge.textContent = `Q${play.quarter ?? '-'} • ${play.game_clock || '--'} • ${formatDownDist(play.down, play.yards_to_go)} • ${ydStr}`;
  DOM.stageTypeBadge.textContent = play.play_type;

  if (play.offense_formation) {
    DOM.stageFormationBadge.style.display = 'inline-block';
    DOM.stageFormationBadge.textContent = play.offense_formation;
  } else {
    DOM.stageFormationBadge.style.display = 'none';
  }

  if (play.team_coverage_man_zone) {
    DOM.stageCoverageBadge.style.display = 'inline-block';
    DOM.stageCoverageBadge.textContent = play.team_coverage_man_zone;
  } else {
    DOM.stageCoverageBadge.style.display = 'none';
  }

  const epa = play.expected_points_added;
  DOM.stageEpaVal.textContent = formatEpa(epa);
  DOM.stageEpaPill.classList.toggle('positive', (epa ?? 0) >= 0);
  DOM.stageEpaPill.classList.toggle('negative', (epa ?? 0) < 0);
  DOM.stageYdsVal.textContent = play.yards_gained != null ? `${Math.round(play.yards_gained)} yd` : '--';
  DOM.stageRookieCountVal.textContent = String(play.n_rookies);
  DOM.stageDescription.textContent = play.play_description || 'No description available.';

  // Load 10 Hz tracking for all rookies on this play
  const rookieIds = (play.rookie_ids || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const alignments = (play.rookie_alignments || '').split(',');
  const summaryParts = (play.rookie_summary || '').split(', ');

  DOM.fieldLoadingOverlay.style.display = 'flex';
  DOM.fieldLoadingText.textContent = `Loading 10 Hz telemetry for ${rookieIds.length} rookies...`;
  setPlaybackControlsEnabled(false);

  try {
    const perRookieRows = await Promise.all(
      rookieIds.map(async (nflId) => {
        try {
          const rows = await fetchParquetCached(`parquet/${nflId}/game_tracking_${play.season}.parquet`);
          const playRows = rows
            .filter((r) => Number(r.game_id) === play.game_id && Number(r.play_id) === play.play_id)
            .sort((a, b) => String(a.time).localeCompare(String(b.time)));
          return { nflId, frames: playRows };
        } catch (err) {
          console.warn(`Missing tracking for ${nflId} season ${play.season}:`, err);
          return { nflId, frames: [] };
        }
      })
    );

    const tracks = [];
    let maxFrames = 0;
    const eventMap = new Map();
    const tacklerSet = new Set((play.tackler_ids || '').split(',').filter(Boolean).map(Number));
    const sackSet = new Set((play.sack_ids || '').split(',').filter(Boolean).map(Number));

    perRookieRows.forEach((item, idx) => {
      const pInfo = state.playersById.get(item.nflId) || {};
      // Extract team from summaryParts e.g. "Will Anderson (DE•HOU)"
      let team = '';
      const sp = summaryParts[idx] || '';
      const m = sp.match(/•([A-Z0-9]+)\)$/);
      if (m) team = m[1];

      const isOffense = Boolean(team && play.possession_team && team === play.possession_team);
      const color = ROOKIE_PALETTE[idx % ROOKIE_PALETTE.length];

      const roles = [];
      if (play.receiver_id === item.nflId) {
        roles.push(play.pass_result === 'C' ? 'REC' : 'TGT');
      }
      if (play.rusher_id === item.nflId && !roles.includes('REC')) {
        roles.push('RUSH');
      }
      if (sackSet.has(item.nflId)) {
        roles.push('SACK');
      }
      if (tacklerSet.has(item.nflId)) {
        roles.push('TKL');
      }

      let maxS = 0, maxA = 0, totalDis = 0, peakG = 0;
      item.frames.forEach((fr, fIdx) => {
        const s = fr.s ?? 0;
        const a = Math.abs(fr.a ?? 0);
        const dis = fr.dis ?? 0;
        if (s > maxS) maxS = s;
        if (a > maxA) maxA = a;
        totalDis += dis;
        const g = a / 10.725; // yds/s^2 -> g (1g = 32.174 ft/s^2 = 10.725 yd/s^2)
        if (g > peakG) peakG = g;
        if (fr.event && !eventMap.has(fIdx)) {
          eventMap.set(fIdx, String(fr.event));
        }
      });

      if (item.frames.length > maxFrames) maxFrames = item.frames.length;

      tracks.push({
        nflId: item.nflId,
        name: pInfo.display_name || `Player ${item.nflId}`,
        pos: pInfo.nfl_position || '--',
        draftYear: pInfo.draft_year || '--',
        team,
        align: alignments[idx] || '--',
        isOffense,
        color,
        roles,
        frames: item.frames,
        stats: { maxS, maxA, totalDis, peakG },
      });
    });

    const events = [...eventMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, label]) => ({
        idx,
        label,
        shortLabel: EVENT_LABELS[label] || label.replace(/_/g, ' '),
      }));

    const snapEv = events.find((e) => e.label === 'ball_snap' || e.label === 'snap_direct');
    const snapIdx = snapEv ? snapEv.idx : 0;
    if (events.length > 0) {
      DOM.eventTimelineStrip.innerHTML =
        '<span class="mr-event-timeline-label">Events:</span>' +
        events
          .map((ev) => {
            const absSec = (ev.idx * 0.1).toFixed(1);
            const relSec = ((ev.idx - snapIdx) * 0.1).toFixed(1);
            const relStr = Number(relSec) >= 0 ? `+${relSec}s` : `${relSec}s`;
            return `<button type="button" class="mr-event-pill" data-frame-idx="${ev.idx}" title="${escapeHtml(ev.label)} (${relStr} from snap)">
              <span>${escapeHtml(ev.shortLabel)}</span>
              <span class="mr-event-pill-time">${absSec}s</span>
            </button>`;
          })
          .join('');
      DOM.eventTimelineStrip.style.display = 'flex';
    } else {
      DOM.eventTimelineStrip.style.display = 'none';
    }

    state.tracks = tracks;
    state.maxFrames = maxFrames;
    state.events = events;
    state.frameIdx = 0;

    // Default visible labels to role-players (REC/RUSH/TKL/SACK) to keep the field clean
    state.visibleLabels = new Set(tracks.filter((t) => t.roles.length > 0).map((t) => t.nflId));
    state.fieldCanvas.setVisibleLabels(state.visibleLabels);
    if (DOM.chkAllLabels) {
      DOM.chkAllLabels.checked = tracks.length > 0 && state.visibleLabels.size === tracks.length;
    }

    // Pre-resolve matched interaction pairs into O(1) track indices
    const idxById = new Map(tracks.map((tr, i) => [tr.nflId, i]));
    const interactionPairs = [];
    const stagePills = [];
    const f = state.filters;

    if (play.assign_off_id && play.assign_def_id && play.assign_min_dy != null && play.assign_min_dy <= f.assignMaxDy) {
      const offIdx = idxById.get(play.assign_off_id);
      const defIdx = idxById.get(play.assign_def_id);
      if (offIdx != null && defIdx != null) {
        interactionPairs.push({ type: 'assign', offIdx, defIdx, label: 'ASSIGN', color: '#06b6d4' });
        stagePills.push(`<span class="mr-int-badge assign">&#127919; Assignment: &Delta;y=${play.assign_min_dy.toFixed(1)} yd (${tracks[offIdx].name.split(' ').slice(-1)[0]} vs ${tracks[defIdx].name.split(' ').slice(-1)[0]})</span>`);
      }
    }
    if (play.trench_off_id && play.trench_def_id && play.trench_comove_frames >= f.trenchMinFrames) {
      const offIdx = idxById.get(play.trench_off_id);
      const defIdx = idxById.get(play.trench_def_id);
      if (offIdx != null && defIdx != null) {
        interactionPairs.push({ type: 'trench', offIdx, defIdx, label: 'TRENCH', color: '#f59e0b' });
        stagePills.push(`<span class="mr-int-badge trench">&#128737;&#65039; Trench: ${(play.trench_comove_frames * 0.1).toFixed(1)}s (${tracks[offIdx].name.split(' ').slice(-1)[0]} vs ${tracks[defIdx].name.split(' ').slice(-1)[0]})</span>`);
      }
    }
    if (play.mirror_off_id && play.mirror_def_id && play.mirror_frames >= f.mirrorMinFrames) {
      const offIdx = idxById.get(play.mirror_off_id);
      const defIdx = idxById.get(play.mirror_def_id);
      if (offIdx != null && defIdx != null) {
        interactionPairs.push({ type: 'mirror', offIdx, defIdx, label: 'MIRROR', color: '#a78bfa' });
        const cosStr = play.mirror_mean_cos != null ? `, cos=${play.mirror_mean_cos.toFixed(2)}` : '';
        stagePills.push(`<span class="mr-int-badge mirror">&#129694; Mirror: ${(play.mirror_frames * 0.1).toFixed(1)}s${cosStr} (${tracks[offIdx].name.split(' ').slice(-1)[0]} vs ${tracks[defIdx].name.split(' ').slice(-1)[0]})</span>`);
      }
    }

    if (stagePills.length > 0) {
      DOM.stageInteractionPills.innerHTML = stagePills.join('');
      DOM.stageInteractionPills.style.display = 'flex';
    } else {
      DOM.stageInteractionPills.style.display = 'none';
    }

    state.fieldCanvas.setTracks(tracks, interactionPairs);
    state.tsCanvas.setTracks(tracks, maxFrames, events);

    DOM.playbackScrubber.min = '0';
    DOM.playbackScrubber.max = String(Math.max(0, maxFrames - 1));
    DOM.playbackScrubber.value = '0';
    setPlaybackControlsEnabled(maxFrames > 1);
    updateFrameUI();
  } finally {
    DOM.fieldLoadingOverlay.style.display = 'none';
  }
}

function setPlaybackControlsEnabled(enabled) {
  DOM.btnPlayPause.disabled = !enabled;
  DOM.btnPlayReset.disabled = !enabled;
  DOM.btnStepBack.disabled = !enabled;
  DOM.btnStepFwd.disabled = !enabled;
  DOM.playbackScrubber.disabled = !enabled;
}

function updateFrameUI() {
  const maxIdx = Math.max(0, state.maxFrames - 1);
  const curSec = (state.frameIdx * 0.1).toFixed(1);
  const totSec = (maxIdx * 0.1).toFixed(1);
  DOM.playbackTimeLabel.textContent = `${curSec}s / ${totSec}s`;
  DOM.playbackScrubber.value = String(state.frameIdx);

  // Check if any frame at current index has an event
  let evLabel = '';
  for (const tr of state.tracks) {
    const f = tr.frames[state.frameIdx];
    if (f && f.event) {
      evLabel = f.event;
      break;
    }
  }
  if (evLabel) {
    DOM.playbackEventBadge.style.display = 'inline-block';
    DOM.playbackEventBadge.textContent = EVENT_LABELS[evLabel] || evLabel;
  } else {
    DOM.playbackEventBadge.style.display = 'none';
  }

  DOM.eventTimelineStrip.querySelectorAll('.mr-event-pill').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.frameIdx) === state.frameIdx);
  });

  state.fieldCanvas.setFrame(state.frameIdx);
  state.tsCanvas.setFrame(state.frameIdx);
  renderRosterTable();
}

function renderRosterTable() {
  if (state.tracks.length === 0) {
    DOM.mrRosterBody.innerHTML = '<tr><td colspan="14" class="table-empty">No tracking frames found for this play.</td></tr>';
    return;
  }

  DOM.mrRosterBody.innerHTML = state.tracks.map((tr) => {
    const f = tr.frames[Math.min(state.frameIdx, Math.max(0, tr.frames.length - 1))];
    const liveS = f && f.s != null ? `${f.s.toFixed(2)} yd/s` : '--';
    const isHi = state.highlightedNflId === tr.nflId;
    const isLabelOn = state.visibleLabels.has(tr.nflId);
    const sideHtml = tr.isOffense
      ? '<span class="mr-side-pill mr-side-off">OFF</span>'
      : '<span class="mr-side-pill mr-side-def">DEF</span>';

    const roleBadges = (tr.roles || []).map((r) => {
      if (r === 'REC') return '<span class="mr-role-badge rec">&#127944; REC</span>';
      if (r === 'TGT') return '<span class="mr-role-badge tgt">&#127919; TGT</span>';
      if (r === 'RUSH') return '<span class="mr-role-badge rush">&#127944; RUSH</span>';
      if (r === 'SACK') return '<span class="mr-role-badge sack">&#9889; SACK</span>';
      if (r === 'TKL') return '<span class="mr-role-badge tkl">&#128165; TKL</span>';
      return '';
    }).join('');
    const roleHtml = roleBadges || '<span style="color:var(--text-muted);">—</span>';

    return `<tr data-nfl-id="${tr.nflId}" class="${isHi ? 'highlighted-rookie' : ''}">
      <td style="text-align:center;"><input type="checkbox" class="mr-label-chk" data-nfl-id="${tr.nflId}" ${isLabelOn ? 'checked' : ''} title="Show/hide name on field"></td>
      <td><span class="mr-color-swatch" style="background:${tr.color};"></span></td>
      <td>${sideHtml}</td>
      <td class="font-mono">${escapeHtml(tr.team || '--')}</td>
      <td><strong>${escapeHtml(tr.name)}</strong></td>
      <td>${roleHtml}</td>
      <td class="font-mono">${escapeHtml(tr.pos)}</td>
      <td class="font-mono">${escapeHtml(tr.align)}</td>
      <td class="font-mono">${tr.draftYear}</td>
      <td class="font-mono text-cyan">${liveS}</td>
      <td class="font-mono">${tr.stats.maxS.toFixed(2)} yd/s</td>
      <td class="font-mono">${tr.stats.maxA.toFixed(2)} yd/s²</td>
      <td class="font-mono">${tr.stats.totalDis.toFixed(1)} yd</td>
      <td class="font-mono text-amber">${tr.stats.peakG.toFixed(2)} g</td>
    </tr>`;
  }).join('');
}

function startPlayback() {
  if (state.maxFrames <= 1) return;
  if (state.frameIdx >= state.maxFrames - 1) {
    state.frameIdx = 0;
  }
  state.isPlaying = true;
  DOM.btnPlayPause.innerHTML = '&#9646;&#9646; Pause';
  state.lastTickMs = performance.now();

  const step = (now) => {
    if (!state.isPlaying) return;
    const intervalMs = 100 / state.playbackSpeed; // 10 Hz base
    if (now - state.lastTickMs >= intervalMs) {
      state.lastTickMs = now;
      if (state.frameIdx < state.maxFrames - 1) {
        state.frameIdx += 1;
        updateFrameUI();
      } else {
        stopPlayback();
        return;
      }
    }
    state.rafId = requestAnimationFrame(step);
  };
  state.rafId = requestAnimationFrame(step);
}

function stopPlayback() {
  state.isPlaying = false;
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (DOM.btnPlayPause) {
    DOM.btnPlayPause.innerHTML = '&#9654; Play';
  }
}

function bindEvents() {
  let searchTimer = null;

  DOM.filterMinRookies.addEventListener('change', () => {
    state.filters.minRookies = Number(DOM.filterMinRookies.value) || 2;
    applyFiltersAndSort();
  });

  DOM.filterSeason.addEventListener('change', () => {
    state.filters.season = DOM.filterSeason.value;
    refreshGameDropdown();
    applyFiltersAndSort();
  });

  DOM.filterPlayType.addEventListener('change', () => {
    state.filters.playType = DOM.filterPlayType.value;
    applyFiltersAndSort();
  });

  DOM.filterMatchup.addEventListener('change', () => {
    state.filters.matchup = DOM.filterMatchup.value;
    applyFiltersAndSort();
  });

  DOM.filterTeam.addEventListener('change', () => {
    state.filters.team = DOM.filterTeam.value;
    refreshGameDropdown();
    applyFiltersAndSort();
  });

  DOM.filterPosition.addEventListener('change', () => {
    state.filters.position = DOM.filterPosition.value;
    applyFiltersAndSort();
  });

  DOM.filterRookie.addEventListener('change', () => {
    state.filters.rookieId = DOM.filterRookie.value;
    applyFiltersAndSort();
  });

  DOM.filterGame.addEventListener('change', () => {
    state.filters.gameId = DOM.filterGame.value;
    applyFiltersAndSort();
  });

  DOM.filterSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = DOM.filterSearch.value;
      applyFiltersAndSort();
    }, 180);
  });

  DOM.btnFilterAssign.addEventListener('click', () => {
    state.filters.assignEnabled = !state.filters.assignEnabled;
    DOM.btnFilterAssign.classList.toggle('active', state.filters.assignEnabled);
    applyFiltersAndSort();
  });

  DOM.assignDySelect.addEventListener('change', () => {
    state.filters.assignMaxDy = Number(DOM.assignDySelect.value) || 2.5;
    applyFiltersAndSort();
  });

  DOM.btnFilterTrench.addEventListener('click', () => {
    state.filters.trenchEnabled = !state.filters.trenchEnabled;
    DOM.btnFilterTrench.classList.toggle('active', state.filters.trenchEnabled);
    applyFiltersAndSort();
  });

  DOM.trenchSecSelect.addEventListener('change', () => {
    state.filters.trenchMinFrames = Number(DOM.trenchSecSelect.value) || 15;
    applyFiltersAndSort();
  });

  DOM.btnFilterMirror.addEventListener('click', () => {
    state.filters.mirrorEnabled = !state.filters.mirrorEnabled;
    DOM.btnFilterMirror.classList.toggle('active', state.filters.mirrorEnabled);
    applyFiltersAndSort();
  });

  DOM.mirrorSecSelect.addEventListener('change', () => {
    state.filters.mirrorMinFrames = Number(DOM.mirrorSecSelect.value) || 15;
    applyFiltersAndSort();
  });

  DOM.btnLogicAnd.addEventListener('click', () => {
    state.filters.interactionLogic = 'AND';
    DOM.btnLogicAnd.classList.add('active');
    DOM.btnLogicOr.classList.remove('active');
    applyFiltersAndSort();
  });

  DOM.btnLogicOr.addEventListener('click', () => {
    state.filters.interactionLogic = 'OR';
    DOM.btnLogicOr.classList.add('active');
    DOM.btnLogicAnd.classList.remove('active');
    applyFiltersAndSort();
  });

  DOM.btnResetFilters.addEventListener('click', () => {
    state.filters = {
      minRookies: 2,
      season: '',
      playType: '',
      matchup: '',
      team: '',
      position: '',
      rookieId: '',
      gameId: '',
      search: '',
      assignEnabled: false,
      assignMaxDy: 2.5,
      trenchEnabled: false,
      trenchMinFrames: 15,
      mirrorEnabled: false,
      mirrorMinFrames: 15,
      interactionLogic: 'AND',
    };
    DOM.filterMinRookies.value = '2';
    DOM.filterSeason.value = '';
    DOM.filterPlayType.value = '';
    DOM.filterMatchup.value = '';
    DOM.filterTeam.value = '';
    DOM.filterPosition.value = '';
    DOM.filterRookie.value = '';
    DOM.filterSearch.value = '';
    DOM.btnFilterAssign.classList.remove('active');
    DOM.assignDySelect.value = '2.5';
    DOM.btnFilterTrench.classList.remove('active');
    DOM.trenchSecSelect.value = '15';
    DOM.btnFilterMirror.classList.remove('active');
    DOM.mirrorSecSelect.value = '15';
    DOM.btnLogicAnd.classList.add('active');
    DOM.btnLogicOr.classList.remove('active');
    refreshGameDropdown();
    DOM.filterGame.value = '';
    applyFiltersAndSort();
  });

  DOM.pageSizeSelect.addEventListener('change', () => {
    state.pageSize = Number(DOM.pageSizeSelect.value) || 25;
    state.page = 1;
    renderTable();
  });

  DOM.btnPrevPage.addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      renderTable();
    }
  });

  DOM.btnNextPage.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.filteredPlays.length / state.pageSize));
    if (state.page < totalPages) {
      state.page += 1;
      renderTable();
    }
  });

  // Sortable headers
  DOM.mrPlaysTable.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortCol = col;
        state.sortDir = 'desc';
      }
      applyFiltersAndSort();
    });
  });

  // Row click -> load play
  DOM.mrPlaysBody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-gid]');
    if (!tr) return;
    const gid = Number(tr.dataset.gid);
    const pid = Number(tr.dataset.pid);
    const play = state.filteredPlays.find((p) => p.game_id === gid && p.play_id === pid);
    if (play) selectPlay(play);
  });

  // Roster label checkboxes & row click -> highlight rookie
  DOM.chkAllLabels?.addEventListener('change', () => {
    if (DOM.chkAllLabels.checked) {
      state.visibleLabels = new Set(state.tracks.map((t) => t.nflId));
    } else {
      state.visibleLabels.clear();
    }
    state.fieldCanvas.setVisibleLabels(state.visibleLabels);
    renderRosterTable();
  });

  DOM.mrRosterBody.addEventListener('change', (e) => {
    const chk = e.target.closest('.mr-label-chk');
    if (!chk) return;
    const nflId = Number(chk.dataset.nflId);
    if (chk.checked) state.visibleLabels.add(nflId);
    else state.visibleLabels.delete(nflId);
    if (DOM.chkAllLabels) {
      DOM.chkAllLabels.checked = state.tracks.length > 0 && state.visibleLabels.size === state.tracks.length;
    }
    state.fieldCanvas.setVisibleLabels(state.visibleLabels);
  });

  DOM.mrRosterBody.addEventListener('click', (e) => {
    if (e.target.closest('.mr-label-chk')) return;
    const tr = e.target.closest('tr[data-nfl-id]');
    if (!tr) return;
    const nflId = Number(tr.dataset.nflId);
    state.highlightedNflId = state.highlightedNflId === nflId ? null : nflId;
    state.fieldCanvas.setHighlighted(state.highlightedNflId);
    state.tsCanvas.setHighlighted(state.highlightedNflId);
    renderRosterTable();
  });

  // Playback controls
  DOM.btnPlayPause.addEventListener('click', () => {
    if (state.isPlaying) stopPlayback();
    else startPlayback();
  });

  DOM.btnPlayReset.addEventListener('click', () => {
    stopPlayback();
    state.frameIdx = 0;
    updateFrameUI();
  });

  DOM.btnStepBack.addEventListener('click', () => {
    stopPlayback();
    state.frameIdx = Math.max(0, state.frameIdx - 1);
    updateFrameUI();
  });

  DOM.btnStepFwd.addEventListener('click', () => {
    stopPlayback();
    state.frameIdx = Math.min(Math.max(0, state.maxFrames - 1), state.frameIdx + 1);
    updateFrameUI();
  });

  DOM.playbackScrubber.addEventListener('input', () => {
    stopPlayback();
    state.frameIdx = Number(DOM.playbackScrubber.value) || 0;
    updateFrameUI();
  });

  DOM.playbackSpeedSelect.addEventListener('change', () => {
    state.playbackSpeed = Number(DOM.playbackSpeedSelect.value) || 1.0;
  });

  DOM.btnZoomAuto.addEventListener('click', () => {
    DOM.btnZoomAuto.classList.add('active');
    DOM.btnZoomFull.classList.remove('active');
    state.fieldCanvas.setZoomMode('auto');
  });

  DOM.btnZoomFull.addEventListener('click', () => {
    DOM.btnZoomFull.classList.add('active');
    DOM.btnZoomAuto.classList.remove('active');
    state.fieldCanvas.setZoomMode('full');
  });

  DOM.btnFieldZoomIn.addEventListener('click', () => state.fieldCanvas.zoomIn());
  DOM.btnFieldZoomOut.addEventListener('click', () => state.fieldCanvas.zoomOut());
  DOM.btnFieldZoomReset.addEventListener('click', () => state.fieldCanvas.resetZoom());

  const headerEl = document.querySelector('.mr-header');
  const setHeaderHidden = (hidden) => {
    if (headerEl) headerEl.style.display = hidden ? 'none' : '';
    if (DOM.btnShowHeader) DOM.btnShowHeader.style.display = hidden ? 'inline-flex' : 'none';
  };
  DOM.btnToggleHeader?.addEventListener('click', () => setHeaderHidden(true));
  DOM.btnShowHeader?.addEventListener('click', () => setHeaderHidden(false));

  DOM.eventTimelineStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('.mr-event-pill[data-frame-idx]');
    if (!btn) return;
    stopPlayback();
    state.frameIdx = Math.min(Math.max(0, state.maxFrames - 1), Number(btn.dataset.frameIdx) || 0);
    updateFrameUI();
  });
}

async function init() {
  cacheDOM();
  state.fieldCanvas = new MultiRookieFieldCanvas(DOM.multiFieldCanvas);
  state.tsCanvas = new MultiRookieTimeseriesCanvas(DOM.multiTimeseriesCanvas);
  bindEvents();

  try {
    DOM.loadingStatusText.textContent = 'Downloading & decoding multi-rookie plays (ZSTD Parquet)...';
    const [rawPlays, playersArr, gamesObj] = await Promise.all([
      fetchParquetCached(`multi_rookie_plays.parquet?v=${DATA_VERSION}`, { cache: 'no-cache' }),
      fetch(`${STATIC_BASE}/players.json`).then((r) => r.json()),
      fetch(`${STATIC_BASE}/games.json`).then((r) => r.json()),
    ]);

    let playsSource = rawPlays;
    if (playsSource.length > 0 && !('receiver_id' in playsSource[0])) {
      console.warn('[MultiRookie] Stale parquet detected in cache; forcing reload...');
      playsSource = await fetchParquetCached(
        `multi_rookie_plays.parquet?v=${DATA_VERSION}&t=${Date.now()}`,
        { cache: 'reload' }
      );
    }

    for (const p of playersArr) {
      state.playersById.set(Number(p.nfl_id), p);
    }
    for (const [gid, g] of Object.entries(gamesObj)) {
      state.gamesById.set(Number(gid), g);
    }

    let maxRookies = 0;
    state.allPlays = playsSource.map((r) => {
      const n = Number(r.n_rookies);
      if (n > maxRookies) maxRookies = n;
      return {
        ...r,
        game_id: Number(r.game_id),
        play_id: Number(r.play_id),
        season: Number(r.season),
        week: Number(r.week),
        quarter: r.quarter != null ? Number(r.quarter) : null,
        down: r.down != null ? Number(r.down) : null,
        yards_to_go: r.yards_to_go != null ? Number(r.yards_to_go) : null,
        yardline_number: r.yardline_number != null ? Number(r.yardline_number) : null,
        expected_points_added: r.expected_points_added != null ? Number(r.expected_points_added) : null,
        yards_gained: r.yards_gained != null ? Number(r.yards_gained) : null,
        n_rookies: n,
        n_teams: Number(r.n_teams),
        assign_min_dy: r.assign_min_dy != null ? Number(r.assign_min_dy) : null,
        assign_dist: r.assign_dist != null ? Number(r.assign_dist) : null,
        assign_off_id: r.assign_off_id != null ? Number(r.assign_off_id) : null,
        assign_def_id: r.assign_def_id != null ? Number(r.assign_def_id) : null,
        trench_comove_frames: r.trench_comove_frames != null ? Number(r.trench_comove_frames) : 0,
        trench_off_id: r.trench_off_id != null ? Number(r.trench_off_id) : null,
        trench_def_id: r.trench_def_id != null ? Number(r.trench_def_id) : null,
        mirror_frames: r.mirror_frames != null ? Number(r.mirror_frames) : 0,
        mirror_mean_cos: r.mirror_mean_cos != null ? Number(r.mirror_mean_cos) : null,
        mirror_off_id: r.mirror_off_id != null ? Number(r.mirror_off_id) : null,
        mirror_def_id: r.mirror_def_id != null ? Number(r.mirror_def_id) : null,
        receiver_id: r.receiver_id != null ? Number(r.receiver_id) : null,
        rusher_id: r.rusher_id != null ? Number(r.rusher_id) : null,
        tackler_ids: r.tackler_ids || '',
        sack_ids: r.sack_ids || '',
      };
    });

    if (DOM.statTotalCount) DOM.statTotalCount.textContent = state.allPlays.length.toLocaleString();
    if (DOM.statMaxRookies) DOM.statMaxRookies.textContent = String(maxRookies);

    populateFilterOptions();
    applyFiltersAndSort();

    DOM.loadingBanner.style.display = 'none';

    // Auto-load the top play so the field is immediately alive
    if (state.filteredPlays.length > 0) {
      await selectPlay(state.filteredPlays[0]);
    }
  } catch (err) {
    console.error('Failed to initialize Multi-Rookie Lab:', err);
    DOM.loadingStatusText.textContent = `Error loading data: ${err.message}`;
  }
}

document.addEventListener('DOMContentLoaded', init);
