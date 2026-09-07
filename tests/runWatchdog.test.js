const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRunWatchdog } = require('../src/code/loop/runWatchdog.js');

test('emits a heartbeat on each tick with elapsed/idle and meta', () => {
    let t = 1000;
    const events = [];
    const wd = createRunWatchdog({
        now: () => t, emit: (e) => events.push(e),
        inactivityMs: 100000, maxRuntimeMs: 1000000,
        meta: () => ({ phase: 'implement' })
    });
    t = 1050; wd._tick();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'heartbeat');
    assert.equal(events[0].elapsedMs, 50);
    assert.equal(events[0].idleMs, 50);
    assert.equal(events[0].phase, 'implement');
});

test('fires onStall after inactivity exceeds the limit', () => {
    let t = 0, reason = null;
    const wd = createRunWatchdog({ now: () => t, inactivityMs: 100000, maxRuntimeMs: 1e12, onStall: (r) => { reason = r; } });
    t = 70000; wd._tick();   // idle 70s < 100s
    assert.equal(reason, null);
    t = 130000; wd._tick();  // idle 130s >= 100s
    assert.match(reason, /stalled — no progress for 130s/);
});

test('touch() resets the inactivity window (slow-but-progressing run does not trip)', () => {
    let t = 0, reason = null;
    const wd = createRunWatchdog({ now: () => t, inactivityMs: 100000, maxRuntimeMs: 1e12, onStall: (r) => { reason = r; } });
    t = 80000; wd.touch();   // progress at 80s
    t = 150000; wd._tick();  // idle = 70s < 100s
    assert.equal(reason, null);
    t = 200000; wd._tick();  // idle = 120s >= 100s
    assert.match(reason, /stalled/);
});

test('fires on the wall-clock max-runtime cap even if active', () => {
    let t = 0, reason = null;
    const wd = createRunWatchdog({ now: () => t, inactivityMs: 1e12, maxRuntimeMs: 500000, onStall: (r) => { reason = r; } });
    t = 600000; wd._tick();
    assert.match(reason, /exceeded max runtime of 500s/);
});

test('onStall fires at most once', () => {
    let t = 0, count = 0;
    const wd = createRunWatchdog({ now: () => t, inactivityMs: 100000, maxRuntimeMs: 1e12, onStall: () => { count++; } });
    t = 200000; wd._tick();
    t = 400000; wd._tick();
    assert.equal(count, 1);
    assert.equal(wd.stalled, true);
});
