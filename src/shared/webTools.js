/**
 * v50 web tools — DuckDuckGo search + public URL fetch, extracted out of main.js
 * so BOTH the `perform-search` IPC (renderer netrunner/agent path) and the unified
 * engine's web_search/fetch_url tools share one implementation.
 *
 * v54 — DEEP RESEARCH: web_search no longer stops at snippets. researchWeb() reads
 * the top result pages in full (parallel, budget-bounded), extracts what each page
 * actually says + its key facts, and assembles a detailed natural-language report of
 * everything learned. That report is what both tool paths return by default; the old
 * snippet-only behavior survives behind {deep:false} / quick:true for fast lookups.
 */
'use strict';

const { validatePublicFetchTarget } = require('./netGuard.js');

const MAX_RESULTS = 6;
const SEARCH_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 20000;
const FETCH_MAX_CHARS = 8000;

// ── v54 deep-research tuning ──────────────────────────────────────────────────
const RESEARCH_PAGE_COUNT = 3;           // top pages read in full (default)
const RESEARCH_FETCH_TIMEOUT_MS = 15000; // per-page fetch bound
const RESEARCH_PAGE_CHARS = 6000;        // readable text kept per page
const RESEARCH_TOTAL_BUDGET_MS = 45000;  // wall-clock budget for ALL page reads (they run in parallel)
const RESEARCH_MIN_CONTENT_CHARS = 80;   // below this a body is "thin" → snippet-only source
const RESEARCH_SUMMARY_SENTENCES = 4;    // sentences in each page's "what I learned" paragraph
const RESEARCH_FACTS_MAX = 5;            // key facts per page

function cleanText(str) {
    return String(str || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Strip HTML to readable text (shared by fetchUrl and deep-research page reads). */
function htmlToReadable(body) {
    return String(body || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

/** DuckDuckGo HTML search. Resolves to an array of {url,title,snippet}. */
async function webSearch(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.3.6',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://duckduckgo.com/'
            },
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Search failed: ${response.statusText}`);

        const html = await response.text();
        const results = [];
        const bodies = html.split('result__body');

        for (let i = 1; i < bodies.length; i++) {
            if (results.length >= MAX_RESULTS) break;
            const block = bodies[i];

            const linkMatch = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
            const snippetMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

            if (linkMatch) {
                let url = linkMatch[1];
                let title = linkMatch[2];
                const snippet = snippetMatch ? snippetMatch[1] : '';

                if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
                    try {
                        const urlObj = new URL('https:' + url);
                        const uddg = urlObj.searchParams.get('uddg');
                        if (uddg) url = decodeURIComponent(uddg);
                    } catch (e) { /* keep original */ }
                }

                title = cleanText(title);
                const cleanSnippet = cleanText(snippet);

                if (url && title) results.push({ url, title, snippet: cleanSnippet });
            }
        }
        return results;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Low-level public fetch → readable text. No truncation marker (that belongs to the
 * model-facing fetch_url wrapper). Resolves to {content,url,status,truncated} or throws.
 */
async function fetchReadable(url, opts = {}) {
    const u = validatePublicFetchTarget(url);
    if (!u) throw new Error('URL rejected (must be http(s) to a non-internal host).');

    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : FETCH_TIMEOUT_MS;
    const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : FETCH_MAX_CHARS;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(u.toString(), {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.3.6' }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const ctype = resp.headers.get('content-type') || '';
        let body = await resp.text();
        if (/html/i.test(ctype) || /^\s*</.test(body)) {
            body = htmlToReadable(body);
        }
        const truncated = body.length > maxChars;
        return { content: truncated ? body.slice(0, maxChars) : body, url: u.toString(), status: resp.status, truncated };
    } finally {
        clearTimeout(t);
    }
}

/** Fetch a public http(s) URL as readable text. Resolves to {content,url,status,truncated} or throws. */
async function fetchUrl(url) {
    const r = await fetchReadable(url);
    return {
        content: r.truncated ? r.content + '\n...[truncated — fetch a more specific URL for the rest]' : r.content,
        url: r.url,
        status: r.status,
        truncated: r.truncated
    };
}

// ── v54 deep-research text utilities (pure — unit-testable) ───────────────────

/** Split readable text into sentences. Paragraph breaks are hard boundaries; within a
 *  paragraph we break after sentence-final punctuation followed by an uppercase start. */
function splitSentences(text) {
    const out = [];
    for (const para of String(text || '').split(/\n+/)) {
        const p = para.replace(/[ \t]+/g, ' ').trim();
        if (!p) continue;
        const parts = p.split(/(?<=[.!?])\s+(?=["'A-Z0-9(])/);
        for (const s of parts) {
            const s2 = s.trim();
            // Skip fragments ("e.g.", "U.S.") and keep anything that can carry a fact.
            if (s2.length >= 10 && /[a-zA-Z]/.test(s2)) out.push(s2);
        }
    }
    return out;
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'what', 'which', 'who', 'whom', 'when', 'where', 'why',
    'how', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
    'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'there', 'here', 'not', 'no',
    'yes', 'at', 'by', 'from', 'as', 'into', 'over', 'under', 'again', 'then', 'once', 'so', 'than',
    'too', 'very', 'just', 'also', 'more', 'most', 'some', 'any', 'all', 'each', 'every', 'both',
    'few', 'own', 'same', 'such', 'only', 'other'
]);

/** Meaningful query terms (lowercased, stopwords removed) used to score page content. */
function queryTerms(query) {
    return String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Heuristic fact-signal score for one sentence against the query terms. */
function scoreSentence(sentence, terms) {
    const lower = String(sentence || '').toLowerCase();
    let score = 0;
    for (const t of terms) if (lower.includes(t)) score += 2;
    // Fact signals: digits, currency, percentages, years.
    if (/\d/.test(lower)) score += 1;
    if (/[$€£]|%|\b(19|20)\d{2}\b/.test(sentence)) score += 1;
    // Boilerplate penalty — nav/cookie/legal noise is not "what the page says".
    if (/cookie|privacy policy|sign ?in|log ?in|subscribe|copyright|all rights reserved|click here|read more|advertisement/i.test(lower)) score -= 3;
    // Nav-menu penalty: long runs of Capitalized words ("Overview Platforms All Targets
    // macOS Windows Linux") are site chrome, not content. [a-zA-Z]+ covers camelCase
    // entries like "macOS" that still read as menu items in a run.
    const titleRuns = sentence.match(/\b[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)+/g) || [];
    for (const run of titleRuns) {
        const words = run.split(' ').length;
        if (words >= 4) score -= 6; // a 4+ word capitalized run is almost certainly menu chrome
        else if (words === 3) score -= 3;
    }
    return score;
}

/** True when the sentence is just the page's title repeated (nav/header echo). */
function isTitleEcho(sentence, pageTitle) {
    const s = String(sentence || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const t = String(pageTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!s || !t) return false;
    return s.includes(t) || t.includes(s);
}

/** Pick up to `max` key facts (sentences) from page text, best query-relevance first. */
function pickKeyFacts(text, query, max = 5, pageTitle) {
    const terms = queryTerms(query);
    const seen = new Set();
    const scored = [];
    for (const s of splitSentences(text)) {
        if (s.length > 300) continue; // too long to be a clean fact line
        if (pageTitle && isTitleEcho(s, pageTitle)) continue; // header/nav echo, not content
        const key = s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        scored.push({ s, score: scoreSentence(s, terms) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.filter(x => x.score > 0).slice(0, max).map(x => x.s);
}

/** A short natural-language paragraph of what the page says (top sentences, document order). */
function summarizePage(text, query, maxSentences = 4, pageTitle) {
    const terms = queryTerms(query);
    let sentences = splitSentences(text);
    if (pageTitle) sentences = sentences.filter(s => !isTitleEcho(s, pageTitle)); // drop header echoes
    if (!sentences.length) return '';

    let picked;
    const scored = sentences.map((s, i) => ({ s, score: scoreSentence(s, terms) + (i < 6 ? 1 : 0) }));
    const positive = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (!positive.length) {
        picked = sentences.slice(0, maxSentences); // no query overlap — the lede is the best we have
    } else {
        const set = new Set();
        for (const x of positive) { if (set.size >= maxSentences) break; set.add(x.s); }
        picked = sentences.filter(s => set.has(s)).slice(0, maxSentences); // re-emit in document order
    }
    return picked.join(' ');
}

function capText(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (s.length <= n) return s;
    return s.slice(0, n).replace(/[\s,;:—-]+$/, '') + '…';
}

/**
 * Build the model-facing deep-research report. The format is STABLE and parseable —
 * the renderer's sources card and the silence-fallback synthesizer both rely on it:
 *
 *   DEEP RESEARCH REPORT — "query"
 *   Sources found: N · pages read in full: M
 *
 *   SOURCE 1: <title>                      ← read in full (WHAT/KEY FACTS sections follow)
 *   URL: <url>
 *   WHAT I LEARNED FROM THIS PAGE:
 *   <natural-language paragraph taken from the page itself>
 *   KEY FACTS:
 *   - <fact sentence>
 *
 *   SOURCE 4: <title> — <snippet>          ← snippet-only source (page not readable)
 *   URL: <url>
 *
 *   [SYSTEM NUDGE] ...
 */
function buildResearchReport(query, results, pages) {
    const lines = [];
    lines.push(`DEEP RESEARCH REPORT — "${query}"`);
    lines.push(`Sources found: ${results.length} · pages read in full: ${(pages || []).length}`);

    for (const p of pages || []) {
        const src = results[p.index];
        if (!src) continue;
        lines.push('', `SOURCE ${p.index + 1}: ${src.title}`, `URL: ${src.url}`);
        if (p.summary) lines.push('WHAT I LEARNED FROM THIS PAGE:', capText(p.summary, 900));
        if (Array.isArray(p.keyFacts) && p.keyFacts.length) {
            lines.push('KEY FACTS:');
            for (const f of p.keyFacts) lines.push(`- ${capText(f, 260)}`);
        }
    }

    const readIdx = new Set((pages || []).map(p => p.index));
    const unread = results.map((r, i) => ({ r, i })).filter(x => !readIdx.has(x.i));
    if (unread.length) {
        lines.push('', 'SNIPPET-ONLY SOURCES (page not readable — paywall, timeout or empty body):');
        for (const { r, i } of unread) {
            lines.push(`SOURCE ${i + 1}: ${r.title}${r.snippet ? ` — ${capText(r.snippet, 300)}` : ''}`, `URL: ${r.url}`);
        }
    }

    if (!(pages || []).length) {
        lines.push('', '(None of the top pages could be read in full — this report is built from search snippets alone.)');
    }

    lines.push('', '[SYSTEM NUDGE] This result is a DEEP RESEARCH REPORT: it contains what was actually learned from the source pages, not just snippets. Your next response MUST be a detailed, complete report for the user written in natural language (Smith\'s voice, first person): synthesize EVERYTHING above into flowing prose organized by topic — include specific facts, numbers, names and dates, and name your sources inline (title + URL). Do NOT reply with a bare list of snippets or "here are some results". If a page could not be read, say so honestly. The pages above were already fetched for you — do NOT call fetch_url on them again; if you need more depth from OTHER sources, one or two targeted fetch_url calls are fine.');
    return lines.join('\n');
}

/**
 * v54 deep research: search + read the top result pages in full and build a detailed
 * natural-language report of everything learned.
 *
 * @param {string} query
 * @param {object} [opts]
 *   deep      — false → snippet-only (old behavior, no page reads). Default true.
 *   pageCount — how many top pages to read (default RESEARCH_PAGE_COUNT, max MAX_RESULTS)
 *   budgetMs  — wall-clock budget for all page reads (default RESEARCH_TOTAL_BUDGET_MS)
 * @returns {Promise<{query:string, results:Array, pagesRead:number, pages:Array|null, report:string|null}>}
 */
async function researchWeb(query, opts = {}) {
    const q = String(query || '').trim();
    const results = await webSearch(q);
    if (!results.length) return { query: q, results: [], pagesRead: 0, pages: null, report: null };

    let pages = [];
    if (opts.deep !== false) {
        const pageCount = Math.max(1, Math.min(MAX_RESULTS, Number(opts.pageCount) || RESEARCH_PAGE_COUNT));
        const deadline = Date.now() + (Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : RESEARCH_TOTAL_BUDGET_MS);

        // Read the top pages IN PARALLEL; each read is bounded by its own timeout AND the
        // shared remaining budget. A page that fails (timeout, HTTP error, blocked host,
        // thin body) simply falls back to snippet-only — one bad source never sinks the report.
        const targets = results.slice(0, pageCount);
        const reads = await Promise.all(targets.map(async (r, i) => {
            const remaining = deadline - Date.now();
            if (remaining < 2500) return null; // no time left to read this page
            try {
                const f = await fetchReadable(r.url, { timeoutMs: Math.min(RESEARCH_FETCH_TIMEOUT_MS, remaining), maxChars: RESEARCH_PAGE_CHARS });
                const content = String(f.content || '').trim();
                if (content.length < RESEARCH_MIN_CONTENT_CHARS) return null; // thin/empty body → snippet-only
                return {
                    index: i,
                    url: r.url,
                    title: r.title,
                    truncated: !!f.truncated,
                    summary: summarizePage(content, q, RESEARCH_SUMMARY_SENTENCES, r.title),
                    keyFacts: pickKeyFacts(content, q, RESEARCH_FACTS_MAX, r.title)
                };
            } catch (e) {
                return null; // timeout / HTTP error / rejected host → snippet-only source
            }
        }));
        pages = reads.filter(Boolean);
    }

    const report = buildResearchReport(q, results, pages);
    return { query: q, results, pagesRead: pages.length, pages, report };
}

module.exports = {
    webSearch, fetchUrl, researchWeb, cleanText, htmlToReadable,
    // v54 deep-research internals (exported for unit tests)
    buildResearchReport, splitSentences, pickKeyFacts, summarizePage, queryTerms, scoreSentence, isTitleEcho,
    RESEARCH_PAGE_COUNT, RESEARCH_TOTAL_BUDGET_MS
};
