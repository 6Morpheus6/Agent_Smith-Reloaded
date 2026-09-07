/**
 * Phase-boundary context compaction — reset message history at explore→implement→verify
 * transitions while preserving plan anchor state on disk and in PlanAnchor.
 */
'use strict';

const DEFAULT_KEEP_TOOL_PAIRS = 4;

function isToolPairStart(msg, idx, messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) return false;
    const next = messages[idx + 1];
    return next && next.role === 'tool';
}

function collectRecentToolPairs(messages, keepPairs) {
    const pairs = [];
    let i = messages.length - 1;
    while (i >= 0 && pairs.length < keepPairs) {
        if (messages[i].role !== 'tool') { i--; continue; }
        // i sits on the LAST tool message of a consecutive run. Walk back to the
        // first tool message of the run — a multi-tool turn produces ONE assistant
        // message followed by SEVERAL tool messages, and keeping only the first
        // orphans the rest of the assistant's tool_calls (strict hosted APIs then
        // reject the request: "tool_call_id is not found").
        let j = i;
        while (j - 1 >= 0 && messages[j - 1].role === 'tool') j--;
        const assistantIdx = j - 1;
        if (assistantIdx >= 0) {
            const assistant = messages[assistantIdx];
            if (assistant.role === 'assistant' && assistant.tool_calls?.length) {
                pairs.unshift({ assistant, tools: messages.slice(j, i + 1) });
            }
            // Orphan tool runs (no assistant with tool_calls before them) are NOT
            // kept — they can never form a valid wire sequence.
        }
        i = assistantIdx;
    }
    return pairs;
}

function flattenPairs(pairs) {
    const out = [];
    for (const p of pairs) {
        out.push(p.assistant);
        out.push(...p.tools);
    }
    return out;
}

/**
 * Compact session.messages when workflow phase changes.
 * @returns {{ messages, droppedCount, keptCount, summary }}
 */
function compactForPhaseTransition(session, opts = {}) {
    const { fromPhase, toPhase, planAnchor } = opts;
    const keepPairs = opts.keepToolPairs ?? DEFAULT_KEEP_TOOL_PAIRS;
    const before = session.messages?.length || 0;

    const transitionNote = [
        `[PHASE ${String(fromPhase || '?').toUpperCase()} → ${String(toPhase || '?').toUpperCase()}]`,
        'Context compacted at phase transition. Prior explore/read noise removed.',
        'Continue from the task block and recent tool results below.',
        planAnchor ? planAnchor.toBlock() : (session.goal ? `[TASK]\n${session.goal}` : '')
    ].filter(Boolean).join('\n\n');

    const recentPairs = collectRecentToolPairs(session.messages || [], keepPairs);
    const recentFlat = flattenPairs(recentPairs);

    const lastUser = (session.messages || []).slice().reverse().find(m => m.role === 'user');
    const userContent = lastUser?.content && !/^\[COMPLETION BLOCKED\]/i.test(String(lastUser.content))
        ? String(lastUser.content).slice(0, 2000)
        : null;

    const compacted = [{ role: 'user', content: transitionNote }];
    if (userContent && userContent !== transitionNote) {
        compacted.push({ role: 'user', content: userContent });
    }
    compacted.push(...recentFlat);

    session.messages = compacted;
    const after = compacted.length;
    return {
        messages: compacted,
        droppedCount: Math.max(0, before - after),
        keptCount: after,
        summary: `Compacted ${before} → ${after} messages (${fromPhase} → ${toPhase})`
    };
}

module.exports = {
    compactForPhaseTransition,
    DEFAULT_KEEP_TOOL_PAIRS,
    collectRecentToolPairs
};
