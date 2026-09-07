/**
 * v52.7 — INFINITE TURNS contract: the "Thinking Steps" slider is gone, so a run must never
 * stop on turn count by default; explicit positive caps (tests / advanced callers) still work.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');

test('default detector has NO turn cap — 500 turns never trip max-turns', () => {
    const det = new EarlyStopDetector(); // no maxTurns → infinite (v52.7)
    assert.equal(det.maxTurns, Infinity);
    for (let i = 0; i < 500; i++) {
        const r = det.onTurn();
        assert.equal(r.stop, false, `turn ${i + 1} must not stop on turn count`);
    }
});

test('-1 and 0 are the JSON-safe "infinite" sentinels', () => {
    for (const v of [-1, 0]) {
        const det = new EarlyStopDetector({ maxTurns: v });
        assert.equal(det.maxTurns, Infinity);
        for (let i = 0; i < 50; i++) assert.equal(det.onTurn().stop, false);
    }
});

test('null / undefined maxTurns are infinite', () => {
    assert.equal(new EarlyStopDetector({ maxTurns: null }).maxTurns, Infinity);
    assert.equal(new EarlyStopDetector({}).maxTurns, Infinity);
});

test('an explicit positive cap is still honored (exactly N turns)', () => {
    const det = new EarlyStopDetector({ maxTurns: 5 });
    let ran = 0;
    while (!det.onTurn().stop) ran++;
    assert.equal(ran, 5);
});

test('fractional caps floor to whole turns', () => {
    const det = new EarlyStopDetector({ maxTurns: 2.9 });
    let ran = 0;
    while (!det.onTurn().stop) ran++;
    assert.equal(ran, 2);
});

test('resume seeding still works with an infinite cap (turn counter persists)', () => {
    const det = new EarlyStopDetector({ maxTurns: -1, initialTurn: 37 });
    assert.equal(det.turn, 37);
    assert.equal(det.onTurn().stop, false); // 38th turn of an unbounded run — fine
});

test('stuck guards still fire under infinite turns (no-write stagnation)', () => {
    const det = new EarlyStopDetector({ maxNoWriteTurns: 3 }); // infinite turns, but...
    assert.equal(det.onProgress(0).stop, false);
    assert.equal(det.onProgress(0).stop, false);
    const r = det.onProgress(0); // ...three no-write turns still stop the run
    assert.equal(r.stop, true);
    assert.match(r.reason, /No files written/);
});
