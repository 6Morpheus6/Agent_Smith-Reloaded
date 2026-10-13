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
    delete global.document; // v56.0.1 — focus-simulation in the typed-field tests
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

test('v55.9.2 — dragging the ctx slider no longer auto-syncs (APPLY button owns the reload)', async () => {
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

    // Dragging the slider (any number of ticks) must NOT queue a full model reload…
    els.ctxSlider.value = '32768';
    els.ctxSlider.dispatch('input');
    els.ctxSlider.value = '49152';
    els.ctxSlider.dispatch('input');
    els.ctxSlider.value = '65536';
    els.ctxSlider.dispatch('input');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(contexts, [], 'slider drags alone never reload LM Studio');

    // …pressing APPLY commits exactly the value on the slider.
    const result = await ui.applyCtx('google/gemma-4-e4b', els.ctxSlider.value);
    assert.deepEqual(contexts, [65536]);
    assert.equal(result.loadedContext, 65536);
});

test('v55.9.2 — APPLY accepts a context ABOVE the 32000 minimum and mirrors what loaded', async () => {
    const contexts = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'lmstudio-ensure-model') {
            contexts.push(opts.contextLength);
            // LM Studio honors the request — 131072 loads fine.
            return { managed: true, requestedContext: opts.contextLength, loadedContext: opts.contextLength, maxContext: 262144 };
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
        isBusy: () => false
    });

    const result = await ui.applyCtx('google/gemma-4-e4b', 131072);
    assert.deepEqual(contexts, [131072], 'the exact requested window was sent to LM Studio');
    assert.equal(result.loadedContext, 131072);
    // The slider + display now mirror the REAL loaded window (no snap-back to 32000).
    assert.equal(els.ctxSlider.value, '131072');
    assert.equal(els.ctxVal.textContent, '131072');
});

test('v55.9.2 — APPLY reports a VRAM fallback honestly instead of snapping the slider back', async () => {
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'lmstudio-ensure-model') {
            return { managed: true, requestedContext: opts.contextLength, loadedContext: 49152, maxContext: 262144, fallbackUsed: true, warning: `Requested context ${opts.contextLength} could not load; using 49152.` };
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
        isBusy: () => false
    });

    const result = await ui.applyCtx('google/gemma-4-e4b', 98304);
    assert.equal(result.fallbackUsed, true);
    // The slider shows what ACTUALLY loaded (49152), and the chip says why.
    assert.equal(els.ctxSlider.value, '49152');
    assert.match(els.chipEl.textContent, /fallback|49152/i);
});

test('v55.9.2 — APPLY on an unmanaged endpoint keeps the user value and reports why', async () => {
    const ui = loadUi(async (channel) => {
        if (channel === 'lmstudio-ensure-model') return { managed: false, reason: 'remote_endpoint' };
        return null;
    });
    const els = elements();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        getApiBaseUrl: () => 'http://localhost:1234',
        isBusy: () => false
    });

    // The user drags the slider to 65536, then presses APPLY on an unmanaged endpoint.
    els.ctxSlider.value = '65536';
    const result = await ui.applyCtx('google/gemma-4-e4b', els.ctxSlider.value);
    assert.equal(result.managed, false);
    // Nothing to reload against — the slider keeps the user's value.
    assert.equal(els.ctxSlider.value, '65536');
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

// --- v56.0.1: typed custom-context field (next to the Auto-tune toggle) --------

function elementsWithTypedCtx() {
    const els = elements();
    els.customCtxInput = new FakeElement('');
    els.customApplyBtn = new FakeElement();
    return els;
}

test('v56.0.1 — typed ctx value reloads LM Studio at exactly that window and mirrors back', async () => {
    const contexts = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'lmstudio-ensure-model') {
            contexts.push(opts.contextLength);
            return { managed: true, requestedContext: opts.contextLength, loadedContext: opts.contextLength, maxContext: 262144 };
        }
        return null;
    });
    const els = elementsWithTypedCtx();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        customCtxInput: els.customCtxInput,
        customApplyBtn: els.customApplyBtn,
        getApiBaseUrl: () => 'http://localhost:1234',
        isBusy: () => false
    });

    // The user types a value the slider can't even express and presses APPLY.
    els.customCtxInput.value = '98304';
    const result = await ui.applyCtx('google/gemma-4-e4b', els.customCtxInput.value);
    assert.deepEqual(contexts, [98304], 'the exact typed window was sent to LM Studio');
    assert.equal(result.loadedContext, 98304);
    // Both the slider and the typed field mirror what actually loaded.
    assert.equal(els.ctxSlider.value, '98304');
    assert.equal(els.customCtxInput.value, '98304');
});

test('v56.0.1 — Enter in the typed field commits (same as pressing APPLY)', async () => {
    const contexts = [];
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'lmstudio-ensure-model') {
            contexts.push(opts.contextLength);
            return { managed: true, loadedContext: opts.contextLength };
        }
        return null;
    });
    const els = elementsWithTypedCtx();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        customCtxInput: els.customCtxInput,
        customApplyBtn: els.customApplyBtn,
        getApiBaseUrl: () => 'http://localhost:1234',
        isBusy: () => false
    });

    els.customCtxInput.value = '65536';
    // FakeElement.dispatch has no preventDefault — call the keydown listener with a real event shape.
    for (const fn of els.customCtxInput.listeners.get('keydown') || []) {
        fn({ target: els.customCtxInput, key: 'Enter', preventDefault() {} });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(contexts, [65536], 'Enter committed the typed value');

    // The APPLY button commits too.
    contexts.length = 0;
    els.customCtxInput.value = '49152';
    els.customApplyBtn.dispatch('click');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(contexts, [49152], 'APPLY button committed the typed value');
});

test('v56.0.1 — VRAM fallback: typed field shows what ACTUALLY loaded', async () => {
    const ui = loadUi(async (channel, opts) => {
        if (channel === 'lmstudio-ensure-model') {
            return { managed: true, requestedContext: opts.contextLength, loadedContext: 49152, maxContext: 262144, fallbackUsed: true, warning: `Requested context ${opts.contextLength} could not load; using 49152.` };
        }
        return null;
    });
    const els = elementsWithTypedCtx();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        customCtxInput: els.customCtxInput,
        customApplyBtn: els.customApplyBtn,
        getApiBaseUrl: () => 'http://localhost:1234',
        isBusy: () => false
    });

    els.customCtxInput.value = '98304';
    const result = await ui.applyCtx('google/gemma-4-e4b', els.customCtxInput.value);
    assert.equal(result.fallbackUsed, true);
    // The field must not claim the 98304 window LM Studio refused.
    assert.equal(els.customCtxInput.value, '49152');
});

test('v56.0.1 — reflection mirrors the verified loaded ctx into the typed field', async () => {
    const ui = loadUi(async (channel) => {
        if (channel === 'lmstudio-get-status') return { managed: true, loadedContext: 49152 };
        return null;
    });
    const els = elementsWithTypedCtx();
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        customCtxInput: els.customCtxInput,
        customApplyBtn: els.customApplyBtn,
        getApiBaseUrl: () => 'http://localhost:1234',
        isBusy: () => false
    });

    // Mount already reflected once; force another read to be sure.
    await ui.refreshCurrentLoadedContext();
    assert.equal(els.customCtxInput.value, '49152');
});

test('v56.0.1 — reflection never clobbers the field while the user is typing', async () => {
    const ui = loadUi(async (channel) => {
        if (channel === 'lmstudio-get-status') return { managed: true, loadedContext: 49152 };
        return null;
    });
    const els = elementsWithTypedCtx();
    global.document = { activeElement: els.customCtxInput }; // user is typing in the field
    ui.mount({
        modelSelect: els.modelSelect,
        sliders: els,
        chipEl: els.chipEl,
        toggleEl: els.toggleEl,
        customCtxInput: els.customCtxInput,
        customApplyBtn: els.customApplyBtn,
        getApiBaseUrl: () => 'http://localhost:1234',
        isBusy: () => false
    });

    els.customCtxInput.value = '131072'; // mid-typing value
    await ui.refreshCurrentLoadedContext();
    assert.equal(els.customCtxInput.value, '131072', 'focused field keeps the user\'s in-progress text');
});
