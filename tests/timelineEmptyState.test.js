// Regression: the welcome/#empty-state overlay must be hidden once the Code Mode timeline
// renders content into #messages. updateEmptyState was only called at run_start (before any
// content exists) and system messages now render as toasts (not inline .message nodes), so
// the welcome page stayed on top of the live activity timeline. Inserting timeline content
// must re-check the empty state.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeEl() {
    const el = {
        className: '', innerHTML: '', textContent: '', title: '',
        style: {}, dataset: {}, children: [], parentNode: null,
        scrollTop: 0, scrollHeight: 0,
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c) { c.parentNode = el; el.children.unshift(c); return c; },
        removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
        remove() {}, setAttribute() {}, getAttribute() { return null; },
        addEventListener() {}, scrollTo() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        closest() { return null; }, getBoundingClientRect() { return { top: 0, bottom: 0 }; }
    };
    return el;
}

global.document = {
    createElement: () => fakeEl(),
    getElementById: () => fakeEl(),
    createTextNode: (t) => ({ textContent: t })
};
global.window = {
    XKEventAdapter: { adaptCodeEvent: () => null },
    XKScrollFollow: { get: () => null }
};

const tl = require('../src/renderer/timeline/activityTimeline.js');

test('inserting timeline content re-calls updateEmptyState (hides the welcome overlay)', () => {
    const container = fakeEl();
    let checks = 0;
    const inst = tl.mount(container, { updateEmptyState: () => { checks++; } });

    inst.handleCodeEvent({ type: 'run_start' });
    const afterRunStart = checks; // run_start checks once, before any content

    inst.handleCodeEvent({ type: 'turn_start', turn: 1 }); // inserts a turn header into #messages
    assert.ok(checks > afterRunStart, 'a turn header is content — must re-check empty state');
    // and the node really landed in the container that updateEmptyState inspects
    assert.ok(container.children.length > 0, 'timeline content inserted into #messages');
});
