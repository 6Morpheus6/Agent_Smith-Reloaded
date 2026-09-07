// Asset-completion / recovery policy (per-run workspace state — NOT vector/long-term memory):
// after an HTML entry point is created, the harness scans it for linked CSS/JS, tracks any
// missing ones, and keeps proactively steering the model to CREATE them (and FIX broken ones)
// before it can rewrite the HTML again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    syncPendingAfterHtmlWrite, clearPendingIfCreated, checkMissingRefWrite
} = require('../src/code/loop/missingRefGuard.js');

function mkSite({ css = false, js = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-'));
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site/index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>'
        + '<body><div id="app"></div><script src="script.js"></script></body></html>');
    if (css) fs.writeFileSync(path.join(root, 'site/style.css'), 'body{margin:0}');
    if (js) fs.writeFileSync(path.join(root, 'site/script.js'), 'console.log(1)');
    return root;
}

test('creating index.html with missing linked assets proactively arms the repair nudge', () => {
    const root = mkSite(); // neither asset exists
    const session = { projectRoot: root };
    const missing = syncPendingAfterHtmlWrite(session, 'site/index.html');
    assert.deepEqual(missing.sort(), ['site/script.js', 'site/style.css']);
    assert.deepEqual([...session.pendingMissingRefs].sort(), ['site/script.js', 'site/style.css']);
    assert.equal(session._injectMissingRefsNudge, true, 'high-priority repair nudge armed before next turn');
    fs.rmSync(root, { recursive: true, force: true });
});

test('creating ONE asset while another is still missing re-arms the nudge (no drift back to HTML)', () => {
    const session = { pendingMissingRefs: ['site/script.js', 'site/style.css'] };
    clearPendingIfCreated(session, 'site/style.css'); // model just created the css
    assert.deepEqual(session.pendingMissingRefs, ['site/script.js'], 'css removed, script still pending');
    assert.equal(session._injectMissingRefsNudge, true, 'nudge re-armed to create the remaining file');
});

test('creating the LAST missing asset clears pending and stops nudging', () => {
    const session = { pendingMissingRefs: ['site/script.js'] };
    clearPendingIfCreated(session, 'site/script.js');
    assert.equal(session.pendingMissingRefs, undefined);
    assert.ok(!session._injectMissingRefsNudge, 'no nudge once everything exists');
});

// Requirement #8 — the exact scenario.
test('exact scenario: index.html references missing script.js -> rewrite blocked, directed to site/script.js', () => {
    const root = mkSite({ css: true }); // style.css present, script.js missing
    const session = { projectRoot: root, pendingMissingRefs: ['site/script.js'] };
    const res = checkMissingRefWrite(session, 'write_file', {
        path: 'site/index.html',
        content: '<!doctype html><html>...rewrite attempt...</html>'
    });
    assert.ok(res && res.blockedReason === 'html_rewrite_while_refs_missing', 'rewrite is blocked');
    assert.match(res.error, /CREATE site\/script\.js/, 'directs to the COMPLETE path of the missing file');
    assert.match(res.error, /do NOT rewrite/i);
    assert.equal(session._injectMissingRefsNudge, true);
    // and the recovery is not a trap: creating script.js itself is allowed
    assert.equal(checkMissingRefWrite(session, 'write_file', { path: 'site/script.js', content: 'init();' }), null);
    fs.rmSync(root, { recursive: true, force: true });
});

test('once all assets exist, an HTML edit is NOT blocked (legitimate edits still work)', () => {
    const root = mkSite({ css: true, js: true }); // everything present
    const session = { projectRoot: root };
    syncPendingAfterHtmlWrite(session, 'site/index.html'); // no missing -> clears pending
    assert.equal(session.pendingMissingRefs, undefined);
    assert.equal(checkMissingRefWrite(session, 'write_file', { path: 'site/index.html', content: '<html>edit</html>' }), null);
    fs.rmSync(root, { recursive: true, force: true });
});
