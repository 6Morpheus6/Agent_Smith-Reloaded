/**
 * Download registry — the set of files the agent itself produced, which the
 * /download_remote endpoint may serve OUTSIDE the default roots (project root /
 * userData / ~/Downloads).
 *
 * Why: Agent Mode writes anywhere on the host (by design), but the download
 * endpoint only served the default roots — so a link to an agent-created file in
 * e.g. ~/Documents 403'd with "File not found or not permitted". Widening the
 * roots themselves (e.g. allowing $HOME) would turn the app into an arbitrary
 * file reader for any authenticated web client — the exact SSRF hole netGuard was
 * built to close. The registry keeps the boundary precise: a file is servable
 * when there is EVIDENCE the agent made it (registered on write / on link issue).
 *
 * Persisted to <userData>/download-registry.json as a ring buffer (realpath'd
 * absolute paths) so issued links keep working across restarts.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function createDownloadRegistry(deps = {}) {
    const file = path.join(deps.userDataPath || '.', 'download-registry.json');
    const MAX = deps.max || 500;
    let entries = load();

    function load() {
        try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (d && Array.isArray(d.paths)) return d.paths.filter(p => typeof p === 'string');
        } catch (e) { /* first run / unreadable → start empty */ }
        return [];
    }

    function save() {
        try { fs.writeFileSync(file, JSON.stringify({ paths: entries }, null, 2), { mode: 0o600 }); return true; }
        catch (e) { return false; }
    }

    // Resolve to a canonical real file path, or null when missing / not a file.
    function realFile(rawPath) {
        if (!rawPath) return null;
        try {
            const abs = fs.realpathSync(path.resolve(String(rawPath)));
            return fs.statSync(abs).isFile() ? abs : null;
        } catch (e) {
            return null;
        }
    }

    /** Register a file as agent-produced. Returns { ok, path } or { error }. */
    function register(rawPath) {
        const abs = realFile(rawPath);
        if (!abs) return { error: `File not found: ${rawPath}` };
        if (!entries.includes(abs)) {
            entries.push(abs);
            if (entries.length > MAX) entries = entries.slice(-MAX);
            save();
        }
        return { ok: true, path: abs };
    }

    /** True when rawPath resolves to a previously registered real file. */
    function isRegistered(rawPath) {
        const abs = realFile(rawPath);
        return !!abs && entries.includes(abs);
    }

    return { register, isRegistered, _file: file };
}

/**
 * Single decision point for /download_remote (exported for tests — main.js's
 * validateDownloadPath delegates here): serve a path when it sits inside one of
 * the default roots (netGuard policy) OR when the download registry proves the
 * agent produced it. Everything else → null (403).
 */
function resolveServablePath(rawPath, { roots, registry, netGuard }) {
    return explainDownloadRefusal(rawPath, { roots, registry, netGuard }).path || null;
}

/**
 * Diagnostic variant of resolveServablePath: WHY can this file not be served?
 * Returns { ok: true, path } when servable, otherwise { ok: false, code, message }
 * with a precise, user-actionable reason:
 *   - missing_param   — the link carried no file parameter
 *   - missing_file    — no such file on disk (moved / renamed / deleted / never created)
 *   - not_registered  — file exists but there is no evidence the agent produced it
 *                       (blocked by the arbitrary-host-file protection)
 * The endpoint surfaces code+message in the 403 body and server log so "file has
 * an issue" vs "blocked by policy" is never a guess.
 */
function explainDownloadRefusal(rawPath, { roots, registry, netGuard }) {
    if (!rawPath) {
        return { ok: false, code: 'missing_param', message: 'The download link has no file parameter — it was malformed when created.' };
    }
    const viaRoots = netGuard.validateDownloadPath(rawPath, roots);
    if (viaRoots) return { ok: true, path: viaRoots };

    let abs = null;
    try {
        const candidate = fs.realpathSync(path.resolve(String(rawPath)));
        if (fs.statSync(candidate).isFile()) abs = candidate;
    } catch (e) { /* not on disk */ }

    if (!abs) {
        return {
            ok: false,
            code: 'missing_file',
            message: `No file exists at: ${rawPath} — it was moved, renamed, or deleted after the link was created (or the path was wrong from the start). Ask the agent to recreate and re-share the file.`
        };
    }
    if (registry && typeof registry.isRegistered === 'function' && registry.isRegistered(rawPath)) {
        return { ok: true, path: abs };
    }
    return {
        ok: false,
        code: 'not_registered',
        message: `The file exists (${abs}) but Agent Smith has no record of creating or sharing it, so the download is blocked by the arbitrary-host-file protection. Ask the agent to share it again with the provide_file_download_link tool — a fresh link will be registered.`
    };
}

module.exports = { createDownloadRegistry, resolveServablePath, explainDownloadRefusal };
