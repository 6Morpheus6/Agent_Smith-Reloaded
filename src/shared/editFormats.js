/**
 * Parse and apply structured edit formats (search/replace blocks, unified diff hunks).
 */

function applySearchReplace(content, find, replace, opts = {}) {
    const replaceAll = !!opts.replaceAll;
    if (content.includes(find)) {
        const n = content.split(find).length - 1;
        if (n > 1) {
            if (replaceAll) {
                return { content: content.split(find).join(replace), note: `exact ×${n}`, replacedCount: n };
            }
            return {
                error: `Multiple exact matches (${n}). To replace every occurrence set replace_all:true. ` +
                    `To replace just one, add surrounding context to the find block so it is unique. ` +
                    `To rebuild the whole file cleanly, use write_file.`,
                matchCount: n
            };
        }
        return { content: content.replace(find, replace), note: 'exact' };
    }
    const findNorm = find.replace(/\s+/g, ' ').trim();
    const lines = content.split('\n');
    // Window the tolerant scan to the find block's own line span (plus margin) so a
    // multi-line find of >40 lines can still match — the old fixed 40-line cap made
    // large find blocks impossible to locate.
    const findLineSpan = find.split('\n').length;
    const window = Math.max(40, findLineSpan + 4);
    // Collect every whitespace-tolerant match. If more than one distinct region
    // matches, refuse rather than silently editing the first (which may be wrong) —
    // same safety contract as the exact-match path above.
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
        for (let j = i; j < Math.min(i + window, lines.length); j++) {
            const chunk = lines.slice(i, j + 1).join('\n');
            if (chunk.replace(/\s+/g, ' ').trim() === findNorm) {
                matches.push({ i, j });
                break; // shortest window at this start position
            }
        }
    }
    if (matches.length > 1) {
        if (replaceAll) {
            // Replace every region, from last to first so earlier indices stay valid.
            let outLines = lines.slice();
            for (let m = matches.length - 1; m >= 0; m--) {
                const { i, j } = matches[m];
                outLines = outLines.slice(0, i).concat(replace.split('\n'), outLines.slice(j + 1));
            }
            return { content: outLines.join('\n'), note: `whitespace-tolerant ×${matches.length}`, replacedCount: matches.length };
        }
        return { error: `Multiple whitespace-tolerant matches (${matches.length}). Set replace_all:true to replace all, add surrounding context to target one, or use write_file to rebuild the file.`, matchCount: matches.length };
    }
    if (matches.length === 1) {
        const { i, j } = matches[0];
        const before = lines.slice(0, i).join('\n');
        const after = lines.slice(j + 1).join('\n');
        const prefix = before.length ? before + '\n' : '';
        const suffix = after.length ? '\n' + after : '';
        return { content: prefix + replace + suffix, note: 'whitespace-tolerant' };
    }
    return { error: 'No match for the `find` text. Re-read the file with read_file (the content or whitespace may differ from what you expected), then regenerate the patch with an exact snippet — or use write_file to replace the whole file.' };
}

function parseUnifiedDiff(patchText) {
    const files = [];
    const lines = patchText.split('\n');
    let i = 0;
    while (i < lines.length) {
        if (lines[i].startsWith('--- ') || lines[i].startsWith('+++ ')) {
            const oldPath = lines[i].startsWith('--- ') ? lines[i].slice(4).replace(/^a\//, '').trim() : null;
            i++;
            const newPath = lines[i] && lines[i].startsWith('+++ ') ? lines[i].slice(4).replace(/^b\//, '').trim() : oldPath;
            i++;
            const hunks = [];
            while (i < lines.length && !lines[i].startsWith('--- ')) {
                if (lines[i].startsWith('@@')) {
                    // Capture the old-file start line so the applier can anchor an
                    // ambiguous (repeated) context/delete line to the intended occurrence.
                    const hdr = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                    const oldStart = hdr ? parseInt(hdr[1], 10) : null;
                    const hunkLines = [];
                    i++;
                    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
                        hunkLines.push(lines[i]);
                        i++;
                    }
                    hunks.push({ oldStart, lines: hunkLines });
                } else {
                    i++;
                }
            }
            const target = (newPath && newPath !== '/dev/null') ? newPath : oldPath;
            if (target && target !== '/dev/null') files.push({ path: target.replace(/\\/g, '/'), hunks });
        } else {
            i++;
        }
    }
    return files;
}

function applyUnifiedDiff(original, hunks) {
    let lines = original.split('\n');
    for (const hunk of hunks) {
        // Back-compat: accept either a bare array of hunk lines or {oldStart, lines}.
        const hunkLines = Array.isArray(hunk) ? hunk : hunk.lines;
        const oldStart = Array.isArray(hunk) ? null : hunk.oldStart;

        // Position the hunk: find the first context/delete line and prefer the
        // occurrence at/after the diff's line-number hint, so a repeated anchor line
        // resolves to the intended site instead of the first match in the file.
        let base = 0;
        const firstAnchor = hunkLines.find(hl => hl && (hl[0] === ' ' || hl[0] === '-'));
        if (oldStart && firstAnchor) {
            const anchorText = firstAnchor.slice(1);
            let p = -1;
            for (let k = Math.max(0, oldStart - 1); k < lines.length; k++) {
                if (lines[k] === anchorText) { p = k; break; }
            }
            if (p === -1) {
                for (let k = 0; k < lines.length; k++) { if (lines[k] === anchorText) { p = k; break; } }
            }
            if (p !== -1) base = p;
        }

        const newLines = lines.slice(0, base);
        let idx = base;
        // Buffer for '+' lines emitted before the first anchor (context/'-') line is
        // located, so a leading insertion lands at the anchor rather than file top.
        let pendingAdds = [];
        let anchored = false;
        const flushPending = () => {
            if (pendingAdds.length) { newLines.push(...pendingAdds); pendingAdds = []; }
        };
        for (const hl of hunkLines) {
            if (!hl.length) continue;
            const tag = hl[0];
            const text = hl.slice(1);
            if (tag === ' ' || tag === '-') {
                // Copy through unchanged lines until we reach the anchor line.
                // CRITICAL: preserve the skipped lines (previously dropped → data loss).
                while (idx < lines.length && lines[idx] !== text) newLines.push(lines[idx++]);
                // FAIL LOUD: if the context/delete line isn't found, the patch doesn't
                // match the file. Previously the loop ran off EOF and silently corrupted
                // the file while still reporting success — throw so the model re-reads.
                if (idx >= lines.length) {
                    throw new Error(`Patch context line not found: "${text}". The file differs from the patch — re-read it and regenerate the patch.`);
                }
                anchored = true;
                flushPending();
                if (tag === ' ') newLines.push(lines[idx]); // keep context line
                idx++; // for '-' this skips (deletes) the matched line
            } else if (tag === '+') {
                if (anchored) newLines.push(text);
                else pendingAdds.push(text); // hold until anchored
            }
        }
        flushPending();
        while (idx < lines.length) newLines.push(lines[idx++]);
        lines = newLines;
    }
    return lines.join('\n');
}

function applyPatchToFile(original, patchText, opts = {}) {
    const parsed = parseUnifiedDiff(patchText);
    if (!parsed.length) return { error: 'No files in patch' };
    // Reject multi-file patches when applied through the single-file applyPatch
    // entrypoint. Previously this silently applied only parsed[0] and dropped every
    // later file hunk while reporting success — a multi-file patch could also apply
    // the first file's hunks to a DIFFERENT caller-supplied filepath. Now: refuse
    // multi-file patches and verify the parsed path matches the expected target.
    if (parsed.length > 1 && !opts.allowMultiFile) {
        return { error: `Patch contains ${parsed.length} files; apply_patch operates on a single file. Apply each file's hunks separately, or use write_file.` };
    }
    const file = parsed[0];
    if (opts.expectedPath) {
        const expected = String(opts.expectedPath).replace(/\\/g, '/');
        const parsedPath = String(file.path).replace(/\\/g, '/');
        // Compare the basename + tail so a/ prefixes and absolute vs relative forms match.
        const norm = (p) => p.replace(/^a\//, '').replace(/^b\//, '').replace(/^\.\//, '');
        if (norm(parsedPath) !== norm(expected) && !norm(expected).endsWith('/' + norm(parsedPath)) && !norm(parsedPath).endsWith('/' + norm(expected))) {
            return { error: `Patch target "${file.path}" does not match the file being edited ("${opts.expectedPath}"). Re-read the file and regenerate the patch.` };
        }
    }
    try {
        const content = applyUnifiedDiff(original, file.hunks);
        return { content, path: file.path };
    } catch (e) {
        return { error: e.message };
    }
}

module.exports = {
    applySearchReplace,
    parseUnifiedDiff,
    applyUnifiedDiff,
    applyPatchToFile
};
