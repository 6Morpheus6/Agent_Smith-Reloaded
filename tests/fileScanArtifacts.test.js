/**
 * Bounded recursive file scan + required-artifact content check (audit LOW items):
 *  - deliverables nested more than one level deep are found (no false [ARTIFACT]/missing),
 *  - a required deliverable that exists but is 0 bytes is NOT accepted as done,
 *  - legitimately-empty files (.gitkeep, __init__.py) are still accepted by existence.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findFileDeep, fileExistsDeep, findIndexHtmlDeep } = require('../src/code/context/fileScan.js');
const { checkCompletion } = require('../src/code/governor/completionGate.js');

function proj(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fscan-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return root;
}

test('findFileDeep locates nested files (shallowest wins) and skips vendor dirs', () => {
    const root = proj({
        'apps/web/index.html': '<html></html>',
        'src/js/app.js': 'x',
        'node_modules/pkg/index.html': 'IGNORED'
    });
    assert.equal(findFileDeep(root, 'app.js'), 'src/js/app.js');
    assert.equal(findIndexHtmlDeep(root), 'apps/web/index.html', 'node_modules ignored');
    assert.equal(fileExistsDeep(root, 'README.md'), false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('a nested required deliverable is NOT reported missing', async () => {
    const root = proj({
        'src/main.py': 'def add(a,b):\n    return a+b\n',
        'docs/README.md': '# Project\nReal content.\n'
    });
    const r = await checkCompletion(root, ['src/main.py'], 'write main.py with a README.md', { grindMode: false });
    assert.ok(!r.messages.some(m => /README/.test(m)), 'nested README.md must satisfy the artifact check');
    fs.rmSync(root, { recursive: true, force: true });
});

test('a 0-byte required deliverable is rejected; real content passes', async () => {
    const root = proj({ 'app.py': 'print(1)\n', 'README.md': '' });
    const empty = await checkCompletion(root, ['app.py'], 'write app.py and README.md', { grindMode: false });
    assert.ok(empty.messages.some(m => /README/.test(m)), '0-byte README must block');

    fs.writeFileSync(path.join(root, 'README.md'), '# Real\nContent.\n');
    const full = await checkCompletion(root, ['app.py'], 'write app.py and README.md', { grindMode: false });
    assert.ok(!full.messages.some(m => /README/.test(m)), 'non-empty README passes');
    fs.rmSync(root, { recursive: true, force: true });
});
