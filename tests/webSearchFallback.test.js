/**
 * v53.5 — web search fallback: "mobile web UI shows sources but no results"
 *
 * Root cause (reproduced live on qwen3.8-27b-obliterated, scripts/_repro-turn2.js): merged
 * Qwen builds ignore the enable_thinking:false override and burn their whole post-search
 * reply on reasoning_content — returning either NO content or only a forbidden fetch_url
 * call as XML text. The old recovery nudged up to 3 times (or executed the forbidden
 * fetches, minutes each) and ended with an apology note; the user saw ONLY sources.
 *
 * The fix guarantees an answer from data already in hand: after a SUCCESSFUL web_search,
 *   - silence → synthesize + finish,
 *   - no-prose web-only tool batch → skip execution, synthesize + finish.
 *
 * This file tests the pure module (parser / synthesizer / batch detection) for real, and
 * statically verifies the app.js wiring (module bundled via entry.js; both guard sites
 * present and gated on a successful search).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fb = require('../src/renderer/modes/webSearchFallback.js');

// The exact compact shape agentTools.js returns (v53+), nudge included.
const COMPACT_RESULT = [
    '1. FIFA — 2026 World Cup Final: full report and highlights',
    '   URL: https://www.fifa.com/en/tournaments/mens/worldcup/2026/final',
    '2. ESPN — Final score, stats and reaction from the 2026 World Cup final',
    '   URL: https://www.espn.com/soccer/story/_/id/45678901/world-cup-final-recap'
].join('\n') + '\n\n[SYSTEM NUDGE]: The web search completed successfully. You MUST now write the final answer for the user in your NEXT response, summarizing these results in Smith\'s voice (first-person narrative, "I found that…"). Do NOT call fetch_url or any other tool to read these pages — the snippets above are enough; do not ask permission to continue.';

// ── parser ────────────────────────────────────────────────────────────────────

test('parseWebSearchEntries: compact numbered shape (title, snippet, url)', () => {
    const entries = fb.parseWebSearchEntries(COMPACT_RESULT);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
        title: 'FIFA',
        url: 'https://www.fifa.com/en/tournaments/mens/worldcup/2026/final',
        snippet: '2026 World Cup Final: full report and highlights'
    });
    assert.equal(entries[1].title, 'ESPN');
});

// v54 deep-research report fixture (the exact shape buildResearchReport emits).
const DEEP_REPORT = [
    'DEEP RESEARCH REPORT — "2026 World Cup final"',
    'Sources found: 3 · pages read in full: 2',
    '',
    'SOURCE 1: FIFA — Official match report',
    'URL: https://www.fifa.com/en/tournaments/mens/worldcup/2026/final',
    'WHAT I LEARNED FROM THIS PAGE:',
    'The final was played on July 19, 2026 and ended 3-2 after extra time.',
    'KEY FACTS:',
    '- The match drew a record crowd of 98,452 fans.',
    '- Two goals were scored in the last ten minutes.',
    '',
    'SOURCE 2: ESPN — Final score, stats and reaction',
    'URL: https://www.espn.com/soccer/story/_/id/45678901/world-cup-final-recap',
    'WHAT I LEARNED FROM THIS PAGE:',
    'ESPN reports the winner sealed the title with a penalty in stoppage time.',
    '',
    'SNIPPET-ONLY SOURCES (page not readable — paywall, timeout or empty body):',
    'SOURCE 3: Reuters — Live updates from the final',
    'URL: https://reuters.com/final',
    '',
    '[SYSTEM NUDGE] This result is a DEEP RESEARCH REPORT…'
].join('\n');

test('v54 parseWebSearchEntries: deep-research report (learned content + key facts)', () => {
    const entries = fb.parseWebSearchEntries(DEEP_REPORT);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], {
        title: 'FIFA — Official match report',
        url: 'https://www.fifa.com/en/tournaments/mens/worldcup/2026/final',
        snippet: '',
        content: 'The final was played on July 19, 2026 and ended 3-2 after extra time.',
        facts: [
            'The match drew a record crowd of 98,452 fans.',
            'Two goals were scored in the last ten minutes.'
        ]
    });
    assert.equal(entries[1].title, 'ESPN — Final score, stats and reaction');
    assert.ok(entries[1].content.includes('penalty in stoppage time'));
    // Snippet-only source: no learned section → title/snippet from the dash.
    assert.deepEqual(entries[2], {
        title: 'Reuters',
        url: 'https://reuters.com/final',
        snippet: 'Live updates from the final',
        content: '',
        facts: []
    });
});

test('v54 parseWebSearchEntries: deep-research [SYSTEM NUDGE] trailer never leaks into entries', () => {
    const entries = fb.parseWebSearchEntries(DEEP_REPORT);
    for (const e of entries) {
        assert.ok(!/NUDGE/i.test(e.title + ' ' + e.snippet + ' ' + e.content), 'nudge text leaked');
        for (const f of e.facts) assert.ok(!/NUDGE/i.test(f));
    }
});

test('v54 synthesizeAnswer: deep-research entries produce a real report, not bare snippets', () => {
    const out = fb.synthesizeAnswer('2026 World Cup final', DEEP_REPORT);
    assert.ok(out, 'must produce an answer from the deep-research results');
    assert.match(out.markdown, /Here's what I found on \*\*"2026 World Cup final"\*\*/);
    assert.match(out.markdown, /\[FIFA — Official match report\]\(https:\/\/www\.fifa\.com\/en\/tournaments\/mens\/worldcup\/2026\/final\)/);
    // Learned content + key facts must be in the synthesized answer.
    assert.ok(out.markdown.includes('ended 3-2 after extra time'), 'learned content present');
    assert.ok(out.markdown.includes('- The match drew a record crowd of 98,452 fans.'), 'key fact present');
});

test('parseWebSearchEntries: [SYSTEM NUDGE] trailer is stripped (never parsed as an entry)', () => {
    const entries = fb.parseWebSearchEntries(COMPACT_RESULT);
    for (const e of entries) {
        assert.ok(!/NUDGE/i.test(e.title + ' ' + e.snippet), 'nudge text leaked into an entry');
    }
});

test('parseWebSearchEntries: legacy "Title (url): snippet" shape', () => {
    const text = 'Reuters — Live updates from the final\n   URL: https://reuters.com/final';
    // Legacy form is blank-line separated, no numbering.
    const legacy = 'BBC Sport (https://bbc.co.uk/sport/final): The full story of the match';
    assert.deepEqual(fb.parseWebSearchEntries(legacy), [
        { title: 'BBC Sport', url: 'https://bbc.co.uk/sport/final', snippet: 'The full story of the match' }
    ]);
    // Numbered-with-URL lines (the v53 shape) also parse.
    assert.equal(fb.parseWebSearchEntries(text)[0].url, 'https://reuters.com/final');
});

test('parseWebSearchEntries: backend failure and zero-hit text yield no entries', () => {
    assert.deepEqual(fb.parseWebSearchEntries('Web search failed: fetch to DuckDuckGo timed out.'), []);
    assert.deepEqual(fb.parseWebSearchEntries('No web results found. Tell the user you could not find any results.'), []);
});

test('parseWebSearchEntries: null/empty/garbage input is safe', () => {
    assert.deepEqual(fb.parseWebSearchEntries(null), []);
    assert.deepEqual(fb.parseWebSearchEntries(undefined), []);
    assert.deepEqual(fb.parseWebSearchEntries(''), []);
    assert.deepEqual(fb.parseWebSearchEntries(42), []);
});

// ── synthesizer ───────────────────────────────────────────────────────────────

test('synthesizeAnswer: builds a first-person answer with linked sources', () => {
    const out = fb.synthesizeAnswer('what happened at the 2026 World Cup final', COMPACT_RESULT);
    assert.ok(out, 'must produce an answer from real results');
    assert.match(out.markdown, /Here's what I found on \*\*"what happened at the 2026 World Cup final"\*\*/);
    assert.match(out.markdown, /\[FIFA\]\(https:\/\/www\.fifa\.com\/en\/tournaments\/mens\/worldcup\/2026\/final\)/);
    assert.match(out.markdown, /ESPN/);
    // Honest attribution: the user must know this was compiled from the results.
    assert.match(out.markdown, /Compiled from the search results above/);
});

test('synthesizeAnswer: caps at 6 entries', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
        `${i + 1}. Source ${i + 1} — snippet number ${i + 1}\n   URL: https://example.com/${i + 1}`).join('\n');
    const out = fb.synthesizeAnswer('q', many);
    assert.ok(out);
    assert.equal((out.markdown.match(/snippet number \d+/g) || []).length, 6);
});

test('synthesizeAnswer: null when there is nothing real to report', () => {
    assert.equal(fb.synthesizeAnswer('q', 'Web search failed: network down.'), null);
    assert.equal(fb.synthesizeAnswer('q', 'No web results found. Tell the user you could not find any results.'), null);
    assert.equal(fb.synthesizeAnswer('q', ''), null);
});

// ── web-only batch detection ──────────────────────────────────────────────────

test('isWebOnlyBatch: true only when EVERY call is a web-read tool', () => {
    const tc = (name) => ({ function: { name } });
    assert.equal(fb.isWebOnlyBatch([tc('fetch_url')]), true);
    assert.equal(fb.isWebOnlyBatch([tc('web_search'), tc('fetch_url')]), true);
    assert.equal(fb.isWebOnlyBatch([tc('fetch_url'), tc('run_shell_command')]), false);
    assert.equal(fb.isWebOnlyBatch([]), false);
    assert.equal(fb.isWebOnlyBatch(null), false);
});

// ── app.js wiring (static — the loop itself is browser-only) ──────────────────

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const entrySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'entry.js'), 'utf8');

test('wiring: webSearchFallback is bundled via entry.js (web mode + electron both load it)', () => {
    assert.match(entrySrc, /require\('\.\/modes\/webSearchFallback\.js'\)/);
});

test('wiring: successful searches are remembered per-run (batch + legacy paths)', () => {
    // Both execution paths must record lastWebSearch — and only for SUCCESSFUL results.
    const sets = appSrc.match(/lastWebSearch\s*=\s*\{\s*query:/g) || [];
    assert.ok(sets.length >= 4, `expected ≥4 lastWebSearch assignments (batch try/catch + legacy try/catch), found ${sets.length}`);
    assert.match(appSrc, /let lastWebSearch = null;/);
});

test('wiring: silent-after-search renders the fallback answer and ends the run', () => {
    const idx = appSrc.indexOf('silentTurns === 1 && lastTurnHadWebSearch && lastWebSearch');
    assert.ok(idx > 0, 'silent branch must check for a web_search on the PREVIOUS turn (no stale summaries)');
    const after = appSrc.slice(idx, idx + 1400);
    // The synthesized answer (not an empty string) is recorded as the assistant's reply —
    // follow-ups ("tell me more about #2") need continuity.
    assert.match(after, /convo\.push\(\{ role: 'assistant', content: fbAnswer\.markdown \}\)/);
    assert.match(after, /finishWithWebSearchFallback\(botDiv, lastWebSearch\.query, lastWebSearch\.result\)/);
    assert.match(after, /finished = true; continue;/);
});

test('wiring: no-prose web-only batch after a search is skipped (not executed) and answered from results', () => {
    const idx = appSrc.indexOf('isWebOnlyBatch');
    assert.ok(idx > 0, 'must detect web-only tool batches');
    const gate = appSrc.slice(Math.max(0, idx - 400), idx + 1400);
    // The gate requires NO prose, a FRESH search nudge (previous turn ran web_search), and a remembered result.
    assert.match(gate, /!fullContent \|\| !String\(fullContent\)\.trim\(\)/);
    assert.match(gate, /webOnly && lastTurnHadWebSearch && lastWebSearch/);
    assert.match(gate, /convo\.push\(\{ role: 'assistant', content: fbAnswer\.markdown \}\)/);
    assert.match(gate, /finishWithWebSearchFallback\(botDiv, lastWebSearch\.query, lastWebSearch\.result\)/);
});

test('wiring: the fallback renderer appends (never wipes) and only ends on a real answer', () => {
    const fn = appSrc.slice(appSrc.indexOf('function finishWithWebSearchFallback'), appSrc.indexOf('\n}', appSrc.indexOf('function finishWithWebSearchFallback')));
    assert.match(fn, /botDiv\.innerHTML \+=/);          // append — the sources card + any prose survive
    assert.match(fn, /if \(!fb \|\| !fb\.markdown\) return false;/); // nothing real → caller's own path
});
