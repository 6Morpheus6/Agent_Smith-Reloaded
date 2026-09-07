/**
 * Context budget — rough token estimate + eviction of old turns / fat tool results.
 */
'use strict';

const { digestDropped } = require('../../shared/chatSummarizer.js');

// Slightly conservative (real code/JSON density is ~3–3.5 chars/token, and the request also
// carries the tool-schema array that estimateMessages can't see) so fitBudget leaves headroom
// instead of letting the backend silently truncate the prompt.
const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function estimateMessages(messages) {
    let total = 0;
    for (const m of messages) {
        if (m.content) total += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
    }
    return total;
}

function trimToolResults(messages, maxResultChars = 3000) {
    return messages.map(m => {
        if (m.role !== 'tool' && m.role !== 'function') return m;
        const c = String(m.content || '');
        if (c.length <= maxResultChars) return m;
        return Object.assign({}, m, {
            content: c.slice(0, maxResultChars) + `\n…[truncated ${c.length - maxResultChars} chars]`
        });
    });
}

// reserve = tokens kept FREE for the model's reply. 512 was far too small: a full
// source file (e.g. a ~5KB script.js ≈ 1.5k tokens) could never be emitted before the
// output hit the context-window boundary and got truncated. Default to a real file-sized
// budget so the model can actually write the files it's asked to.
function fitBudget(messages, budgetTokens, reserve = 2048) {
    const target = Math.max(1024, budgetTokens - reserve);
    let out = trimToolResults(messages.slice());
    const dropped = [];
    // Evict the OLDEST evictable message. Protected = the leading contiguous system block (the
    // base system prompt + any compaction breadcrumb), the first user message (the goal), and the
    // LAST message (the freshest tool result/instruction). Everything between is fair game —
    // CRUCIALLY including accumulated `[HARNESS …]` system nudges, which previously could never be
    // dropped and would overflow numCtx, causing the backend to silently truncate the real prompt.
    //
    // Eviction is ATOMIC per conversational unit: an assistant tool_call block is dropped
    // together with its tool results, and a stranded tool run is dropped whole. Splitting a
    // run would leave the sanitizer to synthesize "skipped" placeholders (valid but lossy)
    // or drop orphaned results — evicting whole units keeps the remaining history coherent
    // for the model instead of just valid on the wire.
    const evictOldest = () => {
        let head = 0;
        while (head < out.length && out[head].role === 'system') head++;
        if (head < out.length && out[head].role === 'user') head++; // keep the original goal
        if (out.length <= head + 1) return false; // only protected head + tail remain
        let end = head + 1;
        const m = out[head];
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            while (end < out.length && out[end].role === 'tool') end++;
        } else if (m.role === 'tool') {
            while (end < out.length && out[end].role === 'tool') end++;
        }
        if (end >= out.length) return false; // the unit includes the protected tail — keep it
        dropped.push(...out.splice(head, end - head));
        return true;
    };
    while (estimateMessages(out) > target) { if (!evictOldest()) break; }
    // Leave a breadcrumb so evicted context isn't silently lost (state also lives in
    // .agentsmith/*.md). Inserted after the leading system block — then re-evict if the
    // breadcrumb's own tokens tipped us back over budget.
    if (dropped.length) {
        const digest = digestDropped(dropped);
        if (digest) {
            let insertAt = 0;
            while (insertAt < out.length && out[insertAt].role === 'system') insertAt++;
            out.splice(insertAt, 0, { role: 'system', content: digest });
            while (estimateMessages(out) > target) { if (!evictOldest()) break; }
        }
    }
    return out;
}

module.exports = { estimateTokens, estimateMessages, fitBudget, trimToolResults, CHARS_PER_TOKEN };
