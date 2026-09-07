/**
 * retryPolicy — v53.6: HERMES-GRADE transient-failure recovery for the CHAT path.
 *
 * Why this exists: Code Mode (turnLoop) already retries a stalled stream on a fresh
 * request up to 8 times before giving up, which is why builds survive LM Studio
 * hiccups. The chat/agent loop had NO retry — one "failed to fetch", one engine
 * SIGABRT right after headers, or one ECONNRESET ended the whole run with an error
 * wall. This module gives both loops ONE shared, pure, testable policy for deciding:
 *
 *   - isRetryableError(err)      → was this failure transient (worth a fresh request)?
 *   - retryDelayMs(attempt, err) → bounded exponential backoff (+ Retry-After respect)
 *   - shouldRetry({attempt,...}) → the full decision: retry? wait how long? why not?
 *
 * Safety contract (the part that matters): a retry is only ever SAFE before any
 * content token has reached the user. Once the reply is on screen, re-issuing the
 * request would double-render it — so `contentSeen: true` makes every error fatal.
 * Tool side effects are safe to replay here because the chat loop retries only the
 * LLM call (tools run after a successful stream), never mid-tool-batch.
 */
'use strict';

// Transient signatures observed from LM Studio / llama.cpp / Ollama / hosted relays:
// engine crash after headers, between-token stalls, connect resets, DNS blips on the
// web-UI path, 5xx and rate limits. All of them clear on a fresh request.
const RETRYABLE_PATTERNS = [
    /stalled/i,
    /timed out|timeout/i,
    /failed to fetch/i,              // browser-side connect failure (web UI + renderer)
    /networkerror|network error/i,
    /econnreset|econnrefused|epipe|enetunreach|ehostunreach|socket hang up/i,
    /engine may have crashed|engine protocol runtime/i,
    /\b(429|500|502|503|504)\b/,     // HTTP status embedded in the message
    /http (?:429|5\d\d)/i,
    /rate.?limit/i,
    /overloaded|temporarily unavailable|server busy/i
];

// Permanent signatures — retrying these only wastes minutes of the user's time.
const FATAL_PATTERNS = [
    /exceed_context_size|exceeds the available context size/i,
    /context window/i,
    /invalid api key|unauthorized|forbidden\b/i,
    /model.*not found|no models? loaded|failed to load model/i,
    /aborted/i                        // user pressed Stop — never auto-retry a stop
];

function classifyError(err) {
    const msg = String((err && (err.message || err)) || '');
    if (!msg) return 'unknown';
    for (const re of FATAL_PATTERNS) if (re.test(msg)) return 'fatal';
    for (const re of RETRYABLE_PATTERNS) if (re.test(msg)) return 'transient';
    // A bare HTTP status number in the message that wasn't matched above (e.g.
    // "Uplink Error (503): ...") is still transient — servers recover.
    const status = msg.match(/\((\d{3})\)/);
    if (status && Number(status[1]) >= 500) return 'transient';
    if (status && Number(status[1]) === 429) return 'transient';
    return 'unknown';
}

function isRetryableError(err) {
    return classifyError(err) === 'transient';
}

// Exponential backoff with jitter: 1s, 2s, 4s, 8s… capped at 15s. A "slow down"
// Retry-After hint (when the caller passes one) wins up to the cap.
function retryDelayMs(attempt, err) {
    const n = Math.max(1, Number(attempt) || 1);
    const base = Math.min(1000 * Math.pow(2, n - 1), 15000);
    const jitter = Math.floor(base * 0.2 * Math.random());
    let delay = base + jitter;
    const retryAfter = Number(err && err.retryAfterSec);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delay = Math.min(Math.max(delay, retryAfter * 1000), 30000);
    }
    return delay;
}

/**
 * @param {{ attempt?: number, maxAttempts?: number, contentSeen?: boolean,
 *           aborted?: boolean, error?: any }} req
 * @returns {{ retry: boolean, delayMs: number, reason: string }}
 */
function shouldRetry(req) {
    const r = req || {};
    const maxAttempts = Math.max(0, Number(r.maxAttempts != null ? r.maxAttempts : 2));
    const attempt = Math.max(1, Number(r.attempt) || 1);
    if (r.aborted) return { retry: false, delayMs: 0, reason: 'aborted by user' };
    // Tokens already on screen — a fresh request would double-render the reply.
    if (r.contentSeen) return { retry: false, delayMs: 0, reason: 'reply already streaming to user' };
    const kind = classifyError(r.error);
    if (kind === 'fatal') return { retry: false, delayMs: 0, reason: 'permanent error — retrying will not help' };
    if (attempt > maxAttempts) return { retry: false, delayMs: 0, reason: `retry budget exhausted (${maxAttempts})` };
    // Unknown failures before any token are cheap to replay once more than to lose.
    return { retry: true, delayMs: retryDelayMs(attempt, r.error), reason: kind === 'transient' ? 'transient failure — retrying on a fresh request' : 'unclassified failure with no output yet — one safe retry' };
}

const api = { classifyError, isRetryableError, retryDelayMs, shouldRetry };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKRetryPolicy = api;
