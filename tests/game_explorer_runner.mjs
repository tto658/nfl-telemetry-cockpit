/**
 * Game Explorer Runner (M4 Verification)
 * Headless Node.js execution against src/web/static/js/game_field.js and timeseries.js
 */

import { GameFieldCanvas } from '../src/web/static/js/game_field.js';
import { TimeseriesCanvas, PlaybackEngine } from '../src/web/static/js/timeseries.js';

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

function approx(val, target, eps = 1e-4) {
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
        createLinearGradient(x0, y0, x1, y1) {
            calls.push({ op: 'createLinearGradient', x0, y0, x1, y1 });
            return gradientMock;
        },
        measureText(text) { return { width: (text ? text.toString().length : 0) * 6 }; },
        fillText(text, x, y) { calls.push({ op: 'fillText', text, x, y }); },
        strokeText(text, x, y) { calls.push({ op: 'strokeText', text, x, y }); },
        textAlign: 'start',
        textBaseline: 'alphabetic',
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        font: '10px sans-serif',
        globalAlpha: 1.0,
        setPointerCapture(id) {},
        releasePointerCapture(id) {},
    };

    const canvas = {
        width: width,
        height: height,
        clientWidth: width,
        clientHeight: height,
        getBoundingClientRect: () => ({ width, height, top: 0, left: 0, bottom: height, right: width }),
        getContext: () => ctx,
        parentElement: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        setPointerCapture: () => {},
        releasePointerCapture: () => {},
    };

    return { canvas, ctx };
}

// Global stubs
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

console.log('=== STARTING GAME EXPLORER RUNNER (M4) ===');

// ============================================================================
// 1. GAME FIELD CANVAS GEOMETRY & TRANSFORMS
// ============================================================================
{
    const { canvas, ctx } = createMockCanvas(900, 480);
    const field = new GameFieldCanvas(canvas);

    // Initial Full-Field Bounds Check
    const bounds = field.bounds;
    assert(bounds.minX <= 0, `bounds.minX (${bounds.minX}) must be <= 0`);
    assert(bounds.maxX >= 120, `bounds.maxX (${bounds.maxX}) must be >= 120`);
    assert(bounds.minY <= 0, `bounds.minY (${bounds.minY}) must be <= 0`);
    assert(bounds.maxY >= 53.33, `bounds.maxY (${bounds.maxY}) must be >= 53.33`);

    // Transform Bijection: pixelToYard(yardToPixel(x, y)) == (x, y)
    const testPoints = [
        [0, 0],
        [10, 5],
        [60, 26.6666],
        [110, 48],
        [120, 53.3333],
        [23.58, 29.75], // NFL hashmark lines
    ];

    for (const [x, y] of testPoints) {
        const p = field.yardToPixel(x, y);
        const un = field.pixelToYard(p.px, p.py);
        assert(approx(un.x, x), `yardToPixel/pixelToYard X bijection failed for (${x}, ${y}): got ${un.x}`);
        assert(approx(un.y, y), `yardToPixel/pixelToYard Y bijection failed for (${x}, ${y}): got ${un.y}`);
    }

    // Inverted-Y verification: higher yard Y maps to lower pixel Y
    const p1 = field.yardToPixel(50, 10);
    const p2 = field.yardToPixel(50, 40);
    assert(p2.py < p1.py, `Inverted-Y check failed: p2.py (${p2.py}) must be < p1.py (${p1.py})`);

    console.log('✔ Full-field geometry & transform bijection verified');
}

// ============================================================================
// 2. SLIP ANGLE NORMALIZATION & SEVERITY CLASSIFICATION
// ============================================================================
{
    const { canvas } = createMockCanvas();
    const field = new GameFieldCanvas(canvas);

    // normalizeSlipAngle tests
    assert(field.normalizeSlipAngle(0) === 0, 'normalizeSlipAngle(0) == 0');
    assert(field.normalizeSlipAngle(45) === 45, 'normalizeSlipAngle(45) == 45');
    assert(field.normalizeSlipAngle(-45) === -45, 'normalizeSlipAngle(-45) == -45');
    assert(field.normalizeSlipAngle(180) === 180, 'normalizeSlipAngle(180) == 180');
    assert(field.normalizeSlipAngle(-180) === -180, 'normalizeSlipAngle(-180) == -180');
    assert(field.normalizeSlipAngle(200) === -160, 'normalizeSlipAngle(200) == -160');
    assert(field.normalizeSlipAngle(-200) === 160, 'normalizeSlipAngle(-200) == 160');
    assert(field.normalizeSlipAngle(360) === 0, 'normalizeSlipAngle(360) == 0');
    assert(field.normalizeSlipAngle(350 - 10) === -20, 'normalizeSlipAngle(340) == -20');
    assert(field.normalizeSlipAngle(10 - 350) === 20, 'normalizeSlipAngle(-340) == 20');

    // getSlipSeverity tests
    assert(field.getSlipSeverity(10) === 'normal', 'Severity for 10° should be normal');
    assert(field.getSlipSeverity(-25) === 'normal', 'Severity for -25° should be normal');
    assert(field.getSlipSeverity(35) === 'moderate', 'Severity for 35° should be moderate');
    assert(field.getSlipSeverity(-55) === 'moderate', 'Severity for -55° should be moderate');
    assert(field.getSlipSeverity(75) === 'high', 'Severity for 75° should be high');
    assert(field.getSlipSeverity(-120) === 'high', 'Severity for -120° should be high');

    console.log('✔ Slip angle normalization and severity classification verified');
}

// ============================================================================
// 3. SNAP LOADING, VIEWPORT MODES & TRAP 2 LINE DASH RESET
// ============================================================================
{
    const { canvas, ctx } = createMockCanvas(900, 480);
    const field = new GameFieldCanvas(canvas);

    const mockFrames = [];
    const mockBall = [];
    for (let i = 0; i < 30; i++) {
        mockFrames.push({
            frame_idx: i,
            time: i * 0.1,
            x: 20 + i * 0.8,
            y: 25 + Math.sin(i * 0.2) * 5,
            s: 4.5 + Math.sin(i * 0.3) * 2,
            a: 1.2,
            dir: (90 + i * 2) % 360,
            o: (85 + i * 2.5) % 360,
            slip_angle: ((90 + i * 2) - (85 + i * 2.5)),
            event: i === 10 ? 'pass_arrived' : (i === 20 ? 'tackle' : null)
        });
        mockBall.push({
            frame_idx: i,
            x: 22 + i * 0.85,
            y: 26 + Math.sin(i * 0.2) * 4.8
        });
    }

    field.loadSnap({
        frames: mockFrames,
        ball_frames: mockBall,
        events: [
            { frame_idx: 10, event: 'pass_arrived' },
            { frame_idx: 20, event: 'tackle' }
        ]
    });

    assert(field.playerFrames.length === 30, 'Player frames loaded count');
    assert(field.ballFrames.length === 30, 'Ball frames loaded count');
    assert(field.events.length === 2, 'Events loaded count');

    // Render snap
    ctx.calls.length = 0;
    field.render();

    // Verify Trap 2: setLineDash([6 / scale, 6 / scale]) followed by setLineDash([])
    const dashCalls = ctx.calls.filter(c => c.op === 'setLineDash');
    assert(dashCalls.length > 0, 'Ball trail should setLineDash');
    const lastDash = dashCalls[dashCalls.length - 1];
    assert(Array.isArray(lastDash.dash) && lastDash.dash.length === 0,
        `Trap 2 invariant: last setLineDash must be [] to prevent dash bleed, got: ${JSON.stringify(lastDash.dash)}`);

    // Verify Viewport Mode Switching
    assert(field.getViewMode() === 'full', 'Default mode should be full');
    field.setViewMode('snap');
    assert(field.getViewMode() === 'snap', 'Mode should be snap after setViewMode');
    
    // Check snap bounds
    const snapBounds = field.bounds;
    assert(snapBounds.spanX < field.getFullFieldBounds().spanX,
        `Snap bounds spanX (${snapBounds.spanX}) should be tighter than full field (${field.getFullFieldBounds().spanX})`);

    // Bijection still holds under snap bounds
    for (let i = 0; i < 5; i++) {
        const pt = mockFrames[i];
        const p = field.yardToPixel(pt.x, pt.y);
        const un = field.pixelToYard(p.px, p.py);
        assert(approx(un.x, pt.x), `Snap bounds X bijection failed for (${pt.x}, ${pt.y})`);
        assert(approx(un.y, pt.y), `Snap bounds Y bijection failed for (${pt.x}, ${pt.y})`);
    }

    // Toggle view mode back to full
    field.toggleViewMode();
    assert(field.getViewMode() === 'full', 'Mode should toggle back to full');

    console.log('✔ Snap loading, Trap 2 dash reset & viewport switching verified');
}

// ============================================================================
// 4. TIMESERIES CANVAS 5-LANE & 4-LANE DYNAMIC CONFIGURATION
// ============================================================================
{
    // Test 5-lane configuration (Tab 2 Game Explorer)
    const { canvas: canvas5 } = createMockCanvas(900, 320);
    const ts5 = new TimeseriesCanvas(canvas5, {
        lanes: [
            { key: 's', label: 'SPEED', unit: 'yd/s', color: '#06b6d4', min: 0, max: 12 },
            { key: 'a', label: 'ACCEL', unit: 'yd/s²', color: '#10b981', min: -8, max: 8 },
            { key: 'omega', label: 'ANG VEL', unit: '°/s', color: '#f59e0b', min: -360, max: 360 },
            { key: 'kappa', label: 'CURVATURE', unit: 'rad/m', color: '#a855f7', min: 0, max: 1.5 },
            { key: 'slip_angle', label: 'SLIP ANGLE (β)', unit: '°', color: '#f43f5e', min: -180, max: 180 },
        ]
    });

    assert(ts5.lanes.length === 5, 'ts5 should have 5 configured lanes');
    assert(ts5.lanes[4].key === 'slip_angle', 'ts5 lane 4 should be slip_angle');

    const sampleFrames = [];
    for (let i = 0; i < 40; i++) {
        sampleFrames.push({
            frame_idx: i,
            time: i * 0.1,
            s: 4.0 + Math.sin(i * 0.2) * 2,
            a: Math.cos(i * 0.2) * 3,
            omega: Math.sin(i * 0.4) * 120,
            kappa: Math.abs(Math.sin(i * 0.1) * 0.8),
            slip_angle: Math.sin(i * 0.3) * 75,
            event: i === 15 ? 'cut' : null
        });
    }

    ts5.loadData(sampleFrames, [{ frame_idx: 15, event: 'cut' }]);
    assert(ts5.frames.length === 40, 'ts5 loaded 40 frames');
    ts5.render();

    // Test seek and cursor
    ts5.setCursor(20);
    assert(ts5.cursorFrameIdx === 20, 'ts5 cursor set to 20');

    // Test 4-lane backward compatibility (Tab 1 Combine Explorer)
    const { canvas: canvas4 } = createMockCanvas(900, 260);
    const ts4 = new TimeseriesCanvas(canvas4); // default 4 lanes
    assert(ts4.lanes.length === 4, 'ts4 default should have 4 lanes for Combine backward compatibility');

    // Combine frames without orientation / slip angle
    const combineFrames = sampleFrames.map(f => ({
        frame_idx: f.frame_idx,
        time: f.time,
        s: f.s,
        a: f.a,
        omega: f.omega,
        curvature: f.kappa,
    }));
    ts4.loadData(combineFrames);
    ts4.render();
    assert(ts4.lanes.length === 4, 'ts4 with combine frames should remain 4 lanes');
    assert(ts4.lanes[0].key === 's', 'ts4 lane 0 speed');
    assert(ts4.lanes[1].key === 'a', 'ts4 lane 1 accel');
    assert(ts4.lanes[2].key === 'omega', 'ts4 lane 2 ang vel');
    assert(ts4.lanes[3].key === 'curvature' || ts4.lanes[3].alias === 'kappa', 'ts4 lane 3 curvature/kappa');

    console.log('✔ TimeseriesCanvas 5-lane & 4-lane dynamic configurations verified');
}

// ============================================================================
// 5. PLAYBACK ENGINE INTEGRATION
// ============================================================================
{
    const engine = new PlaybackEngine();
    const testFrames = new Array(50).fill(0).map((_, i) => ({ frameId: i, s: 5.0 }));
    engine.loadFrames(testFrames);

    assert(!engine.isPlaying, 'Engine should initially be stopped');
    assert(engine.currentFrameIdx === 0, 'Engine starts at frame 0');

    engine.seek(25);
    assert(engine.currentFrameIdx === 25, 'Engine seeks to frame 25');

    engine.step(1);
    assert(engine.currentFrameIdx === 26, 'Engine steps forward to 26');

    engine.step(-2);
    assert(engine.currentFrameIdx === 24, 'Engine steps backward to 24');

    engine.setPlaybackRate(2.0);
    assert(engine.playbackRate === 2.0, 'Playback rate set to 2.0x');

    console.log('✔ PlaybackEngine frame progression & rate controls verified');
}

console.log(`\n========================================`);
console.log(`ALL CHECKS PASSED: ${passed} passed, ${failed} failed`);
console.log(`========================================`);
