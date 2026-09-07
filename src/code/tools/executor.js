/**
 * Code Mode tool executor — patch-first edits with changeLedger snapshots.
 *
 * v52.6: every dispatch now flows through the dsh-style staged pipeline
 * (tools/pipeline.js): pre-execute hooks → guards → around-dispatch timeout →
 * body → post-execute waterfall → lossless-JSON normalization → spill finalize.
 * The switch below is the registered tool bodies only; policy lives in the stages.
 */
'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { syntaxCheckFile } = require('../../shared/verificationHarness.js');
const { detectContentIssues } = require('../governor/completionGate.js');
const { assessCommand, blockedResult } = require('../../shared/commandPolicy.js');
const { assessPathMutation, blockedPathResult } = require('../../shared/pathPolicy.js');
const webTools = require('../../shared/webTools.js');
const { advanceStep } = require('../plan/codePlan.js');
const { runToolPipeline } = require('./pipeline.js');

// Upper bound on a single write so one tool call can hold a COMPLETE source file.
// This only rejects content that already arrived in full — real output truncation is
// handled separately (streamCompletion surfaces finish_reason="length" and the turn loop
// retries in small append chunks). So this cap should be generous enough that a normal
// multi-file app's modules (often 400–800 lines) are NOT rejected: a 449-line utils.js
// being bounced at 400 forced weak models into a fragile write-first-400-then-append
// dance that corrupted files. The 64KB byte cap below is the real size backstop.
const MAX_WRITE_LINES = 1000;
const MAX_WRITE_BYTES = 65536;
const MAX_WRITE_CHARS = 65536;
const MAX_READ_LINES = 400;

function checkWriteChunkSize(content) {
    const s = String(content || '');
    const lineCount = s.split('\n').length;
    if (lineCount > MAX_WRITE_LINES) {
        return {
            error: `Content too large (${lineCount} lines, max ${MAX_WRITE_LINES}). ` +
                `Split the file into smaller modules, or write the first ${MAX_WRITE_LINES} lines with write_file ` +
                `and add the rest with append_file (new content only — never re-send code already on disk).`
        };
    }
    if (s.length > MAX_WRITE_BYTES) {
        return {
            error: `Content too large (${Math.round(s.length / 1024)}KB, max ${Math.round(MAX_WRITE_BYTES / 1024)}KB). ` +
                `Split it: write_file the first part, then append_file the remainder (new content only).`
        };
    }
    return null;
}

// Per-session write history: detect a file rewritten with identical content (churn
// with no improvement) so the harness can warn instead of silently looping.
const writeHistory = new Map(); // key `${sessionId}::${rel}` -> { hash, count }

function hashContent(s) {
    return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/**
 * Top-level (column-0) JS declarations in `src` — `function/const/let/var/class NAME`,
 * including ESM exports (`export const x = …`, `export function f() {}`,
 * `export default class C {}`). Used to stop append_file from re-declaring a symbol that
 * already exists, which is the exact bug that produced five `gameLoop` definitions in the
 * failed Pac-Man run. ESM exports are included because they are the dominant style in web
 * app builds (and what this harness itself generates) — an appended `export const add = …`
 * over an existing `add` is the same duplicate-definition corruption as a bare re-decl.
 * We only look at column 0 so legitimately continuing a cut-off file (whose tail is
 * indented body lines, not new declarations) is never flagged.
 */
function topLevelJsDeclNames(src) {
    const names = new Set();
    const re = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(String(src || '')))) names.add(m[1]);
    return names;
}

/** Warn when content clearly does not match the file's extension (CSS in .html, etc.). */
function contentTypeWarnings(relPath, content) {
    const ext = path.extname(relPath).toLowerCase();
    const c = String(content || '');
    const out = [];
    const hasHtmlTag = /<(?:!doctype|html|head|body|div|span|script|link|p|h1|ul|table|canvas)\b/i.test(c);
    const looksCss = /[.#]?[\w-]+\s*\{[^{}]*:[^{}]*;?[^{}]*\}/.test(c);
    const looksJs = /\b(?:function|const|let|var|=>)\b|document\.|addEventListener/.test(c);

    if (ext === '.html') {
        if (!hasHtmlTag && looksCss) out.push('content looks like CSS but is being written to an .html file — did you mean styles.css?');
    } else if (ext === '.css') {
        if (hasHtmlTag) out.push('content contains HTML markup but is being written to a .css file');
        else if (looksJs && !looksCss) out.push('content looks like JavaScript but is being written to a .css file');
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        if (/^\s*<(?:!doctype|html)\b/i.test(c)) out.push('content starts with HTML but is being written to a .js file');
    }
    return out;
}

async function attachFileQualityHints(relPath, content, projectRoot) {
    const hints = [];
    for (const msg of detectContentIssues(relPath, content)) {
        hints.push(msg);
    }
    for (const msg of contentTypeWarnings(relPath, content)) {
        hints.push(msg);
    }
    const syn = await syntaxCheckFile(projectRoot, relPath);
    if (!syn.skipped && !syn.ok) {
        hints.push(`syntax error: ${syn.message}`);
    }
    return hints.length ? { warnings: hints } : null;
}

async function executeTool(name, args, deps) {
    const {
        sessionId, projectContext, editEngine, changeLedger,
        grepProject, globFiles, relPathFromRoot, spawnShell, fireHook, session
    } = deps;

    const a = args || {};
    // v52.6: the call id is minted by the caller (turn loop / run_code) when present —
    // it anchors the spill file and sub-dispatch ids (`<callId>:code:<n>`).
    const callId = deps.callId || `anon_${sessionId || 'run'}_${name}`;

    async function dispatch() {
        switch (name) {
        case 'run_code': {
            // dsh Code Mode transport: the program's sub-dispatches go through THIS
            // executor (deps.executeTool), so they get the full pipeline + phase gates.
            const { createRunCodeExecutor } = require('./runCode.js');
            const runExecDeps = Object.assign({}, deps, { executeTool });
            return createRunCodeExecutor(runExecDeps)(a, callId);
        }
        case 'mark_code_step_done': {
            if (!session?.codePlan) {
                return { error: 'No approved plan is active for this run.' };
            }
            // v52.5 — a step may only be marked done with EVIDENCE since the last edit:
            // either a verification command that passed (node --check / tests / tsc ...) or
            // a successful foreground command, per SYSTEM_PROMPT rule 14 "TEST BEFORE DONE".
            // Without this gate the model could mark every step done by calling the tool in
            // sequence without doing any of the work — the v52.4 stall where the plan UI
            // showed all steps complete while nothing had been verified (or written).
            const hasEvidence = !!session.agentRanOkAfterEdit || !!session.testRunsSinceEdit;
            if (!hasEvidence) {
                return {
                    error: 'Step not marked — no verification since your last edit. Run a check first ' +
                        '(node --check on each changed .js file, then the project test command; python3 -m py_compile for Python), ' +
                        'fix anything it reports, and call mark_code_step_done again.'
                };
            }
            const adv = advanceStep(session.codePlan);
            if (a.note) {
                /* note captured via planAnchor in turnLoop */
            }
            return { success: true, ...adv };
        }
        case 'show_preview': {
            if (typeof deps.showPreview !== 'function') {
                return { error: 'Preview is not available in this environment.' };
            }
            return deps.showPreview({
                kind: a.kind,
                target: a.target,
                caption: a.caption,
                viewport: a.viewport,
                scope: a.scope
            });
        }
        case 'browser_verify': {
            if (typeof deps.browserVerify !== 'function') {
                return { error: 'Browser verify is not available in this environment.' };
            }
            return deps.browserVerify({
                target: a.target || a.path || 'index.html',
                checks: a.checks
            });
        }
        case 'query_run_trace': {
            const trace = deps.trace || session?.trace;
            if (!trace || typeof trace.query !== 'function') {
                return { error: 'Run trace not available yet.', steps: [], summary: { total: 0 } };
            }
            return trace.query({
                failuresOnly: a.failuresOnly,
                tool: a.tool,
                lastN: a.lastN
            });
        }
        case 'read_file': {
            const resolved = projectContext.resolvePath(a.path);
            if (resolved.error) return { error: resolved.error };
            let content;
            try {
                content = await fs.readFile(resolved.path, 'utf-8');
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return { error: `File not found: ${a.path}. Use glob or list_project to find the correct path, then read_file again.` };
                }
                return { error: `Could not read ${a.path}: ${e.message}` };
            }
            const lines = content.split('\n');
            const offset = Math.max(1, parseInt(a.offset, 10) || 1);
            const limit = Math.min(MAX_READ_LINES, parseInt(a.limit, 10) || MAX_READ_LINES);
            const slice = lines.slice(offset - 1, offset - 1 + limit);
            const rel = relPathFromRoot(resolved.path);
            return {
                path: rel,
                totalLines: lines.length,
                offset,
                content: slice.map((l, i) => `${offset + i}|${l}`).join('\n')
            };
        }
        case 'patch': {
            if (String(a.find ?? '') === String(a.replace ?? '')) {
                return {
                    error: 'No-op patch rejected: find and replace are identical. Inspect the file and make a real change.'
                };
            }
            const r = await editEngine.apply(sessionId, a.path, a.find, a.replace, { replaceAll: a.replace_all });
            if (r.error) return r;
            const rel = r.relPath || a.path;
            let quality = null;
            try {
                const resolved = projectContext.resolvePath(a.path);
                if (!resolved.error) {
                    const content = await fs.readFile(resolved.path, 'utf-8');
                    quality = await attachFileQualityHints(rel, content, projectContext.getRoot());
                }
            } catch (e) { /* non-fatal */ }
            return {
                success: true,
                path: a.path,
                relPath: rel,
                note: r.note,
                fileDiff: r.fileDiff,
                linesAdded: r.linesAdded,
                linesRemoved: r.linesRemoved,
                ...(quality || {})
            };
        }
        case 'write_file': {
            if (!a.path || !String(a.path).trim()) {
                return { error: 'write_file requires a "path" (e.g. {"path":"src/app.js","content":"..."}). You sent no path — retry with both path and the full file content.' };
            }
            const chunkErr = checkWriteChunkSize(a.content);
            if (chunkErr) return chunkErr;
            if (String(a.content || '').length > MAX_WRITE_CHARS) {
                return { error: `Content exceeds ${MAX_WRITE_CHARS} chars — use append_file or patch for large edits.` };
            }
            const resolved = projectContext.resolvePath(a.path);
            if (resolved.error) return { error: resolved.error };
            let before = '';
            let existed = false;
            try {
                before = await fs.readFile(resolved.path, 'utf-8');
                existed = true;
            } catch (e) { /* new file */ }
            if (existed) {
                const snap = await changeLedger.snapshotBefore(sessionId, resolved.path, 'write');
                if (snap && snap.error) {
                    return { error: `Refusing to write — could not snapshot the existing file for Revert All: ${snap.error}` };
                }
            } else {
                await changeLedger.recordCreate(sessionId, resolved.path);
            }
            await fs.mkdir(path.dirname(resolved.path), { recursive: true });
            await fs.writeFile(resolved.path, a.content, 'utf-8');
            projectContext.establishFromFilePath(resolved.path);
            const rel = relPathFromRoot(resolved.path);
            const diffMeta = changeLedger.buildFileDiffResult(before.replace(/\r\n/g, '\n'), String(a.content).replace(/\r\n/g, '\n'), rel);
            const quality = await attachFileQualityHints(rel, String(a.content), projectContext.getRoot());

            const histKey = `${sessionId}::${rel}`;
            const hash = hashContent(a.content);
            const prev = writeHistory.get(histKey);
            const repeated = prev && prev.hash === hash;
            writeHistory.set(histKey, { hash, count: (prev ? prev.count : 0) + 1 });
            const warnings = (quality && quality.warnings) ? quality.warnings.slice() : [];
            if (repeated) warnings.push(`file rewritten with identical content (no improvement) — change the content or move on instead of re-writing ${rel}`);

            return {
                success: true,
                path: a.path,
                relPath: rel,
                created: !existed,
                rewrittenIdentical: !!repeated,
                fileDiff: diffMeta.fileDiff,
                linesAdded: diffMeta.linesAdded,
                linesRemoved: diffMeta.linesRemoved,
                ...(warnings.length ? { warnings } : {})
            };
        }
        case 'append_file': {
            if (!a.path || !String(a.path).trim()) {
                return { error: 'append_file requires "path" and "content". Create the file first with write_file.' };
            }
            const chunkErr = checkWriteChunkSize(a.content);
            if (chunkErr) return chunkErr;
            const resolved = projectContext.resolvePath(a.path);
            if (resolved.error) return { error: resolved.error };
            let before = '';
            try {
                before = await fs.readFile(resolved.path, 'utf-8');
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return {
                        error: `append_file: file not found: ${a.path}. Create it first with write_file.`
                    };
                }
                return { error: `Could not read ${a.path}: ${e.message}` };
            }
            // append_file ONLY concatenates at end-of-file. For an HTML document that is
            // already closed, that places the new markup OUTSIDE <html> (the classic
            // "<div> after </html>" corruption). Refuse and point at the right tools.
            const appendExt = path.extname(resolved.path).toLowerCase();
            if (appendExt === '.html' || appendExt === '.htm') {
                if (/<\/html\s*>/i.test(before)) {
                    return {
                        error: `append_file would add content AFTER </html> (outside the document). ` +
                            `To add an element, use patch to insert it before </body>; to rebuild the page, use write_file.`
                    };
                }
            }
            if (appendExt === '.js' || appendExt === '.mjs' || appendExt === '.cjs') {
                const existingDecls = topLevelJsDeclNames(before);
                const dup = [...topLevelJsDeclNames(a.content)].filter(n => existingDecls.has(n));
                if (dup.length) {
                    return {
                        error: `append_file would create a DUPLICATE definition of ${dup.map(n => `"${n}"`).join(', ')} — ` +
                            `${dup.length === 1 ? 'it is' : 'they are'} already defined in ${a.path}. ` +
                            `Appending only adds to the end, so this would leave two copies (the bug that breaks the build). ` +
                            `To change existing code use patch (set replace_all if the text repeats); to rebuild the file use write_file.`
                    };
                }
            }
            const appendSnap = await changeLedger.snapshotBefore(sessionId, resolved.path, 'append');
            if (appendSnap && appendSnap.error) {
                return { error: `Refusing to append — could not snapshot the existing file for Revert All: ${appendSnap.error}` };
            }
            const appended = String(a.content || '');
            const next = before + appended;
            await fs.writeFile(resolved.path, next, 'utf-8');
            projectContext.establishFromFilePath(resolved.path);
            const rel = relPathFromRoot(resolved.path);
            const diffMeta = changeLedger.buildFileDiffResult(
                before.replace(/\r\n/g, '\n'),
                next.replace(/\r\n/g, '\n'),
                rel
            );
            const quality = await attachFileQualityHints(rel, next, projectContext.getRoot());
            return {
                success: true,
                path: a.path,
                relPath: rel,
                appended: true,
                bytesAdded: appended.length,
                fileDiff: diffMeta.fileDiff,
                linesAdded: diffMeta.linesAdded,
                linesRemoved: diffMeta.linesRemoved,
                ...(quality || {})
            };
        }
        case 'grep': {
            const root = projectContext.getRoot();
            const r = await grepProject(root, a.pattern, a.glob || '**/*');
            if (r.error) return r;
            const hits = (r.hits || []).slice(0, 50);
            return { hits: hits.map(h => ({ file: h.file, line: h.line, text: h.text })), truncated: (r.hits || []).length > 50 };
        }
        case 'glob': {
            const root = projectContext.getRoot();
            const r = await globFiles(root, a.pattern || '**/*');
            if (r.error) return r;
            return { files: (r.files || []).slice(0, 100) };
        }
        case 'run_command': {
            const cwd = projectContext.getRoot();
            const cmd = a.command;
            const verdict = assessCommand(cmd, { projectRoot: projectContext.projectRoot || cwd, cwd });
            if (!verdict.allowed) return blockedResult(cmd, verdict.reason);
            if (a.is_background) {
                return deps.runBackgroundCommand(cmd, cwd, sessionId);
            }
            return deps.runForegroundCommand(cmd, cwd);
        }
        case 'list_project': {
            const tree = await projectContext.listProjectTree();
            return { tree };
        }
        // ── v50 host-control tools (merged from Agent Mode) ────────────────────────
        // These reach outside the project root by design. Guardrails: pathPolicy
        // refuses catastrophic targets, actionLog records every mutation (undoable),
        // and downloads are registered so remote users can fetch agent-produced files.
        case 'read_host_file': {
            const resolved = projectContext.resolvePath(a.filepath, { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            try {
                let content = await fs.readFile(resolved.path, 'utf-8');
                const lines = content.split('\n');
                const offset = Math.max(1, parseInt(a.offset, 10) || 1);
                const limit = a.limit != null ? Math.min(Math.max(1, parseInt(a.limit, 10)), 2000) : MAX_READ_LINES;
                const slice = lines.slice(offset - 1, offset - 1 + limit);
                projectContext.establishFromFilePath(resolved.path); // rootless run: establish a workspace from the first file touched
                return { path: resolved.path, totalLines: lines.length, offset, content: slice.map((l, i) => `${offset + i}|${l}`).join('\n') };
            } catch (e) {
                if (e.code === 'ENOENT') return { error: `File not found: ${a.filepath}` };
                return { error: `Could not read ${a.filepath}: ${e.message}` };
            }
        }
        case 'write_host_file': {
            const resolved = projectContext.resolvePath(a.filepath, { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            const absPath = resolved.path;
            const sizeCheck = editEngine && typeof editEngine.validateWriteSize === 'function' ? editEngine.validateWriteSize(a.content) : null;
            if (sizeCheck && sizeCheck.error) return sizeCheck;
            const guard = assessPathMutation(absPath, 'write');
            if (!guard.allowed) return blockedPathResult(absPath, guard.reason);
            let before = '';
            let existed = false;
            try { before = await fs.readFile(absPath, 'utf-8'); existed = true; } catch (e) { /* new file */ }
            // Undo capture for the action log (small files only), mirroring agent-write-file.
            let undo = null;
            if (deps.actionLog && existed && before.length <= deps.actionLog.MAX_UNDO_BYTES) {
                try { undo = deps.actionLog.captureWriteUndo(absPath, true, before); } catch (e) { /* non-fatal */ }
            }
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, String(a.content || ''), 'utf-8');
            projectContext.establishFromFilePath(absPath);
            if (deps.invalidateRepoMap) { try { deps.invalidateRepoMap(); } catch (e) {} }
            if (deps.actionLog) {
                try { deps.actionLog.record({ type: existed ? 'write_file' : 'create_file', summary: `${existed ? 'Overwrote' : 'Created'} ${absPath}`, detail: absPath, undo }); } catch (e) {}
            }
            if (deps.registerDownload) { try { deps.registerDownload(absPath); } catch (e) {} }
            return { success: true, path: absPath, created: !existed };
        }
        case 'delete_host_file': {
            const resolved = projectContext.resolvePath(a.filepath, { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            const absPath = resolved.path;
            const guard = assessPathMutation(absPath, 'delete');
            if (!guard.allowed) return blockedPathResult(absPath, guard.reason);
            let stats;
            try { stats = await fs.stat(absPath); } catch (e) { return { error: `Not found: ${a.filepath}` }; }
            let undo = null;
            if (stats.isDirectory()) {
                undo = { op: 'delete', path: absPath, isDir: true };
                await fs.rm(absPath, { recursive: true, force: true });
            } else {
                if (deps.actionLog && stats.size <= deps.actionLog.MAX_UNDO_BYTES) {
                    try { undo = { op: 'delete', path: absPath, isDir: false, content: await fs.readFile(absPath, 'utf-8') }; } catch (e) {}
                }
                await fs.unlink(absPath);
            }
            if (deps.invalidateRepoMap) { try { deps.invalidateRepoMap(); } catch (e) {} }
            if (deps.actionLog) {
                try { deps.actionLog.record({ type: 'delete_file', summary: `Deleted ${absPath}`, detail: absPath, undo }); } catch (e) {}
            }
            return { success: true };
        }
        case 'list_host_directory': {
            const resolved = projectContext.resolvePath(a.dirpath || '.', { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            try {
                const files = await fs.readdir(resolved.path, { withFileTypes: true });
                return { files: files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE]'} ${f.name}`), dir: resolved.path };
            } catch (e) {
                return { error: `Could not list ${a.dirpath || '.'}: ${e.message}` };
            }
        }
        case 'list_processes': {
            const jobApi = deps.jobApi;
            if (!jobApi) return { jobs: [] };
            const jobs = jobApi.listJobs();
            if (!jobs.length) return { jobs: [], note: 'No background jobs yet. Start one with run_command is_background:true.' };
            return { jobs };
        }
        case 'read_process_log': {
            const jobApi = deps.jobApi;
            if (!jobApi) return { error: 'No job API in this environment' };
            return jobApi.readLog(a.job_id, a.lines) || { error: `Unknown job id ${a.job_id}` };
        }
        case 'send_input': {
            const jobApi = deps.jobApi;
            if (!jobApi) return { error: 'No job API in this environment' };
            return jobApi.sendInput(a.job_id, a.input);
        }
        case 'stop_process': {
            const jobApi = deps.jobApi;
            if (!jobApi) return { error: 'No job API in this environment' };
            return jobApi.kill(a.job_id);
        }
        case 'web_search': {
            try {
                // v54 — DEEP RESEARCH by default: read the top result pages in full and
                // return a detailed natural-language report of everything learned, not just
                // snippets. quick:true (or deep:false) keeps the old snippet-only behavior
                // for fast lookups where page reads would be wasted time.
                const quick = a.quick === true || a.deep === false;
                if (quick) {
                    const results = await webTools.webSearch(String(a.query || '').trim());
                    if (!results.length) return { results: [], note: 'No results found.' };
                    const cap = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 200 ? s.slice(0, 200) + '…' : s; };
                    const text = results.map((r, i) => `${i + 1}. ${cap(r.title)} — ${cap(r.snippet)}\n   URL: ${r.url}`).join('\n');
                    return {
                        results,
                        summary: text,
                        nudge: '[SYSTEM NUDGE] Summarize these results for the user in your next response. The snippets above are enough — do not call fetch_url on them; answer from what you have.'
                    };
                }
                const r = await webTools.researchWeb(String(a.query || '').trim());
                if (!r.results.length) return { results: [], note: 'No results found.' };
                // `report` is the model-facing text (deep-research report + nudge);
                // `results`/`pagesRead` stay structured for the UI sources card.
                return {
                    query: r.query,
                    results: r.results,
                    pagesRead: r.pagesRead,
                    summary: r.report,
                    nudge: '[SYSTEM NUDGE] This result is a DEEP RESEARCH REPORT — write the user a detailed natural-language report of everything it contains (see the full instructions inside the report). Do not reply with bare snippets.'
                };
            } catch (e) {
                return { error: `Web search failed: ${e.message}. Tell the user the search backend could not be reached right now.` };
            }
        }
        case 'fetch_url': {
            try {
                const r = await webTools.fetchUrl(a.url || a.link || a.href);
                return r;
            } catch (e) {
                return { error: e.name === 'AbortError' ? 'Fetch timed out (20s).' : (e.message || String(e)) };
            }
        }
        case 'review_actions': {
            const log = deps.actionLog;
            if (!log) return { actions: [], note: 'Action log unavailable in this environment.' };
            try {
                const acts = (log.list({ limit: a.limit || 20 }) || []).map(x => ({ id: x.id, type: x.type, summary: x.summary, reversible: !!x.reversible }));
                if (!acts.length) return { actions: [], note: 'No consequential actions recorded yet.' };
                return { actions: acts };
            } catch (e) {
                return { error: e.message };
            }
        }
        case 'undo_action': {
            const log = deps.actionLog;
            if (!log) return { error: 'Action log unavailable in this environment.' };
            try {
                const r = await log.undo(a.id);
                if (r && r.error) return { error: r.error };
                return { success: true, undone: a.id };
            } catch (e) {
                return { error: e.message };
            }
        }
        case 'save_user_fact': {
            const fact = String(a.exact_new_fact || '').trim();
            if (!fact) return { error: 'exact_new_fact is required.' };
            const remember = deps.rememberMemory;
            if (typeof remember !== 'function') return { error: 'Cross-session memory is disabled for this run.' };
            try {
                await remember(fact, { source: 'save_user_fact', sessionId });
                return { success: true, note: 'Fact stored to cross-session memory.' };
            } catch (e) {
                return { error: `Memory store failed: ${e.message}` };
            }
        }
        case 'memory_search': {
            const recall = deps.recallMemory;
            if (typeof recall !== 'function') return { results: [], note: 'Cross-session memory is disabled for this run.' };
            try {
                const mems = await recall(String(a.query || '').trim());
                const out = (Array.isArray(mems) ? mems : []).map(m => (m && m.text != null ? m.text : String(m)));
                if (!out.length) return { results: [], note: 'No matching memories found.' };
                return { results: out, note: '[READ-ONLY BACKGROUND DATABASE] Do not re-save any of the above into memory — only save genuinely new facts.' };
            } catch (e) {
                return { error: `Memory search failed: ${e.message}` };
            }
        }
        default: {
            // Plugin tools: anything not a core tool is delegated to the plugin manager
            // (capability-gated + sandboxed by the host). invokePluginTool returns a string,
            // or { __notFound:true } if no enabled plugin owns the name.
            if (typeof deps.invokePluginTool === 'function') {
                const out = await deps.invokePluginTool(name, a);
                if (!(out && out.__notFound)) {
                    const s = typeof out === 'string' ? out : JSON.stringify(out);
                    return /^Error[:\s]/i.test(s) ? { error: s } : { result: s, pluginTool: true };
                }
            }
            return { error: `Unknown tool: ${name}` };
        }
        }
    }

    // v52.6 — staged pipeline (dsh contract): pre-execute hooks/permission → guards →
    // around-dispatch timeout (exclusive calls) → body → post-execute waterfall →
    // lossless-JSON normalization + spill finalize. A throwing stage is normalized into
    // an isError outcome, never a rejection; the model-facing result carries `resultStr`
    // (post-spill text) for history while keeping its structured shape for the UI.
    return runToolPipeline({ name, args: a, callId, body: dispatch, deps });
}

module.exports = {
    executeTool,
    MAX_WRITE_LINES,
    MAX_WRITE_BYTES,
    MAX_WRITE_CHARS,
    MAX_READ_LINES,
    checkWriteChunkSize,
    attachFileQualityHints
};
