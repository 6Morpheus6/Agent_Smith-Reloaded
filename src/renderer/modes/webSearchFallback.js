/**
 * webSearchFallback — v53.5: when the model goes silent AFTER a successful web_search,
 * render an answer from the ACTUAL search results instead of ending with "sources shown,
 * no summary."
 *
 * Why this exists (reproduced live on qwen3.8-27b-obliterated via LM Studio):
 *   - The Qwen3 chat template thinks by default. Merged/"abliterated" builds IGNORE the
 *     enable_thinking:false override (chat_template_kwargs) — a post-search turn burned
 *     8,600+ chars of reasoning_content and returned either NO content at all, or only a
 *     forbidden fetch_url call emitted as XML text.
 *   - The app's nudge ("answer NOW from the snippets") is then ignored: the model chains
 *     fetch_url (minutes per call on slow GPUs) or goes silent; after 3 silent nudges the
 *     run ends with an apology note. On the mobile web UI the user sees ONLY the sources
 *     card — "the chat only shows the sources, not the actual results."
 *
 * The fix is model-agnostic: it does NOT try to make the model stop thinking (that knob
 * demonstrably doesn't work on merged builds). It guarantees the user gets an answer from
 * data we already have in hand — v54: that data is a DEEP RESEARCH REPORT (the top pages
 * were read in full; each entry carries what was learned + key facts, not just snippets).
 * Two triggers, both gated on a SUCCESSFUL web_search earlier in the run:
 *   1. SILENT turn (no content, no tool call) right after the search → synthesize + finish.
 *   2. Turn that returns ONLY more web calls (fetch_url/web_search) with NO prose — the
 *      model ignoring the "answer now" nudge → skip execution (it would burn minutes and
 *      loop back into silence), synthesize from the actual results, finish.
 *
 * A turn WITH prose is always allowed through unchanged: a model that narrates ("let me
 * read that page…") before calling fetch_url is doing legitimate multi-step work.
 *
 * Exposed as window.XKWebSearchFallback (renderer) / module.exports (tests).
 */
(function (global) {
    'use strict';

    const WEB_TOOL_NAMES = new Set(['web_search', 'fetch_url']);

    /**
     * Parse a web_search result into entries. Handles, in order:
     *   1. v54 DEEP RESEARCH REPORT — "SOURCE N: title" blocks with URL / WHAT I LEARNED
     *      FROM THIS PAGE / KEY FACTS sections (snippet-only sources carry "— snippet").
     *   2. v53 compact numbered text — "N. Title — snippet\n   URL: https://…"
     *   3. legacy — "Title (https://…): snippet"
     * Strips the [SYSTEM NUDGE] trailer first; returns [] for failures / no-results text.
     * Entry shape: { title, url, snippet, content?, facts? } — content/facts only exist
     * when the page was read in full (v54).
     */
    function parseWebSearchEntries(resultText) {
        if (!resultText || typeof resultText !== 'string') return [];
        const clean = String(resultText).split('[SYSTEM NUDGE]')[0].trim();
        if (!clean) return [];
        // Backend failure ("Web search failed: …") and genuine zero-hit searches carry no entries.
        if (/^(?:web search failed|no web results found)/i.test(clean)) return [];

        // ── v54 deep-research report format ────────────────────────────────────────
        if (/^DEEP RESEARCH REPORT/i.test(clean) || /\nSOURCE \d+: /m.test('\n' + clean)) {
            const entries = [];
            for (const block of clean.split(/\n(?=SOURCE \d+: )/)) {
                const b = block.trim();
                if (!/^SOURCE \d+: /i.test(b)) continue; // report header lines, section headers
                let title = '', url = '', snippet = '', content = '';
                const facts = [];

                const firstLine = b.split('\n')[0];
                const head = firstLine.replace(/^SOURCE \d+:\s*/i, '');
                const LEARNED = 'WHAT I LEARNED FROM THIS PAGE:';
                const learnedIdx = b.indexOf(LEARNED);
                if (learnedIdx >= 0) {
                    // Page was read in full: the whole head is its title (titles may contain "—").
                    title = head.trim();
                } else {
                    // Snippet-only source: "Title — snippet" (dash may be absent).
                    const dash = / — /.exec(head);
                    if (dash) { title = head.slice(0, dash.index).trim(); snippet = head.slice(dash.index + 3).trim(); }
                    else title = head.trim();
                }

                const urlM = /\n\s*URL:\s*(\S+)/.exec(b);
                if (urlM) url = urlM[1];

                if (learnedIdx >= 0) {
                    let rest = b.slice(learnedIdx + LEARNED.length).trim();
                    const kfIdx = rest.indexOf('\nKEY FACTS:');
                    content = kfIdx >= 0 ? rest.slice(0, kfIdx).trim() : rest;
                    if (kfIdx >= 0) {
                        for (const line of rest.slice(kfIdx + '\nKEY FACTS:'.length).split('\n')) {
                            const f = line.replace(/^-\s*/, '').trim();
                            // Blank lines between sections — skip, don't stop.
                            if (!f) continue;
                            if (/^SOURCE \d+: /i.test(f) || /^(SNIPPET-ONLY SOURCES|DEEP RESEARCH REPORT)/i.test(f)) break;
                            facts.push(f);
                        }
                    }
                } else if (!snippet) {
                    // No learned section and no dash-snippet: first body line is the snippet.
                    const body = b.replace(/^SOURCE \d+:\s*/i, '').replace(/\n\s*URL:\s*\S+/g, '').trim();
                    if (body) snippet = body.split('\n')[0].trim();
                }

                if (!title && !url) continue;
                entries.push({ title: title || url, url, snippet, content, facts });
            }
            return entries;
        }

        // ── v53 compact numbered + legacy formats ──────────────────────────────────
        const entries = [];
        const rawBlocks = /^\d+\.\s/.test(clean) ? clean.split(/\n(?=\d+\. )/) : clean.split(/\n\s*\n/);
        for (const block of rawBlocks) {
            const b = block.trim();
            if (!b) continue;
            let title = '', url = '', snippet = '';
            const numRe = /^\d+\.\s*/.exec(b);
            const body = numRe ? b.slice(numRe[0].length) : b;
            const urlM = /\n\s*URL:\s*(\S+)/.exec(body);
            if (urlM) {
                url = urlM[1];
                const head = body.slice(0, urlM.index).trim();
                const dash = / — /.exec(head);
                title = dash ? head.slice(0, dash.index).trim() : head;
                snippet = dash ? head.slice(dash.index + 3).trim() : '';
            } else {
                // Legacy: "Title (https://…): snippet"
                const legacy = /^(.*?)\s*\((https?:\/\/[^)\s]+)\):\s*(.*)$/.exec(body);
                if (legacy) { title = legacy[1]; url = legacy[2]; snippet = legacy[3]; }
                else { title = body.split('\n')[0].trim(); snippet = ''; }
            }
            if (!title && !url) continue;
            entries.push({ title: title || url, url, snippet });
        }
        return entries;
    }

    /**
     * Build a first-person answer from the actual search results (Smith's voice per the
     * agent-mode WEB OUTPUT STYLE). v54: when pages were read in full, each entry carries
     * its learned content + key facts — the synthesized answer is a real report, not just
     * snippets. Returns { markdown, entries } or null when there is nothing real to report.
     */
    function synthesizeAnswer(query, resultText) {
        const entries = parseWebSearchEntries(resultText);
        if (!entries.length) return null;

        const lines = [];
        lines.push(`Here's what I found on **"${String(query || '').trim()}"**:`, '');
        entries.slice(0, 6).forEach((e, i) => {
            const titleHtml = e.url ? `[${e.title}](${e.url})` : e.title;
            if (e.content) {
                lines.push(`${i + 1}. ${titleHtml}`);
                lines.push(`   ${e.content}`);
                if (Array.isArray(e.facts) && e.facts.length) {
                    for (const f of e.facts.slice(0, 3)) lines.push(`   - ${f}`);
                }
            } else {
                lines.push(`${i + 1}. ${titleHtml}${e.snippet ? ` — ${e.snippet}` : ''}`);
            }
        });
        lines.push('', '*Compiled from the search results above — the model spent its reply on internal reasoning and never wrote its own summary, so these are the findings verbatim.*');
        return { markdown: lines.join('\n'), entries };
    }

    /**
     * True when EVERY tool call in the batch is a web-read call (web_search/fetch_url).
     * Used to detect "the model ignored the answer-now nudge and wants to re-fetch" —
     * which, with no prose alongside it, we skip instead of executing.
     */
    function isWebOnlyBatch(toolCalls) {
        if (!Array.isArray(toolCalls) || !toolCalls.length) return false;
        return toolCalls.every(tc => WEB_TOOL_NAMES.has(tc && tc.function ? tc.function.name : null));
    }

    const api = { parseWebSearchEntries, synthesizeAnswer, isWebOnlyBatch };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKWebSearchFallback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
