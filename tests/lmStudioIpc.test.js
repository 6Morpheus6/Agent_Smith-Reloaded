const { test } = require('node:test');
const assert = require('node:assert/strict');

const { INVOKE_CHANNELS } = require('../src/shared/ipcChannels.js');
const registerLmStudioIpc = require('../src/main/ipc/lmStudio.js');

test('LM Studio management IPC channels are whitelisted', () => {
    assert.ok(INVOKE_CHANNELS.includes('lmstudio-get-status'));
    assert.ok(INVOKE_CHANNELS.includes('lmstudio-ensure-model'));
    // v52.3: UNLOAD ALL button needs its own channel (preload + web /api/invoke).
    assert.ok(INVOKE_CHANNELS.includes('lmstudio-unload-all'));
    // v52.5: model swap + startup embedding guarantee.
    assert.ok(INVOKE_CHANNELS.includes('lmstudio-swap-model'));
    assert.ok(INVOKE_CHANNELS.includes('lmstudio-ensure-embedding'));
});

test('LM Studio IPC forwards only supported fields', async () => {
    const handlers = new Map();
    const ipcMain = {
        handle(name, fn) { handlers.set(name, fn); }
    };
    const calls = [];
    const lmStudioManager = {
        async getStatus(opts) { calls.push(['status', opts]); return { managed: true }; },
        async ensureModel(opts) { calls.push(['ensure', opts]); return { managed: true }; },
        async unloadAll(opts) { calls.push(['unload-all', opts]); return { ok: true, unloaded: [], errors: [] }; }
    };
    registerLmStudioIpc(ipcMain, { lmStudioManager });

    await handlers.get('lmstudio-get-status')(null, {
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'gemma',
        ignored: 'nope'
    });
    await handlers.get('lmstudio-ensure-model')(null, {
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'gemma',
        contextLength: 65536,
        command: 'malicious'
    });

    assert.deepEqual(calls, [
        ['status', { apiBaseUrl: 'http://127.0.0.1:1234', model: 'gemma' }],
        ['ensure', {
            apiBaseUrl: 'http://127.0.0.1:1234',
            model: 'gemma',
            contextLength: 65536
        }]
    ]);
});

test('lmstudio-unload-all forwards only the backend URL (v52.3)', async () => {
    const handlers = new Map();
    const ipcMain = { handle(name, fn) { handlers.set(name, fn); } };
    const calls = [];
    registerLmStudioIpc(ipcMain, {
        lmStudioManager: {
            async unloadAll(opts) { calls.push(opts); return { ok: true, unloaded: [], errors: [] }; }
        }
    });

    const res = await handlers.get('lmstudio-unload-all')(null, {
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'should-not-forward',
        command: 'malicious'
    });
    assert.deepEqual(calls, [{ apiBaseUrl: 'http://127.0.0.1:1234' }]);
    assert.equal(res.ok, true);

    // A manager that throws still returns a shaped error (never rejects to the UI).
    const handlers2 = new Map();
    registerLmStudioIpc({ handle(name, fn) { handlers2.set(name, fn); } }, {
        lmStudioManager: { async unloadAll() { throw new Error('boom'); } }
    });
    const res2 = await handlers2.get('lmstudio-unload-all')(null, { apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(res2.ok, false);
    assert.match(res2.error, /boom/);
});

test('lmstudio-swap-model forwards only the supported fields (v52.5)', async () => {
    const handlers = new Map();
    const calls = [];
    registerLmStudioIpc({ handle(name, fn) { handlers.set(name, fn); } }, {
        lmStudioManager: {
            async swapModel(opts) { calls.push(opts); return { ok: true, unloaded: [] }; }
        }
    });

    const res = await handlers.get('lmstudio-swap-model')(null, {
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'target/new-model-70b',
        contextLength: 16384,
        command: 'malicious'
    });
    assert.deepEqual(calls, [{
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'target/new-model-70b',
        contextLength: 16384
    }]);
    assert.equal(res.ok, true);

    // A manager that throws still returns a shaped error (never rejects to the UI).
    const handlers2 = new Map();
    registerLmStudioIpc({ handle(name, fn) { handlers2.set(name, fn); } }, {
        lmStudioManager: { async swapModel() { throw new Error('boom'); } }
    });
    const res2 = await handlers2.get('lmstudio-swap-model')(null, { apiBaseUrl: 'http://127.0.0.1:1234', model: 'x/y' });
    assert.equal(res2.ok, false);
    assert.match(res2.error, /boom/);
});

test('lmstudio-ensure-embedding forwards only the backend URL (v52.5)', async () => {
    const handlers = new Map();
    const calls = [];
    registerLmStudioIpc({ handle(name, fn) { handlers.set(name, fn); } }, {
        lmStudioManager: {
            async ensureEmbeddingModel(opts) { calls.push(opts); return { ok: true, model: 'small/all-MiniLM-L6-v2' }; }
        }
    });

    const res = await handlers.get('lmstudio-ensure-embedding')(null, {
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'should-not-forward',
        command: 'malicious'
    });
    assert.deepEqual(calls, [{ apiBaseUrl: 'http://127.0.0.1:1234' }]);
    assert.equal(res.ok, true);

    const handlers2 = new Map();
    registerLmStudioIpc({ handle(name, fn) { handlers2.set(name, fn); } }, {
        lmStudioManager: { async ensureEmbeddingModel() { throw new Error('boom'); } }
    });
    const res2 = await handlers2.get('lmstudio-ensure-embedding')(null, { apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(res2.ok, false);
    assert.match(res2.error, /boom/);
});
