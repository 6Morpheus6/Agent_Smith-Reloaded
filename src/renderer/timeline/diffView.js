/**
 * Unified diff parse + DOM render (Matrix theme via CSS classes only).
 */
'use strict';

const MAX_DIFF_LINES = 200;

function parseDiffLines(diffText) {
    if (!diffText || typeof diffText !== 'string') return [];
    const lines = diffText.split('\n');
    const out = [];
    let file = null;

    for (const raw of lines) {
        if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
            if (raw.startsWith('+++ ')) file = raw.slice(4).trim();
            out.push({ kind: 'header', text: raw, file });
            continue;
        }
        if (raw.startsWith('+')) {
            out.push({ kind: 'add', text: raw.slice(1), file });
        } else if (raw.startsWith('-')) {
            out.push({ kind: 'del', text: raw.slice(1), file });
        } else if (raw.startsWith(' ')) {
            out.push({ kind: 'ctx', text: raw.slice(1), file });
        } else if (raw.length) {
            out.push({ kind: 'ctx', text: raw, file });
        }
    }
    return out;
}

function truncateDiffLines(lines, maxLines = MAX_DIFF_LINES) {
    if (lines.length <= maxLines) return { lines, truncated: false };
    return {
        lines: lines.slice(0, maxLines),
        truncated: true,
        omitted: lines.length - maxLines
    };
}

function buildDiffFromBeforeAfter(before, after, relPath) {
    const header = `--- a/${relPath}\n+++ b/${relPath}\n`;
    const bLines = (before || '').split('\n');
    const aLines = (after || '').split('\n');
    const body = [];
    const max = Math.max(bLines.length, aLines.length);
    let bi = 0;
    let ai = 0;
    while (bi < bLines.length || ai < aLines.length) {
        if (bi < bLines.length && ai < aLines.length && bLines[bi] === aLines[ai]) {
            body.push(` ${bLines[bi]}`);
            bi++;
            ai++;
        } else if (ai < aLines.length && (bi >= bLines.length || bLines[bi] !== aLines[ai])) {
            body.push(`+${aLines[ai]}`);
            ai++;
        } else if (bi < bLines.length) {
            body.push(`-${bLines[bi]}`);
            bi++;
        }
    }
    return header + body.join('\n');
}

function countDiffStats(lines) {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
        if (l.kind === 'add') added++;
        else if (l.kind === 'del') removed++;
    }
    return { added, removed };
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderDiffDom(diffText, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return null;

    const parsed = truncateDiffLines(parseDiffLines(diffText));
    const wrap = documentRef.createElement('div');
    wrap.className = 'activity-diff';

    const stats = countDiffStats(parsed.lines);
    const files = [...new Set(parsed.lines.filter(l => l.file).map(l => l.file))];
    if (files.length) {
        const fh = documentRef.createElement('div');
        fh.className = 'diff-file';
        fh.textContent = files[0];
        wrap.appendChild(fh);
    }

    const pre = documentRef.createElement('pre');
    pre.className = 'activity-diff-body';
    for (const line of parsed.lines) {
        if (line.kind === 'header') continue;
        const row = documentRef.createElement('div');
        row.className = `diff-line diff-line--${line.kind}`;
        const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        row.textContent = prefix + line.text;
        pre.appendChild(row);
    }
    wrap.appendChild(pre);

    if (parsed.truncated) {
        const note = documentRef.createElement('div');
        note.className = 'activity-diff-truncated';
        note.textContent = `…${parsed.omitted} more lines`;
        wrap.appendChild(note);
    }

    const meta = documentRef.createElement('div');
    meta.className = 'activity-diff-meta';
    meta.textContent = `+${stats.added} −${stats.removed}`;
    wrap.appendChild(meta);

    return wrap;
}

const api = {
    MAX_DIFF_LINES,
    parseDiffLines,
    truncateDiffLines,
    buildDiffFromBeforeAfter,
    countDiffStats,
    escapeHtml,
    renderDiffDom
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKDiffView = api;
