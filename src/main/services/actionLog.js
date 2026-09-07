/**
 * Action Log — the trust/audit layer for Agent Mode.
 *
 * Records every consequential thing the agent does (file writes/deletes, shell
 * commands, messages sent, logins, watcher changes) to a durable log the user can
 * review ("what did you do?") and, where reversible, UNDO ("revert that"). This is
 * what makes an agent that acts on your behalf trustworthy.
 *
 * Undo data (e.g. a file's previous contents) is kept INTERNAL — never returned by
 * list() and never shown to the model. File-content undo is only stored for small
 * files (<= maxUndoBytes); larger mutations are logged as audit-only.
 *
 * Persisted to <userData>/action-log.json as a ring buffer (last `max` entries).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function createActionLog(deps = {}) {
    const file = path.join(deps.userDataPath || '.', 'action-log.json');
    const MAX = deps.max || 500;
    const MAX_UNDO_BYTES = deps.maxUndoBytes || 256 * 1024;
    let data = load();

    function load() {
        try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && Array.isArray(d.entries)) return d; } catch {}
        return { entries: [], seq: 0 };
    }
    // save() returns true on success, false on persistence failure. Callers that
    // care about durability (record/undo/clear) surface the failure so the trust
    // layer does not silently degrade to in-memory-only when the userData dir is
    // non-writable, full, or otherwise failing.
    function save() {
        try { fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); return true; }
        catch (e) { return false; }
    }
    const now = () => Date.now();

    /** record({ type, summary, detail?, undo? }) — undo: {op:'write'|'delete'|'custom', ...}
     *  Returns { id } on success or { id, warning } when the entry was recorded
     *  in memory but could not be persisted (the audit/undo trail is volatile). */
    function record(entry) {
        const id = 'a' + (++data.seq).toString(36);
        const e = {
            id, ts: now(),
            type: entry.type || 'action',
            summary: String(entry.summary || '').slice(0, 300),
            detail: String(entry.detail || '').slice(0, 500),
            reversible: !!entry.undo,
            undone: false,
        };
        if (entry.undo) e._undo = entry.undo;
        data.entries.push(e);
        if (data.entries.length > MAX) data.entries = data.entries.slice(-MAX);
        const persisted = save();
        return persisted ? { id } : { id, warning: 'action recorded in memory only — audit log could not be persisted (userData dir not writable or full). Undo may be unavailable after restart.' };
    }

    /** Public listing — no undo internals. */
    function list(opts = {}) {
        const lim = opts.limit || 50;
        return data.entries.slice(-lim).reverse().map(e => ({
            id: e.id, ts: e.ts, type: e.type, summary: e.summary, detail: e.detail,
            reversible: e.reversible && !e.undone, undone: e.undone,
        }));
    }

    function undo(id) {
        const e = data.entries.find(x => x.id === id);
        if (!e) return { error: 'No action with that id.' };
        if (e.undone) return { error: 'That action was already undone.' };
        if (!e._undo) return { error: 'That action cannot be undone (audit-only).' };
        const u = e._undo;
        try {
            if (u.op === 'write') {
                if (u.existed) fs.writeFileSync(u.path, u.prevContent, 'utf-8');
                else fs.rmSync(u.path, { force: true });
            } else if (u.op === 'delete') {
                if (u.isDir) fs.mkdirSync(u.path, { recursive: true });
                else { fs.mkdirSync(path.dirname(u.path), { recursive: true }); fs.writeFileSync(u.path, u.content, 'utf-8'); }
            } else if (u.op === 'custom' && typeof deps.customUndo === 'function') {
                const r = deps.customUndo(u);
                if (r && r.error) return r;
            } else {
                return { error: 'This action type cannot be undone.' };
            }
            e.undone = true;
            const persisted = save();
            return persisted ? { ok: true, summary: e.summary } : { ok: true, summary: e.summary, warning: 'undo applied but the audit log could not be persisted (userData dir not writable or full).' };
        } catch (err) { return { error: err.message }; }
    }

    function clear() {
        data = { entries: [], seq: data.seq };
        const persisted = save();
        return persisted ? { ok: true } : { ok: true, warning: 'audit log cleared in memory only — the persisted log could not be rewritten (userData dir not writable or full).' };
    }

    // Helper for callers wiring file mutations: decide whether content is small enough to keep for undo.
    function captureWriteUndo(absPath, existedBefore, prevContent) {
        if (!existedBefore) return { op: 'write', path: absPath, existed: false };
        if (prevContent != null && Buffer.byteLength(prevContent) <= MAX_UNDO_BYTES) {
            return { op: 'write', path: absPath, existed: true, prevContent };
        }
        return null; // too large -> audit-only
    }

    return { record, list, undo, clear, captureWriteUndo, MAX_UNDO_BYTES };
}

module.exports = { createActionLog };
