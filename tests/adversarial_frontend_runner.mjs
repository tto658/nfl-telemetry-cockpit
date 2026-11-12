/**
 * Adversarial Frontend Verification Script for Challenger M3.2
 * Direct execution against src/web/static/js/combine_field.js and timeseries.js
 */

import { CombineFieldCanvas } from '../src/web/static/js/combine_field.js';
import { PlaybackEngine } from '../src/web/static/js/timeseries.js';

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

function approx(val, target, eps = 1e-5) {
    return Math.abs(val - target) <= eps;
}

// ----------------------------------------------------------------------------
// Mock Canvas & DOM Environment
// ----------------------------------------------------------------------------
function createMockCanvas(width = 800, height = 450) {
    const calls = [];
    const gradientMock = {
        addColorStop: (stop, color) => calls.push({ op: 'addColorStop', stop, color })
    };

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
        arc(x, y, r, sa, ea) { calls.push({ op: 'arc', x, y, r, sa, ea }); },
        createLinearGradient(x0, y0, x1, y1) {
            calls.push({ op: 'createLinearGradient', x0, y0, x1, y1 });
            return gradientMock;
        },
        measureText(text) { return { width: text.length * 6 }; },
        fillText(text, x, y) { calls.push({ op: 'fillText', text, x, y }); },
    };

    const canvas = {
        width: width,
        height: height,
        clientWidth: width,
        clientHeight: height,
        getBoundingClientRect: () => ({ width, height, top: 0, left: 0, bottom: height, right: width }),
        getContext: (type) => ctx,
        parentElement: null,
    };

    return { canvas, ctx };
}

// Setup globals if not present
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        devicePixelRatio: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
    };
}

console.log('=== STARTING ADVERSARIAL CHALLENGER M3.2 TESTS ===');

// ============================================================================
// 1. MATHEMATICAL VERIFICATION OF CANVAS TRANSFORMATIONS
// ============================================================================
console.log('\n--- 1. Coordinate Geometry & Affine Transform ---');

{
    const { canvas, ctx } = createMockCanvas(800, 450);
    const cfc = new CombineFieldCanvas(canvas, { padding: 36, minSpan: 10.0, marginRatio: 0.10 });

    // Test yardToPixel and pixelToYard bijection
    cfc.bounds = { minX: 10, maxX: 60, minY: 5, maxY: 45, spanX: 50, spanY: 40 };
    cfc.computeTransform();

    // Verify forward transform formula matches test_f9
    const testPoints = [
        { x: 10, y: 5 },
        { x: 35, y: 25 },
        { x: 60, y: 45 },
        { x: -5, y: -2 },
        { x: 100, y: 50 }
    ];

    for (const pt of testPoints) {
        const pix = cfc.yardToPixel(pt.x, pt.y);
        const expectedPx = cfc.transform.offsetX + (pt.x - cfc.bounds.minX) * cfc.transform.scale;
        const expectedPy = (cfc.transform.cssHeight - cfc.transform.offsetY) - (pt.y - cfc.bounds.minY) * cfc.transform.scale;
        assert(approx(pix.px, expectedPx), `Forward X transform mismatch for (${pt.x}, ${pt.y})`);
        assert(approx(pix.py, expectedPy), `Forward Y transform mismatch for (${pt.x}, ${pt.y})`);

        // Test exact inverse mapping: pixelToYard(yardToPixel(x, y)) == (x, y)
        const unmapped = cfc.pixelToYard(pix.px, pix.py);
        assert(approx(unmapped.x, pt.x, 1e-4), `Inverse X transform failed for (${pt.x}, ${pt.y})`);
        assert(approx(unmapped.y, pt.y, 1e-4), `Inverse Y transform failed for (${pt.x}, ${pt.y})`);
    }

    // Verify higher yard Y has lower pixel Y (screen Y points down)
    const pLowY = cfc.yardToPixel(20, 10);
    const pHighY = cfc.yardToPixel(20, 30);
    assert(pHighY.py < pLowY.py, `Higher yard Y must produce lower pixel Y (inverted Y axis)`);
}

// Bounding Box Edge Cases
console.log('\n--- 1b. Bounding Box Stress & Safeguards ---');

{
    const { canvas } = createMockCanvas();
    const cfc = new CombineFieldCanvas(canvas, { minSpan: 10.0, marginRatio: 0.10 });

    // Edge Case 1: Empty arrays
    const bEmpty = cfc.computeBoundingBox([], []);
    assert(bEmpty.minX === 0 && bEmpty.maxX === 120, 'Empty bounding box defaults to standard field minX/maxX');
    assert(bEmpty.minY === 0 && approx(bEmpty.maxY, 53.33333), 'Empty bounding box defaults to standard field minY/maxY');
    assert(bEmpty.spanX === 120 && approx(bEmpty.spanY, 53.33333), 'Empty span matches field dimensions');

    // Edge Case 2: Single point trajectory (0-span on both axes)
    const singlePoint = [{ x: 30.0, y: 20.0 }];
    const bSingle = cfc.computeBoundingBox(singlePoint, []);
    assert(bSingle.spanX >= 10.0, `Single-point X span ${bSingle.spanX} must be >= minSpan (10.0)`);
    assert(bSingle.spanY >= 10.0, `Single-point Y span ${bSingle.spanY} must be >= minSpan (10.0)`);
    assert(!isNaN(bSingle.minX) && isFinite(bSingle.minX), 'Single-point minX is finite');
    assert(!isNaN(bSingle.spanX) && bSingle.spanX > 0, 'Single-point spanX is strictly positive');

    // Edge Case 3: 40-yard dash narrow line (delta_x = 40.0, delta_y = 0.4)
    const dash40 = [];
    for (let i = 0; i <= 40; i++) {
        dash40.push({ x: 10.0 + i, y: 25.0 + 0.01 * i, s: 8.0, dir: 90.0 });
    }
    const bDash = cfc.computeBoundingBox(dash40, []);
    assert(bDash.spanX >= 40.0, '40-yd dash spanX >= 40');
    assert(bDash.spanY >= 10.0, `40-yd dash spanY ${bDash.spanY} must be protected by minSpan (>= 10.0)`);

    // Verify it doesn't collapse into a 1-pixel flatline
    cfc.bounds = bDash;
    cfc.computeTransform();
    assert(cfc.transform.scale > 0 && isFinite(cfc.transform.scale), 'Scale is positive and finite');
    const yPixelHeight = bDash.spanY * cfc.transform.scale;
    assert(yPixelHeight > 50, `Y-pixel height ${yPixelHeight}px must prevent flatline collapse (> 50px)`);

    // Edge Case 4: Extreme route drills (delta_x >= 50, delta_y >= 35)
    const routeDrill = [
        { x: 15.0, y: 5.0, s: 4.0 },
        { x: 70.0, y: 45.0, s: 9.5 }
    ];
    const bRoute = cfc.computeBoundingBox(routeDrill, []);
    assert(bRoute.spanX > 55.0, 'Extreme route spanX > 55');
    assert(bRoute.spanY > 40.0, 'Extreme route spanY > 40');
    cfc.bounds = bRoute;
    cfc.computeTransform();
    assert(cfc.transform.scale > 0 && isFinite(cfc.transform.scale), 'Extreme route scale is valid');
}

// ============================================================================
// 2. MOTION DIRECTION VECTOR & COMPASS ORIENTATION
// ============================================================================
console.log('\n--- 2. Motion Direction & Compass Orientation ---');

{
    const { canvas, ctx } = createMockCanvas();
    const cfc = new CombineFieldCanvas(canvas);

    // Cardinal compass tests (0, 90, 180, 270 degrees)
    const compassChecks = [
        { dir: 0,   name: 'North (+Y)',   expDx: 0, expDy: 1 },
        { dir: 90,  name: 'East (+X)',    expDx: 1, expDy: 0 },
        { dir: 180, name: 'South (-Y)',  expDx: 0, expDy: -1 },
        { dir: 270, name: 'West (-X)',   expDx: -1, expDy: 0 },
        { dir: 45,  name: 'Northeast',   expDx: Math.SQRT1_2, expDy: Math.SQRT1_2 },
        { dir: 135, name: 'Southeast',   expDx: Math.SQRT1_2, expDy: -Math.SQRT1_2 },
        { dir: 225, name: 'Southwest',   expDx: -Math.SQRT1_2, expDy: -Math.SQRT1_2 },
        { dir: 315, name: 'Northwest',   expDx: -Math.SQRT1_2, expDy: Math.SQRT1_2 },
    ];

    const x0 = 50.0, y0 = 25.0;
    const speed = 5.0;
    const expectedLen = speed * 0.8; // 4.0 yards

    for (const tc of compassChecks) {
        const rad = (tc.dir * Math.PI) / 180.0;
        const tipX = x0 + expectedLen * Math.sin(rad);
        const tipY = y0 + expectedLen * Math.cos(rad);

        const dx = tipX - x0;
        const dy = tipY - y0;
        const computedLen = Math.hypot(dx, dy);

        assert(approx(computedLen, expectedLen), `${tc.name}: Arrow length ${computedLen} must equal s*0.8 (${expectedLen})`);
        assert(approx(dx / expectedLen, tc.expDx, 1e-4), `${tc.name}: Normalized dx ${dx/expectedLen} mismatch`);
        assert(approx(dy / expectedLen, tc.expDy, 1e-4), `${tc.name}: Normalized dy ${dy/expectedLen} mismatch`);
    }

    // Speed threshold hiding test: s <= 0.15 yd/s hides the arrow
    ctx.calls.length = 0;
    cfc.drawActivePlayer(ctx, { x: 50, y: 25, s: 0.10, dir: 90 }, 10.0);
    const arrowDrawnSlow = ctx.calls.some(c => c.op === 'moveTo' && c.x === 50 && c.y === 25 && ctx.calls.some(c2 => c2.op === 'lineTo'));
    // Specifically check that stroke with cyan #00f0ff did not happen
    assert(!ctx.calls.some(c => c.op === 'stroke' && ctx.strokeStyle === '#00f0ff'), 's = 0.10 must NOT draw direction arrow');

    ctx.calls.length = 0;
    cfc.drawActivePlayer(ctx, { x: 50, y: 25, s: 0.15, dir: 90 }, 10.0);
    assert(!ctx.calls.some(c => c.op === 'stroke' && ctx.strokeStyle === '#00f0ff'), 's = 0.15 boundary must NOT draw direction arrow');

    ctx.calls.length = 0;
    cfc.drawActivePlayer(ctx, { x: 50, y: 25, s: 0.20, dir: 90 }, 10.0);
    // At s = 0.20, arrow must be stroked
    const hasArrowStroke = ctx.calls.some(c => c.op === 'stroke');
    assert(hasArrowStroke, 's = 0.20 MUST draw direction arrow');

    // Null/undefined player/speed handling
    ctx.calls.length = 0;
    cfc.drawActivePlayer(ctx, null, 10.0);
    assert(ctx.calls.length === 0, 'null player draws nothing');

    ctx.calls.length = 0;
    cfc.drawActivePlayer(ctx, { x: 50, y: 25, s: null, dir: null }, 10.0);
    assert(!ctx.calls.some(c => c.op === 'stroke' && ctx.strokeStyle === '#00f0ff'), 'null speed does not draw arrow');
}

// ============================================================================
// 3. DASHED BALL TRAJECTORY SEPARATION
// ============================================================================
console.log('\n--- 3. Dashed Ball Trajectory Separation ---');

{
    const { canvas, ctx } = createMockCanvas();
    const cfc = new CombineFieldCanvas(canvas);
    const scale = 8.0;

    const ballFrames = [
        { x: 20.0, y: 25.0 },
        { x: 30.0, y: 28.0 },
        { x: 40.0, y: 30.0 },
    ];

    ctx.calls.length = 0;
    cfc.drawBallTrajectory(ctx, ballFrames, 1, scale);

    // Verify setLineDash([6 / scale, 6 / scale])
    const dashSet = ctx.calls.find(c => c.op === 'setLineDash' && c.dash.length === 2);
    assert(dashSet !== undefined, 'setLineDash was called for ball trajectory');
    assert(approx(dashSet.dash[0], 6 / scale), `Ball dash segment length must be 6 / scale (${6/scale})`);
    assert(approx(dashSet.dash[1], 6 / scale), `Ball dash gap length must be 6 / scale (${6/scale})`);

    // Verify mandatory reset setLineDash([])
    const dashReset = ctx.calls.find(c => c.op === 'setLineDash' && c.dash.length === 0);
    assert(dashReset !== undefined, 'MANDATORY reset setLineDash([]) must be called');

    // Drills without ball data (empty array / null / undefined / 1 frame)
    ctx.calls.length = 0;
    cfc.drawBallTrajectory(ctx, [], 0, scale);
    assert(ctx.calls.length === 0, 'Empty ball frames draw nothing');

    ctx.calls.length = 0;
    cfc.drawBallTrajectory(ctx, null, 0, scale);
    assert(ctx.calls.length === 0, 'Null ball frames draw nothing');

    ctx.calls.length = 0;
    cfc.drawBallTrajectory(ctx, [{ x: 20, y: 25 }], 0, scale);
    assert(ctx.calls.length === 0, 'Single ball frame (< 2) draws nothing');
}

// ============================================================================
// 4. 10 HZ PLAYBACK TIMING & INVARIANTS
// ============================================================================
console.log('\n--- 4. 10 Hz Playback Timing & Invariants ---');

{
    const engine = new PlaybackEngine();

    // 1. Frame interval rates
    engine.setPlaybackRate(1.0);
    assert(engine.playbackRate === 1.0, 'Playback rate set to 1.0x');
    assert(approx(100.0 / engine.playbackRate, 100.0), '1.0x rate = 100ms interval');

    engine.setPlaybackRate(0.5);
    assert(engine.playbackRate === 0.5, 'Playback rate set to 0.5x');
    assert(approx(100.0 / engine.playbackRate, 200.0), '0.5x rate = 200ms interval');

    engine.setPlaybackRate(2.0);
    assert(engine.playbackRate === 2.0, 'Playback rate set to 2.0x');
    assert(approx(100.0 / engine.playbackRate, 50.0), '2.0x rate = 50ms interval');

    // Invalid rate rejection
    engine.setPlaybackRate(3.5);
    assert(engine.playbackRate === 2.0, 'Invalid playback rate 3.5 rejected, remains 2.0');

    // 2. Boundary clamping: [0, N - 1]
    const testFrames = new Array(50).fill(0).map((_, i) => ({ frameId: i, s: 5.0 }));
    engine.loadFrames(testFrames);
    assert(engine.totalFrames === 50, 'Loaded 50 frames');
    assert(engine.currentFrameIdx === 0, 'Initial index is 0');

    engine.seek(-10);
    assert(engine.currentFrameIdx === 0, 'Clamped negative seek to 0');

    engine.seek(100);
    assert(engine.currentFrameIdx === 49, 'Clamped excessive seek to totalFrames - 1 (49)');

    engine.seek(25.3);
    assert(engine.currentFrameIdx === 25, 'Rounded seek to integer frame 25');

    // Step forward & backward
    engine.stepForward();
    assert(engine.currentFrameIdx === 26, 'Step forward incremented index to 26');

    engine.stepBackward();
    assert(engine.currentFrameIdx === 25, 'Step backward decremented index to 25');

    // Step backward at 0 clamps at 0
    engine.seek(0);
    engine.stepBackward();
    assert(engine.currentFrameIdx === 0, 'Step backward at index 0 stays at 0');

    // Step forward at N-1 clamps at N-1
    engine.seek(49);
    engine.stepForward();
    assert(engine.currentFrameIdx === 49, 'Step forward at index 49 stays at 49');
}

// ============================================================================
// 5. COLORMAP BOUNDARY CONDITIONS
// ============================================================================
console.log('\n--- 5. Colormap Boundary Conditions ---');

{
    const { canvas } = createMockCanvas();
    const cfc = new CombineFieldCanvas(canvas);
    cfc.maxSpeed = 10.0;

    // Boundary speeds
    const cZero = cfc.getSpeedColor(0.0);
    assert(cZero === 'rgb(6, 182, 212)', `Speed 0.0 color is #06b6d4 (${cZero})`);

    const cMax = cfc.getSpeedColor(10.0);
    assert(cMax === 'rgb(239, 68, 68)', `Speed 10.0 color is #ef4444 (${cMax})`);

    const cAbove = cfc.getSpeedColor(15.0);
    assert(cAbove === 'rgb(239, 68, 68)', `Speed 15.0 (> maxSpeed) clamps to #ef4444 (${cAbove})`);

    const cNeg = cfc.getSpeedColor(-5.0);
    assert(cNeg === 'rgb(6, 182, 212)', `Speed -5.0 (< 0) clamps to #06b6d4 (${cNeg})`);

    const cNull = cfc.getSpeedColor(null);
    assert(cNull === 'rgb(6, 182, 212)', `Speed null defaults to #06b6d4 (${cNull})`);

    const cNaN = cfc.getSpeedColor(NaN);
    assert(cNaN === 'rgb(6, 182, 212)', `Speed NaN defaults to #06b6d4 (${cNaN})`);

    // Continuous sweep across colormap: RGB deltas between consecutive 0.01 steps must be small (<= 15)
    let prevRgb = [6, 182, 212];
    for (let s = 0.05; s <= 10.0; s += 0.05) {
        const colStr = cfc.getSpeedColor(s);
        const match = colStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        assert(match !== null, `Valid rgb format for s=${s}`);
        const currRgb = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];

        const dR = Math.abs(currRgb[0] - prevRgb[0]);
        const dG = Math.abs(currRgb[1] - prevRgb[1]);
        const dB = Math.abs(currRgb[2] - prevRgb[2]);
        assert(dR <= 20 && dG <= 20 && dB <= 20, `Discontinuity detected at s=${s}: dR=${dR}, dG=${dG}, dB=${dB}`);
        prevRgb = currRgb;
    }
}

console.log(`\n=== ALL CHECKS PASSED: ${passed} passed, ${failed} failed ===`);
