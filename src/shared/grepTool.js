const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadIgnoreFile, isIgnored } = require('./ignoreFilter.js');

const MAX_HITS = 200;

function simpleGlobMatch(rel, pattern) {
    const re = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
    return re.test(rel);
}

function hasRipgrep() {
    try {
        execSync(process.platform === 'win32' ? 'where rg' : 'which rg', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

function grepWithRg(projectRoot, pattern, opts = {}) {
    return new Promise((resolve) => {
        const args = ['--json', '--max-count', String(opts.maxHits || MAX_HITS), '-e', pattern];
        if (opts.caseInsensitive) args.push('-i');
        if (opts.glob) args.push('--glob', opts.glob);
        const searchPath = opts.subpath ? path.join(projectRoot, opts.subpath) : projectRoot;
        args.push(searchPath);

        const child = spawn('rg', args, { cwd: projectRoot, shell: false });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', (code) => {
            const hits = [];
            for (const line of stdout.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const j = JSON.parse(line);
                    if (j.type === 'match' && j.data) {
                        const rel = path.relative(projectRoot, j.data.path.text).replace(/\\/g, '/');
                        hits.push({
                            file: rel,
                            line: j.data.line_number,
                            text: (j.data.lines && j.data.lines.text) || ''
                        });
                    }
                } catch (e) { /* skip */ }
            }
            resolve({ hits, backend: 'rg', truncated: hits.length >= MAX_HITS, stderr: stderr || null });
        });
        child.on('error', () => resolve({ error: 'rg failed to start', hits: [] }));
    });
}

function grepNode(projectRoot, pattern, opts = {}) {
    const ig = loadIgnoreFile(projectRoot);
    const re = new RegExp(pattern, opts.caseInsensitive ? 'i' : '');
    const hits = [];
    const searchRoot = opts.subpath ? path.join(projectRoot, opts.subpath) : projectRoot;

    function walk(dir) {
        if (hits.length >= MAX_HITS) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const ent of entries) {
            if (hits.length >= MAX_HITS) break;
            const abs = path.join(dir, ent.name);
            const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
            if (isIgnored(ig, rel)) continue;
            if (ent.isDirectory()) {
                walk(abs);
            } else if (ent.isFile() && ent.name.length < 200) {
                if (opts.glob && !simpleGlobMatch(rel, opts.glob)) continue;
                try {
                    const stat = fs.statSync(abs);
                    if (stat.size > 512 * 1024) continue;
                    const content = fs.readFileSync(abs, 'utf-8');
                    const lines = content.split('\n');
                    lines.forEach((text, i) => {
                        if (hits.length >= MAX_HITS) return;
                        if (re.test(text)) {
                            hits.push({ file: rel, line: i + 1, text: text.slice(0, 300) });
                        }
                    });
                } catch (e) { /* binary or unreadable */ }
            }
        }
    }

    walk(searchRoot);
    return { hits, backend: 'node', truncated: hits.length >= MAX_HITS };
}

async function grepProject(projectRoot, pattern, opts = {}) {
    if (!pattern || !projectRoot) return { error: 'pattern and projectRoot required', hits: [] };
    if (hasRipgrep()) {
        const res = await grepWithRg(projectRoot, pattern, opts);
        if (!res.error) return res;
    }
    return grepNode(projectRoot, pattern, opts);
}

module.exports = { grepProject, hasRipgrep, MAX_HITS };
