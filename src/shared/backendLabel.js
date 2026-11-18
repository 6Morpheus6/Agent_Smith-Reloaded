/**
 * backendLabel — how the app NAMES the local inference backend in user-facing messages.
 *
 * LM Studio and Ollama are both reached through the same OpenAI-compatible client code, so
 * the transport cannot tell them apart; only the renderer's PROVIDER selection can. Passing
 * that choice along keeps error texts honest ("Ollama HTTP 500", not "LM Studio HTTP 500"
 * for an Ollama template error). Without a provider (Code Mode subagents, tests, older
 * clients) infer from the endpoint — Ollama listens on 11434 by default.
 *
 * Display only: request bodies, headers and parsing are identical for both backends.
 */
'use strict';

function backendLabel(provider, baseUrl) {
    const p = String(provider || '').toLowerCase();
    if (p === 'ollama') return 'Ollama';
    if (p === 'lmstudio' || p === 'lm-studio') return 'LM Studio';
    try {
        const raw = String(baseUrl || '').trim();
        if (raw) {
            const u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
            if (u.port === '11434' || /ollama/i.test(u.hostname)) return 'Ollama';
        }
    } catch (e) { /* unparseable URL — keep the default label */ }
    return 'LM Studio';
}

const api = { backendLabel };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKBackendLabel = api;
