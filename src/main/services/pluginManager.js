/**
 * Plugin manager (main process).
 *
 * Discovers plugin folders under <userData>/plugins/, validates manifests, loads
 * their tool/command/hook contributions, holds the registry, persists enable/cap
 * state, and routes tool/command/hook invocations through a capability-gated host.
 *
 * Trusted-code model (see lib/pluginHost.js + the design spec). One bad plugin is
 * quarantined, never allowed to break discovery or the agent loop.
 *
 * Dependency-injected for `node --test`: pass `fsImpl`, `pathImpl`, `requireImpl`
 * etc. in tests; in production it defaults to the real node modules.
 */

const pluginHost = require('./pluginHost.js');
const pluginIntegrity = require('./pluginIntegrity.js');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONTRIB_KINDS = ['tools', 'commands', 'hooks'];
const HOOK_EVENTS = [
    'beforeToolCall', 'afterToolCall', 'beforeDone',
    'onPlanApproved', 'onPlanDone', 'onMessageSend',
    'sessionStart', 'sessionStop', 'afterTurn', 'afterToolBatch', 'phaseChange'
];

class PluginManager {
    constructor(userDataPath, deps = {}) {
        this.fs = deps.fsImpl || require('fs');
        this.path = deps.pathImpl || require('path');
        // requireImpl lets tests inject fake modules instead of touching disk.
        this.requireModule = deps.requireImpl || ((abs) => {
            delete require.cache[require.resolve(abs)];
            return require(abs);
        });
        this.log = deps.logger || ((m) => console.log(`[plugins] ${m}`));
        // Injectable for tests; defaults to the real content hasher.
        this.hashPluginDir = deps.hashPluginDir || ((dir) => pluginIntegrity.hashPluginDir(dir, { fs: this.fs, path: this.path }));

        this.pluginsDir = this.path.join(userDataPath, 'plugins');
        this.stateFile = this.path.join(this.pluginsDir, 'plugins.json');

        // Injected host backends (all optional; gated by declared caps anyway).
        this.projectContext = deps.projectContext || null;
        this.runCommand = deps.runCommand || null;       // (cmd) => Promise<{stdout,stderr,error}>
        this.memory = deps.memory || null;               // { store, query }
        this.uiNotify = deps.uiNotify || (() => {});     // (pluginId, msg) => void
        this.netGuard = deps.netGuard || null;
        this.fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
        // Core agent tool names plugins must not shadow.
        this.coreToolNames = new Set(deps.coreToolNames || []);

        // Opt-in OS-enforced sandbox for plugin tool execution (default off; in-process
        // otherwise). Enable with { sandbox:true } or AGENT_SMITH_PLUGIN_SANDBOX=1.
        this.sandbox = !!deps.sandbox || process.env.AGENT_SMITH_PLUGIN_SANDBOX === '1';
        this._sandbox = deps.sandboxImpl || require('./pluginSandbox.js');

        // id -> { manifest, dir, enabled, grantedCaps, tools, commands, hooks, error }
        this.registry = new Map();
        this.state = {}; // persisted: id -> { enabled, grantedCaps, source, version, installedAt }
    }

    // ---- persistence -------------------------------------------------------

    _ensureDir() {
        try { this.fs.mkdirSync(this.pluginsDir, { recursive: true }); } catch (e) { /* exists */ }
    }

    loadState() {
        try {
            const raw = this.fs.readFileSync(this.stateFile, 'utf8');
            this.state = JSON.parse(raw) || {};
        } catch (e) {
            this.state = {};
        }
        return this.state;
    }

    saveState() {
        this._ensureDir();
        this.fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
    }

    // ---- discovery ---------------------------------------------------------

    /** Scan the plugins dir, (re)build the registry. Safe to call repeatedly. */
    discover() {
        this._ensureDir();
        this.loadState();
        this.registry.clear();

        let entries = [];
        try {
            entries = this.fs.readdirSync(this.pluginsDir, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch (e) {
            entries = [];
        }

        for (const dirName of entries) {
            const dir = this.path.join(this.pluginsDir, dirName);
            try {
                this._loadPlugin(dir, dirName);
            } catch (e) {
                // Quarantine: record the error, keep going. Never throw out of discover.
                const msg = e.message || String(e);
                this.registry.set(dirName, {
                    manifest: { id: dirName, name: dirName, version: '0.0.0', capabilities: [] },
                    dir, enabled: false, grantedCaps: [],
                    tools: [], commands: [], hooks: [],
                    loadError: msg, error: msg,
                });
                this.log(`quarantined ${dirName}: ${e.message}`);
            }
        }

        this._resolveToolCollisions();
        return this.list();
    }

    _readManifest(dir, dirName) {
        const manifestPath = this.path.join(dir, 'plugin.json');
        const raw = this.fs.readFileSync(manifestPath, 'utf8'); // throws if missing -> quarantine
        let m;
        try { m = JSON.parse(raw); } catch (e) { throw new Error(`invalid plugin.json: ${e.message}`); }

        const id = m.id || dirName;
        if (!ID_RE.test(id)) throw new Error(`invalid plugin id "${id}" (use [a-z0-9-])`);
        const caps = pluginHost.validCaps(m.capabilities || []);
        return {
            id,
            name: m.name || id,
            version: typeof m.version === 'string' ? m.version : '0.0.0',
            description: m.description || '',
            author: m.author || '',
            capabilities: caps,
            contributes: m.contributes && typeof m.contributes === 'object' ? m.contributes : null,
        };
    }

    /** Resolve a contribution file path and reject traversal outside the plugin dir. */
    _safeContribPath(dir, rel) {
        const abs = this.path.resolve(dir, rel);
        const relCheck = this.path.relative(dir, abs);
        if (relCheck.startsWith('..') || this.path.isAbsolute(relCheck)) {
            throw new Error(`contribution path escapes plugin dir: ${rel}`);
        }
        return abs;
    }

    _listContribFiles(plugin, kind) {
        const contributes = plugin.manifest.contributes;
        if (contributes && Array.isArray(contributes[kind])) {
            return contributes[kind].map((rel) => this._safeContribPath(plugin.dir, rel));
        }
        // Auto-discover: <dir>/<kind>/*.js
        const kindDir = this.path.join(plugin.dir, kind);
        let files = [];
        try {
            files = this.fs.readdirSync(kindDir)
                .filter((f) => f.endsWith('.js'))
                .map((f) => this.path.join(kindDir, f));
        } catch (e) { files = []; }
        return files;
    }

    _loadPlugin(dir, dirName) {
        const manifest = this._readManifest(dir, dirName);
        const st = this.state[manifest.id] || {};
        const plugin = {
            manifest,
            dir,
            enabled: !!st.enabled,
            // Granted caps are the intersection of what was granted and what the
            // manifest currently declares (a plugin update can't silently widen).
            grantedCaps: pluginHost.validCaps(st.grantedCaps || []).filter((c) => manifest.capabilities.includes(c)),
            source: st.source || 'local',
            tools: [],
            commands: [],
            hooks: [],
            loadError: null,
            error: null,
            integrityHash: null,
            trustedHash: st.trustedHash || null,
        };

        // Integrity: enabling a plugin records its content hash. If the bytes changed
        // since then (tamper / silent update), quarantine it WITHOUT executing the changed
        // code (no require of its contributions) until the user re-enables.
        try {
            plugin.integrityHash = this.hashPluginDir(dir);
        } catch (e) { plugin.integrityHash = null; }
        if (plugin.enabled && plugin.trustedHash && plugin.integrityHash && plugin.trustedHash !== plugin.integrityHash) {
            plugin.enabled = false;
            plugin.loadError = 'plugin content changed since it was trusted — re-enable to grant trust again';
            plugin.error = plugin.loadError;
            this.registry.set(manifest.id, plugin);
            return plugin; // do NOT require() the changed contribution code
        }

        // Tools
        for (const file of this._listContribFiles(plugin, 'tools')) {
            const mod = this.requireModule(file);
            if (!mod || !mod.schema || !mod.schema.name || typeof mod.run !== 'function') {
                throw new Error(`tool ${this.path.basename(file)} must export { schema:{name,...}, run() }`);
            }
            plugin.tools.push({ name: mod.schema.name, schema: mod.schema, run: mod.run, file });
        }
        // Commands
        for (const file of this._listContribFiles(plugin, 'commands')) {
            const mod = this.requireModule(file);
            if (!mod || !mod.name || (typeof mod.prompt !== 'string' && typeof mod.run !== 'function')) {
                throw new Error(`command ${this.path.basename(file)} must export { name, prompt|run }`);
            }
            plugin.commands.push({ name: mod.name, description: mod.description || '', prompt: mod.prompt, run: mod.run, file });
        }
        // Hooks
        for (const file of this._listContribFiles(plugin, 'hooks')) {
            const mod = this.requireModule(file);
            if (!mod || !HOOK_EVENTS.includes(mod.event) || typeof mod.run !== 'function') {
                throw new Error(`hook ${this.path.basename(file)} must export { event:<one of ${HOOK_EVENTS.join('|')}>, run() }`);
            }
            plugin.hooks.push({ event: mod.event, run: mod.run, file });
        }

        this.registry.set(manifest.id, plugin);
        return plugin;
    }

    /** Disable+flag any enabled plugin whose tool name collides with a core tool or another enabled plugin. */
    _resolveToolCollisions() {
        // Reset to the load error (if any); collision errors are recomputed below.
        for (const plugin of this.registry.values()) plugin.error = plugin.loadError || null;
        const claimed = new Map(); // toolName -> pluginId
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const t of plugin.tools) {
                if (this.coreToolNames.has(t.name)) {
                    plugin.error = `tool "${t.name}" collides with a core tool`;
                    break;
                }
                if (claimed.has(t.name)) {
                    plugin.error = `tool "${t.name}" already provided by plugin "${claimed.get(t.name)}"`;
                    break;
                }
            }
            if (plugin.error) continue;
            for (const t of plugin.tools) claimed.set(t.name, plugin.manifest.id);
        }
    }

    // ---- queries -----------------------------------------------------------

    list() {
        return Array.from(this.registry.values()).map((p) => ({
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            description: p.manifest.description,
            author: p.manifest.author,
            capabilities: p.manifest.capabilities,
            grantedCaps: p.grantedCaps,
            enabled: p.enabled,
            source: p.source,
            error: p.error,
            integrity: p.trustedHash
                ? (p.integrityHash === p.trustedHash ? 'trusted' : 'changed')
                : 'untrusted',
            tools: p.tools.map((t) => t.name),
            commands: p.commands.map((c) => ({ name: c.name, description: c.description })),
            hooks: p.hooks.map((h) => h.event),
        }));
    }

    /** OpenAI-format tool schemas for every enabled, error-free plugin tool. */
    getEnabledToolSchemas() {
        const out = [];
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const t of plugin.tools) {
                out.push({ type: 'function', function: t.schema });
            }
        }
        return out;
    }

    getEnabledCommands() {
        const out = [];
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const c of plugin.commands) {
                out.push({ pluginId: plugin.manifest.id, name: c.name, description: c.description });
            }
        }
        return out;
    }

    _findToolOwner(toolName) {
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            const t = plugin.tools.find((x) => x.name === toolName);
            if (t) return { plugin, tool: t };
        }
        return null;
    }

    isPluginTool(toolName) {
        return !!this._findToolOwner(toolName);
    }

    // ---- host construction -------------------------------------------------

    _buildHost(plugin) {
        const pc = this.projectContext;
        const fsmod = this.fs;
        const fsImpl = pc ? {
            readFile: (p) => { const r = pc.resolvePath(p); if (r.error) throw new Error(r.error); return fsmod.readFileSync(r.path, 'utf8'); },
            writeFile: (p, c) => { const r = pc.resolvePath(p); if (r.error) throw new Error(r.error); fsmod.writeFileSync(r.path, c); return r.path; },
            exists: (p) => { const r = pc.resolvePath(p); if (r.error) return false; return fsmod.existsSync(r.path); },
            list: (p) => { const r = pc.resolvePath(p); if (r.error) throw new Error(r.error); return fsmod.readdirSync(r.path); },
        } : null;

        const guard = this.netGuard;
        const fetchImpl = this.fetchImpl;
        const netFetch = (fetchImpl) ? (url, opts) => {
            if (guard && !guard.validatePublicFetchTarget(url)) {
                // Reject (don't throw synchronously) so the fetch-like API is uniform.
                return Promise.reject(new Error(`net target blocked by netGuard: ${url}`));
            }
            return fetchImpl(url, opts);
        } : null;

        return pluginHost.build(plugin.grantedCaps, {
            pluginId: plugin.manifest.id,
            log: (id, msg) => this.log(`[${id}] ${msg}`),
            fs: fsImpl,
            runCommand: this.runCommand,
            netFetch,
            memory: this.memory,
            uiNotify: this.uiNotify,
        });
    }

    _sandboxUnavailable() {
        return this.sandbox && this._sandbox && typeof this._sandbox.permissionSupported === 'function' && !this._sandbox.permissionSupported();
    }

    // ---- invocation --------------------------------------------------------

    async invokeTool(toolName, args) {
        const found = this._findToolOwner(toolName);
        if (!found) return `Error: no enabled plugin provides tool "${toolName}".`;
        if (this._sandboxUnavailable()) {
            return `Error: sandbox mode is enabled but the Node permission model is unavailable. Refusing to run plugin "${toolName}" in-process.`;
        }

        // Opt-in: run in an OS-sandboxed child process (no child_process/worker, fs scoped
        // to the project root). When sandbox mode is enabled we FAIL CLOSED on any sandbox
        // infrastructure failure — a misconfigured Node permission model or a plugin that
        // intentionally breaks sandbox startup must not silently regain full main-process
        // privileges. The previous behavior fell back to in-process execution, turning a
        // requested isolation policy into full trust without surfacing the failure.
        if (this.sandbox && this._sandbox && this._sandbox.permissionSupported() && found.tool.file) {
            try {
                return await this._sandbox.runToolSandboxed({
                    pluginDir: found.plugin.dir,
                    toolFile: found.tool.file,
                    args: args || {},
                    grantedCaps: found.plugin.grantedCaps,
                    projectRoot: this.projectContext ? this.projectContext.getRoot() : null,
                    broker: this._buildSandboxBroker(found.plugin),
                });
            } catch (e) {
                return `Error: sandbox mode is enabled but the sandbox failed for tool "${toolName}" (${e.message}). Refusing to fall back to in-process execution — disable sandbox mode or fix the sandbox infrastructure to run this plugin.`;
            }
        }

        const host = this._buildHost(found.plugin);
        try {
            const result = await found.tool.run(args || {}, host);
            if (result == null) return 'Success';
            return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (e) {
            return `Error in plugin "${found.plugin.manifest.id}" tool "${toolName}": ${e.message || e}`;
        }
    }

    /** Broker for sandboxed plugins: applies the same capability gating as the in-process host. */
    _buildSandboxBroker(plugin) {
        const caps = plugin.grantedCaps || [];
        return async (cap, method, args) => {
            if (cap === 'shell' && caps.includes('shell') && this.runCommand) {
                return this.runCommand(args[0]);
            }
            if (cap === 'memory' && caps.includes('memory') && this.memory) {
                return method === 'store' ? this.memory.store(args[0], args[1]) : this.memory.query(args[0], args[1]);
            }
            if (cap === 'net' && caps.includes('net') && this.fetchImpl) {
                const url = args[0];
                if (this.netGuard && !this.netGuard.validatePublicFetchTarget(url)) {
                    throw new Error(`net target blocked by netGuard: ${url}`);
                }
                const res = await this.fetchImpl(url, args[1]);
                // Response objects aren't IPC-serializable; return a simplified shape.
                let text = '';
                try { text = await res.text(); } catch (e) { /* ignore */ }
                return { ok: !!res.ok, status: res.status, text };
            }
            throw new Error(`capability "${cap}" not granted to plugin "${plugin.manifest.id}"`);
        };
    }

    async runCommandText(name, argText) {
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            const cmd = plugin.commands.find((c) => c.name === name);
            if (!cmd) continue;
            if (typeof cmd.run === 'function') {
                if (this._sandboxUnavailable()) {
                    return `Error: sandbox mode is enabled but the Node permission model is unavailable. Refusing to run command "${name}" in-process.`;
                }
                // Route through the sandbox when enabled — commands are plugin code and
                // must not bypass the opt-in isolation policy (previously they always
                // ran in-process, so a malicious command could regain full privileges).
                if (this.sandbox && this._sandbox && this._sandbox.permissionSupported() && cmd.file) {
                    try {
                        const r = await this._sandbox.runToolSandboxed({
                            pluginDir: plugin.dir,
                            toolFile: cmd.file,
                            args: { argText: argText || '' },
                            grantedCaps: plugin.grantedCaps,
                            projectRoot: this.projectContext ? this.projectContext.getRoot() : null,
                            broker: this._buildSandboxBroker(plugin),
                        });
                        return r;
                    } catch (e) {
                        return `Error: sandbox failed for command "${name}" (${e.message}). Refusing to fall back to in-process execution.`;
                    }
                }
                const host = this._buildHost(plugin);
                return await cmd.run(argText || '', host);
            }
            return String(cmd.prompt || '').replace(/\{\{\s*args\s*\}\}/g, argText || '');
        }
        return null;
    }

    /** Fire all hooks for an event. before* hooks may return {block,reason}. */
    async fireHook(event, payload) {
        let result = { blocked: false };
        if (this._sandboxUnavailable()) {
            return { blocked: true, reason: `sandbox mode is enabled but the Node permission model is unavailable. Refusing to run hook "${event}" in-process.`, by: 'sandbox' };
        }
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const h of plugin.hooks) {
                if (h.event !== event) continue;
                try {
                    let r;
                    // Route hooks through the sandbox when enabled — same rationale as
                    // commands: hooks are plugin code and must not bypass isolation.
                    if (this.sandbox && this._sandbox && this._sandbox.permissionSupported() && h.file) {
                        const sandboxed = await this._sandbox.runToolSandboxed({
                            pluginDir: plugin.dir,
                            toolFile: h.file,
                            args: { event, payload },
                            grantedCaps: plugin.grantedCaps,
                            projectRoot: this.projectContext ? this.projectContext.getRoot() : null,
                            broker: this._buildSandboxBroker(plugin),
                        });
                        // The sandbox returns a string; parse {block,reason} if present.
                        if (typeof sandboxed === 'string' && sandboxed.startsWith('{')) {
                            try { r = JSON.parse(sandboxed); } catch (e) { r = null; }
                        }
                    } else {
                        const host = this._buildHost(plugin);
                        r = await h.run(payload, host);
                    }
                    if (event.startsWith('before') && r && r.block) {
                        result = { blocked: true, reason: r.reason || `blocked by plugin ${plugin.manifest.id}`, by: plugin.manifest.id };
                        return result; // first veto wins
                    }
                } catch (e) {
                    this.log(`hook ${event} in ${plugin.manifest.id} failed: ${e.message}`); // swallow
                }
            }
        }
        return result;
    }

    // ---- mutation ----------------------------------------------------------

    setEnabled(id, enabled, grantedCaps) {
        const plugin = this.registry.get(id);
        if (!plugin) return { error: `unknown plugin ${id}` };
        const caps = grantedCaps != null
            ? pluginHost.validCaps(grantedCaps).filter((c) => plugin.manifest.capabilities.includes(c))
            : plugin.grantedCaps;
        // Persist the state change BEFORE mutating the live registry so a write
        // failure does not leave the in-process state diverged from what will be
        // loaded on restart. Previously a saveState() throw propagated as a generic
        // 500 after the in-memory enablement had already happened.
        const prevEnabled = plugin.enabled;
        const prevCaps = plugin.grantedCaps;
        plugin.enabled = !!enabled;
        plugin.grantedCaps = caps;
        // Trust-on-enable: snapshot the current content hash as the approved bytes. A later
        // change to the plugin will mismatch this and quarantine it on next discover.
        let trustedHash = this.state[id]?.trustedHash || null;
        const wasIntegrityQuarantined = !!(plugin.loadError && /content changed/.test(plugin.loadError));
        if (enabled) {
            try { trustedHash = this.hashPluginDir(plugin.dir); } catch (e) { /* keep prior */ }
            plugin.trustedHash = trustedHash;
            plugin.integrityHash = trustedHash;
            if (wasIntegrityQuarantined) { plugin.loadError = null; plugin.error = null; }
        }
        const prevEntry = this.state[id];
        this.state[id] = {
            ...(this.state[id] || {}),
            enabled: !!enabled,
            grantedCaps: caps,
            version: plugin.manifest.version,
            trustedHash,
        };
        try {
            this.saveState();
        } catch (e) {
            // Roll back the in-memory state so it matches the persisted state.
            plugin.enabled = prevEnabled;
            plugin.grantedCaps = prevCaps;
            this.state[id] = prevEntry;
            return { error: `could not persist plugin state: ${e.message}. Enablement was not changed.` };
        }
        // If we just re-trusted a quarantined plugin, its contributions were never loaded
        // (we skipped require() of the changed code) — reload them now that it's trusted.
        if (enabled && wasIntegrityQuarantined) {
            try { this._loadPlugin(plugin.dir, id); } catch (e) {
                const p = this.registry.get(id);
                if (p) { p.loadError = e.message; p.error = e.message; }
            }
        }
        // A change in enablement can introduce/clear collisions.
        this._resolveToolCollisions();
        return { success: true, plugin: this.list().find((p) => p.id === id) };
    }

    uninstall(id) {
        const plugin = this.registry.get(id);
        if (!plugin) return { error: `unknown plugin ${id}` };
        // Persist the state removal BEFORE deleting files/registry so a write failure
        // does not leave the registry diverged from what will load on restart.
        const prevEntry = this.state[id];
        delete this.state[id];
        try {
            this.saveState();
        } catch (e) {
            this.state[id] = prevEntry;
            return { error: `could not persist plugin state: ${e.message}. Uninstall was not performed.` };
        }
        try {
            this.fs.rmSync(plugin.dir, { recursive: true, force: true });
        } catch (e) {
            // Restore state since the directory removal failed.
            this.state[id] = prevEntry;
            try { this.saveState(); } catch (e2) { /* best effort */ }
            return { error: `failed to remove ${id}: ${e.message}` };
        }
        this.registry.delete(id);
        return { success: true };
    }
}

module.exports = PluginManager;
module.exports.HOOK_EVENTS = HOOK_EVENTS;
