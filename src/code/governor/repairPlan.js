'use strict';

// Shared "repair plan" for blocked-write recovery. When the model tries to rewrite a working
// index.html while its linked assets are missing or broken, the harness blocks the rewrite and
// hands back a STRUCTURED plan instead of a single forced path: CREATE each missing file, FIX
// each existing-but-wrong file (e.g. a .css that contains HTML), with complete paths and the
// right tool. Used by both the block message (missingRefGuard) and the next-turn nudge
// (artifactHints) so the two are consistent. Depends only on fs/path/webValidators — no cycles.

const fs = require('fs');
const path = require('path');
const wv = require('./webValidators.js');

function typeName(rel) {
    if (/\.css$/i.test(rel)) return 'CSS';
    if (/\.(js|mjs|cjs)$/i.test(rel)) return 'JavaScript';
    return 'code';
}

/** Does this file's content look like HTML when it should be CSS/JS? (the "bad css" case). */
function contentLooksLikeHtml(content, rel) {
    const c = String(content || '').trimStart();
    if (/^<!doctype\s+html|^<html[\s>]/i.test(c)) return true; // a whole HTML doc dumped into the file
    if (/\.css$/i.test(rel)) {
        return /<!doctype/i.test(c)
            || /<\/?(div|span|button|script|link|p|h[1-6]|ul|ol|li|a|img|nav|header|footer|section|main|form|input|html|head|body)\b/i.test(c);
    }
    return false;
}

/** Linked local CSS/JS files that EXIST but contain HTML (need repair, not creation). */
function collectBadRefsFromHtml(projectRoot, htmlRel) {
    const bad = [];
    try {
        const htmlAbs = path.join(projectRoot, htmlRel);
        const html = fs.readFileSync(htmlAbs, 'utf8');
        const htmlDir = path.dirname(htmlAbs);
        const { scripts, styles } = wv.extractHtmlRefs(html);
        for (const ref of [...scripts, ...styles]) {
            if (/^https?:\/\//i.test(ref)) continue;
            const abs = path.resolve(htmlDir, ref.replace(/^\.\//, ''));
            if (!/\.(js|mjs|cjs|css)$/i.test(abs) || !fs.existsSync(abs)) continue;
            const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
            if (contentLooksLikeHtml(fs.readFileSync(abs, 'utf8'), rel)) bad.push(rel);
        }
    } catch (e) { /* non-fatal */ }
    return [...new Set(bad)];
}

/** Structured repair lines: CREATE each missing file, FIX each existing bad file. */
function buildRepairPlanLines(missing, bad) {
    const lines = [];
    for (const rel of [...new Set((missing || []).filter(Boolean))]) {
        lines.push(`  • CREATE ${rel} — write_file with the COMPLETE ${typeName(rel)} (no HTML).`);
    }
    for (const rel of [...new Set((bad || []).filter(Boolean))]) {
        lines.push(`  • FIX ${rel} — it currently contains HTML; replace it with ${typeName(rel)} only `
            + '(use patch for a small change, or write_file for a full rewrite).');
    }
    return lines;
}

/** Derive index.html's path from a referenced asset (assets are siblings of the HTML). */
function htmlRelForRefs(refs) {
    const first = (refs || []).find(Boolean);
    if (!first) return 'index.html';
    const dir = path.posix.dirname(String(first).replace(/\\/g, '/'));
    return dir && dir !== '.' ? `${dir}/index.html` : 'index.html';
}

module.exports = {
    typeName, contentLooksLikeHtml, collectBadRefsFromHtml, buildRepairPlanLines, htmlRelForRefs
};
