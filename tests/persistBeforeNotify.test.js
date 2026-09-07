/**
 * v53.1 — PERSIST-BEFORE-NOTIFY (mobile "task loops after completion" fix).
 *
 * The renderer's `done` handler immediately queries code-list-sessions to decide whether
 * to show "Resume Code run?". If the terminal status is only saved AFTER the event, a
 * phone client whose SSE round-trip lands first still sees 'running' and offers Resume —
 * tapping it re-runs the whole task. This test drives executeTurnLoop with a stubbed
 * inner turn loop (require.cache) and asserts that at the exact moment `done`/`error` is
 * emitted, the on-disk session file ALREADY carries the terminal status.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub the inner turn loop BEFORE runCodeTask loads it, so we control exactly what the
// "model" does (finish cleanly / throw) without any network.
const { Module } = require('module');
const turnLoopPath = require.resolve('../src/code/loop/turnLoop.js');
let stubBehavior = 'done'; // 'done' | 'throw'
const stubModule = new Module(turnLoopPath);
stubModule.filename = turnLoopPath;
stubModule.loaded = true;
stubModule.exports = {
    SYSTEM_PROMPT: 'test',
    runTurnLoop: async (ctx) => {
        if (stubBehavior === 'throw') throw new Error('synthetic model failure');
        ctx.session.status = 'done';
    }
};
require.cache[turnLoopPath] = stubModule;

const { executeTurnLoop } = require('../src/code/loop/runCodeTask.js');
const { CodeSession } = require('../src/code/session/state.js');

function makeCtx(userDataPath, emitSpy) {
    const session = new CodeSession('code_test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), {
        goal: 'test task', projectRoot: userDataPath, model: 'm'
    });
    session.status = 'running';
    return {
        session,
        planAnchor: { serialize: () => null },
        planArtifacts: { serialize: () => null },
        earlyStop: {},
        qualityMonitor: {},
        trace: { exportToUserData: () => {} },
        userDataPath,
        execDeps: {},
        emit: (ev) => { if (typeof emitSpy === 'function') emitSpy(ev); },
        signal: undefined
    };
}

function sessionFile(userDataPath, id) {
    return path.join(userDataPath, 'code-sessions', `${id}.json`);
}

test('done event is emitted only AFTER the terminal status is on disk', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-pbn-'));
    const events = [];
    let doneSeenOnDisk;
    const emitSpy = (ev) => {
        events.push(ev);
        if (ev.type === 'done') {
            // The exact moment a client can react: what does the disk say?
            const raw = JSON.parse(fs.readFileSync(sessionFile(userDataPath, ev.sessionId), 'utf-8'));
            doneSeenOnDisk = raw.status;
        }
    };
    const ctx = makeCtx(userDataPath, emitSpy);
    await executeTurnLoop(ctx);

    assert.ok(events.some(e => e.type === 'done'), 'a done event was emitted');
    assert.equal(doneSeenOnDisk, 'done', 'on-disk status is "done" at the moment `done` fires (no resume race)');
});

test('error event is emitted only AFTER the terminal status is on disk', async () => {
    stubBehavior = 'throw';
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-pbn-'));
    const events = [];
    let errorSeenOnDisk;
    const emitSpy = (ev) => {
        events.push(ev);
        if (ev.type === 'error') {
            const raw = JSON.parse(fs.readFileSync(sessionFile(userDataPath, ev.sessionId), 'utf-8'));
            errorSeenOnDisk = raw.status;
        }
    };
    const ctx = makeCtx(userDataPath, emitSpy);
    await executeTurnLoop(ctx);

    assert.ok(events.some(e => e.type === 'error'), 'an error event was emitted');
    assert.equal(errorSeenOnDisk, 'error', 'on-disk status is "error" at the moment `error` fires (no resume race)');
});
