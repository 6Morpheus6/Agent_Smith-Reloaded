const path = require('path');
const fg = require('fast-glob');
const { loadIgnoreFile, isIgnored } = require('./ignoreFilter.js');

const MAX_RESULTS = 500;

async function globFiles(projectRoot, pattern, opts = {}) {
    if (!projectRoot) return { error: 'projectRoot required', files: [] };
    const cwd = opts.subpath ? path.join(projectRoot, opts.subpath) : projectRoot;
    const ig = loadIgnoreFile(projectRoot);

    try {
        const raw = await fg(pattern || '**/*', {
            cwd,
            onlyFiles: opts.onlyFiles !== false,
            dot: false,
            absolute: false,
            suppressErrors: true
        });
        const files = [];
        for (const f of raw) {
            if (files.length >= MAX_RESULTS) break;
            const rel = path.relative(projectRoot, path.join(cwd, f)).replace(/\\/g, '/');
            if (!isIgnored(ig, rel)) files.push(rel);
        }
        return { files, truncated: raw.length >= MAX_RESULTS };
    } catch (e) {
        return { error: e.message, files: [] };
    }
}

module.exports = { globFiles, MAX_RESULTS };
