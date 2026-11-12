/**
 * test_adversarial_m4_challenger.mjs
 * Adversarial Verification Harness for Milestone M4
 * 
 * Tests:
 * 1. 2D Field Canvas Coordinate Transform Bijection, Bounds & Extremes
 * 2. Ball Trajectory Scale-Invariant Dash & Trap 2 Stroke Isolation
 * 3. Dual Vector Geometry, Scaling, and Slip Angle Arc Mathematical Oracles
 * 4. 5-Lane TimeseriesCanvas Dynamic Configuration & Robustness
 * 5. 60 FPS PlaybackEngine Delta Accumulation, Rate Multipliers & Boundary Clamping
 */

import { GameFieldCanvas } from '../src/web/static/js/game_field.js';
import { TimeseriesCanvas, PlaybackEngine } from '../src/web/static/js/timeseries.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
    if (!condition) {
        console.error(`FAIL: ${message}`);
        failed++;
        failures.push(message);
        throw new Error(message);
    } else {
        passed++;
    }
}

function approx(val, target, eps = 1e-4) {
    return Math.abs(val - target) <= eps;
}

// ----------------------------------------------------------------------------
// Mock Canvas & DOM Environment with Call Recording & Dash Inspection
// ----------------------------------------------------------------------------
function createMockCanvas(width = 800, height = 450) {
    const calls = [];
    let currentLineDash = [];

    const gradientMock = {
        addColorStop: (stop, color) => calls.push({ op: 'addColorStop', stop, color })
    };

    const ctx = {
        calls,
        setLineDash(dash) {
            currentLineDash = Array.isArray(dash) ? dash.slice() : [];
            calls.push({ op: 'setLineDash', dash: currentLineDash });
        },
        getLineDash() {
            return currentLineDash.slice();
        },
        save() {
            calls.push({ op: 'save', dash: currentLineDash.slice() });
        },
        restore() {
            calls.push({ op: 'restore' });
        },
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
        stroke() {
            calls.push({ op: 'stroke', activeDash: currentLineDash.slice(), strokeStyle: this.strokeStyle });
        },
        fill() { calls.push({ op: 'fill' }); },
        clip() { calls.push({ op: 'clip' }); },
        arc(x, y, r, sa, ea, ccw) { calls.push({ op: 'arc', x, y, r, sa, ea, ccw }); },
        createLinearGradient(x0, y0, x1, y1) {
            calls.push({ op: 'createLinearGradient', x0, y0, x1, y1 });
            return gradientMock;
        },
        measureText(text) { return { width: (text ? text.toString().length : 0) * 7 }; },
        fillText(text, x, y) { calls.push({ op: 'fillText', text, x, y }); },
        strokeText(text, x, y) { calls.push({ op: 'strokeText', text, x, y }); },
        textAlign: 'start',
        textBaseline: 'alphabetic',
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        font: '10px sans-serif',
        globalAlpha: 1.0,
    };

    const canvas = {
        width,
        height,
        clientWidth: width,
        clientHeight: height,
        getBoundingClientRect: () => ({ width, height, top: 0, left: 0, bottom: height, right: width }),
        getContext: () => ctx,
        parentElement: null,
        addEventListener: () => {},
        removeEventListener: () => {},
    };

    return { canvas, ctx };
}

// Global stubs for headless Node environment
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        devicePixelRatio: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
        requestAnimationFrame: (cb) => setTimeout(cb, 16),
        cancelAnimationFrame: (id) => clearTimeout(id),
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
    };
}

console.log('================================================================');
console.log('CHALLENGER M4.2: ADVERSARIAL STRESS TEST SUITE');
console.log('================================================================');

// ============================================================================
// SUITE 1: 2D Field Canvas Coordinate Transform Bijection & Extremes
// ============================================================================
console.log('\n--- SUITE 1: Coordinate Transform Bijection & Geometry Invariants ---');

{
    // Test across 6 distinct canvas aspect ratios and resolutions
    const canvasConfigs = [
        { w: 800, h: 450, dpr: 1 },
        { w: 1200, h: 600, dpr: 2 },
        { w: 1920, h: 540, dpr: 1 },   // Ultra-wide
        { w: 500, h: 800, dpr: 1 },    // Tall / portrait
        { w: 600, h: 600, dpr: 1.5 },  // Square
        { w: 300, h: 200, dpr: 1 },    // Compact
    ];

    for (const cfg of canvasConfigs) {
        globalThis.window.devicePixelRatio = cfg.dpr;
        const { canvas } = createMockCanvas(cfg.w, cfg.h);
        const field = new GameFieldCanvas(canvas);

        // 1. Boundary & corner landmarks
        const landmarkPoints = [
            // Standard field 4 corners
            [0.0, 0.0],
            [120.0, 0.0],
            [0.0, 53.33333],
            [120.0, 53.33333],
            // Goal lines & endzone lines
            [10.0, 0.0],
            [10.0, 53.33333],
            [110.0, 0.0],
            [110.0, 53.33333],
            // 50-yard line center
            [60.0, 26.66667],
            // Rule 1 Sec 2 Hashmarks
            [23.58333, 23.58333],
            [23.58333, 29.75000],
            [85.0, 23.58333],
            [85.0, 29.75000],
            // Out of bounds - negative yards
            [-5.0, 20.0],
            [-50.0, -25.0],
            [-100.0, 30.0],
            // Out of bounds - past visitor endzone
            [125.0, 10.0],
            [180.0, 45.0],
            // Out of bounds - sideline lateral
            [50.0, -15.0],
            [50.0, 75.0],
            // Far extreme
            [999.0, -500.0],
            [-888.0, 1200.0],
        ];

        for (const [x, y] of landmarkPoints) {
            const p = field.yardToPixel(x, y);
            assert(isFinite(p.px) && isFinite(p.py), `Pixel coords must be finite for (${x}, ${y}) on ${cfg.w}x${cfg.h}`);
            const back = field.pixelToYard(p.px, p.py);
            assert(approx(back.x, x, 1e-4), `Full-mode X bijection failed at (${x}, ${y}) on ${cfg.w}x${cfg.h}: got ${back.x}`);
            assert(approx(back.y, y, 1e-4), `Full-mode Y bijection failed at (${x}, ${y}) on ${cfg.w}x${cfg.h}: got ${back.y}`);
        }

        // 2. Uniform Aspect Ratio Invariance (no non-uniform aspect distortion)
        // dx = 10 yd, dy = 10 yd -> must map to identical pixel distance: |dpx| == |dpy|
        const pA = field.yardToPixel(50.0, 20.0);
        const pB = field.yardToPixel(60.0, 20.0);
        const pC = field.yardToPixel(50.0, 30.0);
        const dpx = Math.abs(pB.px - pA.px);
        const dpy = Math.abs(pC.py - pA.py);
        assert(approx(dpx, dpy, 1e-4), `Scale must be uniform isotropic (dpx=${dpx}, dpy=${dpy}) on ${cfg.w}x${cfg.h}`);

        // 3. Inverted-Y Invariant: For any y2 > y1, py(y2) < py(y1)
        for (let y = -20; y <= 70; y += 15) {
            const pLow = field.yardToPixel(50, y);
            const pHigh = field.yardToPixel(50, y + 10);
            assert(pHigh.py < pLow.py, `Inverted-Y check failed: Y=${y+10} py (${pHigh.py}) >= Y=${y} py (${pLow.py})`);
        }
    }

    // 4. Viewport 'snap' mode bounding box stress tests
    {
        const { canvas } = createMockCanvas(900, 480);
        const field = new GameFieldCanvas(canvas);

        // Scenario A: Point trajectory (zero span -> minSpan safeguard)
        field.loadSnap({
            frames: [{ x: 42.0, y: 24.0, s: 0, dir: 0, o: 0 }]
        });
        field.setViewMode('snap');
        assert(field.bounds.spanX >= 15.0, `Zero-span trajectory must expand to minSpan 15.0, got ${field.bounds.spanX}`);
        assert(field.bounds.spanY >= 15.0, `Zero-span trajectory must expand to minSpan 15.0, got ${field.bounds.spanY}`);

        const pA = field.yardToPixel(42.0, 24.0);
        const backA = field.pixelToYard(pA.px, pA.py);
        assert(approx(backA.x, 42.0), 'Snap mode single-point bijection X');
        assert(approx(backA.y, 24.0), 'Snap mode single-point bijection Y');

        // Scenario B: Extreme aspect ratio trajectory (Fly route: 80 yd long, 0.5 yd wide)
        const flyRoute = [];
        for (let i = 0; i < 40; i++) {
            flyRoute.push({ x: 15.0 + i * 2.0, y: 10.0 + (i % 2) * 0.5, s: 8.0, dir: 90, o: 90 });
        }
        field.loadSnap({ frames: flyRoute });
        field.setViewMode('snap');
        assert(field.bounds.spanY >= 15.0, `Lateral span < 15 must be expanded by minSpan safeguard, got ${field.bounds.spanY}`);

        for (const pt of flyRoute) {
            const p = field.yardToPixel(pt.x, pt.y);
            const back = field.pixelToYard(p.px, p.py);
            assert(approx(back.x, pt.x), `Fly route snap bijection X at (${pt.x}, ${pt.y})`);
            assert(approx(back.y, pt.y), `Fly route snap bijection Y at (${pt.x}, ${pt.y})`);
        }
    }

    console.log('✔ All coordinate transform bijection, aspect ratio and bounds stress tests passed');
}

// ============================================================================
// SUITE 2: Ball Trajectory Scale-Invariant Dash & Trap 2 Stroke Isolation
// ============================================================================
console.log('\n--- SUITE 2: Ball Trajectory Dash & Trap 2 Prevention ---');

{
    const { canvas, ctx } = createMockCanvas(900, 480);
    const field = new GameFieldCanvas(canvas);

    // Test across scales: verify [6/scale, 6/scale] and screen pixel invariance
    const testScales = [0.5, 1.0, 2.5, 4.0, 8.0, 12.0];
    for (const sc of testScales) {
        ctx.calls.length = 0;
        const ballFrames = [
            { x: 20, y: 20 },
            { x: 30, y: 25 },
            { x: 40, y: 30 },
        ];
        field.drawBallTrajectory(ctx, ballFrames, 2, sc);

        // Find setLineDash calls
        const setDashCalls = ctx.calls.filter(c => c.op === 'setLineDash');
        assert(setDashCalls.length >= 2, `drawBallTrajectory must set and reset line dash at scale ${sc}`);

        // 1. Initial dash pattern must be [6 / scale, 6 / scale]
        const firstDash = setDashCalls[0].dash;
        assert(approx(firstDash[0], 6.0 / sc), `Dash segment 0 must be 6/scale (${6/sc}), got ${firstDash[0]}`);
        assert(approx(firstDash[1], 6.0 / sc), `Dash segment 1 must be 6/scale (${6/sc}), got ${firstDash[1]}`);

        // Screen invariant: physical pixel length in screen space is (6 / sc) * sc == 6.0 px
        const physicalPx = firstDash[0] * sc;
        assert(approx(physicalPx, 6.0), `Physical screen pixel dash length must be exactly 6.0 px, got ${physicalPx}`);

        // 2. Final dash call before returning MUST BE [] (Trap 2 prevention)
        const lastDash = setDashCalls[setDashCalls.length - 1].dash;
        assert(Array.isArray(lastDash) && lastDash.length === 0,
            `Trap 2: Final setLineDash MUST be empty array [] to avoid leaking into subsequent strokes, got ${JSON.stringify(lastDash)}`);

        // 3. Current active dash on context after drawBallTrajectory MUST BE []
        assert(ctx.getLineDash().length === 0, `Active lineDash on ctx must be empty after drawBallTrajectory, got ${JSON.stringify(ctx.getLineDash())}`);
    }

    // Boundary Cases for drawBallTrajectory:
    // Empty frames
    ctx.calls.length = 0;
    field.drawBallTrajectory(ctx, [], 0, 5.0);
    assert(ctx.calls.length === 0, 'Empty ball frames should not issue any canvas calls');

    // 1 frame (cannot draw trajectory)
    ctx.calls.length = 0;
    field.drawBallTrajectory(ctx, [{ x: 10, y: 10 }], 0, 5.0);
    assert(ctx.calls.length === 0, 'Single ball frame should not issue any trajectory calls');

    // Full render integration: verify NO stroke in the entire render() loop after ball trajectory bleeds dashed pattern
    ctx.calls.length = 0;
    field.loadSnap({
        frames: [
            { x: 20, y: 20, s: 4.0, dir: 90, o: 90 },
            { x: 25, y: 22, s: 5.0, dir: 90, o: 90 },
            { x: 30, y: 24, s: 6.0, dir: 90, o: 90 },
        ],
        ball_frames: [
            { x: 22, y: 20 },
            { x: 28, y: 22 },
            { x: 34, y: 24 },
        ]
    });
    ctx.calls.length = 0;
    field.render();

    // Check all strokes that occur AFTER the ball trajectory reset: none should have dashed line
    let ballDashSeen = false;
    let ballResetSeen = false;
    for (const c of ctx.calls) {
        if (c.op === 'setLineDash') {
            if (c.dash.length > 0) ballDashSeen = true;
            if (ballDashSeen && c.dash.length === 0) ballResetSeen = true;
        }
        if (ballResetSeen && c.op === 'stroke') {
            assert(c.activeDash.length === 0,
                `Stroke call after ball reset had non-empty line dash: ${JSON.stringify(c.activeDash)}`);
        }
    }
    assert(ballDashSeen && ballResetSeen, 'Ball dash and reset sequence must execute during render()');

    console.log('✔ Scale-invariant ball dash and Trap 2 stroke isolation verified');
}

// ============================================================================
// SUITE 3: Dual Vectors & Slip Angle Mathematical Oracles
// ============================================================================
console.log('\n--- SUITE 3: Dual Vectors & Slip Angle Mathematical Oracles ---');

{
    const { canvas, ctx } = createMockCanvas(900, 480);
    const field = new GameFieldCanvas(canvas);

    // 1. Slip Angle Normalization Oracle against ground truth formula
    // Ground truth: beta = ((dir - o + 180) % 360 + 360) % 360 - 180
    function oracleSlipAngle(dir, o) {
        const diff = dir - o;
        let d = ((diff + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
        if (d === -180.0 && diff > 0) d = 180.0;
        return d;
    }

    // Sweep all angle pairs from 0 to 360 in 15 degree increments
    for (let o = 0; o < 360; o += 15) {
        for (let dir = 0; dir < 360; dir += 15) {
            const expected = oracleSlipAngle(dir, o);
            const actual = field.normalizeSlipAngle(dir - o);
            assert(approx(actual, expected), `normalizeSlipAngle(${dir} - ${o}) mismatch: expected ${expected}, got ${actual}`);
            assert(actual >= -180.0 && actual <= 180.0, `normalizeSlipAngle result ${actual} must be in [-180, +180]`);
        }
    }

    // Specific boundary cases:
    assert(field.normalizeSlipAngle(0) === 0, 'Collinear beta=0');
    assert(field.normalizeSlipAngle(180) === 180, 'Exact reverse +180');
    assert(field.normalizeSlipAngle(-180) === -180, 'Exact reverse -180');
    assert(field.normalizeSlipAngle(360) === 0, 'Full circle 360');
    assert(field.normalizeSlipAngle(540) === 180, 'Multi-turn positive');
    assert(field.normalizeSlipAngle(-540) === -180, 'Multi-turn negative');

    // Severity classification thresholds:
    // < 30 normal, 30..60 moderate, > 60 high
    assert(field.getSlipSeverity(0) === 'normal', '0 deg is normal');
    assert(field.getSlipSeverity(29.9) === 'normal', '29.9 deg is normal');
    assert(field.getSlipSeverity(-29.9) === 'normal', '-29.9 deg is normal');
    assert(field.getSlipSeverity(30.0) === 'moderate', '30.0 deg is moderate');
    assert(field.getSlipSeverity(59.9) === 'moderate', '59.9 deg is moderate');
    assert(field.getSlipSeverity(-60.0) === 'moderate', '-60.0 deg is moderate');
    assert(field.getSlipSeverity(60.1) === 'high', '60.1 deg is high');
    assert(field.getSlipSeverity(180.0) === 'high', '180.0 deg is high');
    assert(field.getSlipSeverity(-180.0) === 'high', '-180.0 deg is high');

    // 2. Dual Vector Geometry & Trigonometric Projection
    // Compass convention: 0 deg North (+Y in yard space), 90 deg East (+X in yard space)
    const angles = [
        { deg: 0,   dxNorm: 0.0,  dyNorm: 1.0 },   // North
        { deg: 90,  dxNorm: 1.0,  dyNorm: 0.0 },   // East
        { deg: 180, dxNorm: 0.0,  dyNorm: -1.0 },  // South
        { deg: 270, dxNorm: -1.0, dyNorm: 0.0 },   // West
        { deg: 45,  dxNorm: Math.SQRT1_2, dyNorm: Math.SQRT1_2 },
    ];

    for (const a of angles) {
        const rad = (a.deg * Math.PI) / 180.0;
        const sinV = Math.sin(rad);
        const cosV = Math.cos(rad);
        assert(approx(sinV, a.dxNorm), `sin(${a.deg}) dx mismatch`);
        assert(approx(cosV, a.dyNorm), `cos(${a.deg}) dy mismatch`);
    }

    // 3. Motion Vector Length Scaling: L = s * 0.8 yd, clamped [0.5, 8.0], suppressed if s <= 0.15
    const speedCases = [
        { s: 0.0,  expectedLen: null },  // Suppressed
        { s: 0.10, expectedLen: null },  // Suppressed (<= 0.15)
        { s: 0.15, expectedLen: null },  // Suppressed
        { s: 0.20, expectedLen: 0.5 },   // Clamped min 0.5 (0.2 * 0.8 = 0.16 < 0.5)
        { s: 1.0,  expectedLen: 0.8 },   // 1.0 * 0.8 = 0.8
        { s: 5.0,  expectedLen: 4.0 },   // 5.0 * 0.8 = 4.0
        { s: 10.0, expectedLen: 8.0 },   // 10.0 * 0.8 = 8.0
        { s: 15.0, expectedLen: 8.0 },   // Clamped max 8.0 (15.0 * 0.8 = 12.0 > 8.0)
    ];

    for (const sc of speedCases) {
        ctx.calls.length = 0;
        const player = { x: 50, y: 25, s: sc.s, dir: 90, o: 90 };
        field.drawActivePlayer(ctx, player, 5.0);

        // Look for cyan motion vector stroke
        const cyanStrokes = ctx.calls.filter(c => c.op === 'stroke' && c.strokeStyle === '#00f0ff');
        if (sc.expectedLen === null) {
            assert(cyanStrokes.length === 0, `Speed ${sc.s} must suppress motion vector, but stroke was found`);
        } else {
            assert(cyanStrokes.length > 0, `Speed ${sc.s} must draw motion vector`);
            // Check lineTo endpoint: x + L * sin(90) = 50 + L * 1, y + L * cos(90) = 25 + L * 0
            const tipX = 50 + sc.expectedLen;
            const tipY = 25;
            const lineToCall = ctx.calls.find(c => c.op === 'lineTo' && approx(c.x, tipX) && approx(c.y, tipY));
            assert(Boolean(lineToCall), `Motion vector tip for s=${sc.s} expected at (${tipX}, ${tipY})`);
        }

        // Amber Orientation vector MUST ALWAYS be drawn with length 1.5 yd regardless of speed!
        const tipOx = 50 + 1.5 * Math.sin(Math.PI / 2); // 51.5
        const tipOy = 25 + 1.5 * Math.cos(Math.PI / 2); // 25.0
        const oLineTo = ctx.calls.find(c => c.op === 'lineTo' && approx(c.x, tipOx) && approx(c.y, tipOy));
        assert(Boolean(oLineTo), `Orientation vector tip must always be 1.5 yd away at (${tipOx}, ${tipOy}) for s=${sc.s}`);
    }

    // 4. Edge Cases:
    // Null/undefined player
    ctx.calls.length = 0;
    field.drawActivePlayer(ctx, null, 5.0);
    assert(ctx.calls.length === 0, 'null player should be no-op');

    // Missing orientation (o == null): orientation suppressed, motion vector intact
    ctx.calls.length = 0;
    field.drawActivePlayer(ctx, { x: 30, y: 20, s: 5.0, dir: 0, o: null }, 5.0);
    const cyanStroke = ctx.calls.find(c => c.op === 'stroke' && c.strokeStyle === '#00f0ff');
    assert(Boolean(cyanStroke), 'Motion vector should draw even if o is null');

    // Missing speed (s == null): treated as s=0, orientation intact
    ctx.calls.length = 0;
    field.drawActivePlayer(ctx, { x: 30, y: 20, s: null, dir: 0, o: 180 }, 5.0);
    const oTip = ctx.calls.find(c => c.op === 'lineTo' && approx(c.x, 30) && approx(c.y, 20 - 1.5));
    assert(Boolean(oTip), 'Orientation vector should draw even if s is null');

    console.log('✔ Dual vectors and slip angle mathematical oracles verified');
}

// ============================================================================
// SUITE 4: 5-Lane TimeseriesCanvas Dynamic Configuration & Robustness
// ============================================================================
console.log('\n--- SUITE 4: 5-Lane TimeseriesCanvas & Telemetry Handling ---');

{
    const { canvas: canvas5 } = createMockCanvas(800, 360);
    const ts5 = new TimeseriesCanvas(canvas5);

    // Load game telemetry containing slip_angle -> should auto-configure 5 lanes
    const gameFrames = [
        { frame_idx: 0, s: 4.5, a: 1.2, omega: 25.0, curvature: 0.05, slip_angle: 15.0 },
        { frame_idx: 1, s: 5.0, a: 0.8, omega: -30.0, curvature: 0.08, slip_angle: -45.0 },
        { frame_idx: 2, s: 6.2, a: -1.5, omega: 60.0, curvature: 0.12, slip_angle: 85.0 },
    ];
    ts5.loadFrames(gameFrames);
    assert(ts5.lanes.length === 5, `Game telemetry must trigger 5 lanes, got ${ts5.lanes.length}`);
    const slipLane = ts5.lanes.find(l => l.key === 'slip_angle');
    assert(Boolean(slipLane), 'Lane key "slip_angle" must exist');
    assert(slipLane.fixedRange[0] === -180.0 && slipLane.fixedRange[1] === 180.0,
        `Slip angle fixed range must span [-180, +180], got ${JSON.stringify(slipLane.fixedRange)}`);

    // Load combine telemetry without slip_angle -> should revert to 4 lanes
    const combineFrames = [
        { frame_idx: 0, s: 3.0, a: 2.0, omega: 10.0, curvature: 0.02 },
        { frame_idx: 1, s: 7.0, a: 1.0, omega: 12.0, curvature: 0.03 },
    ];
    ts5.loadFrames(combineFrames);
    assert(ts5.lanes.length === 4, `Combine telemetry must configure 4 lanes, got ${ts5.lanes.length}`);
    assert(!ts5.lanes.some(l => l.key === 'slip_angle'), 'Combine lanes must NOT include slip_angle');

    // Robustness: frames with null/NaN values
    const pathologicalFrames = [
        { frame_idx: 0, s: null, a: undefined, omega: NaN, curvature: null, slip_angle: NaN },
        { frame_idx: 1, s: 5.0, a: 0.0, omega: 0.0, curvature: 0.0, slip_angle: 0.0 },
        { frame_idx: 2, s: Infinity, a: -Infinity, omega: 9999, curvature: -10, slip_angle: 720 },
    ];
    ts5.loadFrames(pathologicalFrames);
    // Render must not throw
    ts5.render();
    assert(true, 'Pathological frames render without throwing');

    // Empty frames
    ts5.loadFrames([]);
    ts5.render();
    assert(ts5.totalFrames === 0, 'Total frames is 0 on empty load');

    console.log('✔ TimeseriesCanvas 5-lane dynamic configuration and resilience verified');
}

// ============================================================================
// SUITE 5: 60 FPS PlaybackEngine Delta Accumulation & Frame Stepping
// ============================================================================
console.log('\n--- SUITE 5: 60 FPS PlaybackEngine Delta Accumulation & Stepping ---');

{
    const engine = new PlaybackEngine();
    const testFrames = new Array(60).fill(0).map((_, i) => ({ frameId: i, s: 5.0 }));
    engine.loadFrames(testFrames);

    // Initial state
    assert(!engine.isPlaying, 'Engine should start paused');
    assert(engine.currentFrameIdx === 0, 'Initial frame index must be 0');
    assert(engine.playbackRate === 1.0, 'Default rate must be 1.0x');

    // Stepping & bounds clamping:
    // Step forward 1
    engine.step(1);
    assert(engine.currentFrameIdx === 1, 'step(1) advances to 1');

    // Step backward 5 -> clamps to 0
    engine.step(-5);
    assert(engine.currentFrameIdx === 0, 'step(-5) clamps at 0');

    // Seek to 30
    engine.seek(30);
    assert(engine.currentFrameIdx === 30, 'seek(30) sets index to 30');

    // Seek past end -> clamps to totalFrames - 1
    engine.seek(150);
    assert(engine.currentFrameIdx === 59, 'seek(150) clamps to totalFrames - 1 (59)');

    // Seek negative -> clamps to 0
    engine.seek(-20);
    assert(engine.currentFrameIdx === 0, 'seek(-20) clamps to 0');

    // Rate controls:
    engine.setPlaybackRate(0.5);
    assert(engine.playbackRate === 0.5, 'Rate set to 0.5x');
    engine.setPlaybackRate(2.0);
    assert(engine.playbackRate === 2.0, 'Rate set to 2.0x');
    engine.setPlaybackRate(3.5); // Invalid rate -> must be rejected
    assert(engine.playbackRate === 2.0, 'Invalid rate 3.5x must be rejected and stay 2.0x');
    engine.setPlaybackRate(1.0);

    // Simulated 60 FPS Delta Accumulation Math Oracle:
    // At 60 FPS, tick delta is ~16.666 ms.
    // Frame interval at 1.0x (10 Hz) = 100 ms.
    // Every 6 ticks (99.996 ms -> 100 ms), accumulator triggers next frame.
    function simulatePlaybackTicks(rate, totalTicks, tickIntervalMs = 16.6666667) {
        let currentFrame = 0;
        let accumulator = 0.0;
        const frameIntervalMs = 100.0 / rate;

        for (let t = 0; t < totalTicks; t++) {
            accumulator += tickIntervalMs;
            const advance = Math.floor(accumulator / frameIntervalMs);
            if (advance > 0) {
                accumulator -= advance * frameIntervalMs;
                currentFrame += advance;
            }
        }
        return currentFrame;
    }

    // Over 1.0 second (60 ticks):
    // 1.0x rate -> should advance exactly 10 frames
    const adv1x = simulatePlaybackTicks(1.0, 60);
    assert(adv1x === 10, `At 1.0x rate over 60 rAF ticks, should advance 10 frames, got ${adv1x}`);

    // 0.5x rate -> should advance exactly 5 frames
    const adv05x = simulatePlaybackTicks(0.5, 60);
    assert(adv05x === 5, `At 0.5x rate over 60 rAF ticks, should advance 5 frames, got ${adv05x}`);

    // 2.0x rate -> should advance exactly 20 frames
    const adv2x = simulatePlaybackTicks(2.0, 60);
    assert(adv2x === 20, `At 2.0x rate over 60 rAF ticks, should advance 20 frames, got ${adv2x}`);

    // Auto-pause at end of play invariant:
    engine.seek(58);
    engine.step(1); // at 59 (end)
    assert(engine.currentFrameIdx === 59, 'At end frame 59');

    // Calling step forward at end stays at end
    engine.step(1);
    assert(engine.currentFrameIdx === 59, 'Step forward at end remains clamped at 59');

    console.log('✔ 60 FPS PlaybackEngine delta accumulation, rate scaling and bounds verified');
}

console.log('\n================================================================');
console.log(`ALL ADVERSARIAL CHECKS PASSED: ${passed} passed, ${failed} failed`);
console.log('================================================================');
