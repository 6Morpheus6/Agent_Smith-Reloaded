/**
 * toolResults — v53.6: HERMES-GRADE tool execution hygiene for the CHAT path.
 *
 * Hermes exposes every tool failure to the model as an explicit, well-formed error
 * string and never lets a handler hang the loop. Agent Smith's chat batch executor
 * had two gaps that produced exactly the "quality/reliability" symptom users see:
 *
 *   1. A hanging tool (fetch to a dead site, a shell command waiting on input) froze
 *      the whole run forever — no timeout anywhere in executeAgentToolBatch.
 *   2. Success was judged by `!startsWith('Error:')` only, so results like
 *      "web search failed…", "[BLOCKED] …", thrown non-Error values, or a JSON body
 *      carrying {error: ...} were reported to the timeline (and the model) as OK.
 *      The model then confidently narrated a successful tool call that had failed —
 *      hallucinated success, the classic small-model trust bug.
 *
 * classifyToolResult() is pure and testable; withTimeout() wraps any promise. Both
 * are used by chatLoop.executeAgentToolBatch so every chat/agent tool call gets the
 * same honest ok/error signal Code Mode already had.
 */
'use strict';

// 4 min (v54.2) — must outlast the slowest legitimate chat tool: generate_image can
// take several minutes on first use (engine + ~4 GB model auto-download, then GPU
// sampling). The old 120 s cap fired while a render was still in flight, so the model
// saw "timed out" over an image that actually rendered and looped re-checking it.
const DEFAULT_TOOL_TIMEOUT_MS = 240000; // 4 min — generous for slow local tools (image gen), finite

// Failure signatures emitted by the existing tool surface (agentTools + IPC handlers).
// Kept as data so new tools can be added without touching the executor.
const ERROR_PREFIXES = [
    'error:',
    '[blocked]',
    'web search failed',
    'no web results found',
    'permission denied',
    'operation not permitted'
];

function classifyToolResult(result) {
    if (result == null) return { ok: false, error: 'tool returned no result' };
    if (result instanceof Error) return { ok: false, error: String(result.message || result) };
    let text;
    if (typeof result === 'string') {
        text = result;
    } else if (typeof result === 'object') {
        // Structured results: a JSON body with an explicit error field is a failure.
        if (result.error) return { ok: false, error: String(typeof result.error === 'string' ? result.error : JSON.stringify(result.error)) };
        text = (() => { try { return JSON.stringify(result); } catch (e) { return String(result); } })();
    } else {
        text = String(result);
    }
    const lower = text.slice(0, 200).toLowerCase();
    for (const p of ERROR_PREFIXES) {
        if (lower.startsWith(p)) return { ok: false, error: text };
    }
    // A tool that returned literally nothing is not a success worth re-sending.
    if (!text.trim()) return { ok: false, error: 'tool produced empty output' };
    return { ok: true, text };
}

/**
 * Race a tool promise against a finite deadline. On timeout the caller gets an
 * honest error string (the model can then move on instead of staring at a spinner);
 * the underlying promise's late settlement is ignored — chat tools are idempotent
 * reads/mutations whose handlers already guard their own side effects.
 */
function withTimeout(promise, ms, label) {
    const limit = Math.max(1000, Number(ms) || DEFAULT_TOOL_TIMEOUT_MS);
    const name = String(label || 'tool');
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(`Error: ${name} timed out after ${Math.round(limit / 1000)}s — the tool did not respond. Try a different approach or report what you have.`);
        }, limit);
        Promise.resolve(promise).then(
            (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
            (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve(e instanceof Error ? e : new Error(String(e && e.message || e))); } }
        );
    });
}

const api = { classifyToolResult, withTimeout, DEFAULT_TOOL_TIMEOUT_MS };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKToolResults = api;
