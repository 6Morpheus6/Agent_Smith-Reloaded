/**
 * Capability-gated host facade handed to a plugin's tool/command/hook code.
 *
 * SECURITY NOTE (read PROTOCOL.md / the design spec): plugins are TRUSTED code in
 * the main process. A hostile plugin can `require('fs')` and bypass this facade.
 * Capabilities are therefore for (a) transparency — the user sees what a plugin
 * declares before enabling — and (b) defence-in-depth for HONEST plugins: a cap
 * that wasn't granted simply isn't present on `host`, and the host-mediated
 * fs/shell/net paths stay sandboxed/guarded. This is not a sandbox against
 * malicious code.
 *
 * Dependency-injected so it is unit-testable without Electron: callers pass the
 * low-level implementations; this module only decides which are exposed.
 */

const ALL_CAPS = ['fs', 'shell', 'net', 'memory', 'ui', 'log'];

function validCaps(caps) {
    if (!Array.isArray(caps)) return [];
    return caps.filter((c) => ALL_CAPS.includes(c));
}

/**
 * Build the host object for one plugin.
 * @param {string[]} grantedCaps  capabilities the user granted this plugin
 * @param {object} deps           injected implementations + identity
 *   deps.pluginId   {string}
 *   deps.log        (pluginId, msg) => void          (always used)
 *   deps.fs         { readFile, writeFile, exists, list }   (cap: fs)
 *   deps.runCommand (cmd) => Promise<{stdout,stderr,error}> (cap: shell)
 *   deps.netFetch   (url, opts) => Promise<Response>        (cap: net)
 *   deps.memory     { store, query }                        (cap: memory)
 *   deps.uiNotify   (pluginId, msg) => void                 (cap: ui)
 */
function build(grantedCaps, deps) {
    const caps = validCaps(grantedCaps);
    const id = deps.pluginId || 'unknown';
    const has = (c) => caps.includes(c);

    const host = {
        pluginId: id,
        capabilities: caps.slice(),
        // `log` is always available regardless of declared caps.
        log: (msg) => deps.log && deps.log(id, String(msg)),
    };

    if (has('fs') && deps.fs) {
        host.fs = {
            readFile: (p) => deps.fs.readFile(p),
            writeFile: (p, content) => deps.fs.writeFile(p, content),
            exists: (p) => deps.fs.exists(p),
            list: (p) => deps.fs.list(p),
        };
    }

    if (has('shell') && deps.runCommand) {
        host.shell = {
            run: (cmd) => deps.runCommand(cmd),
        };
    }

    if (has('net') && deps.netFetch) {
        host.net = {
            fetch: (url, opts) => deps.netFetch(url, opts),
        };
    }

    if (has('memory') && deps.memory) {
        host.memory = {
            store: (text, meta) => deps.memory.store(text, meta),
            query: (text, k) => deps.memory.query(text, k),
        };
    }

    if (has('ui') && deps.uiNotify) {
        host.ui = {
            notify: (msg) => deps.uiNotify(id, String(msg)),
        };
    }

    return host;
}

module.exports = { build, validCaps, ALL_CAPS };
