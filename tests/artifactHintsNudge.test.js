const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildMissingRefsNudge, buildWriteNudge, buildContinueAfterRecoveryNudge
} = require('../src/code/context/artifactHints.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-')); // plain dir, not an app repo

test('missing-refs nudge for a NON-game app: no game/pacman framing, explicit same-folder path', () => {
    const n = buildMissingRefsNudge(['site/script.js', 'site/style.css'], 'Build a Kanban project manager web app', root);
    assert.match(n, /site\/script\.js/);
    assert.match(n, /same folder/i);                 // directory-consistency guidance present
    assert.doesNotMatch(n, /pacman/i);
    assert.doesNotMatch(n, /\bgame\b/i);
    assert.doesNotMatch(n, /win\/lose/i);
});

test('write nudge for a NON-game app describes app logic, not a game loop', () => {
    const n = buildWriteNudge('Build an offline-first Kanban board', root);
    assert.match(n, /app logic/i);
    assert.doesNotMatch(n, /win\/lose/i);
    assert.doesNotMatch(n, /pacman/i);
});

test('GAME goals still get game-specific hints', () => {
    const n = buildMissingRefsNudge(['game/script.js'], 'build a snake game in the browser', root);
    assert.match(n, /game loop|win\/lose|keyboard input/i);
});

test('continue-after-recovery nudge says "app" for non-game, "game" for game', () => {
    assert.match(buildContinueAfterRecoveryNudge('Build a Kanban app', 'app/index.html', true), /app is ready/i);
    assert.match(buildContinueAfterRecoveryNudge('build a pacman game', 'game/index.html', true), /game is ready/i);
});
