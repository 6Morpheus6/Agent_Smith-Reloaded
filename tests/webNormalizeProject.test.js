const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { normalizeWebProject, topLevelDecls, collectWindowRefs, downgradeModuleTags } =
    require('../src/code/governor/webModuleNormalize.js');

function mkproj(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnp-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return root;
}

test('helpers: window refs + top-level decls + tag downgrade', () => {
    assert.deepEqual([...collectWindowRefs(['window.App.init(); window.State'])].sort(), ['App', 'State']);
    assert.deepEqual([...topLevelDecls('const App = {};\nfunction f(){}\n  const nested = 1;')].sort(), ['App', 'f']);
    assert.equal(downgradeModuleTags('<script type="module" src="a.js"></script>'), '<script src="a.js"></script>');
});

// The exact failure from the broken build: type="module" + `const App` used as `window.App`.
test('repairs type=module app that relies on window.* globals (the real failure)', async () => {
    const root = mkproj({
        'index.html':
            '<!doctype html><html><body><div id="app"></div>' +
            '<script type="module" src="src/app.js"></script>' +
            '<script>document.addEventListener("DOMContentLoaded",()=>window.App.init());</script>' +
            '</body></html>',
        'src/app.js': 'const App = {\n  init() { document.getElementById("app").textContent = "ok"; }\n};\n'
    });
    const fixed = await normalizeWebProject(root, 'index.html');
    assert.ok(fixed.includes('src/app.js'), 'app.js repaired');

    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /type\s*=\s*["']module["']/, 'module tag downgraded to classic');

    const appJs = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
    assert.match(appJs, /window\.App\s*=\s*App;/, 'App now exposed on window');
    assert.doesNotThrow(() => new vm.Script(appJs));

    // Simulate the load: run app.js as a classic script in a window context, then App must resolve.
    const ctx = { window: {}, document: { getElementById: () => ({}), addEventListener: () => {} } };
    ctx.window.document = ctx.document;
    vm.runInNewContext(appJs, ctx);
    assert.equal(typeof ctx.window.App, 'object', 'window.App is defined after running the script');
});

test('leaves a REAL ES-module app (files import each other) untouched', async () => {
    const root = mkproj({
        'index.html': '<!doctype html><html><body><script type="module" src="app.js"></script></body></html>',
        'app.js': "import { State } from './state.js';\nState.go();\n",
        'state.js': 'export const State = { go() {} };\n'
    });
    const before = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const fixed = await normalizeWebProject(root, 'index.html');
    assert.deepEqual(fixed, []);
    assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), before);
});

// The E2E build failure: a prior gate pass downgraded the tags to classic, but the files
// still use import/export wiring -> "Unexpected token 'export'". Must re-upgrade to module.
test('re-upgrades to type=module when files use import-wiring but tags were classic', async () => {
    const root = mkproj({
        'index.html': '<!doctype html><html><body><div id="x"></div>' +
            '<script src="src/state.js"></script><script src="src/app.js"></script></body></html>',
        'src/state.js': 'export const State = { v: 7 };\n',
        'src/app.js': "import { State } from './state.js';\ndocument.getElementById('x').textContent = State.v;\n"
    });
    await normalizeWebProject(root, 'index.html');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.equal((html.match(/type="module"/g) || []).length, 2, 'both tags re-upgraded to module');
    assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /\bimport\b/, 'import wiring kept');
    // idempotent: a second pass leaves it consistent
    const second = await normalizeWebProject(root, 'index.html');
    assert.deepEqual(second, []);
});

test('still fixes classic <script> + export, and is idempotent', async () => {
    const root = mkproj({
        'index.html': '<!doctype html><html><body><script src="a.js"></script>' +
            '<script>window.onload=()=>window.Thing.run();</script></body></html>',
        'a.js': 'export const Thing = { run() {} };\n'
    });
    const first = await normalizeWebProject(root, 'index.html');
    assert.ok(first.includes('a.js'));
    const aJs = fs.readFileSync(path.join(root, 'a.js'), 'utf8');
    assert.doesNotMatch(aJs, /\bexport\b/);
    assert.match(aJs, /window\.Thing\s*=\s*Thing;/);
    // running again changes nothing
    const second = await normalizeWebProject(root, 'index.html');
    assert.deepEqual(second, []);
});
