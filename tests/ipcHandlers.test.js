/**
 * IPC handler coverage — register each domain with a fake ipcMain + spy deps and assert
 * the handlers forward correctly (root injection, plan-id fallback, default args, guard
 * branches). Pattern mirrors tests/lmStudioIpc.test.js / agentListDir.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeIpc() {
    const handlers = new Map();
    return { ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, h: (n) => handlers.get(n), handlers };
}
function spy(retFn) {
    const calls = [];
    const fn = (...args) => { calls.push(args); return typeof retFn === 'function' ? retFn(...args) : retFn; };
    fn.calls = calls;
    return fn;
}

test('git IPC forwards getRoot() and applies default commit message / log count', async () => {
    const registerGitIpc = require('../src/main/ipc/git.js');
    const gitIntegration = {
        init: spy({ ok: true }), status: spy({ ok: true }), diff: spy({ ok: true }),
        commit: spy({ ok: true }), undoLast: spy({ ok: true }), logOneline: spy({ ok: true, lines: [] })
    };
    const { ipcMain, h } = fakeIpc();
    registerGitIpc(ipcMain, { gitIntegration, projectContext: { getRoot: () => '/ROOT' } });

    await h('git-status')({});
    assert.deepEqual(gitIntegration.status.calls[0], ['/ROOT']);
    await h('git-commit')({}, { message: undefined });
    assert.deepEqual(gitIntegration.commit.calls[0], ['/ROOT', 'Agent Smith checkpoint'], 'default message');
    await h('git-commit')({}, { message: 'real msg' });
    assert.deepEqual(gitIntegration.commit.calls[1], ['/ROOT', 'real msg']);
    await h('git-log')({}, undefined);
    assert.deepEqual(gitIntegration.logOneline.calls[0], ['/ROOT', 10], 'default n=10');
});

test('ledger IPC falls back to state.currentPlanId', async () => {
    const registerLedgerIpc = require('../src/main/ipc/ledger.js');
    const changeLedger = { diff: spy({ fileCount: 0 }), revertAll: spy({ success: true }) };
    const { ipcMain, h } = fakeIpc();
    registerLedgerIpc(ipcMain, { changeLedger, state: { currentPlanId: 'PID' } });

    await h('ledger-diff')({}, undefined);
    assert.deepEqual(changeLedger.diff.calls[0], ['PID'], 'undefined planId → state.currentPlanId');
    await h('ledger-revert-all')({}, 'EXPLICIT');
    assert.deepEqual(changeLedger.revertAll.calls[0], ['EXPLICIT'], 'explicit planId wins');
});

test('edit IPC: no active plan → error without calling editEngine; with plan → applies + relPath', async () => {
    const registerEditIpc = require('../src/main/ipc/edit.js');
    const editEngine = { apply: spy({ success: true, path: '/ROOT/a.js' }) };
    const invalidateRepoMap = spy();
    const state = { currentPlanId: null };
    const { ipcMain, h } = fakeIpc();
    registerEditIpc(ipcMain, {
        editEngine, planStore: null, projectContext: { getRootOrNull: () => '/ROOT' },
        relPathFromRoot: () => 'a.js', invalidateRepoMap, state
    });

    const noPlan = await h('edit-apply')({}, { filepath: 'a.js', find: 'x', replace: 'y' });
    assert.equal(noPlan.error, 'No active plan for edit');
    assert.equal(editEngine.apply.calls.length, 0, 'editEngine NOT called without a plan');

    const ok = await h('edit-apply')({}, { planId: 'P', filepath: 'a.js', find: 'x', replace: 'y' });
    assert.deepEqual(editEngine.apply.calls[0], ['P', 'a.js', 'x', 'y']);
    assert.equal(ok.relPath, 'a.js');
    assert.equal(invalidateRepoMap.calls.length, 1, 'repo map invalidated on success');
});

test('project IPC: get-root uses getRootOrNull() then falls back to getRoot()', async () => {
    const registerProjectIpc = require('../src/main/ipc/project.js');
    {
        const { ipcMain, h } = fakeIpc();
        registerProjectIpc(ipcMain, { projectContext: { getRootOrNull: () => null, getRoot: () => '/FALLBACK', setRoot: () => ({}), resolvePath: () => ({}) } });
        assert.deepEqual(await h('project-get-root')({}), { projectRoot: '/FALLBACK' });
    }
    {
        const { ipcMain, h } = fakeIpc();
        registerProjectIpc(ipcMain, { projectContext: { getRootOrNull: () => '/SET', getRoot: () => '/FALLBACK', setRoot: () => ({}), resolvePath: () => ({}) } });
        assert.deepEqual(await h('project-get-root')({}), { projectRoot: '/SET' });
    }
});

test('memory IPC forwards to manager; mem-count wraps the count', async () => {
    const registerMemoryIpc = require('../src/main/ipc/memory.js');
    const memoryManager = {
        storeVector: spy({ success: true }), queryVectors: spy({ success: true, data: [] }),
        getCount: spy(7), clearMemory: spy({ ok: true })
    };
    const { ipcMain, h } = fakeIpc();
    registerMemoryIpc(ipcMain, { memoryManager });
    await h('mem-store')({}, { text: 't', metadata: { a: 1 } });
    assert.deepEqual(memoryManager.storeVector.calls[0], ['t', { a: 1 }]);
    await h('mem-query')({}, { query: 'q', limit: 3 });
    assert.deepEqual(memoryManager.queryVectors.calls[0], ['q', 3]);
    assert.deepEqual(await h('mem-count')({}), { count: 7 });
});

test('plugins IPC: invoke-tool wraps result; install re-discovers ONLY on success', async () => {
    const registerPluginsIpc = require('../src/main/ipc/plugins.js');
    const pluginManager = { invokeTool: spy('RESULT'), discover: spy() };
    let installRet = { success: true };
    const pluginInstaller = { install: spy(() => installRet) };
    const { ipcMain, h } = fakeIpc();
    registerPluginsIpc(ipcMain, { pluginManager, pluginInstaller });

    assert.deepEqual(await h('plugin-invoke-tool')({}, { tool: 't', args: {} }), { result: 'RESULT' });

    await h('plugin-install')({}, { url: 'u' });
    assert.equal(pluginManager.discover.calls.length, 1, 'discover called after a successful install');
    installRet = { success: false, error: 'bad' };
    await h('plugin-install')({}, { url: 'u2' });
    assert.equal(pluginManager.discover.calls.length, 1, 'discover NOT called when install fails');
});
