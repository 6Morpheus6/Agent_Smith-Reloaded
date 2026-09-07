const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { applySearchReplace, applyPatchToFile } = require('../../shared/editFormats.js');

function normalizeWhitespace(str) {
    return str.replace(/\s+/g, ' ');
}

function findClosestRegions(content, find, count = 3) {
    const lines = content.split('\n');
    const findNorm = normalizeWhitespace(find).trim();
    const regions = [];

    for (let i = 0; i < lines.length; i++) {
        const windowSize = Math.min(5, lines.length - i);
        const chunk = lines.slice(i, i + windowSize).join('\n');
        const chunkNorm = normalizeWhitespace(chunk);
        let score = 0;
        if (chunkNorm.includes(findNorm)) score = 1;
        else {
            const findWords = findNorm.split(' ').filter(Boolean);
            const matched = findWords.filter(w => chunkNorm.includes(w)).length;
            score = findWords.length ? matched / findWords.length : 0;
        }
        if (score > 0.2) {
            regions.push({ line: i + 1, score, preview: chunk.substring(0, 200) });
        }
    }

    regions.sort((a, b) => b.score - a.score);
    return regions.slice(0, count);
}

class EditEngine {
    constructor(ledger, projectContext) {
        this.ledger = ledger;
        this.projectContext = projectContext;
        this.MAX_WRITE_FILE_CHARS = 65536;
    }

    async apply(planId, filePath, find, replace, opts = {}) {
        if (opts.dryRun) {
            const resolved = this.projectContext.resolvePath(filePath);
            if (resolved.error) return { error: resolved.error };
            let content;
            try {
                content = await fsPromises.readFile(resolved.path, 'utf-8');
            } catch (e) {
                return { error: e.message };
            }
            const preview = applySearchReplace(content, find, replace, { replaceAll: opts.replaceAll });
            if (preview.error) return preview;
            return { dryRun: true, ok: true };
        }

        const resolved = this.projectContext.resolvePath(filePath);
        if (resolved.error) return { error: resolved.error };
        const absPath = resolved.path;

        let content;
        try {
            content = await fsPromises.readFile(absPath, 'utf-8');
        } catch (e) {
            return { error: `Cannot read file: ${e.message}` };
        }

        // Normalize line endings + BOM for matching so an LF find-block matches a
        // CRLF file (the Windows norm), then RESTORE the file's original EOL/BOM on
        // write. Previously the tolerant path silently rewrote CRLF→LF every edit.
        const hasBOM = content.charCodeAt(0) === 0xFEFF;
        const body = hasBOM ? content.slice(1) : content;
        const crlfCount = (body.match(/\r\n/g) || []).length;
        const totalLf = (body.match(/\n/g) || []).length;
        const isCRLF = crlfCount > 0 && crlfCount >= (totalLf - crlfCount);
        const lfBody = body.replace(/\r\n/g, '\n');
        const lfFind = String(find).replace(/\r\n/g, '\n');
        const lfReplace = String(replace).replace(/\r\n/g, '\n');

        const result = applySearchReplace(lfBody, lfFind, lfReplace, { replaceAll: opts.replaceAll });
        if (result.error) {
            const closest = findClosestRegions(lfBody, lfFind);
            return {
                error: result.error,
                matchCount: result.matchCount,
                closest: closest.map(r => `Line ${r.line}: ${r.preview.replace(/\n/g, ' ')}`)
            };
        }

        let outBody = result.content;
        if (isCRLF) outBody = outBody.replace(/\n/g, '\r\n');
        const finalContent = (hasBOM ? String.fromCharCode(0xFEFF) : '') + outBody;

        const snap = await this.ledger.snapshotBefore(planId, absPath, 'edit');
        if (snap && snap.error) return { error: `Refusing to edit — could not snapshot the existing file for Revert All: ${snap.error}` };
        await fsPromises.writeFile(absPath, finalContent, 'utf-8');
        this.projectContext.establishFromFilePath(absPath);
        const relPath = path.relative(this.projectContext.getRoot(), absPath).replace(/\\/g, '/');
        const diffMeta = this.ledger.buildFileDiffResult(lfBody, outBody, relPath);
        return {
            success: true,
            path: absPath,
            relPath,
            note: result.note,
            fileDiff: diffMeta.fileDiff,
            linesAdded: diffMeta.linesAdded,
            linesRemoved: diffMeta.linesRemoved
        };
    }

    async applyPatch(planId, filePath, patchText, opts = {}) {
        const resolved = this.projectContext.resolvePath(filePath);
        if (resolved.error) return { error: resolved.error };
        const absPath = resolved.path;
        let content;
        let existed = true;
        try {
            content = await fsPromises.readFile(absPath, 'utf-8');
        } catch (e) {
            if (!opts.allowCreate) return { error: e.message };
            content = '';
            existed = false;
        }
        // Normalize line endings + BOM for matching so an LF unified diff matches a
        // CRLF file (the Windows norm), then RESTORE the file's original EOL/BOM on
        // write — mirrors apply(). Without this, apply_patch silently fails to match
        // every context line on CRLF files (the diff sees "code", the file has "code\r").
        const hasBOM = content.charCodeAt(0) === 0xFEFF;
        const body = hasBOM ? content.slice(1) : content;
        const crlfCount = (body.match(/\r\n/g) || []).length;
        const totalLf = (body.match(/\n/g) || []).length;
        const isCRLF = crlfCount > 0 && crlfCount >= (totalLf - crlfCount);
        const lfBody = body.replace(/\r\n/g, '\n');
        const lfPatch = String(patchText).replace(/\r\n/g, '\n');

        const patched = applyPatchToFile(lfBody, lfPatch, { expectedPath: filePath });
        if (patched.error) return patched;
        if (!opts.dryRun) {
            let outBody = patched.content;
            if (isCRLF) outBody = outBody.replace(/\n/g, '\r\n');
            const finalContent = (hasBOM ? String.fromCharCode(0xFEFF) : '') + outBody;
            if (existed) {
                const snap = await this.ledger.snapshotBefore(planId, absPath, 'edit');
                if (snap && snap.error) return { error: `Refusing to patch — could not snapshot the existing file for Revert All: ${snap.error}` };
            } else await this.ledger.recordCreate(planId, absPath);
            await fsPromises.writeFile(absPath, finalContent, 'utf-8');
            this.projectContext.establishFromFilePath(absPath);
        }
        return { success: true, path: absPath };
    }

    async applyBatch(planId, edits, opts = {}) {
        const results = [];
        for (const ed of edits) {
            const r = await this.apply(planId, ed.filepath || ed.path, ed.find, ed.replace, opts);
            results.push({ ...ed, result: r });
            if (r.error && !opts.continueOnError) break;
        }
        const failed = results.filter(r => r.result.error);
        return { success: failed.length === 0, results };
    }

    validateWriteSize(content) {
        if (content && content.length > this.MAX_WRITE_FILE_CHARS) {
            return {
                error: `write_file limited to ${this.MAX_WRITE_FILE_CHARS} chars. Use edit_file or apply_patch for larger changes.`,
                tooLarge: true
            };
        }
        return { ok: true };
    }
}

module.exports = EditEngine;
