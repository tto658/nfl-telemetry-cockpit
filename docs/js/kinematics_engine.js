/**
 * kinematics_engine.js — Client-Side Biomechanical Kinematics & Parquet Payload Builder
 * Mirrors src/web/kinematics.py and src/web/data_loader.py so GitHub Pages static mode
 * delivers 100% of all 510 players' combine drills, games, plays, snaps, and G-G KDE clouds
 * directly from slimmed ZSTD Parquet files.
 */

const G_CONST_YD = 10.7247; // 1 g = 9.80665 m/s^2 = 10.7247 yd/s^2

const toNum = (v, fallback = 0) => {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const toNullableNum = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const roundN = (v, digits) => {
  const m = Math.pow(10, digits);
  return Math.round((v + Number.EPSILON) * m) / m;
};

/**
 * Minimal signed angular difference in degrees in [-180, 180].
 * Uses positive modulo to match Python's `% 360.0` behavior.
 */
export function unwrapAngleDiff(degT, degPrev) {
  const diff = degT - degPrev + 180.0;
  return (((diff % 360.0) + 360.0) % 360.0) - 180.0;
}

/**
 * Compute percentile using linear interpolation (matches numpy.percentile).
 */
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0.0;
  const sorted = [...arr].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100.0) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Encode Float32Array to Base64 string (works in both Browser and Node.js).
 */
export function encodeFloat32Base64(f32) {
  if (!f32 || f32.length === 0) return '';
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

/**
 * Compute Trail-Braking / Overlap Index matching kinematics.compute_overlap_index.
 */
export function computeOverlapIndex(aTangential, aLateral, speeds = null, minSpeedThreshold = 0.5, pct = 70.0) {
  const n = Math.min(aTangential.length, aLateral.length);
  if (n === 0) return 0.0;

  let atList = [];
  let alatList = [];

  if (speeds) {
    const validAt = [];
    const validAlat = [];
    for (let i = 0; i < n; i++) {
      if (speeds[i] >= minSpeedThreshold) {
        validAt.push(aTangential[i]);
        validAlat.push(aLateral[i]);
      }
    }
    if (validAt.length >= 5) {
      atList = validAt;
      alatList = validAlat;
    } else {
      atList = aTangential.slice(0, n);
      alatList = aLateral.slice(0, n);
    }
  } else {
    atList = aTangential.slice(0, n);
    alatList = aLateral.slice(0, n);
  }

  if (atList.length < 3) return 0.0;

  const absAt = atList.map(Math.abs);
  const absAlat = alatList.map(Math.abs);
  const pA = percentile(absAt, pct);
  const pLat = percentile(absAlat, pct);

  let overlapCount = 0;
  for (let i = 0; i < absAt.length; i++) {
    if (absAt[i] > pA && absAlat[i] > pLat) {
      overlapCount++;
    }
  }
  return roundN(overlapCount / absAt.length, 4);
}

/**
 * Compute Apex Speed and Corner Exit Traction across curvature peaks.
 */
export function computeApexMetrics(speeds, curvatures, accelerations, dt = 0.1, minCurvature = 0.10, exitWindowSec = 0.5) {
  const n = Math.min(speeds.length, curvatures.length, accelerations.length);
  if (n < 3) return [];

  const exitFrames = Math.max(1, Math.round(exitWindowSec / dt));
  const apexes = [];

  for (let i = 1; i < n - 1; i++) {
    const c = curvatures[i];
    if (c >= minCurvature && c >= curvatures[i - 1] && c >= curvatures[i + 1]) {
      const vApex = speeds[i];
      const endIdx = Math.min(n, i + 1 + exitFrames);
      let exitSum = 0;
      let exitCnt = 0;
      for (let j = i + 1; j < endIdx; j++) {
        exitSum += accelerations[j];
        exitCnt++;
      }
      const exitTraction = exitCnt > 0 ? exitSum / exitCnt : accelerations[i];
      apexes.push({
        frame_index: i,
        time: roundN(i * dt, 2),
        curvature: roundN(c, 4),
        v_apex: roundN(vApex, 2),
        apex_speed: roundN(vApex, 2),
        exit_traction: roundN(exitTraction, 2)
      });
    }
  }
  return apexes;
}

/**
 * Compute per-frame kinematics on an already time-sorted trajectory slice.
 * Mirrors kinematics.compute_tracking_kinematics + FrameDTO serialization.
 */
export function computeFrameKinematics(rawRows, { isCombine = false, dt = 0.1, singularityThreshold = 0.2 } = {}) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) return [];

  const rows = [...rawRows].sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')));
  const frames = [];

  let prevDir = null;
  let prevBeta = null;
  let prevA = null;
  let prevS = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const s = toNum(r.s, 0.0);
    const a = toNum(r.a, 0.0);
    const d = toNum(r.dir, 0.0);
    const oRaw = !isCombine ? toNullableNum(r.o) : null;
    const x = toNum(r.x, 0.0);
    const y = toNum(r.y, 0.0);
    const ev = r.event ?? null;

    // 1. Angular diff & omega
    const deltaDir = prevDir !== null ? unwrapAngleDiff(d, prevDir) : null;
    const omega = deltaDir === null ? 0.0 : Math.abs(deltaDir) / dt;

    // 2. Curvature kappa
    const kappa = (s >= singularityThreshold && Math.abs(s) > 1e-9)
      ? (omega * (Math.PI / 180.0)) / s
      : 0.0;

    // 3. Slip angle beta_slip (for in-game tracking where body orientation o exists)
    const betaSlip = (!isCombine && oRaw !== null) ? unwrapAngleDiff(d, oRaw) : null;

    // 4. Beta rate
    let betaRate = null;
    if (betaSlip !== null) {
      betaRate = prevBeta === null ? 0.0 : unwrapAngleDiff(betaSlip, prevBeta) / dt;
    }

    // 5. Jerk
    const jerk = prevA === null ? 0.0 : (a - prevA) / dt;

    // 6. Snap Oversteer & Dynamics state
    const isSnap = Boolean(
      !isCombine &&
      betaSlip !== null &&
      betaRate !== null &&
      s >= 1.0 &&
      Math.abs(betaRate) >= 100.0 &&
      Math.abs(jerk) >= 6.0
    );

    let dynamicsState = 'ON_RAILS';
    if (isSnap) {
      dynamicsState = 'SNAP_OVERSTEER';
    } else if (s < 0.5) {
      dynamicsState = 'STATIONARY';
    } else if (betaSlip !== null) {
      const absB = Math.abs(betaSlip);
      if (absB <= 10.0) dynamicsState = 'ON_RAILS';
      else if (absB <= 45.0) dynamicsState = 'CONTROLLED_DRIFT';
      else dynamicsState = 'LATERAL_BACKPEDAL';
    }

    // 7. Signed lateral accel & G-forces
    const aLat = deltaDir === null ? 0.0 : s * ((deltaDir / dt) * (Math.PI / 180.0));
    const signedA = (prevS !== null && s < prevS) ? -Math.abs(a) : a;
    const aComb = Math.hypot(a, aLat);
    const gLat = aLat / G_CONST_YD;
    const gT = signedA / G_CONST_YD;
    const gComb = aComb / G_CONST_YD;

    // 8. NGS compass velocity components
    const rad = d * (Math.PI / 180.0);
    const vx = s * Math.sin(rad);
    const vy = s * Math.cos(rad);
    const tRel = roundN(i * dt, 2);

    frames.push({
      frame_id: i,
      frameId: i,
      time_elapsed: tRel,
      time: tRel,
      x: roundN(x, 2),
      y: roundN(y, 2),
      s: roundN(s, 2),
      a: roundN(a, 2),
      dir: roundN(d, 2),
      o: oRaw !== null ? roundN(oRaw, 2) : null,
      omega_deg: roundN(omega, 2),
      omega: roundN(omega, 2),
      kappa: roundN(kappa, 4),
      curvature: roundN(kappa, 4),
      beta_slip: betaSlip !== null ? roundN(betaSlip, 2) : null,
      slip_angle: betaSlip !== null ? roundN(betaSlip, 2) : null,
      beta_rate: betaRate !== null ? roundN(betaRate, 2) : null,
      d_beta_dt: betaRate !== null ? roundN(betaRate, 2) : null,
      jerk: roundN(jerk, 2),
      snap_oversteer: isSnap,
      dynamics_state: dynamicsState,
      a_lat: roundN(aLat, 2),
      a_comb: roundN(aComb, 2),
      g_comb: roundN(gComb, 2),
      g_lat: roundN(gLat, 3),
      g_t: roundN(gT, 3),
      v_x: roundN(vx, 3),
      v_y: roundN(vy, 3),
      event: ev
    });

    prevDir = d;
    if (betaSlip !== null) prevBeta = betaSlip;
    prevA = a;
    prevS = s;
  }

  return frames;
}

/**
 * Build full combine drill payload (identical to GET /api/player/{id}/combine/{event_id}).
 */
export function buildCombineDrillPayload(allCombineRows, eventId) {
  const filtered = (allCombineRows || []).filter(r => r.event_id === eventId);
  if (filtered.length === 0) return null;

  const drillName = filtered[0].drill_name || 'DRILL';
  const playerRows = filtered.filter(r => r.entity_type === 'PLAYER');
  const ballRows = filtered
    .filter(r => r.entity_type === 'BALL')
    .sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')));

  const pFrames = computeFrameKinematics(playerRows, { isCombine: true });
  const bFrames = ballRows.map((r, i) => ({
    frame_id: i,
    frameId: i,
    time_elapsed: roundN(i * 0.1, 2),
    time: roundN(i * 0.1, 2),
    x: roundN(toNum(r.x), 2),
    y: roundN(toNum(r.y), 2),
    s: roundN(toNum(r.s), 2),
    a: roundN(toNum(r.a), 2),
    dir: roundN(toNum(r.dir), 2),
    o: null,
    omega_deg: null,
    omega: null,
    kappa: null,
    curvature: null,
    beta_slip: null,
    slip_angle: null,
    event: null
  }));

  const sList = pFrames.map(f => f.s);
  const aList = pFrames.map(f => f.a);
  const kList = pFrames.map(f => f.curvature || 0);
  const aLatList = pFrames.map(f => f.a_lat || 0);
  const gCombList = pFrames.map(f => f.g_comb || 0);
  const posCurv = kList.filter(k => k > 0);

  const sMax = sList.length ? Math.max(...sList) : 0;
  const aMax = aList.length ? Math.max(...aList) : 0;
  const gCombMax = gCombList.length ? Math.max(...gCombList) : 0;
  const duration = pFrames.length * 0.1;
  const kappa90 = posCurv.length ? percentile(posCurv, 90) : 0;

  const overlapIndex = computeOverlapIndex(aList, aLatList, sList);
  const apexMetrics = computeApexMetrics(sList, kList, aList);
  const vApex = apexMetrics.length ? Math.max(...apexMetrics.map(m => m.v_apex)) : 0;
  const cornerExitTraction = apexMetrics.length
    ? apexMetrics.reduce((acc, m) => acc + m.exit_traction, 0) / apexMetrics.length
    : 0;

  const metrics = {
    s_max: roundN(sMax, 2),
    a_max: roundN(aMax, 2),
    g_comb_max: roundN(gCombMax, 2),
    overlap_index: roundN(overlapIndex, 4),
    overlap_pct: roundN(overlapIndex * 100, 1),
    v_apex: roundN(vApex, 2),
    apex_speed: roundN(vApex, 2),
    corner_exit_traction: roundN(cornerExitTraction, 2),
    apex_metrics: apexMetrics,
    duration: roundN(duration, 2),
    duration_sec: roundN(duration, 2),
    kappa_90: roundN(kappa90, 4)
  };

  return {
    drill_name: drillName,
    metrics,
    ...metrics,
    player_frames: pFrames,
    player_trajectory: pFrames,
    ball_frames: bFrames,
    ball_trajectory: bFrames
  };
}

function teamsMatch(t1, t2) {
  if (!t1 || !t2) return false;
  if (t1 === t2) return true;
  const s = new Set([t1, t2]);
  return s.size === 2 && s.has('LA') && s.has('LAR');
}

/**
 * Aggregate player_play.parquet rows + global games lookup map into /api/player/{id}/games structure.
 */
export function buildGamesFromParquet(playRows, gamesMap = {}, playerFallbackTeam = null) {
  if (!Array.isArray(playRows) || playRows.length === 0) return [];

  const gamesDict = new Map();
  const gameTeams = new Map();

  for (const r of playRows) {
    const gId = toNum(r.game_id, 0);
    if (!gId) continue;

    if (!gamesDict.has(gId)) gamesDict.set(gId, []);
    if (r.team_abbr && !gameTeams.has(gId)) gameTeams.set(gId, String(r.team_abbr));

    let isRun = false;
    if (r.run !== undefined && r.run !== null) {
      isRun = Boolean(r.run);
    } else {
      isRun = (r.pass_result === null || r.pass_result === undefined) &&
              (r.dropback_duration === null || r.dropback_duration === undefined);
    }

    const pType = isRun ? 'RUN' : 'PASS';
    const epa = toNum(r.expected_points_added, 0.0);
    const desc = r.play_description ? String(r.play_description) : '';

    gamesDict.get(gId).push({
      play_id: toNum(r.play_id, 0),
      quarter: toNum(r.quarter, 1),
      down: toNullableNum(r.down),
      yards_to_go: toNullableNum(r.yards_to_go),
      yardline_side: r.yardline_side ?? null,
      yardline_number: toNullableNum(r.yardline_number),
      possession_team: r.possession_team ?? null,
      play_direction: r.play_direction ?? null,
      game_clock: r.game_clock ? String(r.game_clock) : '',
      play_type: pType,
      is_run: isRun,
      epa,
      expected_points_added: epa,
      description: desc,
      play_description: desc,
      lined_up_position: r.lined_up_position ? String(r.lined_up_position) : ''
    });
  }

  const result = [];
  for (const [gId, plays] of gamesDict.entries()) {
    const gidStr = String(gId);
    const meta = gamesMap[gidStr] || gamesMap[gId] || null;
    const dateStr = gidStr.length >= 8 ? `${gidStr.slice(0, 4)}-${gidStr.slice(4, 6)}-${gidStr.slice(6, 8)}` : null;

    const gSeason = meta ? toNum(meta.season, Number(gidStr.slice(0, 4))) : Number(gidStr.slice(0, 4));
    const week = meta ? toNullableNum(meta.week) : null;
    const seasonType = meta?.season_type || 'REG';
    const homeTeam = meta?.home_team_abbr || null;
    const visitorTeam = meta?.visitor_team_abbr || null;
    const gameKey = meta?.game_key ? toNullableNum(meta.game_key) : null;

    const playerTeam = gameTeams.get(gId) || playerFallbackTeam;
    let homeAway = null;
    let opponent = null;
    if (homeTeam && visitorTeam && playerTeam) {
      if (teamsMatch(playerTeam, homeTeam)) {
        homeAway = 'home';
        opponent = visitorTeam;
      } else if (teamsMatch(playerTeam, visitorTeam)) {
        homeAway = 'away';
        opponent = homeTeam;
      } else {
        homeAway = 'home';
        opponent = visitorTeam;
      }
    }

    result.push({
      game_id: gId,
      game_key: gameKey,
      season: gSeason,
      season_type: seasonType,
      week,
      date: dateStr,
      home_team: homeTeam,
      home_team_abbr: homeTeam,
      visitor_team: visitorTeam,
      visitor_team_abbr: visitorTeam,
      opponent,
      home_away: homeAway,
      total_plays: plays.length,
      play_count: plays.length,
      plays
    });
  }

  result.sort((a, b) => a.game_id - b.game_id);
  return result;
}

/**
 * Build 10 Hz snap payload (identical to GET /api/player/{id}/snap/{game_id}/{play_id}).
 */
export function buildSnapPayload(trackingRows, gameId, playId) {
  const gTarget = Number(gameId);
  const pTarget = Number(playId);
  const snapRows = (trackingRows || []).filter(
    r => Number(r.game_id) === gTarget && Number(r.play_id) === pTarget
  );
  if (snapRows.length === 0) return null;

  const frames = computeFrameKinematics(snapRows, { isCombine: false });
  const events = [];
  const snapOversteerFrames = [];

  for (const f of frames) {
    if (f.event) {
      events.push({ event: f.event, frameId: f.frameId, time: f.time });
    }
    if (f.snap_oversteer) {
      snapOversteerFrames.push({
        frameId: f.frameId,
        time: f.time,
        beta: f.slip_angle ?? 0.0,
        beta_rate: f.beta_rate ?? 0.0,
        jerk: f.jerk ?? 0.0
      });
    }
  }

  const sList = frames.map(f => f.s);
  const aList = frames.map(f => f.a);
  const kList = frames.map(f => f.curvature || 0);
  const aLatList = frames.map(f => f.a_lat || 0);
  const gCombMax = frames.length ? Math.max(...frames.map(f => f.g_comb || 0)) : 0;

  const overlapIndex = computeOverlapIndex(aList, aLatList, sList);
  const apexMetrics = computeApexMetrics(sList, kList, aList);
  const vApex = apexMetrics.length ? Math.max(...apexMetrics.map(m => m.v_apex)) : 0;
  const cornerExitTraction = apexMetrics.length
    ? apexMetrics.reduce((acc, m) => acc + m.exit_traction, 0) / apexMetrics.length
    : 0;

  return {
    game_id: gTarget,
    play_id: pTarget,
    frames,
    events,
    snap_oversteer_incidents: snapOversteerFrames.length,
    snap_oversteer_frames: snapOversteerFrames,
    g_comb_max: roundN(gCombMax, 2),
    overlap_index: roundN(overlapIndex, 4),
    overlap_pct: roundN(overlapIndex * 100, 1),
    v_apex: roundN(vApex, 2),
    apex_speed: roundN(vApex, 2),
    corner_exit_traction: roundN(cornerExitTraction, 2),
    apex_metrics: apexMetrics
  };
}

/**
 * Build Base64 Float32 binary G-G cloud from tracking rows (mirrors load_player_gg_cloud_binary).
 * Applies Dynamic Energy Gate: (s > 0.3) || (g_comb >= 0.12).
 */
export function buildGGCloudPayload(nflId, partitions, { isCombine = false, scope = 'season', season = null, gameId = null } = {}) {
  const gLatVals = [];
  const gTVals = [];
  const sVals = [];
  const betaVals = [];

  for (const partRows of partitions) {
    const frames = computeFrameKinematics(partRows, { isCombine });
    for (const f of frames) {
      if (f.s > 0.3 || f.g_comb >= 0.12) {
        gLatVals.push(f.g_lat ?? 0.0);
        gTVals.push(f.g_t ?? 0.0);
        sVals.push(f.s ?? 0.0);
        betaVals.push(f.beta_slip ?? 0.0);
      }
    }
  }

  const gLatArr = new Float32Array(gLatVals);
  const gTArr = new Float32Array(gTVals);
  const sArr = new Float32Array(sVals);
  const betaArr = new Float32Array(betaVals);

  let minLat = Infinity, maxLat = -Infinity, minT = Infinity, maxT = -Infinity;
  for (let i = 0; i < gLatArr.length; i++) {
    if (gLatArr[i] < minLat) minLat = gLatArr[i];
    if (gLatArr[i] > maxLat) maxLat = gLatArr[i];
    if (gTArr[i] < minT) minT = gTArr[i];
    if (gTArr[i] > maxT) maxT = gTArr[i];
  }

  return {
    nfl_id: Number(nflId),
    scope,
    season,
    game_id: gameId,
    count: gLatArr.length,
    b64_g_lat: encodeFloat32Base64(gLatArr),
    b64_g_t: encodeFloat32Base64(gTArr),
    b64_s: encodeFloat32Base64(sArr),
    b64_beta: encodeFloat32Base64(betaArr),
    bounds: gLatArr.length > 0 ? {
      g_lat_min: roundN(minLat, 3),
      g_lat_max: roundN(maxLat, 3),
      g_t_min: roundN(minT, 3),
      g_t_max: roundN(maxT, 3)
    } : { g_lat_min: 0.0, g_lat_max: 0.0, g_t_min: 0.0, g_t_max: 0.0 }
  };
}
