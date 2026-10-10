/**
 * v55.9.1 — MIN-CTX AUTO-RELOAD (src/renderer/ui/runtimeProfileUI.js).
 *
 * The 10s refresh loop re-reads what LM Studio ACTUALLY has loaded for the selected model;
 * when that verified window is below the app-wide minimum (ctxGate.minCtx, 32000), auto-tune
 * reloads THAT model in LM Studio at exactly the floor — instead of letting the send gate wall
 * the user off with "Minimum context not met" and telling them to fix it by hand.
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

class FakeElement {
    constructor(value = '') {
        this.value = value;
        this.textContent = '';
        this.title = '';
        this.checked = true;
        this.listeners = new Map();
    }
    addEventListener(name, fn) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(fn);
    }
}

function makeStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

/**
 * Mount the real runtimeProfileUI against a scripted LM Studio.
 * `loadedCtx` is what /api/v1/models reports as loaded for the model; `ensureResult` is what
 * lmstudio-ensure-model returns (default: success at the requested context).
 */
function loadUi({ invoke, lsSeed = {} } = {}) {
    global.localStorage = makeStorage(lsSeed);
    const runtimeProfile = {
        buildRuntimeProfile: () => ({
            numCtx: 65536, temperature: 0.2, codeTemperature: 0.15, maxSteps: 25, maxTurns: 50,
            summary: 'Gemma ctx 64K', warnings: []
        })
    };
    global.window = { api: { invoke }, XKRuntimeProfile: runtimeProfile };
    global.XKRuntimeProfile = runtimeProfile;
    const file = require.resolve('../src/renderer/ui/runtimeProfileUI.js');
    delete require.cache[file];
    return require(file);
}

function elements(modelId = 'google/gemma-4-e4b') {
    return {
        modelSelect: new FakeElement(modelId),
        tempSlider: new FakeElement('0.5'),
        tempVal: new FakeElement(),
        ctxSlider: new FakeElement('8192'),
        ctxVal: new FakeElement(),
        chipEl: new FakeElement(),
        toggleEl: new FakeElement()
    };
}

function mount(ui, els, opts = {}) {
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://127.0.0.1:1234',
        isBusy: opts.isBusy || (() => false),
        debounceMs: 5
    });
}

beforeEach(() => { delete global.window; delete global.localStorage; delete global.XKRuntimeProfile; });
afterEach(() => { delete global.window; delete global.localStorage; delete global.XKRuntimeProfile; });

test('verified loaded ctx below the minimum triggers an automatic LM Studio reload at exactly 32000', async () => {
    const ensures = [];
    let loadedCtx = 16384; // user loaded it in LM Studio with a small window
    const ui = loadUi({ invoke: async (channel, opts) => {
        if (channel === 'get-gpu-telemetry') return {};
        if (channel === 'lmstudio-get-status') return { managed: true, model: opts.model, loadedContext: loadedCtx, maxContext: 131072 };
        if (channel === 'lmstudio-ensure-model') { ensures.push(opts); loadedCtx = opts.contextLength; return { managed: true, requestedContext: opts.contextLength, loadedContext: opts.contextLength, maxContext: 131072 }; }
        return null;
    }});
    const els = elements();
    mount(ui, els);

    // The refresh (what the 10s loop + every send do) detects 16384 < 32000 and fixes it.
    await ui.refreshCurrentLoadedContext();
    await new Promise(r => setTimeout(r, 5)); // let the fire-and-forget reload settle

    assert.equal(ensures.length, 1, 'exactly one automatic reload');
    assert.deepEqual(ensures[0], { apiBaseUrl: 'http://127.0.0.1:1234', model: 'google/gemma-4-e4b', contextLength: 32000 });
    // The slider now mirrors the FIXED window, and the chip reports it.
    assert.equal(els.ctxSlider.value, '32000');
    assert.match(els.chipEl.textContent, /LM Studio ctx 32000/);
});

test('a model loaded AT or ABOVE the minimum is never reloaded', async () => {
    const ensures = [];
    const ui = loadUi({ invoke: async (channel, opts) => {
        if (channel === 'lmstudio-get-status') return { managed: true, model: opts.model, loadedContext: 32000, maxContext: 131072 };
        if (channel === 'lmstudio-ensure-model') ensures.push(opts);
        return null;
    }});
    const els = elements();
    mount(ui, els);

    await ui.refreshCurrentLoadedContext();
    await new Promise(r => setTimeout(r, 5));

    assert.equal(ensures.length, 0, '32000 is the inclusive minimum — no reload');
});

test('auto-tune OFF or a manual override: below-min ctx is detected but NOT auto-reloaded', async () => {
    for (const seed of [{ agentsmith_auto_tune: 'false' }, { agentsmith_profile_override: 'true' }]) {
        const ensures = [];
        const ui = loadUi({ invoke: async (channel, opts) => {
            if (channel === 'lmstudio-get-status') return { managed: true, model: opts.model, loadedContext: 8192, maxContext: 131072 };
            if (channel === 'lmstudio-ensure-model') ensures.push(opts);
            return null;
        }, lsSeed: seed });
        const els = elements();
        mount(ui, els);

        await ui.refreshCurrentLoadedContext();
        await new Promise(r => setTimeout(r, 5));

        assert.equal(ensures.length, 0, `no auto-reload with ${JSON.stringify(seed)}`);
    }
});

test('a FAILED below-min reload backs off (no churn) and reports the VRAM reality on the chip', async () => {
    const ensures = [];
    let loadedCtx = 8192; // hardware can only hold 8K — every attempt lands back at 8192
    const ui = loadUi({ invoke: async (channel, opts) => {
        if (channel === 'lmstudio-get-status') return { managed: true, model: opts.model, loadedContext: loadedCtx, maxContext: 131072 };
        if (channel === 'lmstudio-ensure-model') ensures.push(opts.contextLength);
        return { managed: true, requestedContext: opts.contextLength, loadedContext: loadedCtx, fallbackUsed: true, warning: `Requested context ${opts.contextLength} could not load; using ${loadedCtx}.` };
    }});
    const els = elements();
    mount(ui, els);

    await ui.refreshCurrentLoadedContext();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(ensures.length, 1, 'first attempt fires');
    assert.match(els.chipEl.textContent, /below min|retry/i);

    // Second refresh within the back-off window: NO second full reload of a multi-GB model.
    await ui.refreshCurrentLoadedContext();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(ensures.length, 1, 'backed off — no churn while the state is unfixable');

    // The send gate sees "backoff" for this model (so it can say "retrying automatically").
    const st = ui.getMinCtxReloadState('google/gemma-4-e4b');
    assert.equal(st.state, 'backoff');
});

test('a SUCCESSFUL reload clears the back-off so a later regression is fixed again', async () => {
    let loadedCtx = 8192;
    const ensures = [];
    const ui = loadUi({ invoke: async (channel, opts) => {
        if (channel === 'lmstudio-get-status') return { managed: true, model: opts.model, loadedContext: loadedCtx, maxContext: 131072 };
        if (channel === 'lmstudio-ensure-model') ensures.push(opts.contextLength);
        // First attempt fails (VRAM), second succeeds.
        const ok = ensures.length >= 2;
        if (ok) loadedCtx = opts.contextLength;
        return { managed: true, requestedContext: opts.contextLength, loadedContext: ok ? opts.contextLength : loadedCtx };
    }});
    const els = elements();
    mount(ui, els);

    await ui.refreshCurrentLoadedContext();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(ensures.length, 1);
    assert.equal(ui.getMinCtxReloadState('google/gemma-4-e4b').state, 'backoff');

    // Simulate the back-off expiring (60s) — the next refresh retries and succeeds.
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    try {
        await ui.refreshCurrentLoadedContext();
        await new Promise(r => setTimeout(r, 5));
        assert.equal(ensures.length, 2, 'retry after back-off');
        assert.equal(ui.getMinCtxReloadState('google/gemma-4-e4b').state, null, 'success cleared the back-off');
    } finally {
        Date.now = realNow;
    }
});

test('awaitMinCtxReload joins an in-flight auto-reload and re-verifies (send-gate path)', async () => {
    let loadedCtx = 16384;
    const ui = loadUi({ invoke: async (channel, opts) => {
        if (channel === 'lmstudio-get-status') return { managed: true, model: opts.model, loadedContext: loadedCtx, maxContext: 131072 };
        if (channel === 'lmstudio-ensure-model') { await new Promise(r => setTimeout(r, 10)); loadedCtx = opts.contextLength; return { managed: true, requestedContext: opts.contextLength, loadedContext: opts.contextLength }; }
        return null;
    }});
    const els = elements();
    mount(ui, els);

    // The refresh kicks off the reload (fire-and-forget) and returns immediately…
    await ui.refreshCurrentLoadedContext();
    assert.equal(ui.getMinCtxReloadState('google/gemma-4-e4b').state, 'in_flight');
    // …and the send gate joins it. By the time this resolves the model is at 32000.
    const fixed = await ui.awaitMinCtxReload('google/gemma-4-e4b', 5000);
    assert.equal(fixed, true, 'gate re-verifies against the FIXED window');
});

test('awaitMinCtxReload is a no-op when nothing is in flight for this model', async () => {
    const ui = loadUi({ invoke: async (channel) => {
        if (channel === 'lmstudio-get-status') return { managed: true, loadedContext: 65536 };
        return null;
    }});
    const els = elements();
    mount(ui, els);
    await ui.refreshCurrentLoadedContext();
    assert.equal(await ui.awaitMinCtxReload('google/gemma-4-e4b', 100), false);
});

test('busy runs do not trigger an immediate auto-reload (the refresh loop retries next tick)', async () => {
    const ensures = [];
    let busy = true;
    const ui = loadUi({ invoke: async (channel, opts) => {
        if (channel === 'lmstudio-get-status') return { managed: true, model: opts.model, loadedContext: 8192, maxContext: 131072 };
        if (channel === 'lmstudio-ensure-model') ensures.push(opts.contextLength);
        return null;
    }});
    const els = elements();
    mount(ui, els, { isBusy: () => busy });

    await ui.refreshCurrentLoadedContext();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(ensures.length, 0, 'never reload mid-run');

    busy = false;
    await ui.refreshCurrentLoadedContext(); // next tick — now it fires
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(ensures, [32000]);
});

test('unmanaged / unreachable endpoints: no auto-reload (nothing to reload against)', async () => {
    const ensures = [];
    for (const status of [{ managed: false, reason: 'remote_endpoint' }, { managed: false, reason: 'lmstudio_unavailable', warning: 'down' }]) {
        const ui = loadUi({ invoke: async (channel) => {
            if (channel === 'lmstudio-get-status') return status;
            if (channel === 'lmstudio-ensure-model') ensures.push(channel);
            return null;
        }});
        const els = elements();
        mount(ui, els);

        await ui.refreshCurrentLoadedContext();
        await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(ensures.length, 0);
});
