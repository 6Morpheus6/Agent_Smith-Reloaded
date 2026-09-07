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

test('buildResearchReport: caps long learned content and facts (context budget)', () => {
    const long = 'word '.repeat(400).trim(); // ~2000 chars
    const report = wt.buildResearchReport('q', fixtureResults(), [
        { index: 0, url: 'https://alpha.test/report', title: 'Alpha Report', truncated: false, summary: long, keyFacts: [long] }
    ]);
    assert.ok(report.length < 4000, `report must stay bounded (got ${report.length})`);
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
