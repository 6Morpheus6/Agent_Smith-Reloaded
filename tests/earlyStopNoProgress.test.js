const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');

test('stops after N turns with no file written (read-only exploration)', () => {
    const es = new EarlyStopDetector({ maxNoWriteTurns: 5 });
    let stopped = null;
    for (let i = 0; i < 20 && !stopped; i++) {
        const r = es.onProgress(0); // never any files written
        if (r.stop) stopped = r;
    }
    assert.ok(stopped, 'must stop when no files are ever written');
    assert.match(stopped.reason, /No files written in 5 turns/);
    assert.match(stopped.reason, /Chat or Agent mode/);
    assert.equal(es.noWriteTurns, 5);
});

test('does NOT stop while files keep being written', () => {
    const es = new EarlyStopDetector({ maxNoWriteTurns: 3 });
    let count = 0;
    for (let i = 0; i < 30; i++) {
        count += 1; // a new file every turn
        const r = es.onProgress(count);
        assert.equal(r.stop, false);
    }
});

test('the no-write counter resets when a new file appears (exploration then writes)', () => {
    const es = new EarlyStopDetector({ maxNoWriteTurns: 4 });
    // 3 read-only turns
    assert.equal(es.onProgress(0).stop, false);
    assert.equal(es.onProgress(0).stop, false);
    assert.equal(es.onProgress(0).stop, false);
    assert.equal(es.noWriteTurns, 3);
    // a write lands -> counter resets
    assert.equal(es.onProgress(1).stop, false);
    assert.equal(es.noWriteTurns, 0);
    // a few more read-only turns are fine again
    assert.equal(es.onProgress(1).stop, false);
    assert.equal(es.onProgress(1).stop, false);
    assert.equal(es.noWriteTurns, 2);
});

test('env override XK_CODE_MAX_NOWRITE_TURNS is honored', () => {
    const prev = process.env.XK_CODE_MAX_NOWRITE_TURNS;
    process.env.XK_CODE_MAX_NOWRITE_TURNS = '2';
    try {
        const es = new EarlyStopDetector({});
        assert.equal(es.onProgress(0).stop, false);
        assert.equal(es.onProgress(0).stop, true);
    } finally {
        if (prev === undefined) delete process.env.XK_CODE_MAX_NOWRITE_TURNS;
        else process.env.XK_CODE_MAX_NOWRITE_TURNS = prev;
    }
});
