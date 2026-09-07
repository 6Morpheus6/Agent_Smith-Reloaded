/**
 * Plugin installer: fetch a plugin from a Git/URL into <userData>/plugins/<id>.
 *
 * Order of attack:
 *   1. Block-check the URL host via netGuard (no metadata/link-local/ULA pivots).
 *   2. If a `git` binary is present, `git clone --depth 1 <url> <staging>`.
 *      Else, for a GitHub URL, download the codeload tarball and extract with the
 *      system `tar` (present on Win10+/macOS/Linux).
 *   3. Find the dir containing plugin.json in the staging tree (top level or one
 *      level down — GitHub tarballs wrap everything in `<repo>-<ref>/`).
 *   4. Validate the manifest minimally, then move into plugins/<id>.
 *
 * Network/exec are dependency-injected so the staging→validate→install logic is
 * unit-testable without cloning anything.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

class PluginInstaller {
    constructor(pluginsDir, deps = {}) {
        this.fs = deps.fsImpl || require('fs');
        this.path = deps.pathImpl || require('path');
        this.os = deps.osImpl || require('os');
        this.netGuard = deps.netGuard || require('../../shared/netGuard.js');
        this.pluginsDir = pluginsDir;

        // Injected runners (production defaults below).
        this.hasGit = deps.hasGit != null ? deps.hasGit : this._detectGit(deps.execSyncImpl);
        this.runGit = deps.runGit || ((args, cwd) => this._spawn('git', args, cwd));
        this.runTar = deps.runTar || ((args, cwd) => this._spawn('tar', args, cwd));
        this.download = deps.download || ((url, dest) => this._httpsDownload(url, dest));
        this.log = deps.logger || ((m) => console.log(`[plugin-install] ${m}`));
    }

    _detectGit(execSyncImpl) {
        const execSync = execSyncImpl || require('child_process').execSync;
        try { execSync('git --version', { stdio: 'ignore' }); return true; } catch (e) { return false; }
    }

    _spawn(cmd, args, cwd) {
        const { spawnSync } = require('child_process');
        const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
        if (r.status !== 0) {
            throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim() || 'exit ' + r.status}`);
        }
        return r.stdout;
    }

    _httpsDownload(url, dest) {
        return new Promise((resolve, reject) => {
            const https = require('https');
            const file = this.fs.createWriteStream(dest);
            let settled = false;
            // Destroy/close the stream and unlink the partial destination on every
            // failure path. Previously an HTTP error, redirect overflow, validation
            // failure, or request error rejected without closing the stream — on
            // Windows the open descriptor could block the outer finally's rmSync and
            // leave temp data behind.
            const fail = (err) => {
                if (settled) return;
                settled = true;
                try { file.destroy(); } catch (e) { /* ignore */ }
                try { this.fs.unlinkSync(dest); } catch (e) { /* may not exist yet */ }
                reject(err);
            };
            const get = (u, redirects) => {
                if (redirects > 5) return fail(new Error('too many redirects'));
                if (!this.netGuard.validatePublicFetchTarget(u)) return fail(new Error(`blocked host: ${u}`));
                https.get(u, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        return get(new URL(res.headers.location, u).toString(), redirects + 1);
                    }
                    if (res.statusCode !== 200) { res.resume(); return fail(new Error(`HTTP ${res.statusCode}`)); }
                    res.pipe(file);
                    file.on('finish', () => file.close(() => { settled = true; resolve(dest); }));
                    file.on('error', fail);
                }).on('error', fail);
            };
            get(url, 0);
        });
    }

    /** GitHub web URL -> codeload tarball URL (main/master), else null. */
    resolveGithubTarball(url) {
        let u;
        try { u = new URL(url); } catch (e) { return null; }
        if (u.hostname !== 'github.com') return null;
        const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
        if (parts.length < 2) return null;
        const [owner, repoRaw] = parts;
        const repo = repoRaw.replace(/\.git$/, '');
        let ref = 'main';
        const treeIdx = parts.indexOf('tree');
        if (treeIdx >= 0 && parts[treeIdx + 1]) ref = parts[treeIdx + 1];
        const tagIdx = parts.indexOf('tag');
        const releasesIdx = parts.indexOf('releases');
        if (tagIdx >= 0 && parts[tagIdx + 1]) ref = parts[tagIdx + 1];
        if (releasesIdx >= 0 && parts[releasesIdx + 1] === 'tag' && parts[releasesIdx + 2]) ref = parts[releasesIdx + 2];
        // Immutable refs: a commit SHA (40 hex) or a tag always point at the same
        // bytes. A branch HEAD (main/master/develop) is mutable — a later push or a
        // TOCTOU update between review and install becomes trusted app code. Resolve
        // branch refs to the tag/commit form when possible; otherwise require an
        // explicit mutable-source opt-in.
        const isCommitSha = /^[0-9a-f]{40}$/i.test(ref);
        const isTagRef = (treeIdx >= 0 && parts[treeIdx + 2] === 'tags') || (releasesIdx >= 0 && parts[releasesIdx + 1] === 'tag' && parts[releasesIdx + 2]);
        if (isCommitSha) {
            return { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, ref, immutable: true };
        }
        if (isTagRef) {
            return { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/${ref}`, ref, immutable: true };
        }
        return { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${ref}`, ref, immutable: false };
    }

    /** Walk staging (top + immediate children) for the dir containing plugin.json. */
    findPluginRoot(stagingDir) {
        if (this.fs.existsSync(this.path.join(stagingDir, 'plugin.json'))) return stagingDir;
        let children = [];
        try {
            children = this.fs.readdirSync(stagingDir, { withFileTypes: true })
                .filter((d) => d.isDirectory());
        } catch (e) { children = []; }
        for (const c of children) {
            const cand = this.path.join(stagingDir, c.name);
            if (this.fs.existsSync(this.path.join(cand, 'plugin.json'))) return cand;
        }
        return null;
    }

    /** Read+validate the manifest at a plugin root. Returns {id, manifest} or throws. */
    validateStagedManifest(root) {
        const raw = this.fs.readFileSync(this.path.join(root, 'plugin.json'), 'utf8');
        let m;
        try { m = JSON.parse(raw); } catch (e) { throw new Error(`invalid plugin.json: ${e.message}`); }
        const id = m.id || this.path.basename(root);
        if (!ID_RE.test(id)) throw new Error(`invalid plugin id "${id}"`);
        return { id, manifest: m };
    }

    _mkStaging() {
        return this.fs.mkdtempSync(this.path.join(this.os.tmpdir(), 'xk-plugin-'));
    }

    /** Main entry. Returns { success, id, manifest, source } or { error }.
     *  By default refuses mutable branch-HEAD sources; pass { allowMutable: true } to
     *  accept a branch HEAD (recorded as mutable in the result). */
    async install(url, opts = {}) {
        const allowMutable = opts.allowMutable === true;
        const u = this.netGuard.validatePublicFetchTarget(url);
        // Allow scp-like git URLs (git@host:...) only when git is present; otherwise require http(s).
        const isScpGit = /^[^/]+@[^/]+:/.test(String(url));
        if (!u && !(isScpGit && this.hasGit)) {
            return { error: `URL rejected (must be http(s) to a non-internal host${this.hasGit ? ', or an ssh git URL' : ''})` };
        }
        const isGitRepoUrl = isScpGit || /\.git(?:[#?]|$)/.test(String(url));

        const staging = this._mkStaging();
        const cleanup = () => { try { this.fs.rmSync(staging, { recursive: true, force: true }); } catch (e) {} };

        try {
            let sourceRef = null;
            let immutable = false;
            if (this.hasGit && isGitRepoUrl) {
                const repoUrl = String(url).replace(/[#?].*$/, '');
                const refMatch = String(url).match(/[#?]ref=([^&#?]+)/) || String(url).match(/@([0-9a-f]{40})/);
                const ref = refMatch ? decodeURIComponent(refMatch[1]) : null;
                if (ref) {
                    sourceRef = ref;
                    immutable = /^[0-9a-f]{40}$/i.test(ref);
                    if (immutable) {
                        const repoDir = this.path.join(staging, 'repo');
                        this.fs.mkdirSync(repoDir, { recursive: true });
                        this.runGit(['init', 'repo'], staging);
                        this.runGit(['-C', 'repo', 'remote', 'add', 'origin', repoUrl], staging);
                        this.runGit(['-C', 'repo', 'fetch', '--depth', '1', 'origin', ref], staging);
                        this.runGit(['-C', 'repo', 'checkout', '--detach', 'FETCH_HEAD'], staging);
                    } else if (allowMutable) {
                        this.runGit(['clone', '--depth', '1', '--branch', ref, repoUrl, 'repo'], staging);
                    } else {
                        return { error: 'Refusing to install from a mutable branch HEAD without an immutable ref. Pin a commit SHA or tag (append #ref=<sha> or @<sha>), or pass { allowMutable: true } to accept mutable trusted code.' };
                    }
                } else if (allowMutable) {
                    this.runGit(['clone', '--depth', '1', repoUrl, 'repo'], staging);
                } else {
                    return { error: 'Refusing to install from a mutable branch HEAD without an immutable ref. Pin a commit SHA or tag (append #ref=<sha> or @<sha>), or pass { allowMutable: true } to accept mutable trusted code.' };
                }
            } else {
                const resolved = this.resolveGithubTarball(url);
                if (resolved) {
                    if (!resolved.immutable && !allowMutable) {
                        return { error: `Refusing to install from mutable branch "${resolved.ref}". Pin a commit SHA or tag URL (github.com/<owner>/<repo>/tree/<sha> or /releases/tag/<tag>), or pass { allowMutable: true } to accept mutable trusted code.` };
                    }
                    sourceRef = resolved.ref;
                    immutable = resolved.immutable;
                    const archive = this.path.join(staging, 'archive.tar.gz');
                    await this.download(resolved.url, archive);
                    this.fs.mkdirSync(this.path.join(staging, 'repo'), { recursive: true });
                    this.runTar(['-xzf', archive, '-C', 'repo'], staging);
                } else {
                    if (allowMutable !== true) {
                        return { error: 'Refusing generic archive URLs unless { allowMutable: true } is set. Use a GitHub repo/tag URL or pin a commit SHA.' };
                    }
                    const archive = this.path.join(staging, 'archive.tar.gz');
                    await this.download(url, archive);
                    this.fs.mkdirSync(this.path.join(staging, 'repo'), { recursive: true });
                    this.runTar(['-xzf', archive, '-C', 'repo'], staging);
                }
            }

            const root = this.findPluginRoot(this.path.join(staging, 'repo'));
            if (!root) return { error: 'no plugin.json found in the repository' };

            const { id, manifest } = this.validateStagedManifest(root);

            // Confine destination to the plugins dir (no traversal via a crafted id).
            const dest = this.path.join(this.pluginsDir, id);
            const rel = this.path.relative(this.pluginsDir, dest);
            if (rel.startsWith('..') || this.path.isAbsolute(rel)) return { error: `unsafe plugin id "${id}"` };

            this.fs.mkdirSync(this.pluginsDir, { recursive: true });
            if (this.fs.existsSync(dest)) this.fs.rmSync(dest, { recursive: true, force: true });
            this.fs.cpSync(root, dest, { recursive: true });

            return { success: true, id, manifest, source: url, sourceRef, immutable };
        } catch (e) {
            return { error: e.message || String(e) };
        } finally {
            cleanup();
        }
    }
}

module.exports = PluginInstaller;
