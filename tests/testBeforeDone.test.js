/**
 * v51.5 — TEST BEFORE DONE middleware (testBeforeDone in src/code/loop/middleware.js):
 * completion is vetoed until a verification command has passed since the last edit, and the
 * veto steers the run into the verify phase via forcePhase.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function makeSession(overrides = {}) {
    return Object.assign({
        filesTouched: [],
        testRunsSinceEdit: false,
        projectMeta: null
    }, overrides);
}

test('vetoes completion when files were edited but never verified since', async () => {
    const { createDefaultMiddleware } = require('../src/code/loop/middleware.js');
    const session = makeSession({ filesTouched: ['index.html', 'script.js'] });
    for (const mw of createDefaultMiddleware({})) {
        if (mw.name !== 'testBeforeDone') continue;
        const out = await mw.beforeDone({ ctx: {}, session, payload: {} });
        assert.equal(out.veto, true);
        assert.match(out.messages.join(' '), /TEST BEFORE DONE/);
        // Steer into the phase where run_command is offered and writes stay available for fixes.
        assert.equal(out.forcePhase, 'verify');
    }
});

test('passes once a verification command has succeeded since the last edit', async () => {
    const { createDefaultMiddleware } = require('../src/code/loop/middleware.js');
    const session = makeSession({ filesTouched: ['app.py'], testRunsSinceEdit: true });
    for (const mw of createDefaultMiddleware({})) {
        if (mw.name !== 'testBeforeDone') continue;
        assert.equal(await mw.beforeDone({ ctx: {}, session, payload: {} }), null);
    }
});

test('does not veto runs that never touched files (chat-only / host-tool work is the gate\'s job)', async () => {
    const { createDefaultMiddleware } = require('../src/code/loop/middleware.js');
    const session = makeSession({ filesTouched: [], testRunsSinceEdit: false });
    for (const mw of createDefaultMiddleware({})) {
        if (mw.name !== 'testBeforeDone') continue;
        assert.equal(await mw.beforeDone({ ctx: {}, session, payload: {} }), null);
    }
});

test('veto message names the project\'s own test command when one is detected', async () => {
    const { createDefaultMiddleware } = require('../src/code/loop/middleware.js');
    const session = makeSession({
        filesTouched: ['main.py'],
        projectMeta: { lintCmd: 'ruff check .', testCmd: 'pytest -q' }
    });
    for (const mw of createDefaultMiddleware({})) {
        if (mw.name !== 'testBeforeDone') continue;
        const out = await mw.beforeDone({ ctx: {}, session, payload: {} });
        assert.match(out.messages.join(' '), /ruff check \./);
        assert.match(out.messages.join(' '), /pytest -q/);
    }
});

test('veto message falls back to language-appropriate verification commands without project meta', async () => {
    const { createDefaultMiddleware } = require('../src/code/loop/middleware.js');
    for (const mw of createDefaultMiddleware({})) {
        if (mw.name !== 'testBeforeDone') continue;
        const jsOut = await mw.beforeDone({ ctx: {}, session: makeSession({ filesTouched: ['a.js', 'b.js'] }), payload: {} });
        assert.match(jsOut.messages.join(' '), /node --check/);

        const pyOut = await mw.beforeDone({ ctx: {}, session: makeSession({ filesTouched: ['util.py'] }), payload: {} });
        assert.match(pyOut.messages.join(' '), /py_compile/);
    }
});
