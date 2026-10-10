// v54.6 — coding-reliability middlewares ported from the Hermes development guide (code.md):
// stale-write re-read enforcement, gather-before-change read-back, background-job settle gate.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createDefaultMiddleware, runMiddlewareChain } = require('../src/code/loop/middleware.js');

function mw(name) {
    const chain = createDefaultMiddleware({});
    const hook = chain.find(m => m.name === name);
    assert.ok(hook, `middleware "${name}" must be registered`);
    return hook;
}

// ── stalePatchGuard ────────────────────────────────────────────────────────────

test('stalePatchGuard: failed write marks the path stale and blocks blind retries', async () => {
    const g = mw('stalePatchGuard');
    const session = {};
    // A patch that fails on script.js...
    await g.afterTool({ session, payload: { name: 'patch', args: { path: 'script.js' }, toolResult: { error: 'no match' }, ok: false } });
    assert.ok(session._staleWritePaths.has('script.js'));

    // ...a blind retry of a write on the same path is vetoed.
    const veto = await g.beforeTool({ session, payload: { name: 'write_file', args: { path: 'script.js' } } });
    assert.ok(veto?.veto, 'blind re-write after failed edit must be blocked');
    assert.equal(veto.result.blockedReason, 'stale_write_retry');

    // A different path is unaffected.
    const other = await g.beforeTool({ session, payload: { name: 'patch', args: { path: 'style.css' } } });
    assert.equal(other, null);
});

test('stalePatchGuard: read_file clears the stale flag; success also clears it', async () => {
    const g = mw('stalePatchGuard');
    const session = {};
    await g.afterTool({ session, payload: { name: 'patch', args: { path: 'a.js' }, toolResult: { error: 'x' }, ok: false } });
    // Model reads the file (fresh content)...
    await g.afterTool({ session, payload: { name: 'read_file', args: { path: 'a.js' }, toolResult: {}, ok: true } });
    const after = await g.beforeTool({ session, payload: { name: 'patch', args: { path: 'a.js' } } });
    assert.equal(after, null, 'after a read the retry must be allowed');

    // And a successful write clears too.
    await g.afterTool({ session, payload: { name: 'patch', args: { path: 'b.js' }, toolResult: { error: 'x' }, ok: false } });
    assert.ok(session._staleWritePaths.has('b.js'));
    await g.afterTool({ session, payload: { name: 'write_file', args: { path: 'b.js' }, toolResult: {}, ok: true } });
    assert.ok(!session._staleWritePaths.has('b.js'));
});

test('stalePatchGuard: reads that FAILED do not clear the stale flag', async () => {
    const g = mw('stalePatchGuard');
    const session = {};
    await g.afterTool({ session, payload: { name: 'patch', args: { path: 'c.js' }, toolResult: { error: 'x' }, ok: false } });
    await g.afterTool({ session, payload: { name: 'read_file', args: { path: 'c.js' }, toolResult: { error: 'not found' }, ok: false } });
    const veto = await g.beforeTool({ session, payload: { name: 'patch', args: { path: 'c.js' } } });
    assert.ok(veto?.veto, 'a failed read proves nothing — stay blocked');
});

// ── gatherBeforeChange ─────────────────────────────────────────────────────────

test('gatherBeforeChange: vetoes done once when zero reads since last edit', async () => {
    const g = mw('gatherBeforeChange');
    const session = { filesTouched: ['script.js'], _readsSinceLastEdit: 0 };
    const veto = await g.beforeDone({ session });
    assert.ok(veto?.veto);
    assert.match(veto.messages[0], /GATHER BEFORE CHANGING/);
    // One-shot: a second completion attempt is not blocked by this guard again.
    const second = await g.beforeDone({ session });
    assert.equal(second, null);
});

test('gatherBeforeChange: passes when a read happened since the edit', async () => {
    const g = mw('gatherBeforeChange');
    const session = { filesTouched: ['script.js'], _readsSinceLastEdit: 2 };
    assert.equal(await g.beforeDone({ session }), null);
});

test('gatherBeforeChange: no edits means nothing to gather', async () => {
    const g = mw('gatherBeforeChange');
    assert.equal(await g.beforeDone({ session: { filesTouched: [] } }), null);
});

// ── backgroundJobsSettled ──────────────────────────────────────────────────────

test('backgroundJobsSettled: vetoes once while a run-started job still runs', async () => {
    const g = mw('backgroundJobsSettled');
    const session = { _bgJobIds: new Set(['7']) };
    const ctx = { execDeps: { jobApi: { listJobs: () => [{ job_id: '7', running: true }] } } };
    const veto = await g.beforeDone({ ctx, session });
    assert.ok(veto?.veto);
    assert.match(veto.messages[0], /BACKGROUND JOB STILL RUNNING \(7\)/);
    // Second pass allowed through (intentional long-running server must not deadlock).
    assert.equal(await g.beforeDone({ ctx, session }), null);
});

test('backgroundJobsSettled: exited jobs and foreign jobs never block', async () => {
    const g = mw('backgroundJobsSettled');
    const session = { _bgJobIds: new Set(['7']) };
    const done = { execDeps: { jobApi: { listJobs: () => [{ job_id: '7', running: false, exit_code: 0 }] } } };
    assert.equal(await g.beforeDone({ ctx: done, session }), null);

    const s2 = { _bgJobIds: new Set(['7']) };
    const foreign = { execDeps: { jobApi: { listJobs: () => [{ job_id: '99', running: true }] } } };
    assert.equal(await g.beforeDone({ ctx: foreign, session: s2 }), null);
});

test('backgroundJobsSettled: no job ledger or missing jobApi is inert', async () => {
    const g = mw('backgroundJobsSettled');
    assert.equal(await g.beforeDone({ ctx: {}, session: {} }), null);
    assert.equal(await g.beforeDone({ ctx: {}, session: { _bgJobIds: new Set(['3']) } }), null);
});

// ── chain integration: the three guards coexist with testBeforeDone ────────────

test('beforeDone chain: stale-write + zero-read run is vetoed, then allowed after read-back', async () => {
    const chain = createDefaultMiddleware({});
    const session = { filesTouched: ['script.js'], _readsSinceLastEdit: 0, testRunsSinceEdit: true };
    // Mark script.js stale via the guard's own bookkeeping.
    const g = chain.find(m => m.name === 'stalePatchGuard');
    await g.afterTool({ session, payload: { name: 'patch', args: { path: 'script.js' }, toolResult: { error: 'x' }, ok: false } });

    // beforeDone: gatherBeforeChange fires (testRunsSinceEdit true so testBeforeDone passes).
    const veto = await runMiddlewareChain(chain, 'beforeDone', { ctx: {}, session, payload: {} });
    assert.ok(veto?.veto);
    assert.match((veto.messages || []).join(' '), /GATHER BEFORE CHANGING/);

    // Model reads back its work → done allowed through the middleware layer.
    await g.afterTool({ session, payload: { name: 'read_file', args: { path: 'script.js' }, toolResult: {}, ok: true } });
    session._readsSinceLastEdit = 1;
    const after = await runMiddlewareChain(chain, 'beforeDone', { ctx: {}, session, payload: {} });
    assert.equal(after, null);
});
