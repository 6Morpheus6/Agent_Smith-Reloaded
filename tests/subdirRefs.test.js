/**
 * Subdirectory reference regression. Reproduces the failed run where the agent wrote
 * pacman/index.html (which references "script.js"/"style.css" relative to pacman/), and
 * the gate told the model to create bare "script.js" — so it could never satisfy the
 * reference at pacman/script.js, looping until INCOMPLETE.
 *
 * The gate must report the PROJECT-ROOT-RELATIVE path (pacman/script.js) so the model
 * writes the file where the HTML actually links it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runValidation, formatGateMessage } = require('../src/code/governor/completionGate.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'subdir-')); }

const INDEX = `<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head>
<body><h1>Pac-Man</h1><div id="game-container"><div id="map"></div></div>
<div id="scoreboard">Score: <span id="score">0</span></div>
<script src="script.js"></script></body></html>`;

test('missing refs from a subdir HTML are reported as project-root-relative paths', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'pacman'));
    fs.writeFileSync(path.join(root, 'pacman', 'index.html'), INDEX);

    const r = await runValidation(root, ['pacman/index.html'], 'Create a web based pac-man game');
    assert.equal(r.allow, false);
    // the model must be told to create pacman/script.js — NOT bare script.js
    assert.ok(r.missingRefs.includes('pacman/script.js'), 'missingRefs: ' + JSON.stringify(r.missingRefs));
    assert.ok(r.missingRefs.includes('pacman/style.css'));
    assert.ok(!r.missingRefs.includes('script.js'), 'must not tell the model to create bare script.js');

    const msg = formatGateMessage(r, 'Create a web based pac-man game', root);
    assert.match(msg, /pacman\/script\.js/);
    assert.match(msg, /pacman\/style\.css/);
});

test('creating the files at the correct subdir path satisfies the gate', async () => {
    const root = tmp();
    const good = path.join(__dirname, '..', 'examples', 'pacman');
    fs.mkdirSync(path.join(root, 'pacman'));
    fs.copyFileSync(path.join(good, 'index.html'), path.join(root, 'pacman', 'index.html'));
    fs.copyFileSync(path.join(good, 'script.js'), path.join(root, 'pacman', 'script.js'));
    fs.copyFileSync(path.join(good, 'style.css'), path.join(root, 'pacman', 'style.css'));

    const r = await runValidation(root, ['pacman/index.html', 'pacman/script.js', 'pacman/style.css'], 'Create a web based pac-man game');
    assert.equal(r.allow, true, 'should pass once files exist at the referenced subdir path; messages: ' + r.messages.join(' | '));
});
