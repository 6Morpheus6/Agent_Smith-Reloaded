/**
 * Coverage for previously-untested pure-logic modules: chatSummarizer, ignoreFilter,
 * planTemplates, projectDetector, bootstrap, readiness. These assert real behavior
 * (inputs → exact outputs), not just "doesn't throw".
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

// ---------- chatSummarizer.digestDropped ----------
const { digestDropped } = require('../src/shared/chatSummarizer.js');

test('digestDropped: empty/falsy → empty string', () => {
    assert.equal(digestDropped([]), '');
    assert.equal(digestDropped(null), '');
    assert.equal(digestDropped([null, undefined].filter(() => true)), '');
});

test('digestDropped: counts messages, extracts relPaths, caps at 12, ends with period', () => {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'go' }];
    const out = digestDropped(msgs);
    assert.match(out, /^\[CONTEXT COMPACTED\] 3 earlier message\(s\)/);
    assert.match(out, /PLAN\.md \+ IMPLEMENT\.md/);
    assert.ok(out.endsWith('.'), 'ends with a period');

    const toolMsgs = Array.from({ length: 15 }, (_, i) => ({ role: 'tool', content: `{"relPath":"f${i}.js"}` }));
    const o2 = digestDropped(toolMsgs);
    assert.match(o2, /files already touched: /);
    assert.match(o2, /\bf0\.js\b/);
    assert.match(o2, /\bf11\.js\b/);
    assert.doesNotMatch(o2, /\bf12\.js\b/, 'file list is capped at 12');
});

// ---------- ignoreFilter ----------
const { loadIgnoreFile, isIgnored, DEFAULT_IGNORE } = require('../src/shared/ignoreFilter.js');

test('ignoreFilter: defaults ignore node_modules/.git/dist; custom file + comments honored', () => {
    const dir = tmp('ig-');
    const ig0 = loadIgnoreFile(dir);
    assert.ok(isIgnored(ig0, 'node_modules/pkg/index.js'));
    assert.ok(isIgnored(ig0, '.git/config'));
    assert.ok(!isIgnored(ig0, 'src/app.js'));
    assert.ok(DEFAULT_IGNORE.includes('node_modules'));

    fs.writeFileSync(path.join(dir, '.xkaliberignore'), '# a comment\nsecret.txt\n\n*.tmp\n');
    const ig = loadIgnoreFile(dir);
    assert.ok(isIgnored(ig, 'secret.txt'), 'custom pattern ignored');
    assert.ok(isIgnored(ig, 'scratch.tmp'), 'glob pattern ignored');
    assert.ok(!isIgnored(ig, '# a comment'), 'comment line is not a pattern');
});

test('ignoreFilter: normalizes Windows backslash paths', () => {
    const ig = loadIgnoreFile(tmp('ig2-'));
    assert.ok(isIgnored(ig, 'node_modules\\pkg\\index.js'), 'backslash path normalized to / before matching');
});

// ---------- planTemplates.stepsForType ----------
const { stepsForType } = require('../src/shared/planTemplates.js');

test('stepsForType: python vs node vs brownfield, returns a fresh copy', () => {
    const py = stepsForType('greenfield', 'python');
    assert.ok(py.some(s => /pytest/i.test(s)));
    const node = stepsForType('greenfield', 'javascript');
    assert.ok(node.some(s => /npm test/i.test(s)));
    assert.equal(stepsForType('brownfield', 'node'), null);
    // mutating the returned array must not affect the next call
    py.push('MUTATED');
    assert.ok(!stepsForType('greenfield', 'python').includes('MUTATED'));
});

// ---------- projectDetector.detect ----------
const { detect } = require('../src/main/services/projectDetector.js');

test('projectDetector: node project with scripts + lockfile', () => {
    const dir = tmp('det-node-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        scripts: { test: 'jest', lint: 'eslint .', 'test:e2e': 'playwright test' }
    }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const d = detect(dir);
    assert.equal(d.language, 'node');
    assert.equal(d.testCmd, 'npm test');
    assert.equal(d.lintCmd, 'npm run lint');
    assert.equal(d.e2eCmd, 'npm run test:e2e');
    assert.equal(d.installCmd, 'npm ci', 'lockfile → npm ci');
    assert.equal(d.projectType, 'brownfield');
});

test('projectDetector: no lockfile → npm install; python/rust/go; greenfield empty dir', () => {
    const n = tmp('det-nolock-');
    fs.writeFileSync(path.join(n, 'package.json'), '{"scripts":{}}');
    assert.equal(detect(n).installCmd, 'npm install');

    const py = tmp('det-py-'); fs.writeFileSync(path.join(py, 'pyproject.toml'), '[tool.x]');
    assert.equal(detect(py).language, 'python');
    assert.equal(detect(py).testCmd, 'pytest -q');

    const rs = tmp('det-rs-'); fs.writeFileSync(path.join(rs, 'Cargo.toml'), '[package]');
    assert.equal(detect(rs).language, 'rust');
    assert.equal(detect(rs).testCmd, 'cargo test');

    const go = tmp('det-go-'); fs.writeFileSync(path.join(go, 'go.mod'), 'module x');
    assert.equal(detect(go).language, 'go');

    assert.equal(detect(tmp('det-empty-')).projectType, 'greenfield', 'empty dir with no source/.git is greenfield');
});

test('projectDetector: malformed package.json does not throw', () => {
    const dir = tmp('det-bad-');
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not valid json');
    const d = detect(dir);
    assert.equal(d.language, 'node');
    assert.equal(d.testCmd, null, 'no testCmd derived from broken package.json');
});

// ---------- bootstrap.buildBootstrapBlock ----------
const { buildBootstrapBlock, detectRuntime } = require('../src/code/context/bootstrap.js');

test('bootstrap: includes runtime/test cmd; static-web hints for unknown runtime; truncates tree', () => {
    const node = tmp('bs-node-');
    fs.writeFileSync(path.join(node, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const b = buildBootstrapBlock(node, 'package.json\nsrc/', 'do a thing');
    assert.match(b, /\[PROJECT BOOTSTRAP\]/);
    assert.match(b, /Runtime: node/);
    assert.match(b, /Test command: npm test/);
    assert.doesNotMatch(b, /Static web project hints/, 'node project gets no static-web hints');

    const empty = tmp('bs-empty-');
    const b2 = buildBootstrapBlock(empty, '', 'build a web page');
    assert.match(b2, /Runtime: unknown/);
    assert.match(b2, /Static web project hints/, 'unknown runtime + no package.json → web hints');

    const big = buildBootstrapBlock(node, 'x'.repeat(5000), 'g');
    assert.ok(big.includes('x'.repeat(2000)), 'keeps up to 2000 tree chars');
    assert.ok(!big.includes('x'.repeat(2001)), 'truncates tree summary at 2000 chars');
    assert.equal(detectRuntime(node).type, 'node');
});

// ---------- readiness.scoreReadiness ----------
const { scoreReadiness } = require('../src/code/governor/readiness.js');

test('readiness: empty repo scores low with recommendations; maxScore invariant', () => {
    const r = scoreReadiness(tmp('rdy-empty-'));
    assert.equal(r.maxScore, r.pillars.length * 5);
    assert.equal(r.maxScore, 40, '8 pillars × 5');
    assert.ok(r.score < 15, 'empty repo is low: ' + r.score);
    const recs = r.recommendations.join('\n');
    assert.match(recs, /README/);
    assert.match(recs, /git/i);
});

test('readiness: equipped repo scores higher and drops satisfied recommendations', () => {
    const dir = tmp('rdy-full-');
    fs.writeFileSync(path.join(dir, 'README.md'), '# x');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# a');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'src'));
    const r = scoreReadiness(dir);
    assert.ok(r.score > scoreReadiness(tmp('rdy-empty2-')).score, 'equipped repo outscores empty');
    assert.doesNotMatch(r.recommendations.join('\n'), /Initialize git/, 'git rec dropped when .git present');
    assert.doesNotMatch(r.recommendations.join('\n'), /Add a README/, 'README rec dropped');
});
