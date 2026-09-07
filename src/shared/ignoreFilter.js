const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

const DEFAULT_IGNORE = [
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    '.venv', 'venv', 'target', '.xkaliber', 'coverage', '.cache'
];

function loadIgnoreFile(projectRoot) {
    const ig = ignore().add(DEFAULT_IGNORE);
    const filePath = path.join(projectRoot, '.xkaliberignore');
    try {
        if (fs.existsSync(filePath)) {
            const body = fs.readFileSync(filePath, 'utf-8');
            ig.add(body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
        }
    } catch (e) { /* ignore */ }
    return ig;
}

function isIgnored(ig, relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    return ig.ignores(normalized) || ig.ignores(normalized + '/');
}

module.exports = { loadIgnoreFile, isIgnored, DEFAULT_IGNORE };
