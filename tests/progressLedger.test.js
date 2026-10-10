// v54.5 — durable progress ledger: remembers what a run has done, across turns and runs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProgressLedger } = require('../src/code/context/progressLedger.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xk-ledger-'));
}

test('ledger records outcomes and renders a stable-track block', () => {
    const root = tmpRoot();
    const led = new ProgressLedger({ projectRoot: root, goal: 'build app and package as AppImage' });
    led.record({ tool: 'write_file', ok: true, ref: 'src/app.js' });
    led.record({ tool: 'run_command', ok: false, ref: 'npx electron-builder --linux', note: 'exit code 1' });
    led.record({ tool: 'run_command', ok: true, ref: 'npx electron-builder --linux' });

    const block = led.toBlock();
    assert.match(block, /PROGRESS LEDGER/);
    assert.match(block, /✓ write_file — src\/app\.js/);
    assert.match(block, /✗ run_command — npx electron-builder --linux \(exit code 1\)/);
    assert.match(block, /build\/package runs: 1 ok \/ 1 failed/);
    assert.match(block, /Do NOT redo steps already marked ✓/);
});

test('repeated identical outcome collapses into a retry count', () => {
    const led = new ProgressLedger({ projectRoot: null });
    for (let i = 0; i < 3; i++) led.record({ tool: 'run_command', ok: false, ref: 'make' });
    assert.strictEqual(led.entries.length, 1);
    assert.strictEqual(led.entries[0].n, 3);
});

test('ledger persists to disk and reloads for the same goal (crash continuity)', () => {
    const root = tmpRoot();
    const a = new ProgressLedger({ projectRoot: root, goal: 'package into .deb' });
    a.record({ tool: 'write_file', ok: true, ref: 'index.js' });

    const b = new ProgressLedger({ projectRoot: root, goal: '  Package   into\n .deb  ' }); // normalized match
    assert.ok(b.loadFromDisk(), 'same goal (normalized) must find the previous ledger');
    assert.strictEqual(b.entries.length, 1);

    const c = new ProgressLedger({ projectRoot: root, goal: 'totally different task' });
    assert.strictEqual(c.loadFromDisk(), false);
});

test('serialize/restore round-trips (resume path)', () => {
    const led = new ProgressLedger({ projectRoot: null, goal: 'g' });
    led.record({ tool: 'patch', ok: true, ref: 'a.js' });
    const copy = new ProgressLedger({ projectRoot: null, goal: 'g' });
    copy.restore(led.serialize());
    assert.deepStrictEqual(copy.entries, led.entries);
});

test('plan anchor injects the ledger block every turn and records both outcomes', () => {
    const root = tmpRoot();
    const led = new ProgressLedger({ projectRoot: root, goal: 'g' });
    const anchor = new PlanAnchor('build it', null, led);

    anchor.recordDone('run_command on npx electron-builder --linux', { tool: 'run_command', ok: false, ref: 'npx electron-builder --linux', note: 'exit 1' });
    anchor.recordDone('write_file on README.md', { tool: 'write_file', ok: true, ref: 'README.md' });

    const block = anchor.toBlock();
    assert.match(block, /PROGRESS LEDGER/);
    assert.ok(led.entries.length === 2);
    // ledger present → the legacy short "Done so far" list is not duplicated
    assert.doesNotMatch(block, /Done so far:/);

    // anchor without a ledger still shows the legacy list (no regression for chat-only runs)
    const bare = new PlanAnchor('g');
    bare.recordDone('read_file on x.js', { tool: 'read_file', ok: true, ref: 'x.js' });
    assert.match(bare.toBlock(), /Done so far:/);
});

test('earlyStop: build progress resets the no-write counter (packaging runs survive)', () => {
    const es = new EarlyStopDetector({ maxNoWriteTurns: 3 });
    // three turns with nothing → stop on the third
    assert.strictEqual(es.onProgress(0, {}).stop, false);
    assert.strictEqual(es.onProgress(0, {}).stop, false);
    assert.strictEqual(es.onProgress(0, {}).stop, true);

    const es2 = new EarlyStopDetector({ maxNoWriteTurns: 3 });
    for (let i = 0; i < 10; i++) {
        const r = es2.onProgress(0, { buildProgress: true });
        assert.strictEqual(r.stop, false, 'a completed long build is forward motion');
    }

    // failed builds count too — reading a failed build's output IS the next step
    const es3 = new EarlyStopDetector({ maxNoWriteTurns: 2 });
    assert.strictEqual(es3.onProgress(0, { buildProgress: true }).stop, false);
    assert.strictEqual(es3.onProgress(0, { buildProgress: true }).stop, false);
});
