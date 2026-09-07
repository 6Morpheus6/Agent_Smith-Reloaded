/**
 * streamSignals — v52.7: MODEL-AGNOSTIC interpretation of what an OpenAI-compatible
 * streaming server (LM Studio) actually did with a request.
 *
 * Why this exists: "the model is still generating" and "this reply was cut off" are
 * properties of the WIRE, not of any model family. Every fix in v52.7 keys on these
 * signals instead of on model names, so ANY model LM Studio can serve (Gemma, Qwen,
 * Llama, DeepSeek, Mistral, …) gets identical treatment:
 *
 *   - isBusyState(state)      → "is the engine generating right now?" — gates every
 *                               action that could cut a reply off mid-stream (model
 *                               swaps, context reloads).
 *   - classifyStreamEnd(...)  → "how did this stream end?" — distinguishes a clean
 *                               stop from an output-budget cutoff where the model spent
 *                               its whole budget on internal reasoning and emitted no
 *                               content/tool call. That signature (finish_reason:"length"
 *                               + empty output, with or without a visible thinking
 *                               channel) is what makes thinking-by-default models look
 *                               "broken": they are not — the reply was just cut off
 *                               before any content could come out.
 *   - classifyHttpError(...)  → "was this HTTP failure a context-overflow?" so the UI
 *                               can say exactly that instead of a raw engine error.
 */
'use strict';

/**
 * Busy states, in order of strength:
 *   'waiting' — request sent, no token has arrived yet (prompt processing / first token)
 *   'generating' — at least one SSE delta (content / reasoning / tool_call) has flowed
 *   'idle' — nothing in flight.
 */
function isBusyState(state) {
    return state === 'waiting' || state === 'generating';
}

/**
 * @param {{ finishReason?: string|null, sawAnyDelta?: boolean, contentChars?: number,
 *           reasoningChars?: number, toolCallCount?: number }} end — what the stream parser observed.
 * @returns {{ kind: 'clean'|'budget_exhausted'|'truncated', reason: string }}
 */
function classifyStreamEnd(end) {
    const e = end || {};
    const finishReason = String(e.finishReason || '');
    const contentChars = Math.max(0, Number(e.contentChars) || 0);
    const reasoningChars = Math.max(0, Number(e.reasoningChars) || 0);
    const toolCallCount = Math.max(0, Number(e.toolCallCount) || 0);

    // The exhaustion signature: the server stopped us at the output budget (length), and
    // NOTHING user-visible came out — no content, no tool call. Whether or not a thinking
    // channel was visible, the model spent its whole reply on internal reasoning.
    // Family-agnostic by construction: it is detected from what arrived, never from which
    // model was loaded. (A partial TOOL CALL with length is `truncated`, not exhaustion —
    // that one goes to chunked-write recovery instead.)
    if (finishReason === 'length' && contentChars === 0 && toolCallCount === 0) {
        return {
            kind: 'budget_exhausted',
            reason: reasoningChars > 0
                ? `Model spent its entire reply budget on internal reasoning (${reasoningChars} chars of thinking, no output).`
                : 'Reply hit the output budget with no content emitted.'
        };
    }

    // Output was cut off but SOMETHING came out (partial content or a partial tool call) —
    // the caller's existing truncation-recovery path applies.
    if (finishReason === 'length') {
        return { kind: 'truncated', reason: 'Reply hit the output budget mid-stream.' };
    }

    return { kind: 'clean', reason: '' };
}

/**
 * @param {{ status?: number, body?: string }} err — a non-2xx response from the server.
 * @returns {{ isContextOverflow: boolean, message: string|null }}
 */
function classifyHttpError(err) {
    const body = String((err && (err.body != null ? err.body : err.message)) || '');
    if (/exceed_context_size|exceeds the available context size/i.test(body)) {
        return {
            isContextOverflow: true,
            message: 'Prompt exceeds the model\'s loaded context window. Lower the Context Window slider (or reload LM Studio with a larger context) and retry.'
        };
    }
    if (/failed to load model|model.*not found|no models? loaded/i.test(body)) {
        return { isContextOverflow: false, message: 'Model failed to load in LM Studio — pick one that loads (check available VRAM) and retry.' };
    }
    return { isContextOverflow: false, message: null };
}

const api = { isBusyState, classifyStreamEnd, classifyHttpError };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKStreamSignals = api;
