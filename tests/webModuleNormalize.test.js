const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { stripEsModuleSyntax, htmlIsClassic, normalizeClassicScriptModules } = require('../src/code/governor/webModuleNormalize.js');

test('strips export/import so the file becomes valid classic-script syntax', () => {
    const src = [
        "import { State } from './state.js';",
        "import './side-effect.js';",
        "export const COLS = ['a','b'];",
        "export function render() { return COLS.length; }",
        "export default class App {}",
        "export { render, COLS };",
        "const keep = 1;"
    ].join('\n');
    const { code, changed } = stripEsModuleSyntax(src);
    assert.equal(changed, true);
    assert.doesNotMatch(code, /\bimport\b/);
    assert.doesNotMatch(code, /\bexport\b/);
    assert.match(code, /const COLS = \['a','b'\];/);
    assert.match(code, /function render\(\)/);
    assert.match(code, /class App \{\}/);
    assert.match(code, /const keep = 1;/);
    // The stripped result must actually parse as a classic script (no module syntax error).
    assert.doesNotThrow(() => new vm.Script(code));
});

test('leaves a plain classic script unchanged', () => {
    const src = 'function f(){return 1;}\nwindow.f = f;\n';
    const { code, changed } = stripEsModuleSyntax(src);
    assert.equal(changed, false);
    assert.equal(code, src);
});

test('htmlIsClassic detects classic vs module loading', () => {
    assert.equal(htmlIsClassic('<script src="a.js"></script>'), true);
    assert.equal(htmlIsClassic('<script type="module" src="a.js"></script>'), false);
    assert.equal(htmlIsClassic('<p>no scripts</p>'), false);
});

test('normalizeClassicScriptModules repairs a real workspace (classic html + export in js)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmn-'));
    fs.writeFileSync(path.join(root, 'index.html'),
        '<!doctype html><html><body><script src="state.js"></script><script src="app.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'state.js'), "export const State = { cards: [] };\n");
    fs.writeFileSync(path.join(root, 'app.js'), "import { State } from './state.js';\nconsole.log(State);\n");

    const fixed = await normalizeClassicScriptModules(root, 'index.html');
    assert.deepEqual(fixed.sort(), ['app.js', 'state.js']);
    // both files now parse as classic scripts
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, 'state.js'), 'utf8')));
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, 'app.js'), 'utf8')));
    fs.rmSync(root, { recursive: true, force: true });
});

test('does NOT touch a proper ES-module app (type=module)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmn-mod-'));
    fs.writeFileSync(path.join(root, 'index.html'),
        '<!doctype html><html><body><script type="module" src="app.js"></script></body></html>');
    const appSrc = "import { State } from './state.js';\nexport const x = 1;\n";
    fs.writeFileSync(path.join(root, 'app.js'), appSrc);
    fs.writeFileSync(path.join(root, 'state.js'), 'export const State = {};\n');
    const fixed = await normalizeClassicScriptModules(root, 'index.html');
    assert.deepEqual(fixed, []);
    assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), appSrc); // untouched
    fs.rmSync(root, { recursive: true, force: true });
});
