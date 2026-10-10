/**
 * thinkingToggle — ONE place that answers: "should the model think (emit
 * reasoning) on this request, and what wire fields enforce that?"
 *
 * Why this exists (v54.4): LM Studio's own Thinking/Reasoning toggle is a
 * per-model SETTING in its UI — it does not reliably apply to requests arriving
 * over the OpenAI-compatible API (older builds ignore it outright; thinking-by-
 * default templates like Qwen3 think unless the template is told otherwise).
 * So Agent Smith carries its own 🧠 THINK toggle and sends the request-level
 * overrides itself. When THINK is ON we send nothing new — LM Studio's setting
 * keeps working exactly as before for anyone who configured it there.
 *
 * Two wire mechanisms, both harmless to servers that don't understand them:
 *   - chat_template_kwargs.enable_thinking = false  → the model's Jinja chat
 *     template (Qwen3+ family) skips its thinking block. LM Studio forwards
 *     this key to the template (verified live since v51.3).
 *   - reasoning_effort = 'none'                     → LM Studio's request-level
 *     reasoning control ("off" on the native API, none on OpenAI-compat). A
 *     model that has no reasoning control at all may reject this with an error,
 *     so it is ONLY sent when explicitly asked for (strict mode) — never as a
 *     blanket default.
 *
 * Exposed as window.XKThinkingToggle (renderer) / module.exports (main + tests).
 */
(function (global) {
    'use strict';

    // `enabled === false` means the user turned 🧠 THINK off. Anything else
    // (true, undefined, null — e.g. an old Code session saved before this
    // field existed) means thinking stays on / LM Studio default.
    function isThinkingEnabled(enabled) {
        return enabled !== false;
    }

    // Extra top-level request-body fields enforcing the toggle. Returns {} when
    // thinking is ON so callers can merge unconditionally — zero new bytes on
    // the wire for the default path.
    //   strict: also send reasoning_effort:'none' (LM Studio's own control).
    //           Off by default because non-reasoning models ERROR on it.
    function thinkingBodyOverrides(enabled, opts) {
        if (isThinkingEnabled(enabled)) return {};
        const extra = { chat_template_kwargs: { enable_thinking: false } };
        if (opts && opts.strict) extra.reasoning_effort = 'none';
        return extra;
    }

    const api = { isThinkingEnabled, thinkingBodyOverrides };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.XKThinkingToggle = api;
})(typeof window !== 'undefined' ? window : globalThis);
