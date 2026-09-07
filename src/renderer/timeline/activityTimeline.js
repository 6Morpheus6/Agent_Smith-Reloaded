/**
 * Code Mode inline activity timeline — Matrix theme (.agent-log).
 */
(function (global) {
    'use strict';

    const adapter = typeof window !== 'undefined' ? window.XKEventAdapter : null;
    const diffView = typeof window !== 'undefined' ? window.XKDiffView : null;

    let container = null;
    let deps = {};
    let toolEls = new Map();
    let toolStartTimes = new Map();
    let currentTurnEl = null;
    let thinkingEl = null;
    let anchorEl = null;
    let streamText = '';

    function escapeHtml(s) {
        if (diffView && diffView.escapeHtml) return diffView.escapeHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function nowClock() {
        const d = new Date();
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    function scrollBottom(force) {
        const sf = typeof window !== 'undefined' && window.XKScrollFollow && window.XKScrollFollow.get();
        if (sf) {
            sf.follow(force ? { force: true } : undefined);
            return;
        }
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function insertBeforeAnchor(el) {
        if (!container) return;
        if (anchorEl && anchorEl.parentNode === container) {
            container.insertBefore(el, anchorEl);
        } else {
            container.appendChild(el);
        }
        // Timeline content now exists in #messages — hide the welcome/empty-state overlay.
        // updateEmptyState is otherwise only called at run_start (before any content exists),
        // and system messages now render as toasts (not inline .message nodes), so nothing
        // else re-hid it — leaving the welcome page sitting on top of the live timeline.
        if (deps && deps.updateEmptyState) deps.updateEmptyState();
        scrollBottom();
    }

    function formatToolLabel(name, args) {
        if (window.SmithPersona && window.SmithPersona.formatToolDisplayLabel) {
            return window.SmithPersona.formatToolDisplayLabel(name, args);
        }
        return { label: name, raw: name };
    }

    // Render a value as a short, readable string. Arrays become "[3 items]"
    // (with first few inlined), objects become "{key: …, …}" — never a wall
    // of raw JSON.
    function previewValue(v) {
        if (v == null) return '';
        if (typeof v === 'string') {
            const s = v.replace(/\s+/g, ' ').trim();
            return s.length > 140 ? s.slice(0, 140) + '…' : s;
        }
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (Array.isArray(v)) {
            if (v.length === 0) return '[]';
            const head = v.slice(0, 3).map(previewValue).join(', ');
            return v.length > 3 ? `[${head}, … ${v.length} items]` : `[${head}]`;
        }
        try {
            const keys = Object.keys(v);
            if (keys.length === 0) return '{}';
            const head = keys.slice(0, 3).map(k => `${k}: ${previewValue(v[k])}`).join(', ');
            return keys.length > 3 ? `{${head}, …}` : `{${head}}`;
        } catch (e) { return ''; }
    }

    // Build a readable "key: value" line list from any object — used for tool
    // inputs and unknown tool outputs so users see structured data, not JSON.
    function buildKvList(obj, opts) {
        const skip = (opts && opts.skip) || [];
        const ul = document.createElement('ul');
        ul.className = 'kv-list';
        const keys = Object.keys(obj || {}).filter(k => !skip.includes(k));
        if (keys.length === 0) return null;
        for (const k of keys) {
            const li = document.createElement('li');
            li.className = 'kv-row';
            const v = obj[k];
            const isMultiline = typeof v === 'string' && v.includes('\n') && v.length > 80;
            if (isMultiline) {
                li.innerHTML = `<span class="kv-key">${escapeHtml(k)}</span>`;
                const pre = document.createElement('pre');
                pre.className = 'kv-block';
                pre.textContent = v.length > 4000 ? v.slice(0, 4000) + '\n…[truncated]' : v;
                li.appendChild(pre);
            } else {
                li.innerHTML =
                    `<span class="kv-key">${escapeHtml(k)}</span>` +
                    `<span class="kv-val">${escapeHtml(previewValue(v))}</span>`;
            }
            ul.appendChild(li);
        }
        return ul;
    }

    function renderInputDetails(name, args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
        const keys = Object.keys(args);
        if (keys.length === 0) return null;
        const det = document.createElement('details');
        det.className = 'agent-log-input';
        det.open = false;
        const sum = document.createElement('summary');
        sum.textContent = `Input · ${keys.length} field${keys.length === 1 ? '' : 's'}`;
        det.appendChild(sum);
        const list = buildKvList(args);
        if (list) det.appendChild(list);
        return det;
    }

    function categoryBadgeHtml(category) {
        const cfg = (adapter && adapter.CATEGORY_CONFIG[category]) || { label: category, badgeClass: 'activity-badge--read', icon: '•' };
        return `<span class="activity-badge ${cfg.badgeClass}" title="${escapeHtml(cfg.label)}">${escapeHtml(cfg.icon)}</span>`;
    }

    function reset() {
        toolEls.clear();
        toolStartTimes.clear();
        currentTurnEl = null;
        thinkingEl = null;
        streamText = '';
    }

    function setAnchor(el) {
        anchorEl = el || null;
    }

    function hideEmptyState() {
        const empty = document.getElementById('empty-state');
        if (empty) empty.style.display = 'none';
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.add('code-run-visible');
        }
    }

    function ensureTurnHeader(turn) {
        // Only the active turn's bar animates; freeze the previous one so past turns
        // sit quietly instead of all pulsing forever.
        if (currentTurnEl) currentTurnEl.classList.add('done');
        const header = document.createElement('div');
        header.className = 'activity-turn';
        header.dataset.turn = String(turn);
        header.innerHTML =
            `<span class="activity-turn-label">TURN</span>` +
            `<span class="activity-turn-num">${turn}</span>` +
            `<span class="activity-turn-rule" aria-hidden="true"></span>`;
        insertBeforeAnchor(header);
        currentTurnEl = header;
        return header;
    }

    function ensureThinkingBlock() {
        if (thinkingEl && thinkingEl.parentNode) return thinkingEl;
        const det = document.createElement('details');
        det.className = 'activity-thinking';
        det.open = true; // expanded by default — see the model thinking, not just code
        const sum = document.createElement('summary');
        sum.textContent = 'Thinking';
        const body = document.createElement('div');
        body.className = 'activity-thinking-body';
        det.appendChild(sum);
        det.appendChild(body);
        insertBeforeAnchor(det);
        thinkingEl = det;
        return det;
    }


    function collapseThinking() {
        if (thinkingEl) thinkingEl.open = false;
    }

    // Reasoning streams from weak/local models often contain raw JSON tool-call
    // fragments with escaped newlines (\n) and CSS/JS payloads. Render those
    // as readable prose: unescape JSON string escapes, strip tool-call shells,
    // and if what's left is mostly code, collapse it to a short status line.
    function cleanReasoningText(raw) {
        let s = String(raw || '');
        // Drop full JSON tool-call objects ({"name":"...","parameters":{...}})
        s = s.replace(/\{\s*"name"\s*:\s*"[a-z_]+"[\s\S]*?"(?:parameters|arguments)"\s*:[\s\S]*?\}\s*\}?/gi, '');
        // Drop fenced JSON / tool_call blocks
        s = s.replace(/```(?:json|tool_call|tool_code)?\s*\{[\s\S]*?\}\s*```/gi, '');
        // Strip stray "path":"...","content":" prefixes that survive truncation
        s = s.replace(/"(?:path|content|arguments|parameters|name)"\s*:\s*"?/gi, '');
        // Unescape common JSON string escapes so \n renders as a real newline,
        // not the literal two characters that bleed all over the timeline.
        s = s
            .replace(/\\r\\n/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '  ')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
        // Collapse runs of blank lines
        s = s.replace(/\n{3,}/g, '\n\n').trim();

        // Heuristic: if it still looks like a raw code dump (lots of braces /
        // semicolons / few prose words), don't show the wall of code in the
        // reasoning panel — it's already going to land as a real file via the
        // tool-call row. Show a short status instead.
        const codeChars = (s.match(/[{};]/g) || []).length;
        const wordChars = (s.match(/[A-Za-z]{4,}/g) || []).length;
        if (s.length > 200 && codeChars > 30 && codeChars > wordChars * 0.6) {
            return '_Writing code…_';
        }
        return s;
    }

    function appendToolRow(callId, name, args) {
        // Leave the thinking panel expanded — users want to keep seeing the
        // model's reasoning while tool work scrolls in below it.
        const category = adapter ? adapter.categoryForTool(name) : 'read';
        const labelled = formatToolLabel(name, args);
        const el = document.createElement('div');
        el.className = 'agent-log running';
        el.dataset.callId = callId;
        const subtitle = adapter ? adapter.compactSubtitle(args, name) : '';
        el.innerHTML =
            `<div class="agent-log-head">` +
            categoryBadgeHtml(category) +
            `<span class="agent-log-status">●</span>` +
            `<span class="agent-log-name" title="${escapeHtml(labelled.raw)}">${escapeHtml(labelled.label)}</span>` +
            `<span class="agent-log-args">${escapeHtml(subtitle)}</span>` +
            `<span class="agent-log-time">${nowClock()}</span>` +
            `</div>`;
        const inputDetails = renderInputDetails(name, args);
        if (inputDetails) el.appendChild(inputDetails);
        insertBeforeAnchor(el);
        toolEls.set(callId, el);
        toolStartTimes.set(callId, Date.now());
        return el;
    }

    function formatToolResultBody(name, result) {
        if (!result || typeof result !== 'object') return String(result || '');
        if (result.skipped) return result.reason || 'Skipped (duplicate)';
        if (result.error) return String(result.error);

        if (name === 'read_file' && result.content) {
            return result.content;
        }
        if (name === 'grep' && result.hits) {
            return result.hits.map(h => `${h.file}:${h.line} ${h.text}`).join('\n');
        }
        if (name === 'glob' && result.files) {
            return result.files.join('\n');
        }
        if (name === 'run_command') {
            const parts = [];
            if (result.stdout) parts.push(result.stdout);
            if (result.stderr) parts.push(result.stderr);
            if (result.error) parts.push(result.error);
            return parts.join('\n') || '(no output)';
        }
        if (name === 'list_project' && result.tree) {
            return typeof result.tree === 'string' ? result.tree : JSON.stringify(result.tree, null, 2);
        }
        // v53: web_search / fetch_url — show the actual retrieved content, not a KV dump.
        if (name === 'web_search') {
            if (result.summary) return String(result.summary);
            if (Array.isArray(result.results)) {
                return result.results.map((r, i) => `${i + 1}. ${r.title || ''}${r.snippet ? ` — ${r.snippet}` : ''}\n   URL: ${r.url || ''}`).join('\n');
            }
        }
        if (name === 'fetch_url' && result.content != null) {
            return String(result.content);
        }
        // Unknown tool: let the caller render a KV list instead of dumping JSON.
        return '';
    }

    // A short, human result line — "Read 200 lines", "+12 −3", "4 matches" — the way
    // Summarize a tool result instead of dumping the raw first line.
    function resultSummary(name, result) {
        if (!result || typeof result !== 'object') return '';
        if (result.skipped) return result.reason || 'Skipped (duplicate)';
        if (result.error) return String(result.error).split('\n')[0].slice(0, 120);
        switch (name) {
        case 'read_file':
            return result.totalLines != null ? `Read ${result.totalLines} lines` : 'File read';
        case 'grep':
        case 'grep_project': {
            const n = (result.hits || result.matches || []).length;
            return `${n} match${n === 1 ? '' : 'es'}${result.truncated ? '+' : ''}`;
        }
        case 'glob':
        case 'glob_files': {
            const n = (result.files || []).length;
            return `${n} file${n === 1 ? '' : 's'} found`;
        }
        case 'list_project':
        case 'list_directory':
            return 'Project tree mapped';
        case 'run_command':
        case 'run_shell_command': {
            const out = String(result.stdout || '').trim();
            return out ? out.split('\n')[0].slice(0, 120) : 'Command finished';
        }
        case 'run_verify':
            return result.passed ? 'Checks passed' : (result.failed ? 'Checks failed' : 'Verification done');
        case 'browser_verify':
        case 'show_preview':
            return 'Preview ready';
        case 'web_search': {
            const n = Array.isArray(result.results) ? result.results.length : 0;
            return n ? `${n} source${n === 1 ? '' : 's'} retrieved` : 'Results retrieved';
        }
        case 'fetch_url':
            return 'Page fetched';
        case 'write_file':
        case 'edit_file':
        case 'patch': {
            const path = (result.relPath || result.path || '').split(/[\\/]/).pop() || '';
            const a = result.linesAdded, r = result.linesRemoved;
            const stat = (a != null || r != null) ? `  +${a || 0} −${r || 0}` : '';
            return `${path}${stat}`.trim() || 'Saved';
        }
        case 'delete_file':
            return 'File removed';
        case 'submit_code_plan':
        case 'submit_plan': {
            const n = Array.isArray(result.steps) ? result.steps.length : null;
            return n != null ? `Plan submitted · ${n} step${n === 1 ? '' : 's'}` : 'Plan submitted';
        }
        case 'mark_code_step_done':
        case 'mark_step_done':
            return 'Step complete';
        case 'mark_step_blocked':
            return 'Step blocked';
        case 'add_steps':
            return 'Steps added';
        case 'add_files':
            return 'Files added';
        default: {
            // Never leak raw JSON into the row summary — only show first line of a
            // plain text result. Object results without a known handler show nothing.
            if (typeof result === 'string') return String(result).split('\n')[0].slice(0, 120);
            return '';
        }
        }
    }




    function updateToolRow(callId, name, result, ok, durationMs) {
        const el = toolEls.get(callId);
        if (!el) return;

        const skipped = !!(result && result.skipped);
        const failed = skipped ? false : (!ok || (adapter && adapter.toolResultFailed(result)));

        el.classList.remove('running');
        if (skipped) {
            el.classList.add('skipped');
        } else {
            el.classList.add(failed ? 'fail' : 'ok');
        }

        const statusEl = el.querySelector('.agent-log-status');
        if (statusEl) statusEl.textContent = skipped ? '↷' : (failed ? '✗' : '✓');

        if (durationMs != null) {
            const timeEl = el.querySelector('.agent-log-time');
            if (timeEl) timeEl.textContent = `${(durationMs / 1000).toFixed(1)}s`;
        }

        const fileDiff = result && result.fileDiff;
        if (fileDiff && diffView && diffView.renderDiffDom) {
            const diffEl = diffView.renderDiffDom(fileDiff);
            if (diffEl) {
                const det = document.createElement('details');
                det.className = 'agent-log-result agent-log-result--diff';
                det.open = true; // edits shown inline
                const sum = document.createElement('summary');
                sum.textContent = resultSummary(name, result) || (result.relPath || result.path || 'diff');
                det.appendChild(sum);
                det.appendChild(diffEl);
                el.appendChild(det);
            }
        } else {
            const body = formatToolResultBody(name, result);
            const summary = resultSummary(name, result);
            const isObj = result && typeof result === 'object' && !Array.isArray(result);
            const kv = (!body && isObj) ? buildKvList(result, { skip: ['fileDiff'] }) : null;
            if (body || summary || kv) {
                const det = document.createElement('details');
                det.className = 'agent-log-result';
                const sum = document.createElement('summary');
                sum.textContent = summary || (body ? body.split('\n')[0].slice(0, 100) : 'Output');
                det.appendChild(sum);
                if (body) {
                    const pre = document.createElement('pre');
                    pre.textContent = body.length > 8000 ? body.slice(0, 8000) + '\n…[truncated]' : body;
                    det.appendChild(pre);
                } else if (kv) {
                    det.appendChild(kv);
                }
                el.appendChild(det);
            }
        }

        toolEls.delete(callId);
        toolStartTimes.delete(callId);
        scrollBottom();
    }

    function handleCodeEvent(ev, opts) {
        if (!ev || !ev.type) return;
        if (opts && opts.anchor) anchorEl = opts.anchor;
        if (opts && opts.botDiv) anchorEl = opts.botDiv;

        const node = adapter ? adapter.adaptCodeEvent(ev) : null;

        switch (ev.type) {
        case 'run_start':
            reset();
            hideEmptyState();
            if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                window.XKScrollFollow.get().beginRun();
            }
            scrollBottom(true);
            if (deps.updateEmptyState) deps.updateEmptyState();
            break;

        case 'turn_start':
            ensureTurnHeader(ev.turn);
            // Collapse the previous task's reasoning when the next task begins, and
            // start fresh so each turn's "Thinking" shows only that turn's reasoning.
            collapseThinking();
            thinkingEl = null;
            streamText = '';
            if (deps.onStatusUpdate) {
                deps.onStatusUpdate({
                    turn: ev.turn,
                    toolCount: ev.toolCountSoFar,
                    sessionId: ev.sessionId
                });
            }
            break;

        case 'model_advisory': {
            // Non-blocking, one-time notice (e.g. "this is a reasoning model — a coder
            // model is recommended"). Persistent row so the user can read it mid-run.
            const note = document.createElement('div');
            note.className = 'activity-advisory';
            note.style.cssText = 'margin:6px 0;padding:7px 10px;border-left:3px solid #d8a657;'
                + 'background:rgba(216,166,55,0.08);border-radius:4px;font-size:12px;line-height:1.4;color:var(--text-muted,#bbb);';
            note.textContent = '⚠ ' + (ev.message || 'Model advisory');
            insertBeforeAnchor(note);
            scrollBottom();
            break;
        }

        case 'stream_retry': {
            // The model stalled mid-reply and the harness is retrying — without this row the
            // turn looks blank (no Thinking panel, no tools), reading as a frozen/dead run.
            const row = document.createElement('div');
            row.className = 'activity-retry';
            row.style.cssText = 'margin:6px 0;padding:6px 10px;border-left:3px solid #e78a4e;'
                + 'background:rgba(231,138,78,0.08);border-radius:4px;font-size:12px;line-height:1.4;color:var(--text-muted,#bbb);';
            row.textContent = '⟳ ' + (ev.message
                || `Model stalled — retrying${ev.attempt ? ` (${ev.attempt})` : ''}.`);
            insertBeforeAnchor(row);
            scrollBottom();
            break;
        }

        case 'reasoning_truncated': {
            const row = document.createElement('div');
            row.className = 'activity-advisory';
            row.style.cssText = 'margin:6px 0;padding:6px 10px;border-left:3px solid #d8a657;'
                + 'background:rgba(216,166,55,0.08);border-radius:4px;font-size:12px;line-height:1.4;color:var(--text-muted,#bbb);';
            row.textContent = '… ' + (ev.message
                || 'Model spent the whole reply reasoning with no output — retrying with a larger budget.');
            insertBeforeAnchor(row);
            scrollBottom();
            break;
        }

        case 'context_budget':
            if (deps.onStatusUpdate && node) {
                deps.onStatusUpdate({
                    turn: ev.turn,
                    budgetPct: node.budgetPct,
                    toolCount: ev.toolCountSoFar
                });
            }
            break;

        case 'delta':
            streamText += ev.text || '';
            {
                const det = ensureThinkingBlock();
                const body = det.querySelector('.activity-thinking-body');
                const cleaned = cleanReasoningText(streamText);
                if (body && deps.markedParse) {
                    body.innerHTML = deps.markedParse(cleaned || '_Thinking…_');
                } else if (body) {
                    body.textContent = cleaned || 'Thinking…';
                }
                const sum = det.querySelector('summary');
                if (sum) {
                    // Keep the header compact while open — raw model/CSS dumps belong
                    // in the body, not squashed into the summary line.
                    if (det.open) {
                        sum.textContent = 'Reasoning';
                    } else {
                        const preview = cleaned.replace(/[_*`]/g, '').replace(/\s+/g, ' ').trim();
                        sum.textContent = preview.length > 60 ? 'Reasoning · ' + preview.slice(0, 60) + '…' : 'Reasoning';
                    }
                }
            }
            scrollBottom();
            break;


        case 'tool_start':
            appendToolRow(ev.callId || `tool_${Date.now()}`, ev.name, ev.args || {});
            break;

        case 'tool_result':
            updateToolRow(
                ev.callId,
                ev.name,
                ev.result,
                ev.ok,
                ev.durationMs != null ? ev.durationMs : (toolStartTimes.has(ev.callId) ? Date.now() - toolStartTimes.get(ev.callId) : null)
            );
            if (deps.onStatusUpdate) {
                deps.onStatusUpdate({
                    turn: ev.turn,
                    toolCount: ev.toolCountSoFar != null ? ev.toolCountSoFar : undefined
                });
            }
            break;

        case 'assistant_done':
            collapseThinking();
            streamText = ev.content || streamText;
            if (anchorEl && deps.markedParse) {
                anchorEl.innerHTML = deps.markedParse(streamText);
            }
            scrollBottom(true);
            break;

        case 'done':
            collapseThinking();
            if (currentTurnEl) currentTurnEl.classList.add('done');
            if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                window.XKScrollFollow.get().endRun();
            }
            scrollBottom(true);
            if (deps.onStatusUpdate) {
                deps.onStatusUpdate({ turn: ev.turn, toolCount: ev.toolCount });
            }
            break;

        case 'error':
            if (currentTurnEl) currentTurnEl.classList.add('done');
            if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                window.XKScrollFollow.get().endRun();
            }
            scrollBottom(true);
            break;

        // verify_blocked → owned by code.js (one concise line; avoids the double box).
        // final_summary → rendered as clean markdown via the assistant_done message.

        default:
            break;
        }
    }

    function mount(messagesContainer, mountDeps) {
        container = messagesContainer;
        deps = mountDeps || {};
        if (typeof window !== 'undefined') {
            window.XKSharedTimeline = { handleCodeEvent, reset, setAnchor };
        }
        return { handleCodeEvent, reset, setAnchor };
    }

    const api = { mount, handleCodeEvent, reset, setAnchor };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKActivityTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
