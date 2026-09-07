// Proves the Code Mode acceptance/verification harness is general-purpose and NOT
// overfit to Pac-Man: non-game goals are not forced through game gates, generic game
// checks pass for any game type, and the last-resort Pac-Man scaffold only triggers
// for actual Pac-Man goals (no cross-contamination into Snake/Tetris/etc.).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAcceptance, classifyTask } = require('../src/code/governor/acceptance.js');
const { isPacmanGoal } = require('../src/code/loop/harnessScaffold.js');

test('non-game goals are not forced through game acceptance gates', () => {
    for (const goal of [
        'fix the failing unit test in utils.js',
        'repair the broken import in server.js',
        'build a Node CLI that reverses a string',
        'fix the bug in the python script parse_args',
        'refactor the auth module into smaller files'
    ]) {
        const r = runAcceptance(goal, { html: '', js: '' });
        assert.equal(r.applicable, false, `acceptance must not apply to non-game goal: ${goal}`);
        assert.deepEqual(r.failed, []);
    }
});

test('a static HTML page is classified web but not gated as a game', () => {
    const t = classifyTask('build a simple static HTML landing page');
    assert.equal(t.isGame, false);
    assert.equal(t.isWeb, true);
    const r = runAcceptance('build a simple static HTML landing page', { html: '<h1>Hi</h1>', js: '' });
    assert.equal(r.applicable, false);
});

test('game acceptance is generic across game types (not Pac-Man specific)', () => {
    const html = '<canvas id="board"></canvas><div class="player"></div><span id="score">0</span>';
    const js = `let score = 0;
        document.addEventListener('keydown', () => { score += 1; });
        document.getElementById('score').textContent = score;
        function gameLoop(){} setInterval(gameLoop, 100);
        function finish(){ /* you win */ }`;
    for (const goal of ['build a snake game', 'make a tetris game', 'create a breakout game']) {
        const r = runAcceptance(goal, { html, js });
        assert.equal(r.applicable, true, goal);
        assert.deepEqual(r.failed, [], `${goal} should pass generic game checks but failed: ${JSON.stringify(r.failed)}`);
    }
});

test('Pac-Man scaffold only triggers for real Pac-Man goals (no cross-contamination)', () => {
    // Real Pac-Man goals still trigger the known-good recovery scaffold.
    assert.equal(isPacmanGoal('build a web based pac-man game'), true);
    assert.equal(isPacmanGoal('create a pac man web browser game'), true); // space variant
    assert.equal(isPacmanGoal('make a PacMan clone'), true);
    // Other games / generic goals must NOT get Pac-Man code injected.
    assert.equal(isPacmanGoal('build a snake game'), false);
    assert.equal(isPacmanGoal('create a tetris game'), false);
    assert.equal(isPacmanGoal('build a simple game'), false);
    assert.equal(isPacmanGoal('fix the failing test'), false);
});
