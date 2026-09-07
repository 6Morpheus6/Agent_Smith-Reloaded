'use strict';
// TEMP v2: FULLY faithful repro of Agent Smith chat loop after web_search.
// - pruneChatHistory runs every turn (like app.js line 2822)
// - fetch_url returns plain content text (like agentTools.executeAgentChatTool)
// - dumps sanitized wire messages each turn to diagnose the HTTP 500
const { webSearch, fetchUrl } = require('../src/shared/webTools.js');
const agentTools = require('../src/renderer/modes/agentTools.js');
const { buildChatSystemPrompt } = require('../src/shared/smithPersona.js');
const { sanitizeToolPairing } = require('../src/shared/toolPairing.js');
const { pruneChatHistory } = require('../src/shared/contextPrune.js');

const MODEL = process.argv[2] || 'qwen3.8-27b';
const THINKING_FLAG = (process.argv[3] === 'think-on') ? {} : { chat_template_kwargs: { enable_thinking: false } };

(async () => {
    const systemPrompt = buildChatSystemPrompt('', {}) + '\n\n' + agentTools.AGENT_MODE_SYSTEM_APPENDIX;
    const activeTools = agentTools.toolsForChatMode({ agentEnabled: true, memoryEnabled: false, imageGenEnabled: false });

    function buildMessages(history) {
        const messages = [];
        for (const m of history) {
            if (!m.role) continue;
            let msg = { role: m.role };
            if (m.role === 'system') msg.content = String(m.content || '');
            else if (m.role === 'user') msg.content = String(m.content || '');
            else if (m.role === 'assistant') {
                msg.content = (m.content && m.content.trim()) ? String(m.content) : '';
                if (Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) } }));
                else if (!msg.content) continue; // app.js skips empty assistant msgs
            } else if (m.role === 'tool') { msg.content = String(m.content || ''); msg.tool_call_id = m.tool_call_id; if (m.name) msg.name = m.name; }
            messages.push(msg);
        }
        return sanitizeToolPairing(messages);
    }

    async function runTurn(history, label, opts = {}) {
        const pruned = pruneChatHistory(history.slice()); // app.js: payloadHistory = pruneChatHistory(payloadHistory)
        const sanitized = buildMessages(pruned);
        console.log(`\n===== ${label} =====`);
        console.log('wire msgs:', sanitized.map(m => `${m.role}${Array.isArray(m.tool_calls) ? '(+' + m.tool_calls.length + ')' : ''}[${String(m.content || '').length}]`).join(' '));
        const body = { model: MODEL, messages: sanitized, stream: true, temperature: 0.7, max_tokens: -1, ...THINKING_FLAG };
        if (!opts.noTools && activeTools.length) body.tools = activeTools.map(t => ({ type: 'function', function: t.function }));

        const t0 = Date.now();
        let res;
        try {
            res = await fetch('http://127.0.0.1:1234/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch (e) { console.log(`FETCH THREW after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, e.message); return { threw: true, ms: Date.now() - t0 }; }
        if (!res.ok) {
            const errText = await res.text();
            console.log(`HTTP ${res.status} after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, errText.slice(0, 400));
            return { httpError: res.status, ms: Date.now() - t0 };
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let leftover = '', fullContent = '', reasoning = '', finishReason = null;
        const toolCalls = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const lines = (leftover + decoder.decode(value)).split('\n'); leftover = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
                try {
                    const json = JSON.parse(trimmed.slice(5));
                    const delta = json.choices?.[0]?.delta;
                    if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                    if (delta?.content) fullContent += delta.content;
                    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
                    if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `call_t${idx}_${Math.random().toString(36).slice(2, 8)}`, function: { name: '', arguments: '' } };
                            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                        }
                    }
                } catch {}
            }
        }
        return { ms: Date.now() - t0, finishReason, fullContent, reasoning, toolCalls: toolCalls.filter(Boolean) };
    }

    const history = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Search for the latest electron-builder release notes and tell me about them' }
    ];

    // Turn 1 (like user's session): model called web_search — feed REAL result.
    const results = await webSearch('latest electron-builder release notes');
    const searchText = results.map(r => `${r.title} (${r.url}): ${r.snippet}`).join('\n\n')
        + '\n\n[SYSTEM NUDGE]: The web search completed successfully. You MUST now summarize these results for the user immediately in your next response. Do not ask permission to continue.';
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'call_t1_0', type: 'function', function: { name: 'web_search', arguments: '{"query":"latest electron-builder release notes"}' } }] });
    history.push({ role: 'tool', name: 'web_search', content: searchText, tool_call_id: 'call_t1_0' });

    const SILENCE_NUDGE = 'Please summarize the results above and provide the final answer.'; // app.js line 3489
    let totalMs = 0;
    for (let i = 2; i <= 7; i++) {
        const r = await runTurn(history, `TURN ${i}`);
        if (r.threw || r.httpError) { console.log('→ request failed; app would show error wall / keep partial.'); break; }
        totalMs += r.ms;
        console.log(`${(r.ms / 1000).toFixed(1)}s (total ${(totalMs / 1000).toFixed(1)}s) | finish=${r.finishReason} | content=${r.fullContent.length}ch reasoning=${r.reasoning.length}ch tools=[${r.toolCalls.map(t => `${t.function.name}(${JSON.parse(t.function.arguments || '{}').url || JSON.parse(t.function.arguments || '{}').query || ''})`).join(', ')}]`);
        if (r.toolCalls.length === 0 && !r.fullContent.trim()) {
            console.log('→ SILENT turn. App pushes nudge + continues.');
            history.push({ role: 'assistant', content: r.fullContent });
            history.push({ role: 'user', content: SILENCE_NUDGE });
            continue;
        }
        if (r.toolCalls.length > 0) {
            history.push({ role: 'assistant', content: r.fullContent, tool_calls: r.toolCalls });
            for (const tc of r.toolCalls) {
                let out;
                try {
                    const args = JSON.parse(tc.function.arguments || '{}');
                    if (tc.function.name === 'fetch_url') {
                        const res = await fetchUrl(args.url); // agentTools returns plain content text
                        out = res.content + (res.truncated ? '' : '');
                    } else if (tc.function.name === 'web_search') out = searchText;
                    else out = `(unavailable in repro: ${tc.function.name})`;
                } catch (e) { out = `Error: ${e.message}`; }
                history.push({ role: 'tool', name: tc.function.name, content: String(out), tool_call_id: tc.id });
            }
            continue;
        }
        console.log('*** FINAL ANSWER REACHED ***');
        console.log(r.fullContent.slice(0, 900));
        return;
    }
})();
