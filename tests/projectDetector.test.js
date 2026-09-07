'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect } = require('../src/main/services/projectDetector.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-')); }

// A scriptless folder that nonetheless carries *.test.js should be verifiable via Node's
// built-in runner — otherwise the completion gate stamps every such project "unverified"
// and the agent burns its turn budget re-verifying code that is already correct.
test('infers `node --test` for a bare dir with *.test.js and no package.json', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'math.js'), 'module.exports={add:(a,b)=>a+b};');
    fs.writeFileSync(path.join(d, 'math.test.js'), 'require("assert").strictEqual(1,1);');
    const out = detect(d);
    assert.equal(out.testCmd, 'node --test');
    assert.equal(out.language, 'node');
});

test('infers `node --test` when test files live in a test/ subdir', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'test'));
    fs.writeFileSync(path.join(d, 'test', 'unit.test.js'), '//');
    assert.equal(detect(d).testCmd, 'node --test');
});

test('does NOT infer a test command for a bare dir with no test files', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'app.js'), 'console.log(1);');
    assert.equal(detect(d).testCmd, null);
});

test('an explicit package.json test script still wins over the node --test fallback', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'pkg.test.js'), '//');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'jest' } }));
    assert.equal(detect(d).testCmd, 'npm test');
});

test('matches .mjs/.cjs/.ts test files too', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'a.test.mjs'), '//');
    assert.equal(detect(d).testCmd, 'node --test');
});
