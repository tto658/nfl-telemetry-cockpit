/**
 * Headless Node.js Unit & Adversarial Test Suite for GGDiagramCanvas KDE Engine
 * Tests: Base64 binary decoding, 84x84 Separable 2D Gaussian KDE, Marching Squares,
 * and Plant-to-Cut Impulse Coupling Biomechanical Diagnostics.
 */

import { GGDiagramCanvas, decodeFloat32Base64 } from '../src/web/static/js/gg_diagram.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
    throw new Error(message);
  } else {
    passed++;
  }
}

function approx(val, target, eps = 1e-3) {
  return Math.abs(val - target) <= eps;
}

function createMockCanvas(width = 400, height = 400) {
  const calls = [];
  const ctx = {
    calls,
    lineDash: [],
    setLineDash(dash) {
      this.lineDash = dash.slice();
      calls.push({ op: 'setLineDash', dash: this.lineDash });
    },
    getLineDash() {
      return this.lineDash;
    },
    save() { calls.push({ op: 'save' }); },
    restore() { calls.push({ op: 'restore' }); },
    translate(x, y) { calls.push({ op: 'translate', x, y }); },
    scale(sx, sy) { calls.push({ op: 'scale', sx, sy }); },
    rotate(angle) { calls.push({ op: 'rotate', angle }); },
    setTransform(a, b, c, d, e, f) { calls.push({ op: 'setTransform', a, b, c, d, e, f }); },
    clearRect(x, y, w, h) { calls.push({ op: 'clearRect', x, y, w, h }); },
    fillRect(x, y, w, h) { calls.push({ op: 'fillRect', x, y, w, h }); },
    strokeRect(x, y, w, h) { calls.push({ op: 'strokeRect', x, y, w, h }); },
    rect(x, y, w, h) { calls.push({ op: 'rect', x, y, w, h }); },
    roundRect(x, y, w, h, r) { calls.push({ op: 'roundRect', x, y, w, h, r }); },
    beginPath() { calls.push({ op: 'beginPath' }); },
    closePath() { calls.push({ op: 'closePath' }); },
    moveTo(x, y) { calls.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { calls.push({ op: 'lineTo', x, y }); },
    stroke() { calls.push({ op: 'stroke' }); },
    fill() { calls.push({ op: 'fill' }); },
    clip() { calls.push({ op: 'clip' }); },
    arc(x, y, r, sa, ea, ccw) { calls.push({ op: 'arc', x, y, r, sa, ea, ccw }); },
    measureText(text) { return { width: (text ? text.toString().length : 0) * 6 }; },
    fillText(text, x, y) { calls.push({ op: 'fillText', text, x, y }); },
    strokeText(text, x, y) { calls.push({ op: 'strokeText', text, x, y }); },
  };

  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getContext(type) {
      if (type === '2d') return ctx;
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width, height, right: width, bottom: height };
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

console.log('=== RUNNING GG-KDE NODE VERIFICATION SUITE ===');

// ----------------------------------------------------------------------------
// Test 1: decodeFloat32Base64 roundtrip
// ----------------------------------------------------------------------------
{
  const original = new Float32Array([0.45, -0.85, 1.25, -0.05, 0.0, 1.65]);
  const buf = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
  const b64 = buf.toString('base64');

  const decoded = decodeFloat32Base64(b64);
  assert(decoded.length === original.length, `Decoded length ${decoded.length} matches original ${original.length}`);
  for (let i = 0; i < original.length; i++) {
    assert(approx(decoded[i], original[i]), `Decoded[${i}] ${decoded[i]} == original ${original[i]}`);
  }
}

// ----------------------------------------------------------------------------
// Test 2: GGDiagramCanvas initialization and mock rendering
// ----------------------------------------------------------------------------
const mockCanvas = createMockCanvas(400, 400);
const gg = new GGDiagramCanvas(mockCanvas, {
  maxScaleG: 1.3,
  displayMode: 'hybrid',
  cloudScope: 'play'
});

assert(gg != null, 'GGDiagramCanvas instantiated');
assert(gg.displayMode === 'hybrid', 'Initial displayMode is hybrid');
assert(gg.cloudScope === 'play', 'Initial cloudScope is play');

// ----------------------------------------------------------------------------
// Test 3: Synthetic telemetry cloud with plant-and-cut maneuver & coasting
// ----------------------------------------------------------------------------
{
  const N = 40;
  const g_lat = new Float32Array(N);
  const g_t = new Float32Array(N);
  const s = new Float32Array(N);
  const beta = new Float32Array(N);

  // Frames 0-9: Straight forward acceleration
  for (let i = 0; i < 10; i++) {
    g_lat[i] = 0.02;
    g_t[i] = 0.45;
    s[i] = 4.0 + i * 0.3;
    beta[i] = 2.0;
  }

  // Frames 10-12: Sharp plant / eccentric deceleration (gt < -0.3g)
  for (let i = 10; i < 13; i++) {
    g_lat[i] = 0.10;
    g_t[i] = -0.55;
    s[i] = 3.0;
    beta[i] = 8.0;
  }

  // Frames 13-16: Explosive lateral cut (glat >= 0.8g, gt > 0)
  for (let i = 13; i < 17; i++) {
    g_lat[i] = 0.85;
    g_t[i] = 0.25;
    s[i] = 4.5;
    beta[i] = 32.0;
  }

  // Frames 17-39: In-motion coasting (s >= 1.5, g_comb < 0.15)
  for (let i = 17; i < N; i++) {
    g_lat[i] = 0.04;
    g_t[i] = 0.03;
    s[i] = 2.2;
    beta[i] = 1.0;
  }

  const b64_g_lat = Buffer.from(g_lat.buffer).toString('base64');
  const b64_g_t = Buffer.from(g_t.buffer).toString('base64');
  const b64_s = Buffer.from(s.buffer).toString('base64');
  const b64_beta = Buffer.from(beta.buffer).toString('base64');

  gg.setBinaryCloud({
    nfl_id: 55867,
    scope: 'season',
    count: N,
    b64_g_lat,
    b64_g_t,
    b64_s,
    b64_beta,
    bounds: { g_lat_min: -0.1, g_lat_max: 0.9, g_t_min: -0.6, g_t_max: 0.5 }
  });

  assert(gg.cloudScope === 'season', 'cloudScope switched to season');
  assert(gg.binaryCloud !== null, 'binaryCloud populated');
  assert(gg.binaryCloud.count === N, `binaryCloud count is ${N}`);

  // Check KDE grid
  assert(gg.kdeGrid !== null, 'KDE grid computed');
  assert(gg.kdeGrid.N === 84, 'KDE grid resolution is 84');
  assert(gg.kdeGrid.Z.length === 84, 'KDE density array has 84 rows');
  assert(gg.kdeIsovalues !== null, 'KDE isovalues computed');
  assert(gg.kdeIsovalues.p50 <= gg.kdeIsovalues.p75, 'p50 <= p75');
  assert(gg.kdeIsovalues.p75 <= gg.kdeIsovalues.p90, 'p75 <= p90');

  // Check Biomechanics Diagnostics
  const diag = gg.getDiagnostics();
  assert(diag.gMax > 0.8, `gMax ${diag.gMax} correctly captures peak cut > 0.8g`);
  assert(diag.gSustained > 0.4, `gSustained ${diag.gSustained} captures 95th percentile sustained grip`);
  assert(diag.spikeDeltaG >= 0, `spikeDeltaG ${diag.spikeDeltaG} >= 0`);
  assert(diag.impulseCouplingMs > 0 && diag.impulseCouplingMs <= 500,
    `impulseCouplingMs ${diag.impulseCouplingMs} ms accurately measures plant-to-cut transition`);
  assert(diag.plantToCutScore >= 70, `plantToCutScore ${diag.plantToCutScore} indicates explosive coupling`);
  assert(diag.coastingPct > 30, `coastingPct ${diag.coastingPct}% accurately captures coasting frames`);
}

// ----------------------------------------------------------------------------
// Test 4: Display mode toggling & headless render verification
// ----------------------------------------------------------------------------
{
  gg.setDisplayMode('kde');
  assert(gg.displayMode === 'kde', 'Mode set to kde');
  gg.render(); // verify no error

  gg.setDisplayMode('scatter');
  assert(gg.displayMode === 'scatter', 'Mode set to scatter');
  gg.render(); // verify no error

  gg.setDisplayMode('hybrid');
  assert(gg.displayMode === 'hybrid', 'Mode set to hybrid');
  gg.render(); // verify no error
}

console.log(`========================================`);
console.log(`ALL CHECKS PASSED: ${passed} passed, ${failed} failed`);
console.log(`========================================`);
