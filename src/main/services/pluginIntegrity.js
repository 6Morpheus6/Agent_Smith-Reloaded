/**
 * Plugin integrity hashing. Enabling a plugin records a content hash ("trust on first
 * enable"); on every later discover the hash is recomputed and a mismatch quarantines
 * the plugin until the user re-enables it. This turns silent post-install tampering or an
 * auto-pulled update into an explicit re-consent step.
 *
 * This is NOT code signing (no author identity) and NOT a sandbox — it is tamper-evidence
 * for the trusted-code model: "the bytes you approved are the bytes that run".
 *
 * Pure-ish: fs/path are injectable for tests.
 */
'use strict';

const crypto = require('crypto');

// Hash every file reachable from the plugin root. Runtime assets in dist/build/
// node_modules/ are part of the trusted surface because plugin code can read them.
const IGNORE_DIRS = new Set();

function walk(dir, fs, path, base, out) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (IGNORE_DIRS.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        const rel = path.relative(base, abs).replace(/\\/g, '/');
        if (e.isDirectory()) {
            walk(abs, fs, path, base, out);
        } else {
            // Hash EVERY file under the plugin dir (not just .js/.json). A plugin can
            // read templates, prompts, binaries, WASM, certificates, or data files at
            // runtime; changing those after trust-on-enable must change the hash.
            out.push({ rel, abs });
        }
    }
}

/**
 * Deterministic sha256 over every file under the plugin dir (sorted by relative
 * path; content + path included so a rename also changes the hash). Throws if any
 * file cannot be read — a transient permissions/IO error must not produce a
 * deterministic hash that gets trusted (the previous empty-string fallback could).
 */
function hashPluginDir(dir, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const files = [];
    walk(dir, fs, path, dir, files);
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    const h = crypto.createHash('sha256');
    for (const f of files) {
        let content;
        try {
            content = fs.readFileSync(f.abs);
        } catch (e) {
            // Fail closed: an unreadable file must not hash as empty content. Either a
            // transient IO error would trust the wrong content set, or a malicious local
            // actor could make a file unreadable during re-enable to trust a stale hash.
            throw new Error(`cannot read plugin file for hashing: ${f.rel} (${e.message})`);
        }
        h.update(f.rel);
        h.update('\0');
        h.update(content);
        h.update('\0');
    }
    return h.digest('hex');
}

module.exports = { hashPluginDir, IGNORE_DIRS };
