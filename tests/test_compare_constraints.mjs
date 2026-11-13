/**
 * Head-to-Head Comparison Constraints, Game -> Play Cascade, and Football Copy Tests.
 * Exercises compare_app.js pure helpers, mocked-DOM event cascades, spatial_engine.js
 * position_avg timing parity, and static HTML de-F1 cleanup on docs/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BENCHMARK_AVG_DRILLS,
  getPlayerPosition,
  getPositionGroups,
  getSamePositionPeers,
  arePositionsCompatible,
  annotateDrillReps,
  getSynchronizedDrillOptions,
  getMatchingRepsForDrill,
  formatGameOptionLabel,
  formatPlayOptionLabel,
  initCompareApp,
  onSpatialGameAChange,
  onSpatialGameBChange,
  renderSpatialSectorsTable,
  renderSpatialMilestonesTable
} from '../src/web/static/js/compare_app.js';
import { resampleAndCompareTrajectories } from '../src/web/static/js/spatial_engine.js';
import { parquetReadObjects, compressors } from '../src/web/static/js/vendor/hyparquet.bundle.mjs';
import { buildCombineDrillPayload } from '../src/web/static/js/kinematics_engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  passed++;
}

// ============================================================================
// Minimal DOM + Fetch Mock for Headless Controller Cascade Testing
// ============================================================================

function parseOptionsFromHtml(html) {
  const opts = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const valMatch = /value="([^"]*)"/i.exec(attrs);
    const disMatch = /\bdisabled\b/i.test(attrs);
    opts.push({
      value: valMatch ? valMatch[1] : '',
      disabled: disMatch,
      dataset: {},
      textContent: m[2].replace(/<[^>]+>/g, '')
    });
  }
  return opts;
}

function createMockElement(id) {
  const listeners = new Map();
  let _innerHTML = '';
  let _value = '';
  const classSet = new Set();

  const el = {
    id,
    style: {},
    dataset: {},
    disabled: false,
    options: [],
    classList: {
      add: (...cls) => cls.forEach(c => classSet.add(c)),
      remove: (...cls) => cls.forEach(c => classSet.delete(c)),
      toggle: (c, force) => {
        const shouldAdd = force !== undefined ? Boolean(force) : !classSet.has(c);
        if (shouldAdd) classSet.add(c);
        else classSet.delete(c);
        return shouldAdd;
      },
      contains: (c) => classSet.has(c)
    },
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(val) {
      _innerHTML = String(val || '');
      el.options = parseOptionsFromHtml(_innerHTML);
      if (el.options.length > 0 && !el.options.some(o => o.value === _value)) {
        _value = el.options[0].value;
      }
    },
    get value() {
      return _value;
    },
    set value(v) {
      _value = String(v ?? '');
    },
    textContent: '',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    async dispatchEvent(type) {
      const fns = listeners.get(type) || [];
      for (const fn of fns) {
        await fn({ target: el, type });
      }
    },
    querySelectorAll() {
      return [];
    }
  };
  return el;
}

function installMockBrowserEnv() {
  const elementIds = [
    'loadingOverlay', 'loadingMessage', 'toastNotification', 'toastMessage',
    'spatialModeCombine', 'spatialModeSnap', 'spatialPositionSelect', 'spatialPositionLockBadge',
    'spatialPlayerA', 'spatialPlayerB', 'spatialNameA', 'spatialNameB',
    'spatialCombineControlsA', 'spatialCombineControlsB', 'spatialDrillA', 'spatialDrillB',
    'spatialDrillSyncNote', 'spatialSnapControlsA', 'spatialSnapControlsB',
    'spatialGameA', 'spatialGameB', 'spatialPlayA', 'spatialPlayB',
    'spatialSwapBtn', 'spatialStepSelect', 'spatialCompareBtn',
    'spatialSummarySection', 'spatialCommonDist', 'spatialFinishDelta',
    'spatialLeaderBadge', 'spatialSectorScore', 'spatialVMaxDelta', 'spatialGComb',
    'spatialOverlapIndex', 'spatialApexSpeed', 'spatialExitTraction',
    'btnLane3Sideslip', 'btnLane3GForce', 'spatialDistanceSlider',
    'spatialCurrentD', 'spatialScrubReset', 'spatialScrubPlay',
    'spatialMilestonesBody', 'spatialSectorsBody'
  ];
  const elements = new Map();
  for (const id of elementIds) {
    elements.set(id, createMockElement(id));
  }
  elements.get('spatialStepSelect').value = '0.5';

  globalThis.document = {
    getElementById: (id) => elements.get(id) || null
  };
  globalThis.window = {
    location: {
      origin: 'https://tto658.github.io',
      hostname: 'tto658.github.io',
      pathname: '/nfl-telemetry-cockpit/compare.html',
      search: ''
    }
  };

  // Serve static files from docs/ over mocked fetch so api.js reads real exported data
  globalThis.fetch = async (url) => {
    const cleanUrl = String(url).split('?')[0].replace(/^\.\//, '');
    if (cleanUrl === '/api/health') {
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const rel = cleanUrl.startsWith('data/') ? cleanUrl : cleanUrl.replace(/^\/+/, '');
    const filePath = path.join(DOCS_DIR, rel);
    if (!fs.existsSync(filePath)) {
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const buf = fs.readFileSync(filePath);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buf.toString('utf-8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
  };

  return elements;
}

// ============================================================================
// Run Tests
// ============================================================================

async function runTests() {
  console.log('=== 1. Position Lock & Singleton Fallback Tests ===');
  const players = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, 'data', 'players.json'), 'utf-8'));
  assert(Array.isArray(players) && players.length === 510, `Expected 510 players in docs/data/players.json, got ${players.length}`);

  const groups = getPositionGroups(players);
  assert(groups.some(g => g.position === 'WR' && g.count >= 100), 'WR position group count should be >= 100');

  const wr = players.find(p => getPlayerPosition(p) === 'WR');
  const de = players.find(p => getPlayerPosition(p) === 'DE');
  const wr2 = players.find(p => getPlayerPosition(p) === 'WR' && p.nfl_id !== wr.nfl_id);
  assert(wr && de && wr2, 'Should find two WRs and one DE in players.json');

  assert(!arePositionsCompatible(players, wr, de), 'WR vs DE must NOT be compatible');
  assert(arePositionsCompatible(players, wr, wr2), 'WR vs WR must be compatible');

  const wrPeers = getSamePositionPeers(players, wr);
  assert(!wrPeers.usedCombineFallback, 'WR peers should not use combine fallback');
  assert(wrPeers.peers.every(p => getPlayerPosition(p) === 'WR'), 'All WR peers must share WR position');
  assert(wrPeers.peers.every(p => p.nfl_id !== wr.nfl_id), 'WR peers must exclude Player A itself');

  for (const singletonId of [57253, 57272, 58380]) {
    const sp = players.find(p => p.nfl_id === singletonId);
    assert(sp, `Singleton player ${singletonId} should exist`);
    const res = getSamePositionPeers(players, sp);
    assert(res.usedCombineFallback === true && res.peers.length > 0, `Singleton ${singletonId} (${getPlayerPosition(sp)}) must fall back to combine_position peers`);
  }

  console.log('=== 2. Combine Drill Synchronization Tests ===');
  const sampleDrillsA = [
    { event_id: '2023_FORTY_1', drill_name: 'FORTY_YARD_DASH', duration_sec: 4.45 },
    { event_id: '2023_FORTY_2', drill_name: 'FORTY_YARD_DASH', duration_sec: 4.42 },
    { event_id: '2023_THREE_CONE', drill_name: 'THREE_CONE', duration_sec: 6.91 }
  ];
  const sampleDrillsB = [
    { event_id: '2024_FORTY_1', drill_name: 'FORTY_YARD_DASH', duration_sec: 4.50 },
    { event_id: '2024_FORTY_2', drill_name: 'FORTY_YARD_DASH', duration_sec: 4.48 },
    { event_id: '2024_SHUTTLE', drill_name: 'SHUTTLE', duration_sec: 4.15 }
  ];

  const annotated = annotateDrillReps(sampleDrillsA);
  assert(annotated[0].displayLabel === 'FORTY_YARD_DASH (Rep 1)', 'First 40-yd dash should be labeled Rep 1');
  assert(annotated[1].displayLabel === 'FORTY_YARD_DASH (Rep 2)', 'Second 40-yd dash should be labeled Rep 2');
  assert(annotated[2].displayLabel === 'THREE_CONE', 'Single-rep drill should not have Rep suffix');

  const syncRes = getSynchronizedDrillOptions(sampleDrillsA, sampleDrillsB, { isPosAvg: false, position: 'WR' });
  const opt40 = syncRes.optionsA.find(o => o.drill_name === 'FORTY_YARD_DASH');
  const opt3c = syncRes.optionsA.find(o => o.drill_name === 'THREE_CONE');
  assert(opt40.compatible === true, 'Shared FORTY_YARD_DASH must be compatible');
  assert(opt3c.compatible === false && opt3c.optionText.includes('Not run by Player B'), 'Unshared THREE_CONE must be disabled/flagged');

  const repsB40 = getMatchingRepsForDrill(sampleDrillsB, 'FORTY_YARD_DASH');
  assert(repsB40.length === 2 && repsB40.every(r => r.drill_name === 'FORTY_YARD_DASH'), 'Player B matching reps must only include FORTY_YARD_DASH');
  const repsB3c = getMatchingRepsForDrill(sampleDrillsB, 'THREE_CONE');
  assert(repsB3c.length === 0, 'Player B must return 0 reps for unrecorded THREE_CONE');

  const dbPosAvg = getSynchronizedDrillOptions(sampleDrillsA, [], { isPosAvg: true, position: 'DB' });
  assert(dbPosAvg.optionsA.find(o => o.drill_name === 'FORTY_YARD_DASH').compatible === true, 'DB Position Average supports FORTY_YARD_DASH');
  assert(dbPosAvg.optionsA.find(o => o.drill_name === 'THREE_CONE').compatible === false, 'DB Position Average does not include THREE_CONE');
  assert(BENCHMARK_AVG_DRILLS.includes('SHUTTLE'), 'Standard WR/LB benchmark drills include SHUTTLE');

  console.log('=== 3. Position Average Timing & Spatial Engine Test ===');
  const wrPosAvg = JSON.parse(
    fs.readFileSync(path.join(DOCS_DIR, 'data', 'spatial', 'position_avg', 'WR_FORTY_YARD_DASH_0.5.json'), 'utf-8')
  );
  let wrWithFortyId = null;
  let wr40Rows = null;
  let wr40Row = null;
  for (const cand of players.filter(p => getPlayerPosition(p) === 'WR')) {
    const pFile = path.join(DOCS_DIR, 'data', 'parquet', String(cand.nfl_id), 'combine_tracking.parquet');
    if (!fs.existsSync(pFile)) continue;
    const buf = fs.readFileSync(pFile);
    const rows = await parquetReadObjects({
      file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      compressors
    });
    const hit = rows.find(r => String(r.drill_name) === 'FORTY_YARD_DASH');
    if (hit) {
      wrWithFortyId = cand.nfl_id;
      wr40Rows = rows;
      wr40Row = hit;
      break;
    }
  }
  assert(wrWithFortyId && wr40Row, 'Should find a WR with FORTY_YARD_DASH parquet rows');
  const payloadA = buildCombineDrillPayload(wr40Rows, String(wr40Row.event_id));
  const compResult = resampleAndCompareTrajectories(payloadA, wrPosAvg.trajectory, 0.5, 'FORTY_YARD_DASH');
  assert(compResult && compResult.common_max_distance >= 35, 'Comparison should cover ~40 yd');
  const finalTimeB = compResult.times_b[compResult.times_b.length - 1];
  assert(
    finalTimeB > 4.0 && finalTimeB < 5.6,
    `WR Position Avg 40-yd time should use real f.time (~4.89s), got ${finalTimeB}`
  );

  console.log('=== 4. Game -> Play Cascade & Snap Mode Constraint Tests ===');
  const elements = installMockBrowserEnv();
  await initCompareApp();

  // Switch to Snap mode (dispatches click handler)
  await elements.get('spatialModeSnap').dispatchEvent('click');
  const optValuesBInSnap = elements.get('spatialPlayerB').options.map(o => o.value);
  assert(!optValuesBInSnap.includes('POS_AVG'), 'POS_AVG must NOT be available in Game Snap mode');

  // Ensure Player A is locked to a multi-game WR (56056 Trey Palmer has 40 games)
  const multiGameWr = players.find(p => p.nfl_id === 56056) || players.find(p => getPlayerPosition(p) === 'WR' && (p.total_games || p.games_played || p.num_games || 0) >= 2);
  assert(multiGameWr, 'Should find a WR with >= 2 games for cascade test');
  elements.get('spatialPlayerA').value = String(multiGameWr.nfl_id);
  await elements.get('spatialPlayerA').dispatchEvent('change');

  const gameOptsA = elements.get('spatialGameA').options;
  assert(gameOptsA.length >= 2, `Multi-game WR ${multiGameWr.nfl_id} must load >= 2 games in dropdown`);
  const initialPlayIdsA = elements.get('spatialPlayA').options.map(o => o.value).join(',');

  // Change Game A to a DIFFERENT game and verify Play A updates automatically
  elements.get('spatialGameA').value = gameOptsA[1].value;
  await elements.get('spatialGameA').dispatchEvent('change');
  const updatedPlayIdsA = elements.get('spatialPlayA').options.map(o => o.value).join(',');
  assert(updatedPlayIdsA.length > 0 && updatedPlayIdsA !== initialPlayIdsA, 'Changing Game A MUST automatically update Play A options');

  // Verify Game B -> Play B cascade too
  const gameOptsB = elements.get('spatialGameB').options;
  if (gameOptsB.length >= 2) {
    const initialPlayIdsB = elements.get('spatialPlayB').options.map(o => o.value).join(',');
    elements.get('spatialGameB').value = gameOptsB[1].value;
    await elements.get('spatialGameB').dispatchEvent('change');
    const updatedPlayIdsB = elements.get('spatialPlayB').options.map(o => o.value).join(',');
    assert(updatedPlayIdsB.length > 0 && updatedPlayIdsB !== initialPlayIdsB, 'Changing Game B MUST automatically update Play B options');
  }

  // Also test game/play label helpers explicitly
  const gLbl = formatGameOptionLabel({ season: 2023, week: 4, home_away: 'away', opponent: 'BUF', total_plays: 12 });
  assert(gLbl.includes('2023') && gLbl.includes('@ BUF') && gLbl.includes('12 plays'), `Unexpected game label: ${gLbl}`);
  const pLbl = formatPlayOptionLabel({ quarter: 2, down: 3, yards_to_go: 7, play_type: 'PASS', play_id: 1234, description: 'Quick slant' });
  assert(pLbl.includes('Q2 3&7') && pLbl.includes('#1234'), `Unexpected play label: ${pLbl}`);

  console.log('=== 5. Football Terminology & Static HTML Verification ===');
  const tbodyMock = { innerHTML: '' };
  renderSpatialSectorsTable(compResult.mini_sectors, tbodyMock);
  assert(tbodyMock.innerHTML.includes('Split 1') && !tbodyMock.innerHTML.includes('Sector 1'), 'Table rows must use Split 1 instead of Sector 1');
  assert(tbodyMock.innerHTML.includes('0&ndash;5 yd') || tbodyMock.innerHTML.includes('0–5 yd'), 'Table must display yardage stretch');

  const compareHtml = fs.readFileSync(path.join(DOCS_DIR, 'compare.html'), 'utf-8');
  const indexHtml = fs.readFileSync(path.join(DOCS_DIR, 'index.html'), 'utf-8');
  for (const [fname, content] of [['docs/compare.html', compareHtml], ['docs/index.html', indexHtml]]) {
    for (const forbidden of ['MINI-SECTOR', 'Mini-Sector', 'F1 5-Yard', 'F1 FRICTION', 'Trail-Braking Overlap', 'Key Apex Speed', 'Corner Exit Traction', '🏎️']) {
      assert(!content.includes(forbidden), `${fname} must NOT contain F1 jargon "${forbidden}"`);
    }
  }
  assert(compareHtml.includes('5-Yard Split Intervals Breakdown'), 'docs/compare.html must contain 5-Yard Split Intervals Breakdown header');
  assert(compareHtml.includes('spatialPositionSelect'), 'docs/compare.html must include Position Group filter');

  console.log(`\nALL ${passed} ASSERTIONS PASSED cleanly.`);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
