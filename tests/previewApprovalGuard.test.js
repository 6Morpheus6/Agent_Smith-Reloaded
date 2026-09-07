// The preview drawer must NOT auto-open over the Build Plan while Code Mode is planning or
// awaiting approval (a show_preview during planning, or a stale preview event, used to take
// over the sidebar and block the approval controls). It must still auto-open during
// execution and for no-plan (idle->grind) runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeEl() {
    return {
        innerHTML: '', textContent: '', style: {},
        addEventListener() {}, setAttribute() {},
        querySelector() { return null; }, querySelectorAll() { return []; }
    };
}

let enterCalls;
function setup(phase) {
    enterCalls = [];
    global.window = {
        XKCodePlanPanel: { getState: () => ({ phase }) },
        XKSidebarLayout: {
            enterPreviewMode: (o) => enterCalls.push(o),
            exitPreviewMode() {}, openPreviewDrawer() {}, collapsePreviewDrawer() {}
        }
    };
    global.document = { getElementById: () => fakeEl() };
    global.localStorage = { getItem: () => null };
}
function load() {
    delete require.cache[require.resolve('../src/renderer/ui/previewPanel.js')];
    const p = require('../src/renderer/ui/previewPanel.js');
    p.init();
    return p;
}

test('does NOT auto-open the preview drawer during PLANNING', () => {
    setup('planning'); const p = load();
    p.handleEvent({ type: 'live', liveUrl: 'http://x/p', relPath: 'index.html' });
    assert.equal(enterCalls.length, 0, 'planning must keep the plan sidebar unobstructed');
});

test('does NOT auto-open the preview drawer during APPROVAL', () => {
    setup('approval'); const p = load();
    p.handleEvent({ type: 'snapshot', snapshotUrl: 'http://x/s.png' });
    p.handleEvent({ type: 'pick_source', previewId: 'pv1', kind: 'desktop' });
    assert.equal(enterCalls.length, 0, 'approval controls must have priority over preview');
});

test('DOES auto-open the preview drawer during EXECUTION (post-approval show_preview)', () => {
    setup('executing'); const p = load();
    p.handleEvent({ type: 'live', liveUrl: 'http://x/p', relPath: 'index.html' });
    assert.equal(enterCalls.length, 1, 'execution-time previews still open');
});

test('DOES auto-open for an idle/no-plan run (grind mode, no approval gate)', () => {
    setup('idle'); const p = load();
    p.handleEvent({ type: 'live', liveUrl: 'http://x/p', relPath: 'index.html' });
    assert.equal(enterCalls.length, 1);
});
