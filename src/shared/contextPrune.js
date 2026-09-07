/**
 * contextPrune — bound the model's context across tool-using agent turns AND keep
 * long-lived conversations focused on what the user is saying NOW.
 *
 * Two problems, one module:
 *
 * 1. Big tool outputs (full-page browser snapshots especially) are re-sent every step;
 *    left unchecked the context overflows within a few steps — the model slows
 *    ("processing context…"), gets cut off, repeats, and starts hallucinating success.
 *    We keep the few most-recent tool results (the relevant ones) capped in size and
 *    collapse older ones to a stub.
 *
 * 2. v52.8 — stale-task fixation. Chat/Agent histories persist across sessions, so after
 *    an app relaunch the model's context is dominated by OLD build tasks from previous
 *    conversations; on small local models it "ignores" the new message and keeps working
 *    the old task. Fix: conversation turns older than `keepRecentTurns` (default 8 user
 *    turns) are collapsed to a one-line stub, and the FIRST surviving user turn is tagged
 *    as the current topic — so what survives is exactly "recent context + the job at
 *    hand", never a wall of history that out-voices the latest message.
 *
 * Pure + idempotent: re-pruning an already-pruned history is a no-op for stubs and
 * keeps caps stable, so it is safe to call every turn.
 */
'use strict';

const STUB_TOOL = '[earlier tool output omitted to conserve context]';
const STUB_MARK = '…[older conversation compacted — see the latest messages for the current task]';
const CURRENT_TOPIC_MARK = '[CURRENT TOPIC — answer THIS; earlier history is background only, not a task list] ';

// v53.4: turns restored from disk at app launch are stamped `__priorSession` by the
// renderer (see app.js load path). They are CLOSED history from a previous app session —
// never live context. Before this, after a fresh start the whole recent-window was made
// of OLD tasks kept verbatim (and even tagged CURRENT TOPIC), so small local models
// "finished" yesterday's task instead of answering today's message.
function isPriorSession(m) {
    return !!(m && m.__priorSession === true);
}

function pruneChatHistory(historyArray, opts) {
    if (!Array.isArray(historyArray)) return historyArray;
    const MAX_TOOL_CHARS = (opts && opts.maxToolChars) || 1600;
    const KEEP_RECENT_TOOL = (opts && opts.keepRecentTool != null) ? opts.keepRecentTool : 4;
    // v52.8: how many recent USER turns stay verbatim; older conversation is compacted to
    // one-line stubs. 0 disables conversation compaction entirely.
    const KEEP_RECENT_TURNS = (opts && opts.keepRecentTurns != null) ? opts.keepRecentTurns : 8;

    const isTool = (m) => m && (m.role === 'tool' || m.role === 'function');

    // ── 1. Tool-result positions: recent ones kept, older stubbed ────────────
    const toolPositions = [];
    for (let i = 0; i < historyArray.length; i++) if (isTool(historyArray[i])) toolPositions.push(i);
    const toolCutoff = toolPositions.length - KEEP_RECENT_TOOL;

    // ── 2. v52.8: conversation-turn positions: recent kept, older compacted ──
    let userPositions = [];
    if (KEEP_RECENT_TURNS > 0) {
        for (let i = 0; i < historyArray.length; i++) {
            const m = historyArray[i];
            if (!m || m.role !== 'user') continue;
            // Harness-injected control messages ([CONTINUE], [GUARD RAIL] nudges) belong to
            // the ACTIVE run, not stale conversation — never compact them.
            const c = String(m.content == null ? '' : m.content);
            if (/^\[(CONTINUE|GUARD RAIL)\b/.test(c)) continue;
            userPositions.push(i);
        }
    }
    // First surviving user turn (oldest of the recent window) — everything before it is
    // stale. -1 when nothing gets compacted.
    const firstSurvivingUser = KEEP_RECENT_TURNS > 0 && userPositions.length > KEEP_RECENT_TURNS
        ? userPositions[userPositions.length - KEEP_RECENT_TURNS]
        : -1;

    // ── 2b. v53.4: the CURRENT TOPIC tag belongs on the LATEST real user turn, not the
    // oldest surviving one. Tagging the oldest survivor told the model to work on an OLD
    // task after a fresh start (the old task was the first survivor). The latest user
    // message IS the job; exactly ONE message ever carries the tag — any other turn that
    // still has it gets the tag stripped below. Only tag when there is something to
    // disambiguate from (2+ real user turns); a lone message needs no tag.
    let tagIdx = -1;
    if (userPositions.length >= 2) {
        for (let k = userPositions.length - 1; k >= 0; k--) {
            const m = historyArray[userPositions[k]];
            if (!isPriorSession(m)) { tagIdx = userPositions[k]; break; }
        }
    }

    return historyArray.map((m, i) => {
        if (!m || !m.role) return m;

        // 2a. Stale conversation turn → one-line stub. System messages are never touched.
        // A turn is stale when it is older than the recent window (v52.8) OR it was
        // restored from a previous app session (v53.4 — position-independent).
        const isConvTurn = (m.role === 'user' || m.role === 'assistant');
        const staleByPosition = firstSurvivingUser >= 0 && i < firstSurvivingUser;
        if (isConvTurn && (staleByPosition || isPriorSession(m))) {
            let c = String(m.content == null ? '' : m.content).trim();
            // Active-run control messages ([CONTINUE]/[GUARD RAIL] nudges) are never compacted,
            // even when they sit inside the stale region by position. (A restored nudge from a
            // dead run carries __priorSession and IS compacted — that guard only exempts the
            // positional rule.)
            if (/^\[(CONTINUE|GUARD RAIL)\b/.test(c) && !isPriorSession(m)) return m;
            // Already stubbed (idempotent re-prune / grown history) — canonical form, keep as-is.
            if (!c || c.includes(STUB_MARK)) {
                // Already compacted — canonical form. Strip any CURRENT TOPIC tag it was
                // persisted with (the tag now belongs to the latest real user turn only).
                const cleaned = c.replace(CURRENT_TOPIC_MARK, '').trim();
                return cleaned === c ? m : Object.assign({}, m, { content: cleaned });
            }
            const who = m.role === 'user' ? 'User' : 'Smith';
            // A turn that was tagged current-topic in an earlier prune is stale now — drop the tag.
            c = c.replace(CURRENT_TOPIC_MARK, '').trim();
            if (m.role === 'assistant') {
                // Assistant turns in the stale region: keep only a marker — their content is
                // long and irrelevant once the task it served has moved on.
                return Object.assign({}, m, { content: `[Smith, earlier] ${STUB_MARK}` });
            }
            return Object.assign({}, m, { content: `[${who}, earlier] ${c.slice(0, 120)}${STUB_MARK}` });
        }

        // v53.4: a CURRENT TOPIC tag left on any turn that is NOT the designated one is
        // stripped here (previously the oldest surviving user turn got tagged, which after
        // an app relaunch pointed the model at a task from the PREVIOUS session).
        if (isConvTurn && i !== tagIdx) {
            const c = String(m.content == null ? '' : m.content);
            if (c.includes(CURRENT_TOPIC_MARK)) {
                return Object.assign({}, m, { content: c.replace(CURRENT_TOPIC_MARK, '') });
            }
        }

        // 2b. v53.4: the designated turn (latest real user message) carries the tag —
        // idempotent, and only when there is older history to disambiguate from.
        if (i === tagIdx && m.role === 'user') {
            const c = String(m.content == null ? '' : m.content);
            if (!c.includes(CURRENT_TOPIC_MARK)) {
                return Object.assign({}, m, { content: CURRENT_TOPIC_MARK + c });
            }
            return m;
        }

        // 1. Tool result — keep the recent ones (size-capped), stub older ones;
        //    everything else passes through untouched. v53.4: a tool result restored from
        //    a PREVIOUS app session is always stubbed — old task output is never live data.
        if (!isTool(m)) return m;
        const order = toolPositions.indexOf(i);
        let content = String(m.content == null ? '' : m.content);
        if (/omitted to conserve context/.test(content)) {
            return Object.assign({}, m, { content }); // already stubbed — stable
        }
        if (isPriorSession(m) || (order > -1 && order < toolCutoff)) {
            content = STUB_TOOL;
        } else if (content.length > MAX_TOOL_CHARS && !content.includes('…[truncated')) {
            content = content.slice(0, MAX_TOOL_CHARS) + `\n…[truncated ${content.length - MAX_TOOL_CHARS} chars; re-run the tool if you need the rest]`;
        }
        return Object.assign({}, m, { content });
    });
}

const api = { pruneChatHistory };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKContextPrune = api;
