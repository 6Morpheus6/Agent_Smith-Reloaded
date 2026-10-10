// v54.5 — completion gate refuses an AppImage/.deb task until a real artifact exists
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { goalImpliesPackaging, findPackagedArtifacts, runValidation } = require('../src/code/governor/completionGate.js');

function tmpProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-pkg-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(root, 'index.js'), 'console.log("hi");\n');
    return root;
}

test('goalImpliesPackaging matches the packaging task class only', () => {
    assert.ok(goalImpliesPackaging('build the app and package it into an AppImage'));
    assert.ok(goalImpliesPackaging('ship a .deb for debian users'));
    assert.ok(goalImpliesPackaging('create installer for the tool'));
    assert.ok(!goalImpliesPackaging('fix the login button color'));
});

test('findPackagedArtifacts ignores tiny/truncated files and odd dirs', () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, 'release'), { recursive: true });
    fs.writeFileSync(path.join(root, 'release', 'broken.AppImage'), 'x'); // 1 byte → not real
    assert.deepStrictEqual(findPackagedArtifacts(root), []);

    fs.writeFileSync(path.join(root, 'release', 'Demo-1.0.0.deb'), Buffer.alloc(70000, 7));
    const found = findPackagedArtifacts(root);
    assert.strictEqual(found.length, 1);
    assert.match(found[0].rel, /Demo-1\.0\.0\.deb$/);
});

test('gate blocks a packaging goal with no artifact, allows it once built', async () => {
    const root = tmpProject();
    const goal = 'package this app into an AppImage and .deb';

    const blocked = await runValidation(root, ['index.js'], goal, {});
    assert.ok(blocked.messages.some(m => m.startsWith('[PACKAGE]')),
        `expected [PACKAGE] block, got ${JSON.stringify(blocked.messages)}`);

    fs.mkdirSync(path.join(root, 'release'), { recursive: true });
    fs.writeFileSync(path.join(root, 'release', 'demo.AppImage'), Buffer.alloc(80000, 1));
    const after = await runValidation(root, ['index.js'], goal, {});
    assert.ok(!after.messages.some(m => m.startsWith('[PACKAGE]')),
        'a real artifact must clear the [PACKAGE] block');

    // non-packaging goals are untouched by this check
    const plain = await runValidation(root, ['index.js'], 'tweak index.js', {});
    assert.ok(!plain.messages.some(m => m.startsWith('[PACKAGE]')));
});
