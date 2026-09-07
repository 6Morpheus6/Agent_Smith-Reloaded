/**
 * Coverage for the tool router, the browser smoke-test engine, and edit-format edge cases
 * (the data-loss guards) — behaviors that were previously untested.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

// ---------- router ----------
const { categorizePrompt, selectToolsForTurn } = require('../src/code/tools/router.js');

test('categorizePrompt maps intent words to tool categories', () => {
    assert.ok(categorizePrompt('fix the bug').has('write'));
    assert.ok(categorizePrompt('run npm test').has('shell'));
    const plain = categorizePrompt('hello there');
    assert.ok(plain.has('read'));
    assert.ok(!plain.has('write') && !plain.has('shell'), 'plain prose is read-only intent');
});

test('selectToolsForTurn: turn 0 takes first N; later turns are category-derived; capped at maxTools', () => {
    const first = selectToolsForTurn({ turnIndex: 0, maxTools: 3 });
    assert.equal(first.length, 3, 'turn 0 returns maxTools schemas');
    assert.ok(first.every(s => s.function && s.function.name));

    const later = selectToolsForTurn({ turnIndex: 2, userPrompt: 'edit a file and run tests', maxTools: 5 });
    assert.ok(later.length > 0 && later.length <= 5, 'capped at maxTools');
});

test('selectToolsForTurn: plugin tools de-duped vs core, and excluded during explore phase', () => {
    const pluginSchemas = [
        { type: 'function', function: { name: 'read_file', description: 'collide' } }, // collides with core
        { type: 'function', function: { name: 'my_plugin_tool', description: 'new' } }
    ];
    const withPlugins = selectToolsForTurn({ turnIndex: 0, maxTools: 20, pluginToolSchemas: pluginSchemas });
    const names = withPlugins.map(s => s.function.name);
    assert.ok(names.includes('my_plugin_tool'), 'new plugin tool added');
    assert.equal(names.filter(n => n === 'read_file').length, 1, 'collision not duplicated');

    const explore = selectToolsForTurn({ phase: 'explore', pluginToolSchemas: pluginSchemas });
    assert.ok(!explore.map(s => s.function.name).includes('my_plugin_tool'), 'no plugin tools in read-only explore phase');
});

// ---------- smokeTest (vm engine; jsdom absent in CI) ----------
const { runSmokeTest, makeStubDom, readLocalScripts } = require('../src/code/governor/smokeTest.js');

function webProject(files) {
    const d = tmp('smoke-');
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(d, name), content);
    return d;
}

test('smokeTest: no index.html → skipped (ok)', () => {
    const r = runSmokeTest({ projectRoot: tmp('smoke-none-') });
    assert.equal(r.skipped, true);
    assert.equal(r.ok, true);
});

test('smokeTest: a throwing script fails the smoke test', () => {
    const d = webProject({
        'index.html': '<!doctype html><html><body><script src="script.js"></script></body></html>',
        'script.js': 'throw new Error("boom");'
    });
    const r = runSmokeTest({ projectRoot: d });
    assert.equal(r.ok, false, 'throwing script must fail');
    assert.match(r.errors.join('\n'), /script\.js.*boom/);
});

test('smokeTest: a referenced-but-missing script fails', () => {
    const d = webProject({ 'index.html': '<!doctype html><html><body><script src="missing.js"></script></body></html>' });
    const r = runSmokeTest({ projectRoot: d });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /referenced script not found: missing\.js/);
});

test('smokeTest: a clean script passes', () => {
    const d = webProject({
        'index.html': '<!doctype html><html><body><div id="app"></div><script src="script.js"></script></body></html>',
        'script.js': 'const el = document.getElementById("app"); el.classList.add("ready");'
    });
    const r = runSmokeTest({ projectRoot: d });
    assert.equal(r.ok, true, 'clean script must pass; errors=' + (r.errors || []).join(' | '));
});

test('smokeTest makeStubDom: getElementById never null, classList.add is recorded', () => {
    const dom = makeStubDom(['app']);
    const el = dom.document.getElementById('totally-unknown-id');
    assert.ok(el, 'getElementById returns a stub, never null');
    el.classList.add('foo');
    assert.ok(dom.classesApplied.has('foo'), 'applied classes are tracked');
    // readLocalScripts marks a missing src
    const srcs = readLocalScripts('.', '<script src="nope.js"></script>', tmp('rls-'));
    assert.ok(srcs.some(s => s.missing));
});

// ---------- editFormats edge cases (data-loss guards) ----------
const { applySearchReplace, parseUnifiedDiff, applyPatchToFile } = require('../src/shared/editFormats.js');

test('applySearchReplace replaceAll replaces every exact occurrence with a count', () => {
    const res = applySearchReplace('a foo b foo c', 'foo', 'X', { replaceAll: true });
    assert.equal(res.content, 'a X b X c');
    assert.equal(res.replacedCount, 2);
    // without replaceAll, multiple matches are REFUSED (not silently first-match)
    const refused = applySearchReplace('foo foo', 'foo', 'X');
    assert.ok(refused.error, 'ambiguous multi-match refused');
    assert.equal(refused.matchCount, 2);
});

test('applyPatchToFile FAILS LOUD when a context line is absent (no silent corruption)', () => {
    const original = 'real line one\nreal line two\n';
    const badPatch = [
        '--- a/x.js',
        '+++ b/x.js',
        '@@ -1,2 +1,2 @@',
        ' THIS CONTEXT LINE IS NOT IN THE FILE',
        '-real line two',
        '+changed',
    ].join('\n');
    const r = applyPatchToFile(original, badPatch);
    assert.ok(r.error, 'must return an error, not a corrupted file');
    assert.match(r.error, /context line not found/i);
});

test('parseUnifiedDiff resolves a /dev/null new-file create to its +++ path', () => {
    const diff = '--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,1 @@\n+hello\n';
    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'new.js');
});
