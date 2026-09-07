// Regression: the completion gate must NOT report a web build "done" when an index.html
// on disk (e.g. left from an earlier run in a reused workspace) references files that were
// never created — even if this run only (re)wrote a trivial file like utils.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkCompletion } = require('../src/code/governor/completionGate.js');

const KANBAN = 'Build a full offline-first Kanban Project Manager web app from scratch';

test('reused workspace: NOT done when index.html references files never created', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-gate-'));
    fs.mkdirSync(path.join(root, 'site'));
    // index.html (left from a prior run) links 3 scripts + a stylesheet; only utils.js exists
    fs.writeFileSync(path.join(root, 'site', 'index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>'
        + '<body><script src="utils.js"></script><script src="storage.js"></script>'
        + '<script src="app.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'site', 'utils.js'), 'function id(){return 1;}\n');

    // This run only (re)wrote utils.js — NOT index.html.
    const res = await checkCompletion(root, ['site/utils.js'], KANBAN, {});

    assert.equal(res.allow, false, 'must NOT pass: index.html references missing storage.js/app.js/styles.css');
    assert.ok(
        (res.messages || []).some(m => /storage\.js|app\.js|styles\.css/i.test(m)),
        'must flag the missing referenced files; got: ' + JSON.stringify(res.messages)
    );
    fs.rmSync(root, { recursive: true, force: true });
});

test('when all referenced files DO exist on disk, the gate can pass', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-ok-'));
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site', 'index.html'),
        '<!doctype html><html><body><script src="utils.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'site', 'utils.js'), 'window.id=function(){return 1;};\n');
    const res = await checkCompletion(root, ['site/utils.js'], KANBAN, {});
    // No missing-FILE errors when refs resolve. (Functional [ACCEPT] capability messages are a
    // separate, expected signal for an interactive-app goal and are not asserted here.)
    assert.ok(!(res.missingRefs || []).length && !(res.messages || []).some(m => /missing on disk|references .* — create|not found/i.test(m)),
        'no missing-file errors when refs resolve; got: ' + JSON.stringify(res.messages));
});

test('host-app repo: the host index.html is NOT validated as the deliverable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-host-'));
    fs.writeFileSync(path.join(root, 'package.json'),
        JSON.stringify({ main: 'main.js', devDependencies: { electron: '^28' } }));
    fs.writeFileSync(path.join(root, 'main.js'), '// host\n');
    fs.writeFileSync(path.join(root, 'index.html'), '<script src="dist/renderer/bundle.js"></script>');
    fs.writeFileSync(path.join(root, 'note.js'), 'const x = 1;\n');
    const res = await checkCompletion(root, ['note.js'], 'build a small web helper app', {});
    assert.ok(!(res.messages || []).some(m => /bundle\.js/.test(m)),
        'must not validate the host app index.html; got: ' + JSON.stringify(res.messages));
    fs.rmSync(root, { recursive: true, force: true });
});
