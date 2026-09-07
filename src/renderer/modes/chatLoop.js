/**
 * Agent chat loop helpers — tool batch execution + timeline events.
 * v53.6: every tool call now runs under a finite timeout and is classified through
 * the shared toolResults policy (honest ok/error for "web search failed", thrown
 * non-Error values, empty output), so the model is never told a failed call worked.
 */
(function (global) {
    'use strict';

    const TR = (typeof window !== 'undefined' && window.XKToolResults) || require('../../shared/toolResults.js');

    async function firePluginHook(api, event, payload) {
        if (!api) return null;
        try {
            return await api.invoke('plugin-fire-hook', { hookEvent: event, payload: payload || {} });
        } catch (e) {
            return null;
        }
    }

    async function executeAgentToolBatch(validToolCalls, deps) {
        const results = [];
        const emit = deps.emitAgentEvent || (() => {});
        const timeoutMs = deps.toolTimeoutMs || TR.DEFAULT_TOOL_TIMEOUT_MS;

        for (const t of validToolCalls) {
            const toolId = t.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const name = t.function.name;
            const args = t.function.arguments;

            emit({ type: 'tool_start', name, args, callId: toolId });

            const before = await firePluginHook(deps.api, 'beforeToolCall', { tool: name, name, args });
            if (before?.blocked) {
                const blocked = `[BLOCKED] ${before.reason || 'plugin hook'}`;
                emit({ type: 'tool_result', name, ok: false, result: { error: blocked }, callId: toolId, durationMs: 0 });
                results.push({ tool: t, result: blocked, toolId, ok: false });
                continue;
            }

            const startTool = Date.now();
            let rawResult;
            try {
                if (deps.executeTool) {
                    // v53.6: finite deadline — a hung fetch/shell can no longer freeze the run.
                    rawResult = await TR.withTimeout(
                        Promise.resolve().then(() => deps.executeTool(name, args, deps)),
                        timeoutMs, name
                    );
                } else {
                    rawResult = 'Error: executeTool not provided';
                }
                if (deps.trace) {
                    deps.trace.addStep('tools.execute', 'tools', 'ok', 'TOOL_OK', Date.now() - startTool, name, name);
                }
            } catch (e) {
                rawResult = e; // classifyToolResult turns thrown values into honest errors
                if (deps.trace) {
                    deps.trace.addStep('tools.execute', 'tools', 'error', 'TOOL_ERR', Date.now() - startTool, e && e.message || String(e), name);
                }
            }

            await firePluginHook(deps.api, 'afterToolCall', { tool: name, name, args, result: rawResult });

            // v53.6: shared classification — Error objects, thrown values, "Error:"/"[BLOCKED]"
            // prefixes, "web search failed", JSON {error}, and empty output are all failures.
            const cls = TR.classifyToolResult(rawResult);
            const result = cls.ok ? cls.text : (cls.error || 'Error: tool failed');
            emit({
                type: 'tool_result',
                name,
                ok: cls.ok,
                result: typeof result === 'string' ? { output: result } : result,
                callId: toolId,
                durationMs: Date.now() - startTool
            });
            results.push({ tool: t, result: String(result), toolId, ok: cls.ok });
        }
        return results;
    }

    const api = { executeAgentToolBatch, firePluginHook };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKChatLoop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

