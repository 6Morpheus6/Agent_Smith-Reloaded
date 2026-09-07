// Blocked-write recovery: when the model tries to rewrite a working index.html while linked
// assets are missing/broken, the harness must BLOCK the rewrite and hand back a clear, complete
// repair plan (create the missing .js, fix the bad .css) — not trap the model into rewriting
// index.html or force a single truncated path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkMissingRefWrite } = require('../src/code/loop/missingRefGuard.js');
const { buildMissingRefsNudge } = require('../src/code/context/artifactHints.js');
const { collectBadRefsFromHtml, buildRepairPlanLines } = require('../src/code/governor/repairPlan.js');

// Scenario from the bug report: existing site/index.html, missing site/script.js,
// bad site/style.css (contains HTML).
function scenario() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwr-'));
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site/index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>'
        + '<body><div id="app"></div><script src="script.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'site/style.css'),
        '<!doctype html><html><body><div class="card">oops this is HTML not CSS</div></body></html>');
    // site/script.js is intentionally absent
    return root;
}

test('blocks the index.html rewrite and directs CREATE script.js + FIX style.css', () => {
    const root = scenario();
    const session = { projectRoot: root, pendingMissingRefs: ['site/script.js'] };
    const res = checkMissingRefWrite(session, 'write_file', {
        path: 'site/index.html',
        content: '<!doctype html><html>...rewritten...</html>'
    });
    assert.ok(res && res.blockedReason === 'html_rewrite_while_refs_missing', 'rewrite is blocked');
    // structured plan, complete paths, both actions
    assert.match(res.error, /CREATE site\/script\.js/);
    assert.match(res.error, /FIX site\/style\.css/);
    assert.match(res.error, /do NOT rewrite the HTML/i);
    // does not force ONE exact tool — patch is offered for repair
    assert.match(res.error, /patch/);
    // arms the next-turn repair nudge
    assert.equal(session._injectMissingRefsNudge, true);
    assert.deepEqual(session.pendingBadRefs, ['site/style.css']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('writing the missing file itself is ALLOWED (recovery is not a trap)', () => {
    const root = scenario();
    const session = { projectRoot: root, pendingMissingRefs: ['site/script.js'] };
    const allowed = checkMissingRefWrite(session, 'write_file', { path: 'site/script.js', content: 'console.log(1);' });
    assert.equal(allowed, null, 'creating the missing script.js is not blocked');
    fs.rmSync(root, { recursive: true, force: true });
});

test('normal file creation is not blocked when nothing is pending', () => {
    const root = scenario();
    const session = { projectRoot: root }; // no pendingMissingRefs
    assert.equal(checkMissingRefWrite(session, 'write_file', { path: 'site/index.html', content: '<html></html>' }), null);
    fs.rmSync(root, { recursive: true, force: true });
});

test('the next-turn nudge repeats the structured repair plan (repair, do not restart)', () => {
    const root = scenario();
    const nudge = buildMissingRefsNudge(['site/script.js'], 'build a website', root);
    assert.match(nudge, /REPAIR, DO NOT RESTART/i);
    assert.match(nudge, /CREATE site\/script\.js/);
    assert.match(nudge, /FIX site\/style\.css/);
    assert.match(nudge, /do NOT rewrite/i);
    fs.rmSync(root, { recursive: true, force: true });
});

test('repair-plan helpers: bad CSS detected, complete paths in lines', () => {
    const root = scenario();
    assert.deepEqual(collectBadRefsFromHtml(root, 'site/index.html'), ['site/style.css']);
    const lines = buildRepairPlanLines(['site/script.js'], ['site/style.css']);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /CREATE site\/script\.js.*JavaScript/);
    assert.match(lines[1], /FIX site\/style\.css.*CSS/);
    fs.rmSync(root, { recursive: true, force: true });
});
