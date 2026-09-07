// Code Mode plans must use task-appropriate wording: a generic web app (e.g. a budget tracker)
// must NOT inherit game/Pac-Man wording from the fallback plan, while a game still may.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultPlan } = require('../src/code/plan/codePlan.js');

const GAME_TERMS = /\b(game|pac-?man|canvas|pellet|ghost|score|collision|arcade|maze)\b/i;

function planText(goal) {
    return defaultPlan(goal).steps.map(s => s.title).join('\n');
}

test('budget tracker plan has NO game wording and DOES use app terms', () => {
    const text = planText('Build a Personal Budget Tracker web app');
    assert.doesNotMatch(text, GAME_TERMS, `unexpected game wording in: ${text}`);
    // app-oriented terms (at least one of transaction/localStorage/filter/totals)
    assert.match(text, /\b(transaction|localStorage|filter|totals?)\b/i, `expected app terms in: ${text}`);
    // and it still verifies + previews (we did not remove preview)
    assert.match(text, /preview/i);
});

test('other generic web apps also avoid game wording', () => {
    for (const goal of ['Build a todo list web app', 'Create a notes app website', 'Make a weather dashboard app']) {
        assert.doesNotMatch(planText(goal), GAME_TERMS, `game wording leaked for: ${goal}`);
    }
});

test('Pac-Man / game prompt MAY use game wording (game support intact)', () => {
    const text = planText('Build a Pac-Man game');
    assert.match(text, /\bgame\b/i, 'game plan should be allowed to mention game');
    assert.match(text, /preview/i);
});

test('a snake game also gets game steps', () => {
    assert.match(planText('Build a Snake game in the browser'), /\bgame\b/i);
});
