/**
 * Bounded recursive project file search. Several Code Mode checks (required-artifact existence,
 * index.html discovery, partial-build / plan-step scans) only looked at the project root + one
 * level of subdirectories, so a deliverable at e.g. src/js/app.js or apps/web/index.html was
 * reported missing — a false [ARTIFACT] block or a spurious recovery nudge. This walks a few
 * levels deep (breadth-first, so the shallowest match wins) while skipping vendor/build dirs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IGNORE = new Set([
    'node_modules', 'dist', 'build', '.git', '.agentsmith', 'release', 'coverage',
    '.cache', 'out', '.next', '.nuxt', 'vendor', 'tmp', '.venv', 'venv', '__pycache__', 'target'
]);

/** @returns {string|null} project-relative path of the shallowest file named `basename`, or null. */
function findFileDeep(root, basename, maxDepth = 4) {
    const target = String(basename || '').toLowerCase();
    if (!root || !target) return null;
    const queue = [{ dir: root, depth: 0, rel: '' }];
    while (queue.length) {
        const { dir, depth, rel } = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase() === target) {
                return rel ? `${rel}/${e.name}` : e.name;
            }
        }
        if (depth < maxDepth) {
            for (const e of entries) {
                if (e.isDirectory() && !e.name.startsWith('.') && !IGNORE.has(e.name)) {
                    queue.push({ dir: path.join(dir, e.name), depth: depth + 1, rel: rel ? `${rel}/${e.name}` : e.name });
                }
            }
        }
    }
    return null;
}

/** True if a non-empty file named `basename` exists within `maxDepth` levels. */
function fileExistsDeep(root, basename, maxDepth = 4) {
    const rel = findFileDeep(root, basename, maxDepth);
    return !!rel;
}

function findIndexHtmlDeep(root, maxDepth = 4) {
    return findFileDeep(root, 'index.html', maxDepth);
}

/**
 * Snapshot of every file present under `root` at run start, with a content hash for files
 * small enough to hash. The plan-step auto-advance must only credit work THIS run produced —
 * a project that already contains index.html/style.css/script.js from an earlier attempt
 * would otherwise have every "create" step marked done instantly without the model writing a
 * single line (the v52.4 "planner marks everything done and stalls" bug). Hashes let callers
 * tell "file existed before AND is unchanged" (not evidence) from "created or modified this
 * run" (evidence), which also gates content-based feature checks. Returns null when `root`
 * is falsy and an empty snapshot for a missing path, so callers can't accidentally treat
 * "no snapshot" as "everything pre-existed".
 */
function snapshotExistingFiles(root, maxDepth = 6) {
    if (!root) return null;
    const files = new Set();
    const hashes = new Map(); // relLower -> sha1 (files <= MAX_HASH_BYTES only)
    const MAX_HASH_BYTES = 2 * 1024 * 1024;
    const MAX_FILES = 5000;
    let counted = 0;
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length && counted < MAX_FILES) {
        const { dir, depth } = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of entries) {
            if (counted >= MAX_FILES) break;
            const abs = path.join(dir, e.name);
            if (e.isFile()) {
                counted++;
                const rel = path.relative(root, abs).replace(/\\/g, '/').toLowerCase();
                files.add(rel);
                try {
                    const st = fs.statSync(abs);
                    if (st.size <= MAX_HASH_BYTES) hashes.set(rel, crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'));
                } catch (_) { /* unhashable — existence still recorded */ }
            } else if (depth < maxDepth && !e.name.startsWith('.') && !IGNORE.has(e.name)) {
                queue.push({ dir: abs, depth: depth + 1 });
            }
        }
    }
    return { files, hashes };
}

module.exports = { findFileDeep, fileExistsDeep, findIndexHtmlDeep, snapshotExistingFiles, SCAN_IGNORE: IGNORE };
