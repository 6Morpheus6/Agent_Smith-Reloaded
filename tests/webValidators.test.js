/**
 * Web validator unit tests — the harness-level guardrails that must hold even when the
 * model is weak: selector↔class matching, map/constant consistency, undefined constants,
 * HTML/CSS parse, reference extraction.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wv = require('../src/code/governor/webValidators.js');

test('extractHtmlRefs finds script + stylesheet references', () => {
    const html = '<link rel="stylesheet" href="style.css"><script src="script.js"></script>';
    const r = wv.extractHtmlRefs(html);
    assert.deepEqual(r.scripts, ['script.js']);
    assert.deepEqual(r.styles, ['style.css']);
});

test('classifyCssSelectors separates classes, ids and bare tag idents', () => {
    const sel = wv.classifyCssSelectors(wv.parseCssRules('.pacman { color: red } #score { } pacman { } body { }'));
    assert.ok(sel.classes.has('pacman'));
    assert.ok(sel.ids.has('score'));
    assert.ok(sel.bareIdents.has('pacman'));
    assert.ok(sel.bareIdents.has('body'));
});

test('parseCssRules ignores @keyframes inner selectors', () => {
    const sel = wv.classifyCssSelectors(wv.parseCssRules('@keyframes chomp { 0% { } 50% { } } .pacman { }'));
    assert.ok(sel.classes.has('pacman'));
    assert.ok(!sel.bareIdents.has('0%'));
    assert.ok(!sel.bareIdents.has('chomp'));
});

test('validateSelectorsMatch flags bare selector that is actually a JS class', () => {
    const issues = wv.validateSelectorsMatch({
        cssSelectors: { classes: new Set(), ids: new Set(), bareIdents: new Set(['pacman']) },
        htmlClasses: new Set(), htmlIds: new Set(),
        jsClasses: new Set(['pacman']), jsIds: new Set()
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'selector-missing-dot');
    assert.match(issues[0].message, /\.pacman/);
});

test('validateSelectorsMatch does NOT flag real HTML tag selectors', () => {
    const issues = wv.validateSelectorsMatch({
        cssSelectors: { classes: new Set(), ids: new Set(), bareIdents: new Set(['body', 'header', 'h1']) },
        htmlClasses: new Set(), htmlIds: new Set(), jsClasses: new Set(), jsIds: new Set()
    });
    assert.equal(issues.length, 0);
});

test('extractJsClassesIds reads classList.add, className templates, querySelector', () => {
    const js = `el.classList.add('wall'); x.className = \`pacman \${dir}\`; document.getElementById('score'); root.querySelector('.pellet, #game-board');`;
    const r = wv.extractJsClassesIds(js);
    assert.ok(r.classes.has('wall'));
    assert.ok(r.classes.has('pacman'));
    assert.ok(r.classes.has('pellet'));
    assert.ok(r.ids.has('score'));
    assert.ok(r.ids.has('game-board'));
});

test('validateConstantsMatchData flags GRID_SIZE that does not match the maze', () => {
    const js = `const GRID_SIZE = 20;\nconst MAZE = [\n'111',\n'101',\n'111'\n];`;
    const issues = wv.validateConstantsMatchData(js);
    assert.ok(issues.some(i => i.code === 'map-size'), JSON.stringify(issues));
});

test('validateConstantsMatchData accepts matching ROWS/COLS', () => {
    const js = `const ROWS = 3; const COLS = 3;\nconst MAZE = ['111','101','111'];`;
    const issues = wv.validateConstantsMatchData(js);
    assert.equal(issues.length, 0, JSON.stringify(issues));
});

test('validateConstantsMatchData flags ragged maps', () => {
    const js = `const MAZE = ['11111','101','11111'];`;
    const issues = wv.validateConstantsMatchData(js);
    assert.ok(issues.some(i => i.code === 'map-ragged'));
});

test('findUndefinedConstants flags referenced-but-undeclared UPPER_SNAKE consts', () => {
    const js = `const CELL = 24;\nx = CELL_PIXEL_SIZE * 2;`;
    const issues = wv.findUndefinedConstants(js);
    assert.ok(issues.some(i => /CELL_PIXEL_SIZE/.test(i.message)));
    // CELL is declared, must not be flagged
    assert.ok(!issues.some(i => /\bCELL\b/.test(i.message) && !/CELL_PIXEL/.test(i.message)));
});

test('parseHtmlWellFormed catches an unclosed <script>', () => {
    const issues = wv.parseHtmlWellFormed('<html><body><script src="a.js"></body></html>');
    assert.ok(issues.some(i => i.code === 'html-unclosed'));
});

test('parseCssBalanced catches unbalanced braces', () => {
    assert.equal(wv.parseCssBalanced('.a { color: red;').length, 1);
    assert.equal(wv.parseCssBalanced('.a { color: red; }').length, 0);
});
