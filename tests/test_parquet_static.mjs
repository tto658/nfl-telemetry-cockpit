/**
 * Parity & Integration Test Suite for In-Browser ZSTD Parquet Telemetry
 * Compares Node hyparquet.bundle.mjs + kinematics_engine.js + api.js against
 * live Python FastAPI endpoints using exported docs/ bundle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parquetReadObjects, compressors } from '../src/web/static/js/vendor/hyparquet.bundle.mjs';
import {
  buildCombineDrillPayload,
  buildGamesFromParquet,
  buildSnapPayload,
  buildGGCloudPayload
} from '../src/web/static/js/kinematics_engine.js';
import { decodeFloat32Base64 } from '../src/web/static/js/gg_diagram.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
    throw new Error(msg);
  }
  passed++;
}

function approx(a, b, eps = 0.02) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

async function readParquetLocal(filePath) {
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return await parquetReadObjects({ file: ab, compressors });
}

function loadPythonGroundTruth(playerIds, pickTargets) {
  const pyScript = `
import json, sys
from fastapi.testclient import TestClient
from src.web.app import app

client = TestClient(app)
spec = json.loads(sys.argv[1])
out = {}

for item in spec:
    pid = item["nfl_id"]
    entry = {}
    comb = client.get(f"/api/player/{pid}/combine").json()
    entry["combine"] = comb
    drills = comb.get("drills", [])
    if drills:
        eid = drills[0]["event_id"]
        entry["combine_drill"] = client.get(f"/api/player/{pid}/combine/{eid}").json()
        entry["combine_event_id"] = eid

    games_resp = client.get(f"/api/player/{pid}/games").json()
    entry["games"] = games_resp
    games = games_resp.get("games", [])
    if games:
        g0 = games[0]
        gid = g0["game_id"]
        plid = g0["plays"][0]["play_id"]
        entry["snap_target"] = {"game_id": gid, "play_id": plid}
        entry["snap"] = client.get(f"/api/player/{pid}/snap/{gid}/{plid}").json()

    entry["gg_combine"] = client.get(f"/api/player/{pid}/gg-kde?scope=combine").json()
    entry["gg_season"] = client.get(f"/api/player/{pid}/gg-kde?scope=season").json()
    out[str(pid)] = entry

print(json.dumps(out))
`;
  const stdout = execFileSync(
    'uv',
    ['run', 'python', '-c', pyScript, JSON.stringify(playerIds.map(id => ({ nfl_id: id })))],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' }
  );
  return JSON.parse(stdout);
}

console.log('=== RUNNING STATIC PARQUET PARITY TEST SUITE ===');

assert(fs.existsSync(DOCS_DIR), 'docs/ directory must exist (run build_github_pages.py first)');
assert(fs.existsSync(path.join(DOCS_DIR, 'js', 'vendor', 'hyparquet.bundle.mjs')), 'vendor/hyparquet.bundle.mjs must exist in docs/js/vendor');
assert(fs.existsSync(path.join(DOCS_DIR, 'data', 'games.json')), 'docs/data/games.json must exist');

const players = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, 'data', 'players.json'), 'utf-8'));
const gamesMap = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, 'data', 'games.json'), 'utf-8'));

assert(players.length === 510, `Expected 510 players in docs/data/players.json, got ${players.length}`);
assert(Object.keys(gamesMap).length > 0, 'docs/data/games.json must have game metadata');

const zeroSnapPlayer = players.find(p => Array.isArray(p.teams) && p.teams.length === 0);
assert(zeroSnapPlayer, 'Expected at least one zero-snap prospect in players.json');

const testIds = [56056, 55867, zeroSnapPlayer.nfl_id];
console.log(`-> Fetching Python ground truth for players ${testIds.join(', ')}...`);
const truth = loadPythonGroundTruth(testIds);

for (const pid of [56056, 55867]) {
  const pMeta = players.find(p => p.nfl_id === pid);
  const pqDir = path.join(DOCS_DIR, 'data', 'parquet', String(pid));
  const py = truth[String(pid)];

  // 1. Games parity
  const playRows = await readParquetLocal(path.join(pqDir, 'player_play.parquet'));
  const jsGames = buildGamesFromParquet(playRows, gamesMap, pMeta?.teams?.[0] || null);
  const pyGames = py.games.games;

  assert(
    jsGames.length === pyGames.length,
    `Player ${pid}: JS games.length (${jsGames.length}) == Python (${pyGames.length})`
  );
  if (pyGames.length > 0) {
    assert(jsGames[0].game_id === pyGames[0].game_id, `Player ${pid}: first game_id matches (${jsGames[0].game_id})`);
    assert(jsGames[0].plays.length === pyGames[0].plays.length, `Player ${pid}: first game play count matches (${jsGames[0].plays.length})`);
    assert(jsGames[0].opponent === pyGames[0].opponent, `Player ${pid}: first game opponent matches (${jsGames[0].opponent})`);
    assert(jsGames[0].home_away === pyGames[0].home_away, `Player ${pid}: first game home_away matches (${jsGames[0].home_away})`);
  }

  // 2. Snap 10Hz telemetry & kinematics parity
  if (py.snap_target) {
    const { game_id: gid, play_id: plid } = py.snap_target;
    const season = Number(String(gid).slice(0, 4));
    const trackingRows = await readParquetLocal(path.join(pqDir, `game_tracking_${season}.parquet`));
    const jsSnap = buildSnapPayload(trackingRows, gid, plid);
    const pySnap = py.snap;

    assert(jsSnap !== null, `Player ${pid}: buildSnapPayload returned payload for ${gid}/${plid}`);
    assert(jsSnap.frames.length === pySnap.frames.length, `Player ${pid}: snap frames (${jsSnap.frames.length}) == Python (${pySnap.frames.length})`);
    assert(approx(jsSnap.g_comb_max, pySnap.g_comb_max, 0.03), `Player ${pid}: g_comb_max (${jsSnap.g_comb_max}) ~= Python (${pySnap.g_comb_max})`);
    assert(approx(jsSnap.overlap_index, pySnap.overlap_index, 0.02), `Player ${pid}: overlap_index (${jsSnap.overlap_index}) ~= Python (${pySnap.overlap_index})`);
    assert(approx(jsSnap.v_apex, pySnap.v_apex, 0.05), `Player ${pid}: v_apex (${jsSnap.v_apex}) ~= Python (${pySnap.v_apex})`);

    const mid = Math.floor(jsSnap.frames.length / 2);
    assert(approx(jsSnap.frames[mid].g_lat, pySnap.frames[mid].g_lat, 0.02), `Player ${pid}: mid g_lat matches`);
    assert(approx(jsSnap.frames[mid].g_t, pySnap.frames[mid].g_t, 0.02), `Player ${pid}: mid g_t matches`);
    assert(jsSnap.frames[mid].dynamics_state === pySnap.frames[mid].dynamics_state, `Player ${pid}: mid dynamics_state matches (${jsSnap.frames[mid].dynamics_state})`);
  }

  // 3. Combine Drill parity
  if (py.combine_event_id) {
    const combineRows = await readParquetLocal(path.join(pqDir, 'combine_tracking.parquet'));
    const jsDrill = buildCombineDrillPayload(combineRows, py.combine_event_id);
    const pyDrill = py.combine_drill;

    assert(jsDrill !== null, `Player ${pid}: combine drill ${py.combine_event_id} loaded`);
    assert(jsDrill.player_frames.length === pyDrill.player_frames.length, `Player ${pid}: drill frames (${jsDrill.player_frames.length}) == Python (${pyDrill.player_frames.length})`);
    assert(approx(jsDrill.metrics.s_max, pyDrill.metrics.s_max, 0.02), `Player ${pid}: drill s_max matches`);
    assert(approx(jsDrill.metrics.g_comb_max, pyDrill.metrics.g_comb_max, 0.03), `Player ${pid}: drill g_comb_max matches`);

    // 4. Combine G-G KDE parity
    const playerOnly = combineRows.filter(r => r.entity_type === 'PLAYER');
    const byEvent = new Map();
    for (const r of playerOnly) {
      if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
      byEvent.get(r.event_id).push(r);
    }
    const jsGgCombine = buildGGCloudPayload(pid, Array.from(byEvent.values()), { isCombine: true, scope: 'combine' });
    const pyGgCombine = py.gg_combine;
    const diffCount = Math.abs(jsGgCombine.count - pyGgCombine.count);
    assert(diffCount <= Math.max(2, pyGgCombine.count * 0.01), `Player ${pid}: combine G-G cloud count (${jsGgCombine.count}) ~= Python (${pyGgCombine.count})`);
    const decodedLat = decodeFloat32Base64(jsGgCombine.b64_g_lat);
    assert(decodedLat.length === jsGgCombine.count, `Player ${pid}: b64_g_lat decodes to ${jsGgCombine.count} floats`);
  }

  // 5. Season G-G KDE parity (via parquet files)
  const gtFiles = fs.readdirSync(pqDir).filter(f => /^game_tracking_\d{4}\.parquet$/.test(f)).sort();
  const partitions = [];
  for (const gtFile of gtFiles) {
    const rows = await readParquetLocal(path.join(pqDir, gtFile));
    const bySnap = new Map();
    for (const r of rows) {
      const k = `${r.game_id}_${r.play_id}`;
      if (!bySnap.has(k)) bySnap.set(k, []);
      bySnap.get(k).push(r);
    }
    for (const arr of bySnap.values()) partitions.push(arr);
  }
  const jsGgSeason = buildGGCloudPayload(pid, partitions, { isCombine: false, scope: 'season' });
  const pyGgSeason = py.gg_season;
  const sDiff = Math.abs(jsGgSeason.count - pyGgSeason.count);
  assert(sDiff <= Math.max(5, pyGgSeason.count * 0.01), `Player ${pid}: season G-G cloud count (${jsGgSeason.count}) ~= Python (${pyGgSeason.count})`);
  assert(approx(jsGgSeason.bounds.g_lat_max, pyGgSeason.bounds.g_lat_max, 0.06), `Player ${pid}: season g_lat_max matches`);

  console.log(`   PASS Player ${pid} (${pMeta.display_name}): ${jsGames.length} games, combine OK, G-G season=${jsGgSeason.count} pts`);
}

// Zero-snap player check + mock window/fetch test of actual api.js static methods
{
  const zid = zeroSnapPlayer.nfl_id;
  const zPqDir = path.join(DOCS_DIR, 'data', 'parquet', String(zid));
  const hasPlayPq = fs.existsSync(path.join(zPqDir, 'player_play.parquet'));
  assert(!hasPlayPq || (await readParquetLocal(path.join(zPqDir, 'player_play.parquet'))).length === 0,
    `Zero-snap player ${zid} has 0 game rows`);

  globalThis.window = {
    location: {
      hostname: 'tto658.github.io',
      protocol: 'https:',
      pathname: '/nfl-telemetry-cockpit/'
    }
  };
  globalThis.fetch = async (url) => {
    const cleanUrl = String(url).split('?')[0].replace(/^\.\//, '');
    const targetPath = path.join(DOCS_DIR, cleanUrl);
    if (!fs.existsSync(targetPath)) {
      return { ok: false, status: 404, async json() { throw new Error('404'); }, async arrayBuffer() { throw new Error('404'); } };
    }
    const buf = fs.readFileSync(targetPath);
    return {
      ok: true,
      status: 200,
      async json() { return JSON.parse(buf.toString('utf-8')); },
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
    };
  };

  const { api } = await import('../src/web/static/js/api.js');
  const palmerGames = await api.getPlayerGames(56056);
  assert(palmerGames.games.length === 40 && !palmerGames.unavailable && !palmerGames.zeroSnap,
    `api.getPlayerGames(56056) returned 40 games cleanly via docs/ parquet`);

  const palmerSnap = await api.getPlayerSnap(56056, palmerGames.games[0].game_id, palmerGames.games[0].plays[0].play_id);
  assert(palmerSnap && palmerSnap.frames.length > 0, `api.getPlayerSnap(56056) returned 10Hz frames`);

  const zeroGames = await api.getPlayerGames(zid);
  assert(zeroGames.games.length === 0 && zeroGames.zeroSnap === true && !zeroGames.unavailable,
    `api.getPlayerGames(${zid}) cleanly signals zeroSnap=true for 0-snap prospect`);

  console.log(`   PASS ApiClient static-mode E2E test (56056: 40 games, zero-snap ${zid}: zeroSnap=true)`);
}

console.log(`\nALL PARQUET PARITY TESTS PASSED (${passed} passed, ${failed} failed)`);
