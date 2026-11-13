/**
 * spatial_engine.js - Pure JavaScript Client-Side Curvilinear Spatial Resampling & Delta Engine
 * Port of core mathematical routines from src/web/spatial.py for zero-backend comparison on GitHub Pages.
 */

export const DRILL_MILESTONES = {
  forty_yard_dash: {
    '10-Yard Split': 10.0,
    '20-Yard Split': 20.0,
    '40-Yard Finish': 40.0,
  },
  three_cone: {
    'Turn 1 (5yd)': 5.0,
    'Return Line (10yd)': 10.0,
    'Cone 2 Cut (15yd)': 15.0,
    'Cone 3 Apex (18yd)': 18.0,
    'Cone 2 Figure-8 (23yd)': 23.0,
    'Finish (30yd)': 30.0,
  },
  short_shuttle: {
    'First Cut (5yd)': 5.0,
    'Second Cut (15yd)': 15.0,
    'Finish (20yd)': 20.0,
  },
  twenty_yard_shuttle: {
    'First Cut (5yd)': 5.0,
    'Second Cut (15yd)': 15.0,
    'Finish (20yd)': 20.0,
  }
};

/**
 * 1D linear interpolation helper.
 */
function interp1D(xNew, xArr, yArr) {
  if (xArr.length === 0) return 0;
  if (xNew <= xArr[0]) return yArr[0];
  if (xNew >= xArr[xArr.length - 1]) return yArr[yArr.length - 1];

  let low = 0;
  let high = xArr.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (xArr[mid] < xNew) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const i0 = Math.max(0, low - 1);
  const i1 = Math.min(xArr.length - 1, low);
  if (i0 === i1 || Math.abs(xArr[i1] - xArr[i0]) < 1e-9) {
    return yArr[i0];
  }

  const t = (xNew - xArr[i0]) / (xArr[i1] - xArr[i0]);
  return yArr[i0] + t * (yArr[i1] - yArr[i0]);
}

/**
 * Compute cumulative distance along raw frames.
 * @param {Array} rawFrames Array of FrameDTO objects with x, y, s, a, etc.
 * @returns {Object} Cumulative trajectory with distance array and max distance
 */
export function computeCumulativeTrajectory(rawFrames) {
  if (!Array.isArray(rawFrames) || rawFrames.length === 0) {
    return { frames: [], distances: [], maxDistance: 0 };
  }

  const sorted = [...rawFrames].sort((a, b) => (a.frame_id ?? 0) - (b.frame_id ?? 0));
  const distances = new Float64Array(sorted.length);
  distances[0] = 0.0;

  for (let i = 1; i < sorted.length; i++) {
    const dx = (sorted[i].x ?? 0) - (sorted[i - 1].x ?? 0);
    const dy = (sorted[i].y ?? 0) - (sorted[i - 1].y ?? 0);
    distances[i] = distances[i - 1] + Math.hypot(dx, dy);
  }

  return {
    frames: sorted,
    distances: Array.from(distances),
    maxDistance: distances[distances.length - 1]
  };
}

/**
 * Resample a single trajectory onto a uniform distance grid.
 */
export function resampleTrajectory(trajData, gridDistances) {
  const { frames, distances } = trajData;
  if (frames.length === 0 || gridDistances.length === 0) {
    return { points: [], total_distance: 0, point_count: 0 };
  }

  // Extract raw series
  const times = frames.map((f, idx) => (
    f.time_elapsed !== undefined ? f.time_elapsed : (f.time !== undefined ? f.time : idx * 0.1)
  ));
  const speeds = frames.map(f => f.s ?? 0);
  const accels = frames.map(f => f.a ?? 0);
  const xs = frames.map(f => f.x ?? 0);
  const ys = frames.map(f => f.y ?? 0);
  const dirs = frames.map(f => f.dir ?? 0);
  const os = frames.map(f => f.o ?? 0);
  const betas = frames.map(f => f.beta_slip ?? f.sideslip ?? 0);
  const gCombs = frames.map(f => f.g_comb ?? 0);

  const points = [];
  for (let i = 0; i < gridDistances.length; i++) {
    const d = gridDistances[i];
    const t = interp1D(d, distances, times);
    const s = Math.max(0, interp1D(d, distances, speeds));
    const a = interp1D(d, distances, accels);
    const x = interp1D(d, distances, xs);
    const y = interp1D(d, distances, ys);
    const dir = interp1D(d, distances, dirs);
    const o = interp1D(d, distances, os);
    const beta_slip = interp1D(d, distances, betas);
    const g_comb = interp1D(d, distances, gCombs);

    points.push({
      distance: Number(d.toFixed(2)),
      time_elapsed: Number(t.toFixed(3)),
      s: Number(s.toFixed(2)),
      a: Number(a.toFixed(2)),
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      dir: Number(dir.toFixed(1)),
      o: Number(o.toFixed(1)),
      beta_slip: Number(beta_slip.toFixed(1)),
      g_comb: Number(g_comb.toFixed(2))
    });
  }

  return {
    total_distance: gridDistances[gridDistances.length - 1] ?? 0,
    point_count: points.length,
    points
  };
}

/**
 * Resample and compare two trajectories in pure JavaScript.
 * Produces the full SpatialDeltaComparison schema expected by SpatialStripCanvas and SpatialOverlayCanvas.
 */
export function resampleAndCompareTrajectories(payloadA, payloadB, step = 0.5, drillKey = 'forty_yard_dash') {
  const framesA = payloadA.player_frames || payloadA.frames || payloadA.points || [];
  const framesB = payloadB.player_frames || payloadB.frames || payloadB.points || [];

  const trajA = computeCumulativeTrajectory(framesA);
  const trajB = computeCumulativeTrajectory(framesB);

  const commonMax = Math.min(trajA.maxDistance, trajB.maxDistance);
  if (commonMax < 0.5) {
    return null;
  }

  const gridCount = Math.floor(commonMax / step) + 1;
  const gridDistance = [];
  for (let i = 0; i < gridCount; i++) {
    gridDistance.push(Number((i * step).toFixed(2)));
  }

  const resampledA = resampleTrajectory(trajA, gridDistance);
  const resampledB = resampleTrajectory(trajB, gridDistance);

  const timesA = resampledA.points.map(p => p.time_elapsed);
  const timesB = resampledB.points.map(p => p.time_elapsed);
  const speedsA = resampledA.points.map(p => p.s);
  const speedsB = resampledB.points.map(p => p.s);

  const deltaTime = [];
  const deltaSpeed = [];
  for (let i = 0; i < gridCount; i++) {
    deltaTime.push(Number((timesA[i] - timesB[i]).toFixed(3)));
    deltaSpeed.push(Number((speedsA[i] - speedsB[i]).toFixed(2)));
  }

  // Mini-sectors (every 5 yards)
  const miniSectors = [];
  const sectorLen = 5.0;
  const numSectors = Math.floor(commonMax / sectorLen);
  for (let i = 0; i < numSectors; i++) {
    const sStart = i * sectorLen;
    const sEnd = (i + 1) * sectorLen;

    const tAStart = interp1D(sStart, gridDistance, timesA);
    const tAEnd = interp1D(sEnd, gridDistance, timesA);
    const dtA = Math.max(0.01, tAEnd - tAStart);

    const tBStart = interp1D(sStart, gridDistance, timesB);
    const tBEnd = interp1D(sEnd, gridDistance, timesB);
    const dtB = Math.max(0.01, tBEnd - tBStart);

    const sAAvg = sectorLen / dtA;
    const sBAvg = sectorLen / dtB;
    const dTime = dtA - dtB;

    let winner = 'TIE';
    if (dTime < -0.005) winner = 'A';
    else if (dTime > 0.005) winner = 'B';

    miniSectors.push({
      sector_index: i,
      start_distance: sStart,
      end_distance: sEnd,
      sector_length: sectorLen,
      time_a: Number(dtA.toFixed(3)),
      time_b: Number(dtB.toFixed(3)),
      delta_time: Number(dTime.toFixed(3)),
      speed_a_avg: Number(sAAvg.toFixed(2)),
      speed_b_avg: Number(sBAvg.toFixed(2)),
      delta_speed_avg: Number((sAAvg - sBAvg).toFixed(2)),
      winner
    });
  }

  // Drill Milestones
  const normKey = (drillKey || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const milestonesDef = DRILL_MILESTONES[normKey] || DRILL_MILESTONES.forty_yard_dash;
  const milestones = [];
  for (const [mName, mDist] of Object.entries(milestonesDef)) {
    if (mDist <= commonMax) {
      const tA = interp1D(mDist, gridDistance, timesA);
      const tB = interp1D(mDist, gridDistance, timesB);
      const sA = interp1D(mDist, gridDistance, speedsA);
      const sB = interp1D(mDist, gridDistance, speedsB);

      milestones.push({
        name: mName,
        distance: mDist,
        time_a: Number(tA.toFixed(3)),
        time_b: Number(tB.toFixed(3)),
        delta_time: Number((tA - tB).toFixed(3)),
        speed_a: Number(sA.toFixed(2)),
        speed_b: Number(sB.toFixed(2)),
        delta_speed: Number((sA - sB).toFixed(2))
      });
    }
  }

  // Peak metrics
  const gCombA = Math.max(0, ...resampledA.points.map(p => p.g_comb || 0));
  const gCombB = Math.max(0, ...resampledB.points.map(p => p.g_comb || 0));

  return {
    common_max_distance: commonMax,
    step_yards: step,
    grid_distance: gridDistance,
    delta_time: deltaTime,
    delta_speed: deltaSpeed,
    times_a: timesA,
    times_b: timesB,
    speeds_a: speedsA,
    speeds_b: speedsB,
    mini_sectors: miniSectors,
    milestones,
    apexes_a: [],
    apexes_b: [],
    resampled_a: resampledA,
    resampled_b: resampledB,
    overlap_index_a: (payloadA.overlap_index ?? (payloadA.overlap_pct != null ? payloadA.overlap_pct / 100 : 0.0)),
    overlap_index_b: (payloadB.overlap_index ?? (payloadB.overlap_pct != null ? payloadB.overlap_pct / 100 : 0.0)),
    g_comb_max_a: Number(gCombA.toFixed(2)),
    g_comb_max_b: Number(gCombB.toFixed(2)),
    exit_traction_a: payloadA.corner_exit_traction ?? payloadA.exit_traction ?? 0.0,
    exit_traction_b: payloadB.corner_exit_traction ?? payloadB.exit_traction ?? 0.0,
    key_apex_speed_a: payloadA.v_apex ?? payloadA.apex_speed ?? 0.0,
    key_apex_speed_b: payloadB.v_apex ?? payloadB.apex_speed ?? 0.0
  };
}
