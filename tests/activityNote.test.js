// Regression: the model's own words between tool calls ("the outer wrapper is swallowing my
// $ variables") used to share the per-turn Reasoning panel, which is reset on every
// turn_start — so a real answer appeared for one turn and then vanished. Content
// (assistant_delta) must get its own persistent block; reasoning (reasoning_delta) keeps the
// per-turn panel. Legacy 'delta' events from older builds still render as reasoning.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeEl() {
    const classes = new Set();
    const el = {
        className: '', innerHTML: '', textContent: '', title: '', open: false,
        style: {}, dataset: {}, children: [], parentNode: null,
        scrollTop: 0, scrollHeight: 0,
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c)
        },
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c) { c.parentNode = el; el.children.unshift(c); return c; },
        removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
        remove() { if (el.parentNode) el.parentNode.removeChild(el); },
        setAttribute() {}, getAttribute() { return null; },
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

const notes = (container) => container.children.filter(c => c.className === 'activity-note');

test('model text between tool calls survives the next turn — reasoning stays per-turn', () => {
    const container = fakeEl();
    const inst = tl.mount(container, { updateEmptyState: () => {} });

    inst.handleCodeEvent({ type: 'run_start' });
    inst.handleCodeEvent({ type: 'turn_start', turn: 1 });
    inst.handleCodeEvent({ type: 'reasoning_delta', text: 'checking the outer wrapper…' });
    inst.handleCodeEvent({ type: 'assistant_delta', text: 'The outer wrapper is swallowing my $ variables.' });

    assert.equal(notes(container).length, 1, 'assistant content gets its own block');
    assert.match(notes(container)[0].textContent, /swallowing my \$ variables/);

    // Next turn resets the reasoning panel — the spoken text must stay.
    inst.handleCodeEvent({ type: 'turn_start', turn: 2 });
    inst.handleCodeEvent({ type: 'assistant_delta', text: 'Scripts go to disk, always.' });

    const all = notes(container);
    assert.equal(all.length, 2, 'each turn starts a new committed block');
    assert.ok(all.some(n => /swallowing my \$ variables/.test(n.textContent)), 'earlier turn still on screen');
    assert.ok(all.some(n => /Scripts go to disk/.test(n.textContent)), 'new turn also visible');
});

test('a legacy delta event still renders as reasoning, not as a persistent answer', () => {
    const container = fakeEl();
    const inst = tl.mount(container, { updateEmptyState: () => {} });
    inst.handleCodeEvent({ type: 'run_start' });
    inst.handleCodeEvent({ type: 'delta', text: 'merged content from an older build' });
    assert.equal(notes(container).length, 0);
});
