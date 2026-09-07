/**
 * Verifies auto-tune actually fires on startup: the real runtimeProfileUI + runtimeProfile
 * modules, driven through applyForCurrentModel() — exactly what fetchModels() calls on boot
 * (app.js:1585) — must read hardware telemetry, size num_ctx to the model+VRAM, override the
 * slider, and trigger an LM Studio context reload. Guards the v46.19.x context behavior.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* optional dep */ }

const SLIDER_HTML = `<!doctype html><body>
  <input type="range" id="ctx-slider" min="2048" max="131072" step="1024" value="8192"><span id="ctx-val">8192</span>
  <input type="range" id="temp-slider" value="0.7"><span id="temp-val">0.7</span>
  <input type="range" id="steps-slider" value="20"><span id="steps-val">20</span>
  <select id="model-select"><option value="qwen/qwen3-coder-30b" selected>qwen/qwen3-coder-30b</option></select>
  <input type="checkbox" id="auto-tune-toggle"><div id="runtime-profile-chip"></div></body>`;

// Build a fresh DOM + mocked main-process IPC, mount the real auto-tune UI, run the startup
// call, and report what happened. lsSeed lets a test simulate auto-tune off / manual override.
async function runStartup(lsSeed = {}) {
    const dom = new JSDOM(SLIDER_HTML);
    global.window = dom.window;
    global.document = dom.window.document;
    const store = { ...lsSeed };
    global.localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
    };
    dom.window.localStorage = global.localStorage;

    const ipc = [];
    const invoke = async (ch, arg) => {
        ipc.push({ ch, arg });
        if (ch === 'get-gpu-telemetry') return { memory: { total: 16 * 1024 }, is_high_pressure: false };
        if (ch === 'lmstudio-ensure-model') return { managed: true, loadedContext: arg.contextLength };
        return null;
    };
    dom.window.api = { invoke };

    // In the browser window === globalThis; bridge so the modules resolve their deps in Node.
    delete require.cache[require.resolve('../src/shared/runtimeProfile.js')];
    delete require.cache[require.resolve('../src/renderer/ui/runtimeProfileUI.js')];
    globalThis.XKRuntimeProfile = require('../src/shared/runtimeProfile.js');
    const RP = globalThis.XKRuntimeProfileUI = require('../src/renderer/ui/runtimeProfileUI.js');

    const g = id => dom.window.document.getElementById(id);
    const sliders = {
        tempSlider: g('temp-slider'), tempVal: g('temp-val'),
        ctxSlider: g('ctx-slider'), ctxVal: g('ctx-val'),
        stepsSlider: g('steps-slider'), stepsVal: g('steps-val')
    };
    const before = g('ctx-slider').value;
    RP.mount({
        modelSelect: g('model-select'), sliders, chipEl: g('runtime-profile-chip'),
        toggleEl: g('auto-tune-toggle'), invoke, getApiBaseUrl: () => 'http://127.0.0.1:1234', isBusy: () => false
    });
    const profile = await RP.applyForCurrentModel(); // === what fetchModels() calls on startup
    return {
        profile, before, after: g('ctx-slider').value,
        toggleChecked: g('auto-tune-toggle').checked,
        hwScan: ipc.some(c => c.ch === 'get-gpu-telemetry'),
        reloads: ipc.filter(c => c.ch === 'lmstudio-ensure-model').map(c => c.arg.contextLength)
    };
}

test('auto-tune fires on startup: scans hardware, overrides the slider, reloads LM Studio', async (t) => {
    if (!JSDOM) return t.skip('jsdom not installed');
    const r = await runStartup({}); // fresh install — empty localStorage
    assert.equal(r.toggleChecked, true, 'auto-tune toggle is on by default');
    assert.equal(r.hwScan, true, 'startup scanned hardware (get-gpu-telemetry)');
    assert.ok(r.profile && r.profile.numCtx > 8192, `sized context above the 8192 default, got ${r.profile?.numCtx}`);
    assert.equal(r.after, String(r.profile.numCtx), 'slider was overridden to the hardware-tuned value');
    assert.notEqual(r.after, r.before, 'slider moved off the 8192 placeholder');
    assert.deepEqual(r.reloads, [r.profile.numCtx], 'LM Studio reload was triggered to the tuned context');
});

test('respects user choice: auto-tune OFF -> no scan, slider stays at the default', async (t) => {
    if (!JSDOM) return t.skip('jsdom not installed');
    const r = await runStartup({ agentsmith_auto_tune: 'false' });
    assert.equal(r.profile, null, 'no profile applied when auto-tune is off');
    assert.equal(r.after, '8192', 'slider left at the conservative default');
    assert.deepEqual(r.reloads, [], 'no LM Studio reload forced');
});

test('respects a manual slider override -> startup auto-tune is skipped', async (t) => {
    if (!JSDOM) return t.skip('jsdom not installed');
    const r = await runStartup({ agentsmith_profile_override: 'true' });
    assert.equal(r.profile, null, 'manual override suppresses auto-tune');
    assert.equal(r.after, '8192', 'user-chosen slider value is preserved');
});
