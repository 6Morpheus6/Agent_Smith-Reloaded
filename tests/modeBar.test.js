/**
 * Mode bar wiring. Regression: the segmented control bailed when EITHER underlying
 * checkbox was disabled — but app.js disables the other mode's checkbox for mutual
 * exclusion, so once you entered a mode you could never leave it ("not clickable").
 * setMode must turn the current mode off first (re-enabling the other) then turn on the
 * target, and only refuse to switch when a run has locked BOTH.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function makeEl(props) {
    const listeners = {};
    return Object.assign({
        dataset: {}, checked: false, disabled: false,
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        dispatchEvent(ev) { (listeners[ev.type] || []).slice().forEach(fn => fn(ev)); return true; }
    }, props);
}

function setupDom() {
    const code = makeEl({});
    const agent = makeEl({});
    const segs = ['chat', 'agent', 'code'].map(m => makeEl({ dataset: { mode: m } }));
    const byId = { 'code-mode-toggle': code, 'agent-toggle': agent };
    global.window = global;
    global.Event = function (type) { this.type = type; };
    global.document = {
        readyState: 'complete',
        getElementById: (id) => byId[id] || null,
        querySelectorAll: (sel) => (sel === '.mode-seg' ? segs : []),
        addEventListener() {}
    };
    // Mirror app.js mutual-exclusion: turning one on turns the other off and
    // DISABLES it (the exact condition that used to wedge the old setMode).
    code.addEventListener('change', () => { if (code.checked) agent.checked = false; agent.disabled = code.checked; });
    agent.addEventListener('change', () => { if (agent.checked) code.checked = false; code.disabled = agent.checked; });

    delete require.cache[require.resolve('../src/renderer/ui/modeBar.js')];
    require('../src/renderer/ui/modeBar.js'); // init() runs now (readyState=complete)
    const click = (mode) => segs.find(s => s.dataset.mode === mode).dispatchEvent({ type: 'click' });
    return { code, agent, segs, click };
}

test('can switch into and back out of every mode (the not-clickable bug)', () => {
    const { code, agent, click } = setupDom();

    click('code');
    assert.equal(code.checked, true, 'CODE on'); assert.equal(agent.checked, false);

    click('agent'); // previously wedged: agent was disabled by exclusivity
    assert.equal(agent.checked, true, 'AGENT on'); assert.equal(code.checked, false);

    click('code');
    assert.equal(code.checked, true, 'back to CODE'); assert.equal(agent.checked, false);

    click('chat');
    assert.equal(code.checked, false, 'CHAT clears both'); assert.equal(agent.checked, false);
});

test('segments stay enabled under normal mutual-exclusion (the unclickable bug)', () => {
    // Browsers do NOT fire click on a disabled <button>. The old sync() disabled ALL
    // segments whenever EITHER checkbox was disabled — but exclusivity always disables
    // the other mode's checkbox, so entering any mode froze the whole control.
    const { segs, click } = setupDom();
    click('code'); // exclusivity now disables the agent checkbox
    assert.ok(segs.every(s => !s.disabled), 'segments must remain clickable after entering a mode');
});

test('a fully-locked run (both disabled) blocks switching', () => {
    const { code, agent, click } = setupDom();
    code.disabled = true; agent.disabled = true; // setCodeLock during an active run
    click('code');
    assert.equal(code.checked, false, 'no switch while a run holds the lock');
});
