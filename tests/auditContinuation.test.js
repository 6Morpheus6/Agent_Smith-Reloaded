/**
 * Regression tests for the audit fixes:
 *
 *  1. extractor field-order: a write_file whose JSON puts "content" BEFORE "path"
 *     must not swallow the trailing `","path":"…"` into the file. This is the exact
 *     corruption that shipped in the Pac-Man build (style.css ended with
 *     `}\n","path":"game/style.css`).
 *  2. webValidators.detectSerializationArtifacts: catch leaked tool-call JSON tails
 *     and backslash-escaped braces in a written file.
 *  3. webValidators.validateRenderedClassesStyled: flag a script that renders elements
 *     with classes the stylesheet never defines (the "invisible game" disconnect), and
 *     stay quiet when the script and CSS agree.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractLenientWriteCalls } = require('../src/code/tools/extractor.js');
const wv = require('../src/code/governor/webValidators.js');

const KNOWN = new Set(['write_file', 'patch']);

test('extractor: content-before-path does NOT leak the path tail into content', () => {
    const seg = '{"name":"write_file","content":"body { color: red; }","path":"game/style.css"}';
    const calls = extractLenientWriteCalls(seg, KNOWN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.arguments.path, 'game/style.css');
    assert.equal(calls[0].function.arguments.content, 'body { color: red; }');
    assert.doesNotMatch(calls[0].function.arguments.content, /"path"/, 'must not contain the leaked JSON tail');
});

test('extractor: content-before-path still works when content has unescaped quotes', () => {
    const seg = '{"name":"write_file","content":"<div id="app" class="box"></div>","path":"index.html"}';
    const calls = extractLenientWriteCalls(seg, KNOWN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.arguments.path, 'index.html');
    assert.match(calls[0].function.arguments.content, /id="app"/);
    assert.doesNotMatch(calls[0].function.arguments.content, /"path"\s*:/);
});

test('extractor: path-before-content (content last) is unaffected', () => {
    const seg = '{"name":"write_file","path":"a.js","content":"const x = 1;\\n"}';
    const calls = extractLenientWriteCalls(seg, KNOWN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.arguments.content, 'const x = 1;\n');
});

test('detectSerializationArtifacts: flags a leaked tool-call tail', () => {
    const css = 'body { color: red; }\n}\n","path":"game/style.css';
    const issues = wv.detectSerializationArtifacts(css);
    assert.ok(issues.some(i => i.code === 'leaked-toolcall' && i.level === 'error'));
});

test('detectSerializationArtifacts: flags a backslash-escaped brace', () => {
    const css = 'body { font-family: sans-serif;\\}';
    const issues = wv.detectSerializationArtifacts(css);
    assert.ok(issues.some(i => i.code === 'escaped-brace' && i.level === 'error'));
});

test('detectSerializationArtifacts: clean source produces no issues', () => {
    const css = '.cell { width: 24px; }\n.wall { background: #1c1cb0; }\n';
    assert.equal(wv.detectSerializationArtifacts(css).length, 0);
});

test('validateRenderedClassesStyled: flags the invisible-game disconnect', () => {
    // JS renders .cell/.pellet/.pacman/.ghost; CSS only styles .wall/.character/.dot/.powerup
    const css = '.wall{} .character{} .dot{} .powerup{}';
    const js = `
        const cell = document.createElement('div'); cell.className = 'cell';
        cell.classList.add('wall');
        const pellet = document.createElement('div'); pellet.className = 'pellet';
        const p = document.createElement('div'); p.className = 'pacman ' + dir;
        const g = document.createElement('div'); g.className = 'ghost ' + color;
    `;
    const cssSel = wv.classifyCssSelectors(wv.parseCssRules(css));
    const issues = wv.validateRenderedClassesStyled({
        cssClasses: cssSel.classes,
        appliedClasses: wv.extractJsAppliedClasses(js),
        htmlClasses: new Set()
    });
    assert.ok(issues.some(i => i.code === 'render-unstyled' && i.level === 'error'),
        'should flag mostly-unstyled rendered classes');
});

test('validateRenderedClassesStyled: stays quiet when script and CSS agree', () => {
    const css = '.cell{} .wall{} .pellet{} .pacman{} .ghost{}';
    const js = `
        const cell = document.createElement('div'); cell.className = 'cell';
        cell.classList.add('wall');
        const pellet = document.createElement('div'); pellet.className = 'pellet';
        const p = document.createElement('div'); p.className = 'pacman ' + dir;
        const g = document.createElement('div'); g.className = 'ghost ' + color;
    `;
    const cssSel = wv.classifyCssSelectors(wv.parseCssRules(css));
    const issues = wv.validateRenderedClassesStyled({
        cssClasses: cssSel.classes,
        appliedClasses: wv.extractJsAppliedClasses(js),
        htmlClasses: new Set()
    });
    assert.equal(issues.length, 0, 'no issue when every rendered class is styled');
});

test('validateRenderedClassesStyled: no-op when there is no stylesheet', () => {
    const js = `const e = document.createElement('div'); e.className = 'whatever';`;
    const issues = wv.validateRenderedClassesStyled({
        cssClasses: new Set(),
        appliedClasses: wv.extractJsAppliedClasses(js),
        htmlClasses: new Set()
    });
    assert.equal(issues.length, 0);
});
