/**
 * v54 — Deep web research: web_search reads the top result pages in full and returns a
 * detailed natural-language report of everything learned, not just snippets.
 *
 * This file tests the pure engine (report builder + text utilities) for real, plus the
 * network path with fetch stubbed (search + page reads), so no test touches the internet:
 *   - buildResearchReport: stable parseable format (SOURCE N / WHAT I LEARNED / KEY FACTS /
 *     SNIPPET-ONLY SOURCES / [SYSTEM NUDGE]) — the renderer card and silence-fallback both
 *     depend on it.
 *   - splitSentences / queryTerms / scoreSentence / pickKeyFacts / summarizePage: fact
 *     extraction quality (query-relevant sentences win; boilerplate is penalized).
 *   - researchWeb with stubbed fetch: parallel page reads, per-page failure → snippet-only
 *     fallback, deep:false = no page reads, zero-hit search.
 *
 * v54.9 — DETAIL PASS: the report must carry enough material for a LONG answer (the user's
 * complaint was "response is very short and brief"). New invariants under test:
 *   - the engine reads EVERY top result in full by default (all 6, not just some), each at
 *     up to ~18k readable chars;
 *   - per page it keeps a 12-sentence findings paragraph + up to 10 facts (not 4+5);
 *   - long findings survive into the report (3600-char cap, not 900) and are bounded above;
 *   - the nudge demands a long answer ("at least 500 words") covering EVERY source.
 *
 * v55 — TRIPLE BUDGET: answers were STILL capped short (~200 words). The whole budget is
 * tripled: 54k chars/page, 36 findings sentences + 30 facts per page, report caps 10800 /
 * 1200, and the nudge demands "at least 1500 words". Tests assert the v55 contract.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const wt = require('../src/shared/webTools.js');

// ── report builder (format contract) ──────────────────────────────────────────

function fixtureResults() {
    return [
        { title: 'Alpha Report', url: 'https://alpha.test/report', snippet: 'snippet A' },
        { title: 'Beta Guide', url: 'https://beta.test/guide', snippet: 'snippet B' },
        { title: 'Gamma News — breaking', url: 'https://gamma.test/news', snippet: 'snippet C' }
    ];
}

test('buildResearchReport: full format with read pages + snippet-only sources', () => {
    const report = wt.buildResearchReport('quantum batteries 2026', fixtureResults(), [
        { index: 0, url: 'https://alpha.test/report', title: 'Alpha Report', truncated: false, summary: 'Quantum batteries reached 90% efficiency in 2026.', keyFacts: ['The milestone was announced by Alpha Labs on March 3, 2026.'] },
        { index: 1, url: 'https://beta.test/guide', title: 'Beta Guide', truncated: true, summary: '', keyFacts: [] }
    ]);

    assert.ok(report.startsWith('DEEP RESEARCH REPORT — "quantum batteries 2026"'));
    assert.ok(report.includes('Sources found: 3 · pages read in full: 2'));
    // Read page with findings.
    assert.ok(report.includes('SOURCE 1: Alpha Report'));
    assert.ok(report.includes('URL: https://alpha.test/report'));
    assert.ok(report.includes('WHAT I LEARNED FROM THIS PAGE:\nQuantum batteries reached 90% efficiency in 2026.'));
    assert.ok(report.includes('- The milestone was announced by Alpha Labs on March 3, 2026.'));
    // Read page with no extractable content: still listed as read (URL present), no learned section.
    assert.ok(report.includes('SOURCE 2: Beta Guide'));
    // Unread source → snippet-only section with its snippet.
    assert.ok(report.includes('SNIPPET-ONLY SOURCES (page not readable — paywall, timeout or empty body):'));
    assert.ok(report.includes('SOURCE 3: Gamma News — breaking — snippet C'));
    assert.ok(report.includes('URL: https://gamma.test/news'));
    // The nudge demands a detailed natural-language report.
    assert.ok(report.includes('[SYSTEM NUDGE]'));
    assert.match(report, /detailed, complete report/i);
});

test('buildResearchReport: no pages read → honest snippet-only note', () => {
    const report = wt.buildResearchReport('q', fixtureResults(), []);
    assert.ok(report.includes('(None of the top pages could be read in full — this report is built from search snippets alone.)'));
    assert.ok(report.includes('SOURCE 1: Alpha Report — snippet A'));
});

test('buildResearchReport: detailed findings survive (v54.9 — no more 900-char cap)', () => {
    // ~2000 chars of learned content must reach the report intact — v54 cut it at 900, which
    // is exactly why final answers came back brief.
    const long = 'word '.repeat(400).trim(); // ~2000 chars
    assert.ok(long.length > 1800 && long.length < 2200);
    const report = wt.buildResearchReport('q', fixtureResults(), [
        { index: 0, url: 'https://alpha.test/report', title: 'Alpha Report', truncated: false, summary: long, keyFacts: [] }
    ]);
    assert.ok(report.includes(long), 'a ~2k-char findings paragraph must survive verbatim');
});

test('buildResearchReport: very long learned content is still bounded (context budget)', () => {
    const huge = 'word '.repeat(3000).trim(); // ~15000 chars — beyond the 10800-char cap
    const report = wt.buildResearchReport('q', fixtureResults(), [
        { index: 0, url: 'https://alpha.test/report', title: 'Alpha Report', truncated: false, summary: huge, keyFacts: [] }
    ]);
    assert.ok(report.length < 15000, `report must stay bounded (got ${report.length})`);
    assert.ok(!report.includes(huge), 'over-cap findings must be capped');
});

test('buildResearchReport: long fact lines are capped per-fact', () => {
    const hugeFact = 'fact '.repeat(360).trim(); // ~1800 chars — beyond the 1200-char cap
    const report = wt.buildResearchReport('q', fixtureResults(), [
        { index: 0, url: 'https://alpha.test/report', title: 'Alpha Report', truncated: false, summary: '', keyFacts: [hugeFact] }
    ]);
    assert.ok(!report.includes(hugeFact), 'over-cap facts must be capped');
});

test('v55 tripled detail levels: ALL top results read in full, 36-sentence findings + up to 30 facts', () => {
    // The engine's own tuning constants (not a snapshot of arbitrary numbers — these ARE the
    // v55 contract that fixes "answers are still capped short": every budget tripled from v54.9).
    assert.equal(wt.RESEARCH_PAGE_COUNT, 6, 'every top result must be read in full by default');
    assert.ok(wt.RESEARCH_PAGE_CHARS >= 54000, 'each page must be read in full (>=54k readable chars)');
    assert.equal(wt.RESEARCH_SUMMARY_SENTENCES, 36);
    assert.equal(wt.RESEARCH_FACTS_MAX, 30);
    assert.ok(wt.RESEARCH_REPORT_SUMMARY_CAP >= 10800, 'findings paragraph cap tripled from v54.9');
    assert.ok(wt.RESEARCH_REPORT_FACT_CAP >= 1200, 'per-fact line cap tripled from v54.9');

    // And the machinery honors them: a page with 38 relevant sentences yields 36 in the
    // findings paragraph and up to 30 key facts.
    const sents = [];
    for (let i = 1; i <= 38; i++) sents.push(`Quantum battery detail number ${i} was confirmed by researchers in 2026.`);
    const text = sents.join(' ');
    const summarySentences = wt.summarizePage(text, 'quantum batteries', wt.RESEARCH_SUMMARY_SENTENCES).split('.').filter(Boolean);
    assert.ok(summarySentences.length >= 36, `findings paragraph must carry ${wt.RESEARCH_SUMMARY_SENTENCES} sentences (got ${summarySentences.length})`);
    const facts = wt.pickKeyFacts(text, 'quantum batteries', wt.RESEARCH_FACTS_MAX);
    assert.equal(facts.length, wt.RESEARCH_FACTS_MAX, `expected up to ${wt.RESEARCH_FACTS_MAX} facts (got ${facts.length})`);
});

test('v55 nudge demands a LONG answer (>=1500 words) covering EVERY source', () => {
    const report = wt.buildResearchReport('quantum batteries', fixtureResults(), [
        { index: 0, url: 'https://alpha.test/report', title: 'Alpha Report', truncated: false, summary: 'Quantum batteries reached 90% efficiency in 2026.', keyFacts: [] }
    ]);
    assert.match(report, /at least 1500 words/i);
    assert.match(report, /cover EVERY source listed above/i);
});

// ── text utilities ────────────────────────────────────────────────────────────

test('splitSentences: paragraph-aware sentence splitting', () => {
    const s = wt.splitSentences('First fact here. Second one too!\n\nThird paragraph starts. It continues? Yes.');
    assert.ok(s.includes('First fact here.'));
    assert.ok(s.includes('Second one too!'));
    assert.ok(s.includes('Third paragraph starts.'));
});

test('queryTerms: stopwords removed, short words dropped', () => {
    const t = wt.queryTerms('What is the price of quantum batteries in 2026?');
    assert.ok(t.includes('quantum') && t.includes('batteries'));
    assert.ok(!t.includes('what') && !t.includes('the') && !t.includes('price'.slice(0, 1)));
});

test('scoreSentence: query overlap + fact signals beat boilerplate', () => {
    const terms = wt.queryTerms('quantum batteries');
    const signal = wt.scoreSentence('Quantum batteries reached 90% efficiency in 2026.', terms);
    const noise = wt.scoreSentence('Click here to sign in and accept our cookie policy.', terms);
    assert.ok(signal > noise, `signal ${signal} must beat boilerplate ${noise}`);
});

test('pickKeyFacts: query-relevant sentences win; dedupe + cap', () => {
    const text = [
        'Welcome to our website. We hope you enjoy your visit.',
        'Quantum batteries reached 90% efficiency in 2026, the company said.',
        'Quantum batteries reached 90% efficiency in 2026, the company said.', // duplicate
        'The milestone was announced by Alpha Labs on March 3, 2026.'
    ].join('\n');
    const facts = wt.pickKeyFacts(text, 'quantum batteries', 5);
    assert.ok(facts.length >= 1 && facts.length <= 5);
    assert.ok(facts.some(f => f.includes('90% efficiency')));
});

test('summarizePage: returns a natural-language paragraph from the page text', () => {
    const text = 'Navigation menu. Home About Contact.\n\nQuantum batteries reached 90% efficiency in 2026, researchers said. The breakthrough uses solid-state cells. Alpha Labs plans to ship them by 2027.';
    const s = wt.summarizePage(text, 'quantum batteries', 4);
    assert.ok(s.length > 0);
    assert.ok(s.includes('Quantum batteries reached 90% efficiency in 2026'));
});

test('nav-noise: title echoes and nav-menu runs are filtered out of facts/summary', () => {
    const pageTitle = 'appimage | electron-builder';
    const text = [
        'appimage | electron-builder', // header echo of the page title
        'electron-builder Overview Platforms All Targets macOS Windows Linux', // nav menu run
        'AppImage is one of the two default Linux targets for electron-builder (along with Snap).',
        'Since electron-builder 21, desktop integration is NOT handled by the AppImage itself.'
    ].join('\n');
    const facts = wt.pickKeyFacts(text, 'electron-builder appimage linux', 5, pageTitle);
    assert.ok(facts.some(f => f.includes('default Linux targets')));
    for (const f of facts) {
        assert.ok(!wt.isTitleEcho(f, pageTitle), `title echo leaked into facts: ${f}`);
        assert.ok(!/Overview Platforms All Targets/.test(f), `nav menu leaked into facts: ${f}`);
    }
    const s = wt.summarizePage(text, 'electron-builder appimage linux', 4, pageTitle);
    assert.ok(!wt.isTitleEcho(s.split('.')[0], pageTitle), 'summary must not open with the title echo');
});

// ── researchWeb with stubbed fetch (no network) ───────────────────────────────

const SEARCH_HTML = `
<html><body>
<div class="result results__result">
  <div class="result__body">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.test%2Freport">Alpha Report</a>
    <a class="result__snippet" href="#">Snippet about alpha.</a>
  </div>
</div>
<div class="result results__result">
  <div class="result__body">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbeta.test%2Fguide">Beta Guide</a>
    <a class="result__snippet" href="#">Snippet about beta.</a>
  </div>
</div>
<div class="result results__result">
  <div class="result__body">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgamma.test%2Fnews">Gamma News</a>
    <a class="result__snippet" href="#">Snippet about gamma.</a>
  </div>
</div>
</body></html>`;

const ALPHA_PAGE = `<html><head><title>Alpha Report</title></head><body>
<p>Quantum batteries reached 90% efficiency in 2026, researchers said. The breakthrough uses solid-state cells that charge in minutes.</p>
<p>Alpha Labs plans to ship the first consumer units by 2027 at a price of $499.</p>
</body></html>`;

function stubFetch(routes) {
    const calls = [];
    return async function fetch(url, opts) {
        calls.push(String(url));
        const route = routes.find(r => String(url).includes(r.match));
        if (!route) throw new Error(`stub: no route for ${url}`);
        if (route.throw) throw new Error(route.throw);
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => route.body };
    };
}

test('researchWeb: reads top pages in full and builds the report (fetch stubbed)', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = stubFetch([
            { match: 'duckduckgo.com/html', body: SEARCH_HTML },
            { match: 'alpha.test/report', body: ALPHA_PAGE },
            { match: 'beta.test/guide', throw: 'HTTP 403' } // paywall → snippet-only fallback
        ]);
        const out = await wt.researchWeb('quantum batteries');
        assert.equal(out.results.length, 3);
        assert.ok(out.pagesRead >= 1 && out.pagesRead <= 2, `expected alpha read (got ${out.pagesRead})`);
        assert.ok(out.report.startsWith('DEEP RESEARCH REPORT'));
        // The page's actual content made it into the report.
        assert.ok(out.report.includes('Quantum batteries reached 90% efficiency in 2026'), 'learned content from the read page');
        // The failed page fell back to snippet-only, not an error.
        assert.ok(out.report.includes('SNIPPET-ONLY SOURCES'));
    } finally { global.fetch = realFetch; }
});

test('researchWeb: deep:false performs NO page reads (snippet-only legacy behavior)', async () => {
    const realFetch = global.fetch;
    try {
        const calls = [];
        global.fetch = stubFetch([{ match: 'duckduckgo.com/html', body: SEARCH_HTML }]);
        // Track every fetch the engine makes.
        const orig = global.fetch;
        global.fetch = async (url) => { calls.push(String(url)); return orig(url); };
        const out = await wt.researchWeb('quantum batteries', { deep: false });
        assert.equal(out.pagesRead, 0);
        assert.ok(!calls.some(u => u.includes('alpha.test')), 'no page fetches when deep:false');
    } finally { global.fetch = realFetch; }
});

test('researchWeb: zero-hit search → no report', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = stubFetch([{ match: 'duckduckgo.com/html', body: '<html><body>no results</body></html>' }]);
        const out = await wt.researchWeb('zzz-nothing-here');
        assert.equal(out.results.length, 0);
        assert.equal(out.report, null);
    } finally { global.fetch = realFetch; }
});

test('researchWeb: all pages fail → report still built from snippets (honest note)', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = stubFetch([
            { match: 'duckduckgo.com/html', body: SEARCH_HTML },
            { match: 'alpha.test/report', throw: 'timeout' },
            { match: 'beta.test/guide', throw: 'timeout' },
            { match: 'gamma.test/news', throw: 'timeout' }
        ]);
        const out = await wt.researchWeb('quantum batteries');
        assert.equal(out.pagesRead, 0);
        assert.ok(out.report.includes('(None of the top pages could be read in full'));
    } finally { global.fetch = realFetch; }
});

// ── v54.9: ALL sources must be read (the user's explicit requirement) ──────────

function resultBlock(host, label) {
    return `<div class="result results__result">
  <div class="result__body">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2F${host}%2Fpage">${label}</a>
    <a class="result__snippet" href="#">Snippet about ${label.toLowerCase()}.</a>
  </div>
</div>`;
}

const SIX_RESULT_HTML = `<html><body>${['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
    .map(h => resultBlock(`${h}.test`, h[0].toUpperCase() + h.slice(1))).join('\n')}</body></html>`;

function pageBody(host, n) {
    // Numeric finding ids — sentences must NOT contain the page-title word (e.g. "Alpha"),
    // or isTitleEcho() correctly treats them as header echoes and filters them out.
    const base = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].indexOf(host) * 100;
    const sents = [];
    for (let i = 1; i <= n; i++) sents.push(`Quantum battery finding ${base + i} was confirmed by researchers in 2026.`);
    return `<html><body><p>${sents.join(' ')}</p></body></html>`;
}

test('researchWeb: reads ALL six top sources in full (v54.9 — "all sources need to be read")', async () => {
    const realFetch = global.fetch;
    try {
        const routes = [{ match: 'duckduckgo.com/html', body: SIX_RESULT_HTML }];
        for (const h of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
            routes.push({ match: `${h}.test/page`, body: pageBody(h, 8) });
        }
        global.fetch = stubFetch(routes);
        const out = await wt.researchWeb('quantum batteries');
        assert.equal(out.results.length, 6);
        // Every single source was read in full — none fell back to snippet-only.
        assert.equal(out.pagesRead, 6, `ALL six sources must be read (got ${out.pagesRead})`);
        for (const h of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
            const base = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].indexOf(h) * 100;
            assert.ok(out.report.includes(`Quantum battery finding ${base + 1} was confirmed by researchers in 2026.`),
                `learned content from ${h} must reach the report`);
        }
        // No snippet-only section at all — everything was readable.
        assert.ok(!out.report.includes('SNIPPET-ONLY SOURCES'), 'no source should be left unread');
        assert.match(out.report, /Sources found: 6 · pages read in full: 6/);
    } finally { global.fetch = realFetch; }
});

test('researchWeb: explicit pageCount still bounds reads (opt-down for fast lookups)', async () => {
    const realFetch = global.fetch;
    try {
        const routes = [{ match: 'duckduckgo.com/html', body: SIX_RESULT_HTML }];
        for (const h of ['alpha', 'beta']) routes.push({ match: `${h}.test/page`, body: pageBody(h, 8) });
        global.fetch = stubFetch(routes);
        const out = await wt.researchWeb('quantum batteries', { pageCount: 2 });
        assert.equal(out.pagesRead, 2, 'pageCount opt-down must be honored');
        // The unread sources fall back to snippet-only — the report stays honest.
        assert.ok(out.report.includes('SNIPPET-ONLY SOURCES'));
    } finally { global.fetch = realFetch; }
});
