/**
 * NFL Tracking & Combine Explorer - Backend API Client Module
 * Exclusively consumes FrameDTO and backend endpoint contracts.
 * Supports both Live FastAPI Backend and Static Hosting (e.g. GitHub Pages).
 */

import { resampleAndCompareTrajectories } from './spatial_engine.js';
import { parquetReadObjects, compressors } from './vendor/hyparquet.bundle.mjs';
import {
  buildCombineDrillPayload,
  buildGamesFromParquet,
  buildSnapPayload,
  buildGGCloudPayload
} from './kinematics_engine.js';

const API_BASE = '/api';
const STATIC_BASE = './data';

// Cached all players array & global games index for client-side static mode
let _staticAllPlayersCache = null;
let _staticGamesMapCache = null;
const _parquetCache = new Map();
const MAX_PARQUET_CACHE = 40;

async function _loadGamesMap() {
  if (_staticGamesMapCache) return _staticGamesMapCache;
  try {
    const res = await fetch(`${STATIC_BASE}/games.json`);
    if (res.ok) {
      _staticGamesMapCache = await res.json();
      return _staticGamesMapCache;
    }
  } catch (e) {
    console.warn('[API] Failed to load static games.json:', e);
  }
  return {};
}

async function _loadParquetRows(relPath) {
  if (_parquetCache.has(relPath)) {
    const cached = _parquetCache.get(relPath);
    // Refresh LRU order
    _parquetCache.delete(relPath);
    _parquetCache.set(relPath, cached);
    return cached;
  }

  try {
    const res = await fetch(`${STATIC_BASE}/parquet/${relPath}`);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const rows = await parquetReadObjects({ file: ab, compressors });
    if (_parquetCache.size >= MAX_PARQUET_CACHE) {
      const oldestKey = _parquetCache.keys().next().value;
      _parquetCache.delete(oldestKey);
    }
    _parquetCache.set(relPath, rows);
    return rows;
  } catch (err) {
    console.warn(`[API] Failed reading parquet ${relPath}:`, err);
    return null;
  }
}

/**
 * Determine if the application is running in a static hosting environment.
 */
function isStaticMode() {
  if (typeof window === 'undefined') return false;
  return (
    window.location.hostname.endsWith('github.io') ||
    window.location.protocol === 'file:' ||
    window.location.pathname.includes('/docs/')
  );
}

/**
 * Safe fetch with automatic fallback between live API and pre-generated static data.
 * @param {string} liveUrl 
 * @param {string} staticPath 
 * @param {string} endpointName 
 */
async function fetchWithFallback(liveUrl, staticPath, endpointName) {
  // 1. If explicitly in static environment (GitHub Pages / file://), go straight to static JSON
  if (isStaticMode()) {
    try {
      const res = await fetch(`${STATIC_BASE}/${staticPath}`);
      if (res.ok) return await res.json();
    } catch (e) {
      console.warn(`[API] Static fetch failed for ${staticPath}:`, e);
    }
  }

  // 2. Otherwise try live backend endpoint
  try {
    const res = await fetch(liveUrl);
    if (res.ok) {
      return await res.json();
    }
    // If live returns 404, attempt static fallback
    if (res.status === 404) {
      const staticRes = await fetch(`${STATIC_BASE}/${staticPath}`);
      if (staticRes.ok) return await staticRes.json();
      return null;
    }
    const errText = await res.text();
    console.warn(`[API] ${endpointName} failed (${res.status}): ${errText}`);
  } catch (err) {
    // Network failure (offline or pure static server without backend)
    try {
      const staticRes = await fetch(`${STATIC_BASE}/${staticPath}`);
      if (staticRes.ok) return await staticRes.json();
    } catch (_) {}
    console.warn(`[API] Fetch error for ${endpointName}:`, err);
  }
  return null;
}

export const api = {
  isStaticMode,

  /**
   * GET /api/metadata
   * Returns: { draft_years: number[], positions: string[], teams: string[], total_players: number }
   */
  async fetchMetadata() {
    const data = await fetchWithFallback(`${API_BASE}/metadata`, 'metadata.json', 'fetchMetadata');
    return data || { draft_years: [2023, 2024, 2025], positions: [], teams: [], total_players: 0 };
  },

  /**
   * GET /api/players?draft_year={year}&pos={pos}&team_abbr={team}&q={search}
   * Returns: PlayerListItem[]
   */
  async fetchPlayers(params = {}) {
    if (isStaticMode()) {
      return this._filterStaticPlayers(params);
    }

    const url = new URL(`${window.location.origin}${API_BASE}/players`);
    if (params.draft_year) url.searchParams.set('draft_year', params.draft_year);
    if (params.pos) url.searchParams.set('pos', params.pos);
    if (params.team_abbr) url.searchParams.set('team_abbr', params.team_abbr);
    if (params.q && params.q.trim()) url.searchParams.set('q', params.q.trim());

    try {
      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      }
      return this._filterStaticPlayers(params);
    } catch (err) {
      return this._filterStaticPlayers(params);
    }
  },

  /**
   * Client-side player filtering for static hosting mode.
   */
  async _filterStaticPlayers(params = {}) {
    if (!_staticAllPlayersCache) {
      try {
        const res = await fetch(`${STATIC_BASE}/players.json`);
        if (res.ok) {
          _staticAllPlayersCache = await res.json();
        }
      } catch (err) {
        console.error('Error loading static players.json:', err);
        return [];
      }
    }

    let list = _staticAllPlayersCache || [];
    if (params.draft_year) {
      const yr = String(params.draft_year);
      list = list.filter(p => String(p.draft_year) === yr);
    }
    if (params.pos) {
      const pos = String(params.pos).toUpperCase();
      list = list.filter(p => (p.position || '').toUpperCase() === pos);
    }
    if (params.team_abbr) {
      const tm = String(params.team_abbr).toUpperCase();
      list = list.filter(p => Array.isArray(p.teams) && p.teams.map(t => String(t).toUpperCase()).includes(tm));
    }
    if (params.q && params.q.trim()) {
      const q = params.q.trim().toLowerCase();
      list = list.filter(p =>
        (p.display_name && p.display_name.toLowerCase().includes(q)) ||
        (p.college && p.college.toLowerCase().includes(q))
      );
    }
    return list;
  },

  /**
   * GET /api/player/{nfl_id}/summary
   */
  async fetchPlayerSummary(nflId) {
    if (!nflId) return null;
    return await fetchWithFallback(
      `${API_BASE}/player/${nflId}/summary`,
      `player/${nflId}/summary.json`,
      `fetchPlayerSummary(${nflId})`
    );
  },

  /**
   * GET /api/player/{nfl_id}/combine
   */
  async fetchCombine(nflId) {
    if (!nflId) return null;
    return await fetchWithFallback(
      `${API_BASE}/player/${nflId}/combine`,
      `player/${nflId}/combine.json`,
      `fetchCombine(${nflId})`
    );
  },

  /**
   * GET /api/player/{nfl_id}/combine/{event_id}
   */
  async fetchCombineDrill(nflId, eventId) {
    if (!nflId || !eventId) return null;

    if (!isStaticMode()) {
      try {
        const res = await fetch(`${API_BASE}/player/${nflId}/combine/${encodeURIComponent(eventId)}`);
        if (res.ok) return await res.json();
      } catch (_) {}
    }

    // Read directly from player's combine_tracking.parquet
    const rows = await _loadParquetRows(`${nflId}/combine_tracking.parquet`);
    if (rows && rows.length > 0) {
      const payload = buildCombineDrillPayload(rows, eventId);
      if (payload) return payload;
    }

    // Legacy static JSON fallback if present
    const safeEventId = encodeURIComponent(eventId).replace(/[^a-zA-Z0-9_-]/g, '_');
    try {
      const res = await fetch(`${STATIC_BASE}/player/${nflId}/drills/${safeEventId}.json`);
      if (res.ok) return await res.json();
    } catch (_) {}
    return null;
  },

  /**
   * GET /api/player/{nfl_id}/dynamics
   */
  async fetchDynamics(nflId) {
    if (!nflId) return null;
    return await fetchWithFallback(
      `${API_BASE}/player/${nflId}/dynamics`,
      `player/${nflId}/dynamics.json`,
      `fetchDynamics(${nflId})`
    );
  },

  /**
   * GET /api/player/{nfl_id}/gg-kde?scope={scope}
   */
  async fetchGGKdeCloud(nflId, scope = 'season', seasonFilter = null, gameIdFilter = null) {
    if (!nflId) return null;

    if (!isStaticMode()) {
      const qp = new URLSearchParams({ scope });
      if (seasonFilter) qp.set('season', seasonFilter);
      if (gameIdFilter) qp.set('game_id', gameIdFilter);
      try {
        const res = await fetch(`${API_BASE}/player/${nflId}/gg-kde?${qp.toString()}`);
        if (res.ok) return await res.json();
      } catch (_) {}
    }

    // Compute G-G telemetry cloud in-browser from Parquet
    if (scope === 'combine') {
      const rows = await _loadParquetRows(`${nflId}/combine_tracking.parquet`);
      if (!rows || rows.length === 0) {
        return buildGGCloudPayload(nflId, [], { isCombine: true, scope: 'combine' });
      }
      const byEvent = new Map();
      for (const r of rows) {
        if (r.entity_type !== 'PLAYER') continue;
        const eid = r.event_id || 'drill';
        if (!byEvent.has(eid)) byEvent.set(eid, []);
        byEvent.get(eid).push(r);
      }
      return buildGGCloudPayload(nflId, Array.from(byEvent.values()), { isCombine: true, scope: 'combine' });
    }

    // Season or game scope: identify available seasons cleanly from games list
    const gamesRes = await this.fetchGames(nflId);
    const games = gamesRes?.games || [];
    const availableSeasons = seasonFilter
      ? [Number(seasonFilter)]
      : [...new Set(games.map(g => Number(g.season)).filter(Boolean))].sort();

    if (availableSeasons.length === 0) {
      // Zero-snap fallback to combine tracking (matches data_loader.py)
      return this.fetchGGKdeCloud(nflId, 'combine');
    }

    const partitions = [];
    for (const yr of availableSeasons) {
      const rows = await _loadParquetRows(`${nflId}/game_tracking_${yr}.parquet`);
      if (!rows || rows.length === 0) continue;
      const byPlay = new Map();
      for (const r of rows) {
        if (gameIdFilter && Number(r.game_id) !== Number(gameIdFilter)) continue;
        const key = `${r.game_id}_${r.play_id}`;
        if (!byPlay.has(key)) byPlay.set(key, []);
        byPlay.get(key).push(r);
      }
      for (const part of byPlay.values()) {
        partitions.push(part);
      }
    }

    if (partitions.length === 0) {
      return this.fetchGGKdeCloud(nflId, 'combine');
    }

    return buildGGCloudPayload(nflId, partitions, {
      isCombine: false,
      scope,
      season: seasonFilter ? Number(seasonFilter) : null,
      gameId: gameIdFilter ? Number(gameIdFilter) : null
    });
  },

  /**
   * GET /api/player/{nfl_id}/games?season={season}&play_type={playType}
   */
  async fetchGames(nflId, season = null, playType = null) {
    if (!nflId) return { games: [] };
    const query = new URLSearchParams();
    if (season) query.set('season', season);
    if (playType) query.set('play_type', playType);
    const qs = query.toString() ? `?${query.toString()}` : '';

    let allGames = null;

    if (!isStaticMode()) {
      try {
        const res = await fetch(`${API_BASE}/player/${nflId}/games${qs}`);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.games)) return data;
        }
      } catch (_) {}
    }

    // Check if player is known to have 0 teams/snaps from cached players list
    const players = await this._filterStaticPlayers();
    const pMeta = players.find(p => Number(p.nfl_id) === Number(nflId));
    if (pMeta && (!Array.isArray(pMeta.teams) || pMeta.teams.length === 0)) {
      return { games: [], zeroSnap: true };
    }

    // Load from player_play.parquet + games.json
    const [playRows, gamesMap] = await Promise.all([
      _loadParquetRows(`${nflId}/player_play.parquet`),
      _loadGamesMap()
    ]);

    if (playRows !== null) {
      allGames = buildGamesFromParquet(playRows, gamesMap, pMeta?.team || pMeta?.teams?.[0] || null);
    } else {
      // Legacy fallback if games.json exists
      try {
        const res = await fetch(`${STATIC_BASE}/player/${nflId}/games.json`);
        if (res.ok) {
          const data = await res.json();
          allGames = data?.games || [];
        }
      } catch (_) {}
    }

    if (!allGames) {
      return { games: [], unavailable: true };
    }

    let filteredGames = allGames;
    if (season) {
      filteredGames = filteredGames.filter(g => String(g.season) === String(season));
    }
    if (playType) {
      const ptUpper = String(playType).toUpperCase();
      filteredGames = filteredGames.map(g => {
        const plays = (g.plays || []).filter(p => {
          if (p.play_type) return String(p.play_type).toUpperCase() === ptUpper;
          if (ptUpper === 'RUN') return p.is_run === true;
          if (ptUpper === 'PASS') return p.is_run === false;
          return true;
        });
        return { ...g, plays, play_count: plays.length, total_plays: plays.length };
      }).filter(g => g.plays.length > 0);
    }
    return { games: filteredGames };
  },

  /**
   * GET /api/player/{nfl_id}/plays/{game_id}?lined_up_position={pos}&play_type={type}
   */
  async fetchPlays(nflId, gameId, params = {}) {
    if (!nflId || !gameId) return [];

    if (!isStaticMode()) {
      const query = new URLSearchParams();
      if (params.lined_up_position) query.set('lined_up_position', params.lined_up_position);
      if (params.play_type) query.set('play_type', params.play_type);
      const qs = query.toString() ? `?${query.toString()}` : '';
      try {
        const res = await fetch(`${API_BASE}/player/${nflId}/plays/${gameId}${qs}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) return data;
        }
      } catch (_) {}
    }

    const gamesRes = await this.fetchGames(nflId, null, params.play_type || null);
    const game = (gamesRes?.games || []).find(g => Number(g.game_id) === Number(gameId));
    let plays = game?.plays || [];
    if (params.lined_up_position) {
      const posUpper = String(params.lined_up_position).trim().toUpperCase();
      plays = plays.filter(p => (p.lined_up_position || '').toUpperCase() === posUpper);
    }
    return plays;
  },

  /**
   * GET /api/player/{nfl_id}/snap/{game_id}/{play_id}
   */
  async fetchSnap(nflId, gameId, playId) {
    if (!nflId || !gameId || !playId) return null;

    if (!isStaticMode()) {
      try {
        const res = await fetch(`${API_BASE}/player/${nflId}/snap/${gameId}/${playId}`);
        if (res.ok) return await res.json();
      } catch (_) {}
    }

    const gamesMap = await _loadGamesMap();
    const gMeta = gamesMap[String(gameId)];
    const season = gMeta?.season || Number(String(gameId).slice(0, 4));

    const rows = await _loadParquetRows(`${nflId}/game_tracking_${season}.parquet`);
    if (rows && rows.length > 0) {
      const payload = buildSnapPayload(rows, gameId, playId);
      if (payload) return payload;
    }

    try {
      const res = await fetch(`${STATIC_BASE}/player/${nflId}/snap/${gameId}_${playId}.json`);
      if (res.ok) return await res.json();
    } catch (_) {}
    return null;
  },

  /**
   * Canonical alias for fetchGames
   */
  async getPlayerGames(nflId, season = null, playType = null) {
    return this.fetchGames(nflId, season, playType);
  },

  /**
   * Canonical alias for fetchPlays
   */
  async getPlayerPlays(nflId, gameId, linedUpPos = null, playType = null) {
    let params = {};
    if (linedUpPos && typeof linedUpPos === 'object') {
      params = linedUpPos;
    } else {
      if (linedUpPos) params.lined_up_position = linedUpPos;
      if (playType) params.play_type = playType;
    }
    return this.fetchPlays(nflId, gameId, params);
  },

  /**
   * Canonical alias for fetchSnap
   */
  async getPlayerSnap(nflId, gameId, playId) {
    return this.fetchSnap(nflId, gameId, playId);
  },

  /**
   * GET /api/spatial/drills?nfl_id={nflId}
   * Robust: Falls back to combine.json drills array if spatial/drills is missing!
   */
  async fetchSpatialDrills(nflId) {
    if (!nflId) return { drills: [] };
    const directData = await fetchWithFallback(
      `${API_BASE}/spatial/drills?nfl_id=${nflId}`,
      `spatial/drills/${nflId}.json`,
      `fetchSpatialDrills(${nflId})`
    );
    if (directData && Array.isArray(directData.drills) && directData.drills.length > 0) {
      return directData;
    }

    // Fallback: Read from combine.json
    try {
      const combine = await this.fetchCombine(nflId);
      if (combine && Array.isArray(combine.drills)) {
        return {
          drills: combine.drills.map(d => ({
            event_id: d.event_id,
            drill_name: d.drill_name || d.name || 'Combine Drill'
          }))
        };
      }
    } catch (_) {}

    return { drills: [] };
  },

  /**
   * Universal compareSpatialCombine with live backend API + fallback to in-browser client resampling.
   */
  async compareSpatialCombine(playerA, drillA, playerB, drillB, step = 0.5, milestones = null) {
    if (!isStaticMode()) {
      const url = new URL(`${window.location.origin}${API_BASE}/spatial/compare/combine`);
      url.searchParams.set('player_a', playerA);
      url.searchParams.set('drill_a', drillA);
      url.searchParams.set('player_b', playerB);
      url.searchParams.set('drill_b', drillB);
      url.searchParams.set('step', step);
      if (milestones) url.searchParams.set('milestones', milestones);

      try {
        const res = await fetch(url.toString());
        if (res.ok) return await res.json();
      } catch (_) {}
    }

    // In static mode or if live API fails: Compute in-browser using spatial_engine!
    try {
      const payloadA = await this.fetchCombineDrill(playerA, drillA);
      let payloadB = null;

      if (playerB === 'POS_AVG') {
        const drillName = drillA.includes('THREE') ? 'THREE_CONE' : (drillA.includes('SHUTTLE') ? 'SHUTTLE' : 'FORTY_YARD_DASH');
        const summaryA = await this.fetchPlayerSummary(playerA);
        const pos = summaryA?.nfl_position || summaryA?.position || 'WR';
        const avgRes = await this.fetchSpatialPositionAvg(pos, drillName, step);
        if (avgRes && avgRes.trajectory) {
          payloadB = avgRes.trajectory;
        }
      } else {
        payloadB = await this.fetchCombineDrill(playerB, drillB);
      }

      if (payloadA && payloadB) {
        return resampleAndCompareTrajectories(payloadA, payloadB, step, drillA);
      }
    } catch (err) {
      console.warn('[API] Client-side spatial combine comparison failed:', err);
    }
    return null;
  },

  /**
   * GET /api/spatial/compare/snap
   */
  async compareSpatialSnap(playerA, gameA, playA, playerB, gameB, playB, step = 0.5) {
    if (!isStaticMode()) {
      const url = new URL(`${window.location.origin}${API_BASE}/spatial/compare/snap`);
      url.searchParams.set('player_a', playerA);
      url.searchParams.set('game_a', gameA);
      url.searchParams.set('play_a', playA);
      url.searchParams.set('player_b', playerB);
      url.searchParams.set('game_b', gameB);
      url.searchParams.set('play_b', playB);
      url.searchParams.set('step', step);

      try {
        const res = await fetch(url.toString());
        if (res.ok) return await res.json();
      } catch (_) {}
    }

    // Fallback in-browser
    try {
      const snapA = await this.fetchSnap(playerA, gameA, playA);
      const snapB = await this.fetchSnap(playerB, gameB, playB);
      if (snapA && snapB) {
        return resampleAndCompareTrajectories(snapA, snapB, step, 'snap');
      }
    } catch (err) {
      console.warn('[API] Client-side spatial snap comparison failed:', err);
    }
    return null;
  },

  /**
   * GET /api/spatial/position_avg
   */
  async fetchSpatialPositionAvg(position, drillName = 'FORTY_YARD_DASH', step = 0.5) {
    const url = new URL(`${window.location.origin}${API_BASE}/spatial/position_avg`);
    url.searchParams.set('position', position);
    url.searchParams.set('drill_name', drillName);
    url.searchParams.set('step', step);

    const staticPath = `spatial/position_avg/${position}_${drillName}_${step}.json`;
    return await fetchWithFallback(url.toString(), staticPath, `fetchSpatialPositionAvg(${position})`);
  }
};

// Expose globally on window
if (typeof window !== 'undefined') {
  window.api = api;
}
