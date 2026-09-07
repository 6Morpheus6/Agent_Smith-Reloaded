/**
 * Pac-Man regression — reproduces the failed coding-test output described in the harness
 * audit and proves the gate now REJECTS it, while the known-good example passes.
 *
 * Symptoms reproduced: broken CSS selectors (pacman/ghost/pellet without a dot), broken
 * JS template literal (repeat(${...}) without backticks), undefined constant
 * (CELL_PIXEL_SIZE), GRID_SIZE=20 vs a 13-row map, and a script referenced but missing.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runValidation } = require('../src/code/governor/completionGate.js');

function tmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const GOAL = 'Build a web based Pac-Man game';

const BROKEN_HTML = `<!DOCTYPE html>
<html><head><title>Pac-Man</title><link rel="stylesheet" href="style.css"></head>
<body>
<h1>Pac-Man</h1>
<p id="score">Score: 0</p>
<div id="game-board"></div>
<script src="script.js"></script>
</body></html>`;

// bare element selectors that are really classes — the classic missing-dot bug
const BROKEN_CSS = `#game-board { display: grid; }
pacman { background: yellow; }
ghost { background: red; }
pellet { background: white; }`;

// GRID_SIZE=20 but 13 rows; CELL_PIXEL_SIZE never declared; repeat(${...}) w/o backticks
const BROKEN_JS = `'use strict';
const GRID_SIZE = 20;
const CELL = 24;
const MAZE = [
'1111111111111',
'1000000000001',
'1011101110101',
'1000000000001',
'1011101110101',
'1000000000001',
'1011101110101',
'1000000000001',
'1011101110101',
'1000000000001',
'1011101110101',
'1000000000001',
'1111111111111'
];
const board = document.getElementById('game-board');
const scoreEl = document.getElementById('score');
let score = 0;
board.style.gridTemplateColumns = repeat(\${GRID_SIZE}, \${CELL_PIXEL_SIZE}px);
function draw() {
  const p = document.createElement('div');
  p.classList.add('pacman');
  board.appendChild(p);
  const g = document.createElement('div');
  g.classList.add('ghost');
  board.appendChild(g);
  const dot = document.createElement('div');
  dot.classList.add('pellet');
  board.appendChild(dot);
}
document.addEventListener('keydown', () => { score += 10; scoreEl.textContent = 'Score: ' + score; });
setInterval(draw, 150);
`;

test('REGRESSION: broken Pac-Man output fails validation (was previously shipped as success)', async () => {
    const d = tmp('pacman-broken-');
    fs.writeFileSync(path.join(d, 'index.html'), BROKEN_HTML);
    fs.writeFileSync(path.join(d, 'style.css'), BROKEN_CSS);
    fs.writeFileSync(path.join(d, 'script.js'), BROKEN_JS);

    const r = await runValidation(d, ['index.html', 'style.css', 'script.js'], GOAL);

    assert.equal(r.allow, false, 'broken project must NOT be allowed to complete');
    assert.equal(r.status, 'incomplete');

    const joined = r.messages.join('\n');
    assert.match(joined, /\[SELECTOR\].*pacman/, 'must catch bare `pacman` selector');
    assert.match(joined, /\[SELECTOR\].*ghost/, 'must catch bare `ghost` selector');
    assert.match(joined, /\[SELECTOR\].*pellet/, 'must catch bare `pellet` selector');
    assert.match(joined, /\[DATA\].*GRID_SIZE/, 'must catch GRID_SIZE vs map mismatch');
    assert.match(joined, /\[UNDEF\].*CELL_PIXEL_SIZE/, 'must catch undefined constant');
    assert.match(joined, /\[SYNTAX\]|\[SMOKE\]/, 'must catch the broken template literal at syntax/smoke level');
});

test('REGRESSION: referenced-but-missing script is caught (stopped before completing script.js)', async () => {
    const d = tmp('pacman-missing-');
    fs.writeFileSync(path.join(d, 'index.html'), BROKEN_HTML); // references script.js + style.css
    fs.writeFileSync(path.join(d, 'style.css'), '#game-board { display:grid; }');
    // script.js intentionally NOT written

    const r = await runValidation(d, ['index.html', 'style.css'], GOAL);
    assert.equal(r.allow, false);
    assert.match(r.messages.join('\n'), /\[WEB\].*script\.js.*missing/);
});

test('REGRESSION: title+score-only output fails game acceptance', async () => {
    const d = tmp('pacman-empty-');
    fs.writeFileSync(path.join(d, 'index.html'),
        '<!DOCTYPE html><html><body><h1>Pac-Man</h1><p>Score: 0</p></body></html>');

    const r = await runValidation(d, ['index.html'], GOAL);
    assert.equal(r.allow, false);
    const joined = r.messages.join('\n');
    assert.match(joined, /\[ACCEPT\]/, 'a title+score page must fail game acceptance checks');
});

test('CONTROL: the known-good example passes every validator', async () => {
    const root = path.join(__dirname, '..', 'examples', 'pacman');
    const r = await runValidation(root, ['index.html', 'style.css', 'script.js'], GOAL);
    assert.equal(r.allow, true, 'good example must pass; messages: ' + r.messages.join(' | '));
    assert.equal(r.status, 'done');
    assert.equal(r.acceptance.failed.length, 0);
    assert.ok(r.smoke.ok);
});
