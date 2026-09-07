/**
 * toolPairing — make assistant tool_calls / tool-result message sequences valid for
 * STRICT chat-completions APIs (Moonshot/Kimi, OpenAI), which reject a request when
 * a `tool` message's tool_call_id is missing from the preceding assistant message
 * ("Invalid request: tool_call_id is not found") or when an assistant tool_call has
 * no matching tool response.
 *
 * Local LM Studio tolerates malformed pairings, which is why histories broken by
 * context compaction (multi-tool turns), session resume, or slice() windowing only
 * fail against hosted APIs. This sanitizer is the single wire-level guarantee:
 *
 *   - every assistant tool_call gets an id (backfilled when absent)
 *   - every assistant tool_call is answered by exactly one tool message placed
 *     immediately after it (synthesized as an explicit "skipped" placeholder when
 *     the real response was dropped from history)
 *   - orphan `tool` messages (no matching preceding tool_call id) are removed
 *
 * It ALSO normalizes every emitted message to the canonical OpenAI/Moonshot wire
 * shape — strict APIs 400 on undocumented fields:
 *   - `tool` messages: only role/tool_call_id/content (the internal `name` field
 *     and any other extras are stripped; Moonshot's documented tool message has
 *     no `name`)
 *   - `assistant` messages with tool_calls: `content` is omitted when empty
 *     (Moonshot's documented shape), kept when non-empty
 *   - `system`/`user`: role + content only (array content for images preserved)
 *
 * Valid histories pass through unchanged in meaning. Pure + dependency-free
 * (unit-testable, loadable in both the main process and the renderer bundle).
 */
'use strict';

function normalizeWireMessage(msg) {
    if (!msg || !msg.role) return msg;
    if (msg.role === 'tool') {
        return {
            role: 'tool',
            tool_call_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
        };
    }
    if (msg.role === 'assistant') {
        const out = { role: 'assistant' };
        // Omit content entirely when empty and tool_calls are present (canonical
        // Moonshot/OpenAI shape); keep non-empty string or array (multimodal) content.
        const hasCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length;
        if (Array.isArray(msg.content)) out.content = msg.content;
        else if (msg.content != null && String(msg.content) !== '') out.content = String(msg.content);
        else if (!hasCalls) out.content = '';
        if (hasCalls) out.tool_calls = msg.tool_calls;
        return out;
    }
    // system / user (and anything else): role + content only.
    return {
        role: msg.role,
        content: Array.isArray(msg.content)
            ? msg.content
            : (typeof msg.content === 'string' ? msg.content : String(msg.content ?? ''))
    };
}

function sanitizeToolPairing(messages) {
    if (!Array.isArray(messages)) return messages;
    const out = [];
    // Ids of tool_calls from the most recent assistant message that have not yet
    // been answered by a tool message. Only one assistant tool_call block can be
    // "open" at a time on the wire — anything else is invalid for strict APIs.
    let pending = [];

    function flushPending() {
        while (pending.length) {
            const call = pending.shift();
            out.push(normalizeWireMessage({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: JSON.stringify({
                    skipped: true,
                    reason: 'tool response missing from conversation history (compacted or interrupted run)'
                })
            }));
        }
    }

    for (const msg of messages) {
        if (!msg || !msg.role) continue;

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            // A new tool_call block begins: any still-unanswered older calls must be
            // closed out first or the strict API rejects the whole request.
            flushPending();
            const calls = msg.tool_calls.map((tc, idx) => {
                const id = tc?.id || `call_backfill_${out.length}_${idx}`;
                const name = tc?.function?.name || tc?.name || 'unknown_function';
                return { ...tc, id, type: 'function', function: { ...(tc?.function || {}), name } };
            });
            out.push(normalizeWireMessage({ ...msg, tool_calls: calls }));
            pending = calls.map((tc) => ({ id: tc.id, name: tc.function.name }));
            continue;
        }

        if (msg.role === 'tool') {
            const id = msg.tool_call_id;
            const idx = id != null ? pending.findIndex((c) => c.id === id) : -1;
            if (idx === -1) {
                // Orphan tool result — no matching open tool_call. Drop it; sending
                // it is a guaranteed 400 on strict APIs.
                continue;
            }
            pending.splice(idx, 1);
            out.push(normalizeWireMessage(msg));
            continue;
        }

        // Any other role closes the open tool_call block (responses must directly
        // follow their assistant message).
        flushPending();
        out.push(normalizeWireMessage(msg));
    }
    flushPending();
    return out;
}

const api = { sanitizeToolPairing, normalizeWireMessage };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKToolPairing = api;
