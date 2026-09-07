/**
 * Final-answer rendering. The user must NEVER see raw tool JSON, turn logs, serialized
 * "Invoking tool ... produced" history, or write_file payloads. The authoritative final
 * answer is GENERATED FROM VALIDATOR RESULTS, not parroted from the model.
 */
'use strict';

const STATUS_BADGE = {
    done: '✅ COMPLETE (verified)',
    incomplete: '❌ INCOMPLETE — verification failed',
    unverified: '⚠️ UNVERIFIED — could not validate',
    error: '⛔ ERROR',
    aborted: '⏹ ABORTED'
};

/**
 * Strip anything that looks like internal tool plumbing out of model prose. Used as a
 * last line of defence if we ever surface model text directly.
 */
function sanitizeAssistantText(text) {
    let s = String(text || '');
    // <tool_call>...</tool_call> blocks
    s = s.replace(/<tool[_-]?call>[\s\S]*?<\/tool[_-]?call>/gi, '');
    // serialized Gemma tool history
    s = s.replace(/^.*Invoking tool `[^`]+` produced:.*$/gim, '');
    // fenced tool/json code blocks that contain a tool-call shape
    s = s.replace(/```(?:json|tool_?code|tool_?call|tool)?\s*\{[\s\S]*?\}\s*```/gi, (block) =>
        /["'](name|tool|tool_name|action)["']\s*:/.test(block) && /["'](parameters|arguments|args|path|content)["']\s*:/.test(block) ? '' : block);
    // bare tool-call JSON objects ({"name": "...","parameters": ...} / write_file payloads)
    s = stripToolJsonObjects(s);
    // collapse the blank lines left behind
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Remove top-level JSON objects that carry a tool-call signature. String-aware scan. */
function stripToolJsonObjects(text) {
    const s = String(text || '');
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s[i] === '{') {
            const end = matchBrace(s, i);
            if (end > i) {
                const blob = s.slice(i, end + 1);
                const looksTool = /["'](name|tool|tool_name|action)["']\s*:/.test(blob) &&
                    /["'](parameters|arguments|args|path|content|command|pattern)["']\s*:/.test(blob);
                if (looksTool) { i = end + 1; continue; }
            }
        }
        out += s[i];
        i++;
    }
    return out;
}

function matchBrace(s, open) {
    let depth = 0, inStr = false, q = '', esc = false;
    for (let j = open; j < s.length; j++) {
        const c = s[j];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === q) inStr = false;
            continue;
        }
        if (c === '"' || c === "'") { inStr = true; q = c; }
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return j; }
    }
    return -1;
}

function bullet(ok, label, detail) {
    const mark = ok ? '✅' : '❌';
    return `- ${mark} ${label}${detail ? ` — ${detail}` : ''}`;
}

/**
 * Build the clean markdown final answer.
 * @param {object} r {
 *   status, goal, filesTouched, validation: { messages, checks, ranChecks },
 *   acceptance: { applicable, checks }, smoke, exitReason
 * }
 */
function buildFinalSummary(r) {
    const status = r.status || 'unverified';
    const lines = [];
    lines.push(`### Code run — ${STATUS_BADGE[status] || status}`);
    if (r.goal) lines.push(`**Task:** ${String(r.goal).split('\n')[0].slice(0, 200)}`);

    const files = [...new Set(r.filesTouched || [])];
    lines.push('', `**Files written (${files.length}):** ${files.length ? files.join(', ') : '(none)'}`);

    const v = r.validation || {};
    const vMessages = v.messages || [];
    const ranChecks = v.ranChecks ?? v.checked ?? 0;
    lines.push('', '**Validation:**');
    if (ranChecks === 0 && !vMessages.length) {
        lines.push('- ⚠️ No automated checks could run (no recognized files / no checker available).');
    } else if (!vMessages.length && ranChecks > 0) {
        lines.push('- ✅ Files parse, references resolve, selectors/constants consistent.');
    } else if (!vMessages.length) {
        lines.push('- ⚠️ No validation messages, but checks did not run.');
    } else {
        for (const m of vMessages) lines.push(`- ❌ ${m}`);
    }

    if (r.acceptance && r.acceptance.applicable) {
        lines.push('', '**Acceptance (game):**');
        for (const c of r.acceptance.checks) lines.push(bullet(c.present, c.label, c.present ? '' : 'missing'));
    }

    if (r.smoke && !r.smoke.skipped) {
        lines.push('', `**Browser smoke test (${r.smoke.engine}):**`);
        if (r.smoke.ok) lines.push('- ✅ index.html scripts executed without errors');
        else for (const e of (r.smoke.errors || [])) lines.push(`- ❌ ${e}`);
    } else if (r.smoke && r.smoke.skipped) {
        lines.push('', `**Browser smoke test:** ⚠️ skipped (${r.smoke.reason || 'not applicable'})`);
    }

    lines.push('');
    if (status === 'done') {
        lines.push('**Verdict:** all checks passed — the project is verified.');
    } else if (status === 'incomplete') {
        const n = vMessages.length + ((r.acceptance && r.acceptance.failed && r.acceptance.failed.length) || 0) + (r.smoke && !r.smoke.skipped && !r.smoke.ok ? (r.smoke.errors || []).length : 0);
        lines.push(`**Verdict:** INCOMPLETE — ${n} check(s) failed. Not reported as success.`);
        if (r.exitReason) lines.push(`(run ended: ${r.exitReason})`);
    } else if (status === 'unverified') {
        lines.push('**Verdict:** UNVERIFIED — correctness could not be confirmed. Not reported as success.');
        if (r.exitReason) lines.push(`(run ended: ${r.exitReason})`);
    } else if (r.exitReason) {
        lines.push(`(run ended: ${r.exitReason})`);
    }

    return lines.join('\n');
}

module.exports = { buildFinalSummary, sanitizeAssistantText, stripToolJsonObjects, STATUS_BADGE };
