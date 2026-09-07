const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    checkMissingRefWrite,
    checkMissingRefRead,
    checkPrematurePreview,
    pickNextMissing,
    clearPendingIfCreated,
    collectMissingRefsFromHtml,
    seedPendingMissingRefs
} = require('../src/code/loop/missingRefGuard.js');
const { createDefaultMiddleware, runMiddlewareChain } = require('../src/code/loop/middleware.js');

test('pickNextMissing prefers script.js over style.css', () => {
    const next = pickNextMissing(['pacman/style.css', 'pacman/script.js']);
    assert.equal(next, 'pacman/script.js');
});

test('checkMissingRefWrite blocks html rewrite while script missing', () => {
    const session = { pendingMissingRefs: ['pacman/script.js', 'pacman/style.css'] };
    const blocked = checkMissingRefWrite(session, 'write_file', {
        path: 'pacman/index.html',
        content: '<!DOCTYPE html><html></html>'
    });
    assert.ok(blocked);
    assert.match(blocked.error, /Do not rewrite/i);
    assert.match(blocked.error, /pacman\/script\.js/);
});

test('checkMissingRefWrite allows write to pending script path', () => {
    const session = { pendingMissingRefs: ['pacman/script.js'] };
    assert.equal(checkMissingRefWrite(session, 'write_file', {
        path: 'pacman/script.js',
        content: 'document.addEventListener("keydown", () => {});'
    }), null);
});

test('checkMissingRefWrite blocks bare script.js when pacman/script.js needed', () => {
    const session = { pendingMissingRefs: ['pacman/script.js'] };
    const blocked = checkMissingRefWrite(session, 'write_file', {
        path: 'script.js',
        content: 'const x = 1;'
    });
    assert.ok(blocked);
    assert.match(blocked.error, /pacman\/script\.js/);
});

test('missingRefGuard middleware vetoes html rewrite', async () => {
    const session = {
        phase: 'implement',
        pendingMissingRefs: ['pacman/script.js'],
        projectRoot: '/proj',
        pluginToolNames: []
    };
    const mw = createDefaultMiddleware({});
    const veto = await runMiddlewareChain(mw, 'beforeTool', {
        ctx: {},
        session,
        payload: {
            name: 'write_file',
            args: { path: 'pacman/index.html', content: '<html></html>' },
            dup: false
        }
    });
    assert.equal(veto.veto, true);
    assert.match(veto.result.error, /BLOCKED/);
});

test('clearPendingIfCreated removes satisfied ref', () => {
    const session = { pendingMissingRefs: ['pacman/script.js', 'pacman/style.css'] };
    clearPendingIfCreated(session, 'pacman/style.css');
    assert.deepEqual(session.pendingMissingRefs, ['pacman/script.js']);
});

test('checkMissingRefRead blocks read_file on pending missing path', () => {
    const session = { pendingMissingRefs: ['pacman/script.js'] };
    const blocked = checkMissingRefRead(session, 'read_file', { path: 'pacman/script.js' });
    assert.ok(blocked);
    assert.match(blocked.error, /does not exist yet/i);
    assert.match(blocked.error, /write_file path="pacman\/script\.js"/);
});

test('collectMissingRefsFromHtml finds missing script sibling', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacman-ref-'));
    const dir = path.join(root, 'pacman');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><script src="script.js"></script></html>');
    const missing = collectMissingRefsFromHtml(root, 'pacman/index.html');
    assert.deepEqual(missing, ['pacman/script.js']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('seedPendingMissingRefs sets session pending for pac-man goal', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacman-seed-'));
    const dir = path.join(root, 'pacman');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><script src="script.js"></script></html>');
    const session = { projectRoot: root, goal: 'Create a web based pac-man game' };
    const missing = seedPendingMissingRefs(session, session.goal);
    assert.deepEqual(missing, ['pacman/script.js']);
    assert.deepEqual(session.pendingMissingRefs, ['pacman/script.js']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('checkPrematurePreview blocks show_preview when script.js missing', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacman-prev-'));
    const dir = path.join(root, 'pacman');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><script src="script.js"></script></html>');
    const session = { projectRoot: root, goal: 'Create pac-man game and show preview' };
    const blocked = checkPrematurePreview(session, 'show_preview', {
        kind: 'project_file',
        target: 'pacman/index.html'
    });
    assert.ok(blocked);
    assert.match(blocked.error, /not ready to preview/i);
    assert.match(blocked.error, /write_file path="pacman\/script\.js"/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('mark_code_step_done allowed in implement phase', () => {
    const { isToolAllowed } = require('../src/code/loop/phases.js');
    assert.equal(isToolAllowed('implement', 'mark_code_step_done'), true);
    assert.equal(isToolAllowed('verify', 'mark_code_step_done'), true);
});
