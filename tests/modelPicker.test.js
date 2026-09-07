/**
 * v52.2 model dropdown polish — the themed picker (src/renderer/ui/modelPicker.js)
 * must stay readable with long LM Studio model ids and must show which model is
 * actually loaded in LM Studio right now.
 *
 * Regression coverage:
 *  - every option renders as its own row (name span + optional badge), so long
 *    ids ellipsize instead of crowding the list;
 *  - the option matching select.dataset.loadedModelId gets .mp-item--loaded and a
 *    "LOADED" badge, all others do not;
 *  - updating data-loaded-model-id while the menu is open re-renders (the
 *    MutationObserver contract app.js relies on to keep the marker live);
 *  - picking an item still writes select.value + fires change and closes the menu.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* optional dep */ }

const PICKER_HTML = `<!doctype html><body>
  <div id="sidebar">
    <label class="ctx-row ctx-model" title="Active model">
      <span class="ctx-ico" aria-hidden="true">▮</span>
      <select id="model-select" class="ctx-select">
        <option value="qwen3.5-9b-instruct-q4_k_m">qwen3.5-9b-instruct-q4_k_m</option>
        <option value="llama-3.1-8b-instant">llama-3.1-8b-instant</option>
        <option value="mistral-small-24b-instruct-v0.2-q5_K_M">mistral-small-24b-instruct-v0.2-q5_K_M</option>
      </select>
    </label>
  </div>
</body>`;

async function boot() {
    const dom = new JSDOM(PICKER_HTML);
    global.window = dom.window;
    global.document = dom.window.document;
    global.Event = dom.window.Event;
    global.MutationObserver = dom.window.MutationObserver;

    delete require.cache[require.resolve('../src/renderer/ui/modelPicker.js')];
    require('../src/renderer/ui/modelPicker.js'); // self-inits (readyState complete)

    const g = (id) => dom.window.document.getElementById(id);
    return { dom, g };
}

test('v52.2: every option renders as its own row with a name span', async () => {
    if (!JSDOM) return;
    const { g } = await boot();
    const select = g('model-select');
    const btn = g('model-select').closest('.ctx-model').querySelector('.mp-btn');

    assert.ok(btn, 'themed picker button replaced the native control');
    btn.click(); // open

    const items = Array.from(g('model-select').closest('.ctx-model').querySelectorAll('.mp-item'));
    assert.equal(items.length, 3, 'one row per option');
    for (const item of items) {
        const name = item.querySelector('.mp-item-name');
        assert.ok(name, `row has a name span: ${item.dataset.value}`);
        assert.equal(name.textContent, item.dataset.value, 'name text matches the option value');
    }
});

test('v52.2: only the loaded model gets the LOADED badge', async () => {
    if (!JSDOM) return;
    const { g } = await boot();
    const select = g('model-select');
    const wrap = select.closest('.ctx-model');

    // app.js sets this from /api/v1/models loaded_instances.
    select.dataset.loadedModelId = 'llama-3.1-8b-instant';
    wrap.querySelector('.mp-btn').click(); // open

    const items = Array.from(wrap.querySelectorAll('.mp-item'));
    const badged = items.filter(i => i.classList.contains('mp-item--loaded'));
    assert.equal(badged.length, 1, 'exactly one row is marked loaded');
    assert.equal(badged[0].dataset.value, 'llama-3.1-8b-instant');
    const badge = badged[0].querySelector('.mp-badge');
    assert.ok(badge && /LOADED/i.test(badge.textContent), 'badge text says LOADED');

    for (const other of items.filter(i => i !== badged[0])) {
        assert.equal(other.querySelector('.mp-badge'), null, `no badge on ${other.dataset.value}`);
    }
});

test('v52.2: changing data-loaded-model-id while open re-renders the marker', async () => {
    if (!JSDOM) return;
    const { g } = await boot();
    const select = g('model-select');
    const wrap = select.closest('.ctx-model');

    select.dataset.loadedModelId = 'llama-3.1-8b-instant';
    wrap.querySelector('.mp-btn').click(); // open
    assert.equal(wrap.querySelectorAll('.mp-item--loaded').length, 1);

    // LM Studio loaded a different model while the menu was open (app.js updates
    // the attribute on the next fetchModels pass) — the marker must follow.
    select.dataset.loadedModelId = 'mistral-small-24b-instruct-v0.2-q5_K_M';
    await new Promise(r => setTimeout(r, 50)); // MutationObserver microtask + render

    const loaded = wrap.querySelectorAll('.mp-item--loaded');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].dataset.value, 'mistral-small-24b-instruct-v0.2-q5_K_M',
        'badge moved to the newly loaded model');
});

test('v52.2: picking a row still sets select.value, fires change, closes menu', async () => {
    if (!JSDOM) return;
    const { g } = await boot();
    const select = g('model-select');
    const wrap = select.closest('.ctx-model');

    let changed = 0;
    select.addEventListener('change', () => { changed++; });

    wrap.querySelector('.mp-btn').click(); // open
    const target = Array.from(wrap.querySelectorAll('.mp-item'))
        .find(i => i.dataset.value === 'qwen3.5-9b-instruct-q4_k_m');
    target.click();

    assert.equal(select.value, 'qwen3.5-9b-instruct-q4_k_m', 'native select is the source of truth');
    assert.equal(changed, 1, 'change event fired for app.js wiring (localStorage remember)');
    assert.ok(wrap.querySelector('.mp-menu').hidden, 'menu closed after pick');
});
