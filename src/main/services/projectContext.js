const path = require('path');
const fs = require('fs');
const os = require('os');

function expandTilde(filepath) {
    if (!filepath) return filepath;
    if (filepath.startsWith('~/')) {
        return path.join(os.homedir(), filepath.slice(2));
    }
    return filepath;
}

class ProjectContext {
    constructor() {
        this.projectRoot = null;
        this.planId = null;
    }

    setPlanId(planId) {
        this.planId = planId;
    }

    getRoot() {
        return this.projectRoot || process.cwd();
    }

    getRootOrNull() {
        return this.projectRoot;
    }

    setRoot(rootPath) {
        if (!rootPath) return { error: 'Empty path' };
        const resolved = path.resolve(expandTilde(rootPath));
        if (!fs.existsSync(resolved)) {
            return { error: `Path does not exist: ${resolved}` };
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            return { error: `Not a directory: ${resolved}` };
        }
        this.projectRoot = resolved;
        return { success: true, projectRoot: resolved };
    }

    clear() {
        this.projectRoot = null;
        this.planId = null;
    }

    /** Walk upward from *startDir* to find a directory containing a project marker file. */
    resolveBestProjectRoot(startDir) {
        let dir = path.resolve(expandTilde(startDir));
        if (!fs.existsSync(dir)) return dir;
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) dir = path.dirname(dir);

        const MARKERS = ['pyproject.toml', 'package.json', 'setup.py', 'setup.cfg', 'go.mod', 'Cargo.toml', 'pom.xml'];
        let current = dir;
        while (current) {
            for (const marker of MARKERS) {
                if (fs.existsSync(path.join(current, marker))) return current;
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return dir;
    }

    /** True when *child* is a strict subdirectory of *parent* (both resolved). */
    isSubdirectoryOf(child, parent) {
        const rel = path.relative(path.resolve(parent), path.resolve(child));
        return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    /** Parse absolute or relative dir from user goal text */
    parsePathFromText(text) {
        if (!text) return null;

        // Quoted paths (handles spaces on Windows)
        const quoted = text.match(/["']([A-Za-z]:[^"']+|\/[^"']+)["']/);
        if (quoted) {
            const p = quoted[1].replace(/[.,;:!?]+$/, '');
            if (fs.existsSync(p)) {
                const st = fs.statSync(p);
                return st.isDirectory() ? p : path.dirname(p);
            }
        }

        // Windows: extend from each drive letter to the longest existing path
        let best = null;
        const winDrive = /[A-Za-z]:[\\\/]/g;
        let m;
        while ((m = winDrive.exec(text)) !== null) {
            let end = m.index + 2;
            while (end < text.length) {
                const c = text[end];
                if (/[\\\/A-Za-z0-9._\- ()]/.test(c)) end++;
                else break;
            }
            const p = text.slice(m.index, end).trim().replace(/[.,;:!?]+$/, '');
            if (fs.existsSync(p)) {
                const st = fs.statSync(p);
                const dir = st.isDirectory() ? p : path.dirname(p);
                if (!best || dir.length > best.length) best = dir;
            }
        }
        if (best) return best;

        const winAbs = text.match(/[A-Za-z]:[\\\/][^\s"',<>|]+/);
        if (winAbs) {
            const p = winAbs[0].replace(/[.,;:!?]+$/, '');
            if (fs.existsSync(p)) {
                const st = fs.statSync(p);
                return st.isDirectory() ? p : path.dirname(p);
            }
        }
        const unixAbs = text.match(/(?:^|\s)(\/[^\s"',<>|]+)/);
        if (unixAbs) {
            const p = unixAbs[1].replace(/[.,;:!?]+$/, '');
            if (fs.existsSync(p)) {
                const st = fs.statSync(p);
                return st.isDirectory() ? p : path.dirname(p);
            }
        }
        const rel = text.match(/(?:^|\s)(\.\/[^\s"',<>|]+)/);
        if (rel) {
            const p = path.resolve(process.cwd(), rel[1].replace(/[.,;:!?]+$/, ''));
            if (fs.existsSync(p)) {
                const st = fs.statSync(p);
                return st.isDirectory() ? p : path.dirname(p);
            }
        }
        return null;
    }

    /** Infer project root from first file operation */
    establishFromFilePath(filePath) {
        const expanded = expandTilde(filePath);
        const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.normalize(path.join(process.cwd(), expanded));
        let dir = abs;
        if (fs.existsSync(abs)) {
            const st = fs.statSync(abs);
            dir = st.isDirectory() ? abs : path.dirname(abs);
        } else {
            dir = path.dirname(abs);
        }
        if (!this.projectRoot) {
            this.projectRoot = dir;
            return { established: true, projectRoot: dir };
        }
        return { established: false, projectRoot: this.projectRoot };
    }

    resolvePath(inputPath, options = {}) {
        const { allowOutsideBeforeRoot = false } = options;
        if (!inputPath) return { error: 'Empty path' };
        const expanded = expandTilde(String(inputPath).trim());
        const root = this.getRoot();

        let resolved;
        if (path.isAbsolute(expanded)) {
            resolved = path.normalize(expanded);
        } else {
            resolved = path.normalize(path.join(root, expanded));
        }

        if (this.projectRoot) {
            // Containment applies to BOTH relative and absolute inputs. A normalized
            // path is inside the root iff path.relative(root, resolved) is neither ''
            // -prefixed with '..' nor itself absolute (cross-drive on Windows).
            if (!options.allowOutsideRoot) {
                const rel = path.relative(this.projectRoot, resolved);
                const escapes = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
                if (escapes) {
                    const rootBase = path.basename(this.projectRoot);
                    const tail = path.basename(String(inputPath));
                    return { error:
                        `Path "${inputPath}" is outside the project root (${this.projectRoot}). ` +
                        `Do NOT use absolute paths or guess folder names — use a path RELATIVE to project root. ` +
                        `Example: write_file path="${tail || 'index.html'}" (resolves under ${rootBase}/). ` +
                        `Retry immediately with the relative path; do not stop or narrate this error.`
                    };
                }
                // Symlink-safe containment: a path that is lexically inside the root can still
                // point OUTSIDE it through a symlink (the link's name sits inside; its target
                // does not). Resolve the real path of the deepest existing ancestor and verify
                // the real target is still within the real root. This is the hard boundary —
                // the lexical check above only stops `..`/absolute inputs.
                const realEscape = this._resolvesOutsideRealRoot(resolved);
                if (realEscape) {
                    return { error:
                        `Path "${inputPath}" resolves outside the project root via a symlink (real target: ${realEscape}). ` +
                        `Refusing to read/write outside ${this.projectRoot}. Use a real path inside the project.`
                    };
                }
            }
        } else if (!allowOutsideBeforeRoot && path.isAbsolute(expanded)) {
            // Before root is set, allow absolute paths only if they exist (for discovery)
            if (!fs.existsSync(resolved)) {
                return { error: `Path not found: ${resolved}` };
            }
        }

        return { path: resolved };
    }

    /**
     * @returns {string|null} the real target path if `resolved` (following symlinks) lands
     * outside the real project root, else null. Probes the deepest existing ancestor so it
     * works for not-yet-created files (we follow links on the directory that will hold them).
     */
    _resolvesOutsideRealRoot(resolved) {
        if (!this.projectRoot) return null;
        try {
            const realRoot = fs.realpathSync(this.projectRoot);
            let probe = resolved;
            // walk up to the deepest path component that actually exists on disk
            while (!fs.existsSync(probe)) {
                const parent = path.dirname(probe);
                if (parent === probe) return null; // reached filesystem root without finding one
                probe = parent;
            }
            const realProbe = fs.realpathSync(probe);
            if (realProbe === realRoot) return null;
            const relReal = path.relative(realRoot, realProbe);
            const escapes = relReal === '..' || relReal.startsWith('..' + path.sep) || path.isAbsolute(relReal);
            return escapes ? realProbe : null;
        } catch (e) {
            return null; // realpath failure: fall back to the lexical decision already made
        }
    }

    isWindows() {
        return process.platform === 'win32';
    }

    getShellConfig() {
        if (this.isWindows()) {
            return { shell: 'powershell.exe', flag: '-NoProfile', commandFlag: '-Command' };
        }
        // /bin/sh, not bash: bash is absent on Alpine/slim Docker/minimal Linux, where a
        // background spawn('bash', …) fails. The foreground path (exec) also defaults to sh.
        return { shell: '/bin/sh', flag: '-c', commandFlag: null };
    }

    async listProjectTree(maxDepth = 2) {
        const root = this.getRoot();
        const lines = [];
        const IGNORE = new Set([
            'node_modules', 'dist', 'build', 'out', '.git', '.svn',
            '__pycache__', 'venv', '.venv', 'target', '.next', '.nuxt',
            '.cache', 'coverage', '.idea', '.vscode', 'vendor'
        ]);

        function walk(dir, depth, prefix) {
            if (depth > maxDepth) return;
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (e) {
                lines.push(`${prefix}[error: ${e.message}]`);
                return;
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const ent of entries) {
                if (ent.name.startsWith('.') && ent.name !== '.env') continue;
                if (IGNORE.has(ent.name)) {
                    if (ent.isDirectory()) lines.push(`${prefix}[SKIP] ${ent.name}/ (not listed)`);
                    continue;
                }
                const rel = path.relative(root, path.join(dir, ent.name));
                lines.push(`${prefix}${ent.isDirectory() ? '[DIR] ' : '[FILE]'}${rel || ent.name}`);
                if (ent.isDirectory() && depth < maxDepth) {
                    walk(path.join(dir, ent.name), depth + 1, prefix + '  ');
                }
            }
        }

        lines.push(`[ROOT] ${root}`);
        walk(root, 0, '');
        return lines.join('\n');
    }
}

module.exports = new ProjectContext();
