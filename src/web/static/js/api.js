/**
 * NFL Tracking & Combine Explorer - Backend API Client Module
 * Exclusively consumes FrameDTO and backend endpoint contracts.
 */

const API_BASE = '/api';

/**
 * Handle fetch response with safe status handling.
 * @param {Response} response
 * @param {string} endpointName
 */
async function handleResponse(response, endpointName) {
  if (!response.ok) {
    if (response.status === 404) {
      console.warn(`[API] 404 Not Found at ${endpointName}`);
      return null;
    }
    const errorText = await response.text();
    throw new Error(`[API] ${endpointName} failed (${response.status}): ${errorText}`);
  }
  return await response.json();
}

export const api = {
  /**
   * GET /api/metadata
   * Returns: { draft_years: number[], positions: string[], teams: string[], total_players: number }
   */
  async fetchMetadata() {
    try {
      const res = await fetch(`${API_BASE}/metadata`);
      return await handleResponse(res, 'fetchMetadata');
    } catch (err) {
      console.error('Error fetching metadata:', err);
      return { draft_years: [2023, 2024, 2025], positions: [], teams: [], total_players: 0 };
    }
  },

  /**
   * GET /api/players?draft_year={year}&pos={pos}&team_abbr={team}&q={search}
   * @param {Object} params { draft_year?: number|string, pos?: string, team_abbr?: string, q?: string }
   * Returns: PlayerListItem[]
   */
  async fetchPlayers(params = {}) {
    const url = new URL(`${window.location.origin}${API_BASE}/players`);
    if (params.draft_year) url.searchParams.set('draft_year', params.draft_year);
    if (params.pos) url.searchParams.set('pos', params.pos);
    if (params.team_abbr) url.searchParams.set('team_abbr', params.team_abbr);
    if (params.q && params.q.trim()) url.searchParams.set('q', params.q.trim());

    try {
      const res = await fetch(url.toString());
      const data = await handleResponse(res, 'fetchPlayers');
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Error fetching players:', err);
      return [];
    }
  },

  /**
   * GET /api/player/{nfl_id}/summary
   * Returns: { nfl_id, display_name, position, draft_year, teams, bio, combine, career }
   */
  async fetchPlayerSummary(nflId) {
    if (!nflId) return null;
    try {
      const res = await fetch(`${API_BASE}/player/${nflId}/summary`);
      return await handleResponse(res, `fetchPlayerSummary(${nflId})`);
    } catch (err) {
      console.error(`Error fetching summary for player ${nflId}:`, err);
      return null;
    }
  },

  /**
   * GET /api/player/{nfl_id}/combine
   * Returns: { combine_tests, opt_outs, ngs_scores, forty, vertical, ..., drills: Array }
   */
  async fetchCombine(nflId) {
    if (!nflId) return null;
    try {
      const res = await fetch(`${API_BASE}/player/${nflId}/combine`);
      return await handleResponse(res, `fetchCombine(${nflId})`);
    } catch (err) {
      console.error(`Error fetching combine data for player ${nflId}:`, err);
      return null;
    }
  },

  /**
   * GET /api/player/{nfl_id}/combine/{event_id}
   * Returns: { drill_name, metrics, s_max, a_max, duration, kappa_90, player_frames: FrameDTO[], ball_frames: FrameDTO[] }
   */
  async fetchCombineDrill(nflId, eventId) {
    if (!nflId || !eventId) return null;
    try {
      const res = await fetch(`${API_BASE}/player/${nflId}/combine/${encodeURIComponent(eventId)}`);
      return await handleResponse(res, `fetchCombineDrill(${nflId}, ${eventId})`);
    } catch (err) {
      console.error(`Error fetching drill ${eventId} for player ${nflId}:`, err);
      return null;
    }
  },

  /**
   * GET /api/player/{nfl_id}/games?season={season}&play_type={playType}
   * Returns: { games: GameSummary[] }
   */
  async fetchGames(nflId, season = null, playType = null) {
    if (!nflId) return { games: [] };
    const url = new URL(`${window.location.origin}${API_BASE}/player/${nflId}/games`);
    if (season) url.searchParams.set('season', season);
    if (playType) url.searchParams.set('play_type', playType);

    try {
      const res = await fetch(url.toString());
      const data = await handleResponse(res, `fetchGames(${nflId})`);
      return data || { games: [] };
    } catch (err) {
      console.error(`Error fetching games for player ${nflId}:`, err);
      return { games: [] };
    }
  },

  /**
   * GET /api/player/{nfl_id}/plays/{game_id}?lined_up_position={pos}&play_type={type}
   * Returns: PlaySummary[]
   */
  async fetchPlays(nflId, gameId, params = {}) {
    if (!nflId || !gameId) return [];
    const url = new URL(`${window.location.origin}${API_BASE}/player/${nflId}/plays/${gameId}`);
    if (params.lined_up_position) url.searchParams.set('lined_up_position', params.lined_up_position);
    if (params.play_type) url.searchParams.set('play_type', params.play_type);

    try {
      const res = await fetch(url.toString());
      const data = await handleResponse(res, `fetchPlays(${nflId}, ${gameId})`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error(`Error fetching plays for player ${nflId}, game ${gameId}:`, err);
      return [];
    }
  },

  /**
   * GET /api/player/{nfl_id}/snap/{game_id}/{play_id}
   * Returns: { game_id, play_id, frames: FrameDTO[], events: EventMarker[] }
   */
  async fetchSnap(nflId, gameId, playId) {
    if (!nflId || !gameId || !playId) return null;
    try {
      const res = await fetch(`${API_BASE}/player/${nflId}/snap/${gameId}/${playId}`);
      return await handleResponse(res, `fetchSnap(${nflId}, ${gameId}, ${playId})`);
    } catch (err) {
      console.error(`Error fetching snap ${playId} for player ${nflId}, game ${gameId}:`, err);
      return null;
    }
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
   * Returns: { drills: [{event_id, drill_name}, ...] }
   */
  async fetchSpatialDrills(nflId) {
    if (!nflId) return { drills: [] };
    try {
      const res = await fetch(`${API_BASE}/spatial/drills?nfl_id=${nflId}`);
      return await handleResponse(res, `fetchSpatialDrills(${nflId})`) || { drills: [] };
    } catch (err) {
      console.error(`Error fetching spatial drills for player ${nflId}:`, err);
      return { drills: [] };
    }
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

    try {
      const res = await fetch(url.toString());
      return await handleResponse(res, `compareSpatialCombine(${playerA}, ${playerB})`);
    } catch (err) {
      console.error('Error comparing spatial combine drills:', err);
      return null;
    }
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

    try {
      const res = await fetch(url.toString());
      return await handleResponse(res, `compareSpatialSnap(${playerA}, ${playerB})`);
    } catch (err) {
      console.error('Error comparing spatial snaps:', err);
      return null;
    }
  },

  /**
   * GET /api/spatial/position_avg
   */
  async fetchSpatialPositionAvg(position, drillName = 'FORTY_YARD_DASH', step = 0.5) {
    const url = new URL(`${window.location.origin}${API_BASE}/spatial/position_avg`);
    url.searchParams.set('position', position);
    url.searchParams.set('drill_name', drillName);
    url.searchParams.set('step', step);

    try {
      const res = await fetch(url.toString());
      return await handleResponse(res, `fetchSpatialPositionAvg(${position})`);
    } catch (err) {
      console.error('Error fetching position average:', err);
      return null;
    }
  }
};

// Also expose globally on window
if (typeof window !== 'undefined') {
  window.api = api;
}
