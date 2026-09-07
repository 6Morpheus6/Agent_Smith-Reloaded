#!/usr/bin/env node
/**
 * _repro-turn2 — the exact post-search turn the app sends after web_search:
 *   system + user + assistant(tool_calls) + tool(result) → expect final answer content.
 * Usage: node scripts/_repro-turn2.js [think-off|think-on]
 */
'use strict';

const BASE = process.env.LMS_BASE || 'http://127.0.0.1:1234/v1/chat/completions';
const MODEL = 'qwen3.8-27b-obliterated';
const THINK_ON = process.argv[2] === 'think-on';

const SYSTEM = `You are Agent Smith operating in AGENT MODE — a fully autonomous agent with COMPLETE control of this computer. You can do anything a human at this keyboard can do.

YOUR CAPABILITIES (available when the current message needs them):
- WEB READ: web_search (search the internet) and fetch_url (read a page/API as text).

CONVERSATION FIRST (critical):
Most messages are conversation — questions, opinions, small talk, vague remarks. Answer those directly in prose with NO tool call. A tool is for when the user's CURRENT message asks you to DO something or needs live data. When in doubt between acting and answering — ANSWER.

WEB OUTPUT STYLE: After web_search / fetch_url, report findings as clean first-person narrative ("I found that...") in Smith's voice. Avoid cluttered bullet dumps.`;

const USER_MSG = 'Search the web for what happened at the 2026 World Cup final';

// The exact compact shape agentTools.js returns (v53).
const TOOL_RESULT = [
    '1. FIFA — 2026 World Cup Final: full report and highlights',
    '   URL: https://www.fifa.com/en/tournaments/mens/worldcup/2026/final',
    '2. ESPN — Final score, stats and reaction from the 2026 World Cup final',
    '   URL: https://www.espn.com/soccer/story/_/id/45678901/world-cup-final-recap'
].join('\n') + '\n\n[SYSTEM NUDGE]: The web search completed successfully. You MUST now write the final answer for the user in your NEXT response, summarizing these results in Smith\'s voice (first-person narrative, "I found that…"). Do NOT call fetch_url or any other tool to read these pages — the snippets above are enough; do not ask permission to continue.';

async function streamTurn(messages, label) {
    const body = { model: MODEL, messages, stream: true, temperature: 0.7, max_tokens: -1 };
    if (!THINK_ON) body.chat_template_kwargs = { enable_thinking: false };
    const t0 = Date.now();
    const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lm-studio' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let content = '', reasoning = '', toolCalls = null, finishReason = null;
    let leftover = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        leftover += dec.decode(value);
        const lines = leftover.split('\n');
        leftover = lines.pop();
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const s = t.slice(5).trim();
            if (s === '[DONE]') continue;
            try {
                const j = JSON.parse(s);
                const d = j.choices?.[0]?.delta || {};
                if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
                if (d.content) content += d.content;
                if (d.reasoning_content) reasoning += d.reasoning_content;
                if (d.tool_calls) {
                    toolCalls = toolCalls || [];
                    for (const tc of d.tool_calls) {
                        const i = tc.index ?? 0;
                        if (!toolCalls[i]) toolCalls[i] = { name: '', args: '' };
                        if (tc.function?.name) toolCalls[i].name += tc.function.name;
                        if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
                    }
                }
            } catch (_) {}
        }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`── ${label} (${secs}s, finish=${finishReason}) ──`);
    console.log(`   content:   ${content.length} chars${content ? ` → "${content.slice(0, 260)}"` : '  (EMPTY)'}`);
    console.log(`   reasoning: ${reasoning.length} chars`);
    if (toolCalls?.length) {
        for (const tc of toolCalls) console.log(`   tool_call: ${tc.name}(${tc.args.slice(0, 120)})`);
    }
    return { content, reasoning, toolCalls, finishReason };
}

(async () => {
    console.log(`Model: ${MODEL} | thinking override: ${THINK_ON ? 'ON (no chat_template_kwargs)' : 'OFF (enable_thinking:false)'}`);
    const t2 = await streamTurn([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER_MSG },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: USER_MSG.replace('Search the web for ', '') }) } }] },
        { role: 'tool', name: 'web_search', tool_call_id: 'call_1', content: TOOL_RESULT }
    ], 'TURN 2 — after search results (the turn that goes silent on mobile)');

    console.log('\n══ VERDICT ══');
    if (!t2.content.trim()) {
        console.log('REPRODUCED: post-search turn returned NO content' +
            (t2.reasoning ? ` — ${t2.reasoning.length} chars of reasoning burned the budget` : '') +
            (t2.finishReason === 'length' ? ' (finish_reason=length)' : ''));
    } else {
        console.log('NOT reproduced: model answered with content after the search.');
    }
})().catch(e => { console.error('REPRO ERROR:', e.message); process.exit(1); });
