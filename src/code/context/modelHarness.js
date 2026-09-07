/**
 * modelHarness — ONE table-driven place that answers: "how do we talk to the model
 * that is loaded right now?"
 *
 * Why this exists: model adaptations used to be scattered as one-off checks
 * (`isGemmaModel(...)` in three files, an inline kimi temperature pin in a fourth).
 * Every new model family meant hunting those checks down. This module replaces the
 * scatter with an ordered STRATEGIES table — first match wins, `default` always
 * matches last, so a lookup can never fail.
 *
 * What a strategy controls (keep it small and mechanical):
 *   - adaptMessages(messages, modelId, opts)  → reshape the prompt so the family
 *     actually understands it (Gemma: fold system + serialize tool turns + JSON
 *     tool preamble). MUST be idempotent — callers may pass the same history
 *     through every turn.
 *   - pinTemperature(temperature)             → family-mandated temperature
 *     overrides (kimi-k3's API rejects anything but 1).
 *   - nativeTools (bool)                      → informational: whether the family
 *     drives tools through the native tools[] path or a text preamble.
 *
 * The wire-level guarantees (tool pairing, canonical fields, schema shape) are a
 * SEPARATE layer — src/shared/toolPairing.js — and always apply regardless of
 * family. Prompt shape here, wire validity there.
 *
 * Adding a family: insert a row above `default`, add a routing test. Nothing else
 * to touch — turnLoop / planningPhase / chat all call through this module.
 *
 * Exposed as window.XKModelHarness (renderer) / module.exports (main + tests).
 */
(function (global) {
    'use strict';

    const gemmaHarness = require('./gemmaHarness.js');
    const { isKimiK3Model, isQwenThinkingModel } = require('../../shared/modelClassifier.js');

    // Qwen3 chat template (as shipped by LM Studio) is STRICT about message shape: at most
    // ONE system message, and it must be the FIRST one. Agent Smith's Code Mode prompt has
    // several leading system blocks (persona + phase hint + plan anchor + code-plan context)
    // AND injects mid-conversation harness nudges as role:"system" — both shapes make LM
    // Studio answer HTTP 200 with an EMPTY stream ("Jinja Exception: System message must be
    // at the beginning"), which Code Mode reads as dead empty turns. Reshape (idempotent):
    //   1. merge all leading consecutive system blocks into a single first message,
    //   2. convert any later role:"system" note to user role — every harness nudge is
    //      self-describing bracketed text ("[COMPLETION BLOCKED]", "[HARNESS — …]"), so it
    //      reads identically as a user turn and keeps strict role alternation valid,
    //   3. drop assistant messages carrying neither content nor tool_calls (empty turns the
    //      old loop persisted; nothing for the model to see, some templates choke on them).
    function reshapeForQwen(messages) {
        if (!Array.isArray(messages)) return messages;
        const out = [];
        let i = 0;
        // 1. Merge ALL leading system blocks into a single first message (the template's
        //    "system must be at the beginning" check sees one system, exactly where it wants).
        while (i < messages.length && messages[i] && messages[i].role === 'system') {
            out.push({ role: 'system', content: String(messages[i].content || '') });
            i++;
        }
        if (out.length > 1) {
            const merged = out.map(m => m.content).join('\n\n');
            out.length = 0;
            out.push({ role: 'system', content: merged });
        }
        // 2. Everything after the first non-system message: late system notes become user
        //    turns (harness nudges are self-describing bracketed text, so they read the same),
        //    and an empty assistant (no content AND no tool_calls) is dropped — it carries no
        //    information and some templates choke on a bare assistant turn. Appending to a
        //    preceding user message keeps role alternation clean instead of stacking two users.
        for (; i < messages.length; i++) {
            const m = messages[i];
            if (!m) continue;
            if (m.role === 'system') {
                const prev = out[out.length - 1];
                if (prev && prev.role === 'user' && typeof prev.content === 'string') {
                    prev.content += '\n\n' + String(m.content || '');
                } else {
                    out.push({ ...m, role: 'user' });
                }
            } else if (m.role === 'assistant'
                && !String(m.content || '').trim()
                && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) {
                continue; // empty assistant — invisible to the model
            } else {
                out.push(m);
            }
        }
        // 3. Merge any adjacent same-role TEXT messages (dropping an empty assistant can leave
        //    two user turns back to back; some Qwen templates want strict alternation). Tool /
        //    tool-call messages are left alone so pairing survives. Idempotent.
        const settled = [];
        for (const m of out) {
            const prev = settled[settled.length - 1];
            if (prev && prev.role === 'user' && m.role === 'user'
                && typeof prev.content === 'string' && typeof m.content === 'string') {
                prev.content += '\n\n' + m.content;
            } else {
                settled.push(m);
            }
        }
        return settled;
    }

    const STRATEGIES = [
        {
            id: 'gemma',
            match: (modelId) => gemmaHarness.isGemmaModel(modelId),
            description:
                'Gemma chat templates ignore role:"system" and mishandle native tool turns. ' +
                'Adaptation: serialize tool history to plain text, inject a {"name","parameters"} ' +
                'JSON tool preamble, fold system into the first user turn.',
            nativeTools: false,
            adaptMessages: (messages, modelId, opts) =>
                gemmaHarness.adaptMessagesForGemma(messages, modelId, opts),
            pinTemperature: (t) => t
        },
        {
            id: 'kimi-k3',
            match: (modelId) => isKimiK3Model(modelId),
            description:
                'Moonshot thinking model. Native tool calling is reliable — no prompt reshaping. ' +
                'Constraints: temperature must be exactly 1 (API rejects other values); strict ' +
                'wire validation applies (handled by toolPairing); our tool named "web_search" ' +
                'collides with Moonshot\'s server-side builtin of the same name (broken on k3 — ' +
                'returns {"success":false,"error":"Search request failed"}), so it is renamed ' +
                '"internet_search" on the wire and mapped back on receipt.',
            nativeTools: true,
            adaptMessages: (messages) => messages,
            adaptSystemPrompt: (text) => String(text).replace(/\bweb_search\b/g, 'internet_search'),
            toolNameOverrides: { web_search: 'internet_search' },
            pinTemperature: () => 1
        },
        {
            id: 'qwen',
            match: (modelId) => isQwenThinkingModel(modelId),
            description:
                'Qwen 3-and-newer hybrid thinking models. The chat template THINKS BY DEFAULT and ' +
                'can spend the ENTIRE output budget on reasoning_content, returning finish_reason:' +
                '"length" with empty content and no tool_calls — Code Mode then loops on "no files ' +
                'written" until it dies (the v51.2 crash-after-plan-approval symptom). Fix: pass ' +
                'chat_template_kwargs {enable_thinking:false} (LM Studio forwards this to the ' +
                'template) so reasoning stays brief and native tool calls come through — verified ' +
                'live on qwen3.8-27b-uncensored.',
            nativeTools: true,
            adaptMessages: (messages) => reshapeForQwen(messages),
            pinTemperature: (t) => t,
            extraBody: () => ({ chat_template_kwargs: { enable_thinking: false } })
        },
        {
            id: 'default',
            match: () => true,
            description:
                'Standard OpenAI-compatible path (Qwen, Llama, DeepSeek, Mistral, …): ' +
                'no prompt reshaping, native tool calling, caller temperature respected.',
            nativeTools: true,
            adaptMessages: (messages) => messages,
            pinTemperature: (t) => t
        }
    ];

    // Never null — the `default` row matches everything.
    function getModelHarness(modelId) {
        const id = String(modelId || '');
        for (const s of STRATEGIES) {
            try {
                if (s.match(id)) return s;
            } catch (e) { /* a broken match() must never break a run — keep looking */ }
        }
        return STRATEGIES[STRATEGIES.length - 1];
    }

    // Idempotent by contract of every strategy's adaptMessages.
    function adaptMessagesForModel(messages, modelId, opts) {
        if (!Array.isArray(messages)) return messages;
        return getModelHarness(modelId).adaptMessages(messages, modelId, opts);
    }

    function pinTemperatureForModel(modelId, temperature) {
        const pinned = getModelHarness(modelId).pinTemperature(temperature);
        return Number.isFinite(pinned) ? pinned : temperature;
    }

    // Tool-name overrides (canonical → wire). Empty for every family except those
    // whose provider reserves one of OUR tool names server-side (kimi: web_search).
    function toolNameOverridesFor(modelId) {
        return getModelHarness(modelId).toolNameOverrides || {};
    }

    // Family-mandated extra top-level request-body fields merged into the chat
    // completion payload (qwen3+: chat_template_kwargs enabling/disabling thinking).
    // Callers merge AFTER their own defaults so the family wins; unknown providers
    // that don't understand the key simply ignore it. Empty for default/gemma/kimi.
    function bodyOverridesFor(modelId) {
        const s = getModelHarness(modelId);
        if (typeof s.extraBody !== 'function') return {};
        try {
            const extra = s.extraBody();
            return (extra && typeof extra === 'object' && !Array.isArray(extra)) ? extra : {};
        } catch (e) { /* a broken extraBody() must never break a run */ }
        return {};
    }

    function wireToolName(modelId, name) {
        const map = toolNameOverridesFor(modelId);
        return map[name] || name;
    }

    function canonicalToolName(modelId, wireName) {
        const map = toolNameOverridesFor(modelId);
        for (const [canonical, wire] of Object.entries(map)) {
            if (wire === wireName) return canonical;
        }
        return wireName;
    }

    // Keep the system prompt consistent with the wire tool names (the Agent Mode
    // appendix names tools explicitly — it must match what the model sees in tools[]).
    function adaptSystemPromptForModel(text, modelId) {
        const s = getModelHarness(modelId);
        return typeof s.adaptSystemPrompt === 'function' ? s.adaptSystemPrompt(text) : text;
    }

    // For UI chips / docs / tests: which strategy applies and what it does.
    function describeModelHarness(modelId) {
        const s = getModelHarness(modelId);
        return { id: s.id, description: s.description, nativeTools: s.nativeTools };
    }

    const api = {
        STRATEGIES,
        getModelHarness,
        adaptMessagesForModel,
        adaptSystemPromptForModel,
        pinTemperatureForModel,
        toolNameOverridesFor,
        bodyOverridesFor,
        wireToolName,
        canonicalToolName,
        describeModelHarness
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKModelHarness = api;
    else if (typeof global !== 'undefined') global.XKModelHarness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
