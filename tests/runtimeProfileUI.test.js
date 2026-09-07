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
    dispatch(name) {
        for (const fn of this.listeners.get(name) || []) fn({ target: this });
    }
}

function makeStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

function loadUi(invoke, profile = {}) {
    global.localStorage = makeStorage();
    const runtimeProfile = {
        buildRuntimeProfile: () => ({
            numCtx: 65536,
            temperature: 0.2,
            codeTemperature: 0.15,
            maxSteps: 25,
            maxTurns: 50,
            summary: 'Gemma ctx 64K',
            warnings: [],
            ...profile
        })
    };
    global.window = {
        api: { invoke },
        XKRuntimeProfile: runtimeProfile
    };
    global.XKRuntimeProfile = runtimeProfile;
    const file = require.resolve('../src/renderer/ui/runtimeProfileUI.js');
    delete require.cache[file];
    return require(file);
}

function elements() {
    return {
        modelSelect: new FakeElement('google/gemma-4-e4b'),
        tempSlider: new FakeElement('0.5'),
        tempVal: new FakeElement(),
        ctxSlider: new FakeElement('8192'),
        ctxVal: new FakeElement(),
        stepsSlider: new FakeElement('20'),
        stepsVal: new FakeElement(),
        chipEl: new FakeElement(),
        toggleEl: new FakeElement()
    };
}

beforeEach(() => {
    delete global.window;
    delete global.localStorage;
});

afterEach(() => {
    delete global.window;
    delete global.localStorage;
    delete global.XKRuntimeProfile;
});

test('auto-tune immediately synchronizes the profile context with LM Studio', async () => {
    const calls = [];
    const ui = loadUi(async (channel, opts) => {
        calls.push([channel, opts]);
        if (channel === 'get-gpu-telemetry') return { memory: { total: 24576 } };
        return {
            managed: true, model: opts.model, requestedContext: opts.contextLength,
            loadedContext: opts.contextLength, maxContext: 131072, fallbackUsed: false
        };
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://127.0.0.1:1234',
        isBusy: () => false,
        debounceMs: 5
    });

    await ui.applyForCurrentModel();

    const ensure = calls.find(call => call[0] === 'lmstudio-ensure-model');
    assert.deepEqual(ensure[1], {
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'google/gemma-4-e4b',
        contextLength: 65536
    });
    assert.match(els.chipEl.textContent, /64K|65536/);
});

test('manual context changes are debounced and only apply the final value', async () => {
    const contexts = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'lmstudio-ensure-model') {
            contexts.push(opts.contextLength);
            return { managed: true, loadedContext: opts.contextLength, maxContext: 131072 };
        }
        return null;
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://localhost:1234',
        isBusy: () => false,
        debounceMs: 5
    });

    els.ctxSlider.value = '32768';
    els.ctxSlider.dispatch('input');
    els.ctxSlider.value = '49152';
    els.ctxSlider.dispatch('input');
    els.ctxSlider.value = '65536';
    els.ctxSlider.dispatch('input');
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(contexts, [65536]);
});

test('fallback updates the slider to the context LM Studio actually loaded', async () => {
    const ui = loadUi(async (channel) => {
        if (channel === 'get-gpu-telemetry') return {};
        return {
            managed: true, requestedContext: 65536, loadedContext: 49152,
            maxContext: 131072, fallbackUsed: true,
            warning: 'Requested context 65536 could not load; using 49152.'
        };
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://127.0.0.1:1234',
        isBusy: () => false
    });

    await ui.applyForCurrentModel();

    assert.equal(els.ctxSlider.value, '49152');
    assert.equal(els.ctxVal.textContent, '49152');
    assert.match(els.chipEl.textContent, /fallback|49152/i);
});

test('busy runs queue the newest context until flushPendingContextSync', async () => {
    let busy = true;
    const contexts = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'get-gpu-telemetry') return {};
        if (channel === 'lmstudio-ensure-model') {
            contexts.push(opts.contextLength);
            return { managed: true, loadedContext: opts.contextLength };
        }
        return null;
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://127.0.0.1:1234',
        isBusy: () => busy
    });

    await ui.applyForCurrentModel();
    assert.deepEqual(contexts, []);
    assert.match(els.chipEl.textContent, /queued/i);

    busy = false;
    await ui.flushPendingContextSync();
    assert.deepEqual(contexts, [65536]);
});

// --- v52.5: model swap must not trigger a second full reload -----------------

test('markSwapHandled suppresses the redundant post-swap context sync (v52.5)', async () => {
    const calls = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'get-gpu-telemetry') return {};
        calls.push([channel, opts]);
        return { managed: true, loadedContext: opts?.contextLength || 65536, maxContext: 131072 };
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://127.0.0.1:1234',
        isBusy: () => false
    });

    // The swap (lmstudio-swap-model) already loaded the selection at its context —
    // app.js marks it handled, then applyForCurrentModel must NOT re-sync.
    ui.markSwapHandled('google/gemma-4-e4b');
    await ui.applyForCurrentModel();

    const ensures = calls.filter(c => c[0] === 'lmstudio-ensure-model');
    assert.equal(ensures.length, 0, 'no second reload after a swap handled the load');
});

test('markSwapHandled is single-use and model-specific (v52.5)', async () => {
    const calls = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'get-gpu-telemetry') return {};
        calls.push([channel, opts]);
        return { managed: true, loadedContext: opts?.contextLength || 65536, maxContext: 131072 };
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://127.0.0.1:1234',
        isBusy: () => false
    });

    // A swap for a DIFFERENT model must not suppress this model's sync…
    ui.markSwapHandled('other/model');
    await ui.applyForCurrentModel();
    assert.equal(calls.filter(c => c[0] === 'lmstudio-ensure-model').length, 1);

    // …and the same flag is single-use: a second apply re-syncs normally.
    calls.length = 0;
    await ui.applyForCurrentModel();
    assert.equal(calls.filter(c => c[0] === 'lmstudio-ensure-model').length, 1);
});

test('flushPendingContextSync drops a stale sync after the selection moved (v52.5)', async () => {
    let busy = true;
    const contexts = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'get-gpu-telemetry') return {};
        if (channel === 'lmstudio-ensure-model') {
            contexts.push(opts.model);
            return { managed: true, loadedContext: opts.contextLength };
        }
        return null;
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://127.0.0.1:1234',
        isBusy: () => busy
    });

    // Busy run queues a sync for the CURRENT model…
    await ui.applyForCurrentModel();
    assert.deepEqual(contexts, []);

    // …then the user picks a different model (a swap takes over). Flushing must NOT
    // load the old model back.
    els.modelSelect.value = 'other/model';
    busy = false;
    await ui.flushPendingContextSync();
    assert.deepEqual(contexts, [], 'stale sync for the previous model was dropped');
});
