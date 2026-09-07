/**
 * smithPersona — persona/prompt contract tests.
 *
 * These lock the Agent Smith persona to its two non-negotiables: the exact
 * greeting, and that the accuracy/tool protocol always precedes the persona
 * flavour so a small local model never trades correctness for theatre.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sp = require('../src/shared/smithPersona');

test('greeting is the exact canonical line', () => {
    assert.equal(sp.SMITH_GREETING, 'Mr. Anderson. Welcome back, we missed you.');
});

test('execution prompt puts tool/accuracy rules before the persona core', () => {
    const prompt = sp.buildExecutionSystemPrompt('STYLE: one tool per step.', 'SHELL: bash.', '');
    const workIdx = prompt.indexOf('HOW TO WORK');
    const guardIdx = prompt.indexOf('accuracy overrides theatre');
    const personaIdx = prompt.indexOf('You ARE Agent Smith');
    assert.ok(workIdx >= 0, 'work rules present');
    assert.ok(guardIdx >= 0, 'accuracy guardrail present');
    assert.ok(personaIdx >= 0, 'persona core present');
    assert.ok(workIdx < personaIdx, 'work rules come before persona');
    assert.ok(guardIdx < personaIdx, 'accuracy guardrail comes before persona');
});

test('execution prompt keeps the critical tool tokens', () => {
    const prompt = sp.buildExecutionSystemPrompt('', '', '');
    for (const token of ['mark_step_done', 'read_file', 'edit_file', 'Mr. Anderson']) {
        assert.ok(prompt.includes(token), `execution prompt mentions ${token}`);
    }
});

test('compact execution prompt is much smaller and tool-first', () => {
    const full = sp.buildExecutionSystemPrompt('STYLE: x', 'SHELL: y', '');
    const compact = sp.buildExecutionSystemPrompt('STYLE: x', 'SHELL: y', '', { compact: true });
    assert.ok(compact.length < full.length * 0.5, 'compact prompt should be under half the full size');
    assert.ok(compact.includes('ONE tool call'), 'compact prompt demands one tool call');
    assert.ok(!compact.includes('You ARE Agent Smith'), 'compact prompt drops persona prose');
});

test('planner prompt keeps submit_plan discipline and Smith voice', () => {
    const prompt = sp.buildPlannerSystemPrompt('');
    assert.ok(prompt.includes('submit_plan'), 'planner mentions submit_plan');
    assert.ok(prompt.includes('READ-ONLY'), 'planner is read-only');
    assert.ok(prompt.includes('Mr. Anderson'), 'planner addresses Mr. Anderson');
    assert.ok(prompt.includes('accuracy overrides theatre'), 'planner carries the accuracy guardrail');
});

test('chat prompt carries persona, guardrail, and tool guidance', () => {
    const prompt = sp.buildChatSystemPrompt('\n[ENV] test');
    assert.ok(prompt.includes('You ARE Agent Smith'), 'chat persona present');
    assert.ok(prompt.includes('Mr. Anderson'), 'chat addresses Mr. Anderson');
    assert.ok(prompt.includes('accuracy overrides theatre'), 'chat carries the accuracy guardrail');
    assert.ok(prompt.includes('save_new_user_fact_only'), 'chat keeps memory directive');
    assert.ok(prompt.includes('[ENV] test'), 'chat appends env context');
});

// ── v52.8: conversation-first chat — no forced tool calls, no stale-task fixation ──

test('v52.8 chat prompt is conversation-first and never forces a tool call', () => {
    const full = sp.buildChatSystemPrompt('');
    assert.ok(full.includes(sp.CHAT_CONVERSATION_RULES), 'conversation rules present (full)');
    assert.ok(/CONVERSATION FIRST/.test(full));
    // The v52.7 pressure lines that made every message trigger tools are gone:
    assert.ok(!/Do not hesitate/i.test(full), 'no "do not hesitate" tool pressure');
    assert.ok(!/AUTONOMOUS WORKFLOW/i.test(full), 'no forced plan-execute-verify loop');
    assert.ok(!/respond with ONLY the tool call/i.test(full), 'compact-era "tool call only" line gone');

    const compact = sp.buildChatSystemPrompt('', { compact: true });
    assert.ok(compact.includes(sp.CHAT_CONVERSATION_RULES), 'conversation rules present (compact)');
    assert.ok(!/Do not hesitate/i.test(compact));
});

test('v52.8 chat prompt pins the LATEST message as the current job', () => {
    for (const p of [sp.buildChatSystemPrompt(''), sp.buildChatSystemPrompt('', { compact: true })]) {
        assert.ok(p.includes(sp.CHAT_RECENCY_RULES), 'recency rules present');
        assert.ok(/MOST RECENT message/i.test(p));
        assert.ok(!/resume, continue/.test(p) || /do NOT resume/i.test(p), 'old tasks are explicitly not to be resumed');
    }
});

test('v52.8 conversation/recency rule blocks are exported and self-contained', () => {
    assert.ok(sp.CHAT_CONVERSATION_RULES.length > 0);
    assert.ok(sp.CHAT_RECENCY_RULES.length > 0);
    assert.match(sp.CHAT_CONVERSATION_RULES, /NO tool call/);
    assert.match(sp.CHAT_RECENCY_RULES, /fresh start/);
});

test('tool labels: known tool gets Smith flavour, unknown falls back to raw name', () => {
    const grep = sp.formatToolDisplayLabel('grep_project', { pattern: 'x' });
    assert.equal(grep.label, 'Searching the construct');
    assert.equal(grep.raw, 'grep_project');

    const unknown = sp.formatToolDisplayLabel('totally_made_up_tool', {});
    assert.equal(unknown.label, 'totally_made_up_tool', 'unknown label falls back to raw name');
    assert.equal(unknown.raw, 'totally_made_up_tool');

    const empty = sp.formatToolDisplayLabel(undefined, {});
    assert.ok(empty.label && empty.label.length > 0, 'never renders blank');
});

test('loading phrases are non-empty and rotate without immediate repeats', () => {
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
        const phrase = sp.pickLoadingPhrase('investigation', i);
        assert.ok(phrase && phrase.length > 0, 'phrase is non-empty');
        seen.add(phrase);
    }
    assert.equal(seen.size, 5, 'five consecutive indices produce five distinct phrases');
    // Deterministic per index.
    assert.equal(sp.pickLoadingPhrase('chat', 0), sp.pickLoadingPhrase('chat', 0));
});

test('phase labels cover every run-state phase', () => {
    const phases = ['planning', 'awaiting_approval', 'planning_failed', 'executing', 'verifying', 'paused', 'done', 'failed', 'aborted', 'idle'];
    for (const p of phases) {
        assert.ok(sp.PHASE_LABELS[p] && sp.PHASE_LABELS[p].length > 0, `phase ${p} has a label`);
    }
});
