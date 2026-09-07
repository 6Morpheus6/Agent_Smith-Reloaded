/**
 * gemmaHarness — Gemma-specific message adaptation for LM Studio /v1/chat/completions.
 *
 * Adapted from published Gemma tool-calling guidance:
 *  - Gemma chat templates frequently ignore role:"system" → fold it into the first user turn.
 *  - Gemma tool-calling is unreliable via the native tools[] path on small builds → add an
 *    explicit JSON preamble instructing {"name","parameters"} replies.
 *  - Gemma mishandles role:"tool" / assistant.tool_calls turns → serialize prior tool
 *    activity into plain user/assistant text so multi-turn builds don't error or stall.
 *  - Gemma4 expects tool results under role:"tool_responses" on the native path.
 *
 * Pure + idempotent (no DOM). adaptMessagesForGemma is safe to call more than once on the
 * same array: folding is a no-op once no system role remains, serialization is a no-op once
 * no tool turns remain, and the preamble is guarded by a sentinel so it is injected once.
 *
 * Exposed as window.XKGemmaHarness (renderer) / module.exports (node tests).
 */
(function (global) {
    // Marker that lets adaptMessagesForGemma stay idempotent: once the preamble is folded
    // into the first user turn, a second pass detects it and skips re-injection.
    const PREAMBLE_SENTINEL = '[GEMMA TOOL PROTOCOL]';

    function isGemmaModel(modelId) {
        return /gemma/i.test(String(modelId || ''));
    }

    // 'gemma4' | 'gemma3' | 'gemma'. Matches both "gemma4" and "gemma-4" id spellings.
    function gemmaVariant(modelId) {
        const m = String(modelId || '').toLowerCase();
        if (!/gemma/.test(m)) return 'gemma';
        if (/gemma-?4/.test(m)) return 'gemma4';
        if (/gemma-?3/.test(m)) return 'gemma3';
        return 'gemma';
    }

    // Gemma4 expects tool results under role:"tool_responses".
    // Only relevant when tool history is NOT text-serialized (the default path serializes).
    function toolResultRole(modelId) {
        return gemmaVariant(modelId) === 'gemma4' ? 'tool_responses' : 'tool';
    }

    // Short, imperative block telling Gemma to emit ONLY a {"name","parameters"} JSON object
    // when it wants to call a tool. Follows the standard Gemma function-call preamble shape;
    // kept minimal (names + optional one-line descriptions) so small ctx budgets survive.
    function buildGemmaToolPreamble(toolNames, toolSchemas) {
        const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
        const lines = [PREAMBLE_SENTINEL];
        if (names.length) {
            if (toolSchemas && typeof toolSchemas === 'object') {
                lines.push('Available tools:');
                names.forEach(n => {
                    const desc = toolSchemas[n] ? ` — ${String(toolSchemas[n]).split('\n')[0]}` : '';
                    lines.push(`- ${n}${desc}`);
                });
            } else {
                lines.push('Available tools: ' + names.join(', ') + '.');
            }
        }
        lines.push('To call a tool, respond with ONLY a JSON object and no other text:');
        lines.push('{"name": "<tool_name>", "parameters": { ... }}');
        lines.push('Call exactly one tool per turn. Do not wrap the JSON in prose, markdown, or code fences when you intend to call a tool.');
        return lines.join('\n');
    }

    // Move all role:"system" content into the first user turn and strip system roles.
    // System-fold pass. Prefers merging into an existing first user
    // message (avoids two consecutive user turns); otherwise prepends one. Returns a NEW array.
    function foldSystemForGemma(messages) {
        if (!Array.isArray(messages)) return messages;
        const systemTexts = [];
        const rest = [];
        for (const m of messages) {
            if (m && m.role === 'system') {
                if (m.content != null && m.content !== '') {
                    systemTexts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
                }
            } else {
                rest.push(m ? Object.assign({}, m) : m);
            }
        }
        if (!systemTexts.length) return rest;
        const sysBlock = systemTexts.join('\n\n');
        const firstUser = rest.find(m => m && m.role === 'user');
        if (firstUser) {
            if (typeof firstUser.content === 'string') {
                firstUser.content = sysBlock + '\n\n' + firstUser.content;
            } else if (Array.isArray(firstUser.content)) {
                firstUser.content = [{ type: 'text', text: sysBlock }, ...firstUser.content];
            } else {
                firstUser.content = sysBlock;
            }
            return rest;
        }
        return [{ role: 'user', content: sysBlock }, ...rest];
    }

    // Chat mode seeds a UI-only assistant greeting before the first real user turn.
    // After system folding that leaves assistant-first ordering, which Gemma / LM Studio
    // rejects with an immediate empty stream. Fold the leading assistant line into the
    // next user turn so the payload always starts with role:"user".
    function foldLeadingAssistantForGemma(messages) {
        if (!Array.isArray(messages) || messages.length < 2) return messages;
        const out = messages.map(m => (m ? Object.assign({}, m) : m));
        while (out.length >= 2 && out[0]?.role === 'assistant' && out[1]?.role === 'user') {
            const greet = String(out[0].content || '').trim();
            const user = out[1];
            if (greet) {
                const prefix = `[Prior assistant message already shown to the user: "${greet}"]\n\n`;
                if (typeof user.content === 'string') {
                    user.content = prefix + user.content;
                } else if (Array.isArray(user.content)) {
                    user.content = [{ type: 'text', text: prefix }, ...user.content];
                } else {
                    user.content = prefix;
                }
            }
            out.shift();
        }
        return out;
    }

    // Rewrite assistant.tool_calls and the role:"tool" results that follow into plain
    // text turns Gemma can read.
    // Returns a NEW array; no-op (shallow copy) when there is nothing to convert.
    function serializeToolTurnsForGemma(messages) {
        if (!Array.isArray(messages)) return messages;
        let touched = false;
        const out = [];
        for (const m of messages) {
            if (!m || !m.role) { out.push(m); continue; }
            if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
                touched = true;
                const callText = m.tool_calls.map(tc => {
                    const fn = tc.function || {};
                    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
                    return `{"name": "${fn.name || 'unknown'}", "parameters": ${args}}`;
                }).join('\n');
                const prose = (m.content && String(m.content).trim()) ? String(m.content).trim() + '\n' : '';
                out.push({ role: 'assistant', content: prose + callText });
            } else if (m.role === 'tool' || m.role === 'function' || m.role === 'tool_responses') {
                touched = true;
                const name = m.name || 'tool';
                out.push({ role: 'user', content: `Invoking tool \`${name}\` produced:\n${String(m.content == null ? '' : m.content)}` });
            } else {
                out.push(m);
            }
        }
        return touched ? out : messages.slice();
    }

    // Orchestrate the Gemma adaptation: serialize tool history → inject the tool preamble
    // into the system block → fold system into the first user turn. Non-Gemma models pass
    // through untouched. Idempotent (see PREAMBLE_SENTINEL note above).
    //
    // opts: { toolNames?: string[], toolSchemas?: object, serializeToolHistory?: boolean=true }
    function adaptMessagesForGemma(messages, modelId, opts) {
        if (!Array.isArray(messages) || !isGemmaModel(modelId)) return messages;
        const o = opts || {};
        let out = messages;

        if (o.serializeToolHistory !== false) out = serializeToolTurnsForGemma(out);

        const hasPreamble = out.some(m => m && typeof m.content === 'string' && m.content.includes(PREAMBLE_SENTINEL));
        if (!hasPreamble && Array.isArray(o.toolNames) && o.toolNames.length) {
            const preamble = buildGemmaToolPreamble(o.toolNames, o.toolSchemas);
            const sysMsg = out.find(m => m && m.role === 'system');
            if (sysMsg) {
                out = out.map(m => m === sysMsg
                    ? Object.assign({}, m, { content: (typeof m.content === 'string' ? m.content : '') + '\n\n' + preamble })
                    : m);
            } else {
                out = [{ role: 'system', content: preamble }, ...out];
            }
        }

        return foldLeadingAssistantForGemma(foldSystemForGemma(out));
    }

    const api = {
        PREAMBLE_SENTINEL,
        isGemmaModel,
        gemmaVariant,
        toolResultRole,
        buildGemmaToolPreamble,
        foldSystemForGemma,
        foldLeadingAssistantForGemma,
        serializeToolTurnsForGemma,
        adaptMessagesForGemma
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKGemmaHarness = api;
    else if (typeof global !== 'undefined') global.XKGemmaHarness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
