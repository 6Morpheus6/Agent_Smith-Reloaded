/**
 * v53.1 — Code Mode resume hardening (mobile "task loops after completion" fix).
 *
 * 1. code-resume must REFUSE terminal sessions (done/unverified/error/aborted/incomplete):
 *    the renderer's resume banner can race the terminal save, and on mobile a single tap
 *    then re-runs a task that already completed. The main process is the last line of
 *    defense — no client can restart a finished session.
 * 2. code-list-sessions must NOT list the session this process is actively running:
 *    "Resume Code run?" for the very run in flight is noise (tapping hits "already active").
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeIpc() {
    const handlers = new Map();
    return { ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, h: (n) => handlers.get(n) };
}

async function register(userDataPath, runCodeTaskStub) {
    // Stub the heavy orchestrator so we can observe whether a resume actually starts.
    const { Module } = require('module');
    const taskPath = require.resolve('../src/code/loop/runCodeTask.js');
    const stubModule = new Module(taskPath);
    stubModule.filename = taskPath;
    stubModule.loaded = true;
    stubModule.exports = { runCodeTask: runCodeTaskStub, executeTurnLoop: async () => ({}), newSessionId: () => 'x' };
    require.cache[taskPath] = stubModule;

    // code.js destructures `runCodeTask` at IMPORT time and keeps module-level activeRun
    // state — so each test must get a FRESH instance bound to THIS test's stub. Purge the
    // cached copy before re-requiring (otherwise tests 2+ would call test 1's stale stub).
    const codePath = require.resolve('../src/main/ipc/code.js');
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(path.join(__dirname, '..', 'src', 'main'))) delete require.cache[key];
    }

    const registerCodeIpc = require(codePath);
    const { ipcMain, h } = fakeIpc();
    registerCodeIpc(ipcMain, {
        spawn: () => ({}),
        projectContext: { getRoot: () => '/ROOT', getRootOrNull: () => null, getShellConfig: () => ({ shell: 'sh', flag: '-c', commandFlag: '-c' }), isWindows: () => false },
        editEngine: {}, changeLedger: {}, grepProject: () => '', globFiles: () => [], relPathFromRoot: (p) => p,
        userDataPath, getLmsUrl: () => 'http://127.0.0.1:1234', getMainWindow: () => null, pushEvent: () => {},
        pluginManager: null, memoryManager: null, previewRunner: null, actionLog: null, downloadRegistry: null, invalidateRepoMap: () => {}
    });
    return { h };
}

function writeSession(userDataPath, id, status) {
    const dir = path.join(userDataPath, 'code-sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
        id, goal: 'build a thing', projectRoot: '/ROOT', model: 'm', numCtx: 8192,
        status, turn: 3, toolCount: 5, filesTouched: [], messages: [], startedAt: Date.now(), finishedAt: null, error: null
    }));
}

test('code-resume refuses terminal sessions (done / unverified / error / aborted)', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-resume-'));
    let started = 0;
    const { h } = await register(userDataPath, async () => { started++; return {}; });

    for (const status of ['done', 'unverified', 'error', 'aborted']) {
        writeSession(userDataPath, `s_${status}`, status);
        const res = await h('code-resume')({}, { sessionId: `s_${status}` });
        assert.ok(res.error, `${status}: resume must be refused`);
        assert.match(res.error, /already finished/i, `${status}: refusal names the state`);
    }
    assert.equal(started, 0, 'no terminal session was restarted');
});

test('code-resume still works for a genuinely interrupted (running) session', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-resume-'));
    let started = 0;
    const { h } = await register(userDataPath, async () => { started++; return {}; });

    writeSession(userDataPath, 's_running', 'running'); // app closed mid-build → resumable
    const res = await h('code-resume')({}, { sessionId: 's_running' });
    assert.ok(!res.error, `unexpected refusal: ${res && res.error}`);
    assert.equal(started, 1, 'interrupted session resumes normally');
});

test('code-list-sessions hides the live in-flight session', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-resume-'));
    let started = 0;
    // Simulate a run that is IN FLIGHT: it emits run_start (which sets activeRun.sessionId
    // via the emit wrapper, exactly like the real engine) and never resolves — code-run's
    // invoke only settles when the whole run finishes.
    const { h } = await register(userDataPath, async (opts) => {
        started++;
        opts.emit({ type: 'run_start', sessionId: 's_live', goal: 'p' });
        return new Promise(() => {}); // stays pending — the run is still running
    });

    writeSession(userDataPath, 's_live', 'running');      // the run in flight right now
    writeSession(userDataPath, 's_old', 'running');       // an older interrupted run (started earlier)

    void h('code-run')({}, { prompt: 'p', model: 'm' }); // fire; do NOT await (run never ends)
    assert.equal(started, 1);

    const list = await h('code-list-sessions')({});
    const ids = (list.sessions || []).map(s => s.id);
    assert.ok(!ids.includes('s_live'), 'the live session is NOT offered as resumable');
    assert.ok(ids.includes('s_old'), 'older interrupted sessions are still offered');
});

test('code-list-sessions shows nothing when no run is active and none incomplete', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-resume-'));
    const { h } = await register(userDataPath, async () => ({}));
    writeSession(userDataPath, 's_done', 'done'); // terminal → excluded by listIncomplete
    const list = await h('code-list-sessions')({});
    assert.deepEqual(list.sessions, []);
});
