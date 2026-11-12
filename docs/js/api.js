/**
 * NFL Tracking & Combine Explorer - Backend API Client Module
 * Exclusively consumes FrameDTO and backend endpoint contracts.
 * Supports both Live FastAPI Backend and Static Hosting (e.g. GitHub Pages).
 */

const API_BASE = '/api';
const STATIC_BASE = './data';

// Cached all players array for client-side filtering on static hosting
let _staticAllPlayersCache = null;

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
    const safeEventId = encodeURIComponent(eventId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return await fetchWithFallback(
      `${API_BASE}/player/${nflId}/combine/${encodeURIComponent(eventId)}`,
      `player/${nflId}/drills/${safeEventId}.json`,
      `fetchCombineDrill(${nflId}, ${eventId})`
    );
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
  async fetchGGKdeCloud(nflId, scope = 'season') {
    if (!nflId) return null;
    return await fetchWithFallback(
      `${API_BASE}/player/${nflId}/gg-kde?scope=${scope}`,
      `player/${nflId}/gg_kde/${scope}.json`,
      `fetchGGKdeCloud(${nflId}, ${scope})`
    );
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

    const data = await fetchWithFallback(
      `${API_BASE}/player/${nflId}/games${qs}`,
      `player/${nflId}/games.json`,
      `fetchGames(${nflId})`
    );

    if (!data || !data.games) return { games: [] };

    // In static mode, apply season / playType filter in memory
    let filteredGames = data.games;
    if (season) {
      filteredGames = filteredGames.filter(g => String(g.season) === String(season));
    }
    if (playType) {
      filteredGames = filteredGames.map(g => {
        const plays = (g.plays || []).filter(p => {
          if (playType === 'RUN') return p.is_run === true;
          if (playType === 'PASS') return p.is_run === false;
          return true;
        });
        return { ...g, plays, play_count: plays.length };
      }).filter(g => g.play_count > 0);
    }
    return { games: filteredGames };
  },

  /**
   * GET /api/player/{nfl_id}/plays/{game_id}?lined_up_position={pos}&play_type={type}
   */
  async fetchPlays(nflId, gameId, params = {}) {
    if (!nflId || !gameId) return [];
    const query = new URLSearchParams();
    if (params.lined_up_position) query.set('lined_up_position', params.lined_up_position);
    if (params.play_type) query.set('play_type', params.play_type);
    const qs = query.toString() ? `?${query.toString()}` : '';

    const data = await fetchWithFallback(
      `${API_BASE}/player/${nflId}/plays/${gameId}${qs}`,
      `player/${nflId}/plays/${gameId}.json`,
      `fetchPlays(${nflId}, ${gameId})`
    );
    return Array.isArray(data) ? data : [];
  },

  /**
   * GET /api/player/{nfl_id}/snap/{game_id}/{play_id}
   */
  async fetchSnap(nflId, gameId, playId) {
    if (!nflId || !gameId || !playId) return null;
    return await fetchWithFallback(
      `${API_BASE}/player/${nflId}/snap/${gameId}/${playId}`,
      `player/${nflId}/snap/${gameId}_${playId}.json`,
      `fetchSnap(${nflId}, ${gameId}, ${playId})`
    );
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
   */
  async fetchSpatialDrills(nflId) {
    if (!nflId) return { drills: [] };
    const data = await fetchWithFallback(
      `${API_BASE}/spatial/drills?nfl_id=${nflId}`,
      `spatial/drills/${nflId}.json`,
      `fetchSpatialDrills(${nflId})`
    );
    return data || { drills: [] };
  },

  /**
   * GET /api/spatial/compare/combine
   */
  async compareSpatialCombine(playerA, drillA, playerB, drillB, step = 0.5, milestones = null) {
    const url = new URL(`${window.location.origin}${API_BASE}/spatial/compare/combine`);
    url.searchParams.set('player_a', playerA);
    url.searchParams.set('drill_a', drillA);
    url.searchParams.set('player_b', playerB);
    url.searchParams.set('drill_b', drillB);
    url.searchParams.set('step', step);
    if (milestones) url.searchParams.set('milestones', milestones);

    const safeDrillA = encodeURIComponent(drillA).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeDrillB = encodeURIComponent(drillB).replace(/[^a-zA-Z0-9_-]/g, '_');
    const staticPath = `spatial/compare_combine/${playerA}_${safeDrillA}_${playerB}_${safeDrillB}_${step}.json`;

    return await fetchWithFallback(url.toString(), staticPath, `compareSpatialCombine(${playerA}, ${playerB})`);
  },

  /**
   * GET /api/spatial/compare/snap
   */
  async compareSpatialSnap(playerA, gameA, playA, playerB, gameB, playB, step = 0.5) {
    const url = new URL(`${window.location.origin}${API_BASE}/spatial/compare/snap`);
    url.searchParams.set('player_a', playerA);
    url.searchParams.set('game_a', gameA);
    url.searchParams.set('play_a', playA);
    url.searchParams.set('player_b', playerB);
    url.searchParams.set('game_b', gameB);
    url.searchParams.set('play_b', playB);
    url.searchParams.set('step', step);

    const staticPath = `spatial/compare_snap/${playerA}_${gameA}_${playA}_${playerB}_${gameB}_${playB}_${step}.json`;
    return await fetchWithFallback(url.toString(), staticPath, `compareSpatialSnap(${playerA}, ${playerB})`);
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

// Also expose globally on window
if (typeof window !== 'undefined') {
  window.api = api;
}
