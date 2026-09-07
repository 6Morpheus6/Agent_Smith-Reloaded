/**
 * Code-event → ActivityNode adapter for the inline timeline (Matrix-themed UI).
 */
'use strict';

const TOOL_CATEGORY = {
    // read
    read_file: 'read',
    list_project: 'read',
    list_directory: 'read',
    get_repo_map: 'read',
    query_run_trace: 'read',
    // search
    grep: 'search',
    glob: 'search',
    grep_project: 'search',
    glob_files: 'search',
    web_search: 'search',
    fetch_url: 'search',
    search_memory: 'search',
    memory_search: 'search',
    // write
    patch: 'write',
    write_file: 'write',
    append_file: 'write',
    edit_file: 'write',
    delete_file: 'write',
    save_new_user_fact_only: 'write',
    // shell / verification
    run_command: 'shell',
    run_shell_command: 'shell',
    run_verify: 'shell',
    browser_verify: 'shell',
    show_preview: 'shell',
    // plan
    submit_code_plan: 'plan',
    submit_plan: 'plan',
    mark_code_step_done: 'plan',
    mark_step_done: 'plan',
    mark_step_blocked: 'plan',
    add_steps: 'plan',
    add_files: 'plan'
};

const CATEGORY_CONFIG = {
    read:   { label: 'Read',   cssVar: '--agent-color',  badgeClass: 'activity-badge--read',   icon: '◈' },
    search: { label: 'Search', cssVar: '--accent-dim',   badgeClass: 'activity-badge--search', icon: '⌕' },
    write:  { label: 'Edit',   cssVar: '--accent-color', badgeClass: 'activity-badge--write',  icon: '✎' },
    shell:  { label: 'Run',    cssVar: '--info-color',   badgeClass: 'activity-badge--shell',  icon: '▶' },
    plan:   { label: 'Plan',   cssVar: '--accent-color', badgeClass: 'activity-badge--plan',   icon: '✦' },
    llm:    { label: 'Think',  cssVar: '--text-muted',   badgeClass: 'activity-badge--llm',    icon: '◉' }
};

function categoryForTool(name) {
    return TOOL_CATEGORY[name] || 'read';
}

// Pull the trailing path segment so subtitles read "renderer.js" not the full
// project-relative path leak.
function basename(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
}

function clip(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + '…' : t;
}

// Human-readable per-tool subtitle. Never falls back to raw JSON — unknown
// tools just show an empty subtitle so the row stays clean.
function subtitleFor(name, args) {
    if (!args || typeof args !== 'object') return '';
    switch (name) {
    case 'read_file':       return basename(args.path || args.filepath) || '';
    case 'write_file':
    case 'append_file':
    case 'edit_file':       return basename(args.path || args.filepath) || '';
    case 'delete_file':     return basename(args.path || args.filepath) || '';
    case 'patch':           return basename(args.path || args.filepath) || '';
    case 'glob':
    case 'glob_files':      return clip(args.pattern || args.glob || '', 60);
    case 'grep':
    case 'grep_project':    {
        const pat = clip(args.pattern || args.query || '', 40);
        const where = basename(args.path || args.dir || '');
        return where ? `${pat} · ${where}` : pat;
    }
    case 'list_project':
    case 'list_directory':  return basename(args.path) || 'project root';
    case 'run_command':
    case 'run_shell_command': return clip(args.command || '', 80);
    case 'run_verify':      return 'compliance check';
    case 'browser_verify':  return clip(args.url || args.path || 'preview', 60);
    case 'show_preview':    return clip(args.url || args.path || 'preview', 60);
    case 'web_search':
    case 'fetch_url':       return clip(args.query || args.url || '', 60);
    case 'search_memory':
    case 'memory_search':   return clip(args.query || '', 60);
    case 'submit_code_plan':
    case 'submit_plan':     {
        const n = Array.isArray(args.steps) ? args.steps.length : 0;
        return n ? `${n} step${n === 1 ? '' : 's'}` : '';
    }
    case 'mark_code_step_done':
    case 'mark_step_done':  return clip(args.note || '', 60);
    case 'mark_step_blocked': return clip(args.reason || args.note || '', 60);
    case 'add_steps':       {
        const n = Array.isArray(args.steps) ? args.steps.length : 0;
        return n ? `+${n} step${n === 1 ? '' : 's'}` : '';
    }
    case 'add_files':       {
        const n = Array.isArray(args.files) ? args.files.length : 0;
        return n ? `+${n} file${n === 1 ? '' : 's'}` : '';
    }
    case 'save_new_user_fact_only': return clip(args.fact || args.text || '', 60);
    case 'query_run_trace': return clip(args.query || args.sessionId || '', 60);
    default: return '';
    }
}

function compactSubtitle(args, name) {
    return subtitleFor(name, args);
}


function toolResultFailed(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.error) return true;
    if (result.skipped) return false;
    return false;
}

function extractFileDiff(result) {
    if (!result || typeof result !== 'object') return null;
    return result.fileDiff || null;
}

/**
 * Map a raw code-event into a partial ActivityNode (renderer enriches with DOM refs).
 */
function adaptCodeEvent(ev, ctx = {}) {
    if (!ev || !ev.type) return null;
    const now = Date.now();

    switch (ev.type) {
    case 'run_start':
        return { type: 'run', id: ev.sessionId || 'run', status: 'running', startedAt: now, goal: ev.goal };
    case 'turn_start':
        return {
            type: 'turn',
            id: `turn_${ev.turn}`,
            turn: ev.turn,
            toolCountSoFar: ev.toolCountSoFar,
            status: 'running',
            startedAt: now
        };
    case 'context_budget':
        return {
            type: 'budget',
            used: ev.used,
            total: ev.total,
            budgetPct: ev.total ? Math.round((ev.used / ev.total) * 100) : null
        };
    case 'delta':
        return { type: 'thinking', text: ev.text || '', status: 'running' };
    case 'tool_start':
        return {
            type: 'tool',
            id: ev.callId || `tool_${now}`,
            toolName: ev.name,
            category: categoryForTool(ev.name),
            status: 'running',
            input: ev.args || {},
            subtitle: compactSubtitle(ev.args, ev.name),
            startedAt: now
        };
    case 'tool_result': {
        const skipped = !!(ev.result && ev.result.skipped);
        const failed = skipped ? false : !ev.ok || toolResultFailed(ev.result);
        return {
            type: 'tool',
            id: ev.callId || ctx.pendingCallId,
            toolName: ev.name,
            category: categoryForTool(ev.name),
            status: skipped ? 'skipped' : (failed ? 'fail' : 'ok'),
            output: ev.result,
            fileDiff: extractFileDiff(ev.result),
            durationMs: ev.durationMs,
            ok: ev.ok
        };
    }
    case 'assistant_done':
        return { type: 'assistant', content: ev.content || '', status: 'ok' };
    case 'done':
        return {
            type: 'run',
            status: 'ok',
            turn: ev.turn,
            toolCount: ev.toolCount,
            sessionId: ev.sessionId
        };
    case 'error':
        return { type: 'error', message: ev.message || 'error', status: 'fail' };
    default:
        return null;
    }
}

const api = {
    CATEGORY_CONFIG,
    TOOL_CATEGORY,
    categoryForTool,
    compactSubtitle,
    adaptCodeEvent,
    toolResultFailed,
    extractFileDiff
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKEventAdapter = api;
