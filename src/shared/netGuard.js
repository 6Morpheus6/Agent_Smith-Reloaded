/**
 * SSRF + download path hardening for the built-in web server.
 *
 * The /api/proxy/* endpoint exists only to let the mobile web client reach the
 * local (or user-configured) LLM server; /download_remote only to hand back files
 * the agent produced. Both previously accepted any target/path, turning the app
 * into an SSRF pivot and an arbitrary file reader. These pure helpers constrain
 * them to their legitimate purpose (kept dependency-free so they're unit-testable).
 */
const fs = require('fs');
const path = require('path');

function isLoopbackHost(host) {
    if (!host) return false;
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h); // 127.0.0.0/8
}

function isBlockedHost(host) {
    if (!host) return true;
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    // Cloud metadata / link-local — never allowed, regardless of configuration.
    if (h === 'metadata.google.internal' || h === 'metadata') return true;
    if (h.startsWith('169.254.')) return true;            // IPv4 link-local (incl. 169.254.169.254)
    if (h.startsWith('fe80:') || h.startsWith('fd') || h.startsWith('fc')) return true; // IPv6 link-local / ULA
    return false;
}

function normOrigin(u) {
    let host = u.hostname.toLowerCase();
    if (host === 'localhost') host = '127.0.0.1';
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//${host}:${port}`;
}

/**
 * Returns the parsed URL if the proxy target is permitted, else null.
 * Allows loopback (default LM Studio/Ollama) or the configured LLM origin only.
 */
function validateProxyTarget(targetUrl, lmsHostUrl) {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isBlockedHost(u.hostname)) return null;
    if (isLoopbackHost(u.hostname)) return u;
    const allowed = new Set();
    try { allowed.add(normOrigin(new URL(lmsHostUrl))); } catch (e) { /* ignore */ }
    if (allowed.has(normOrigin(u))) return u;
    return null;
}

/**
 * Validate a target for an OUTBOUND fetch (plugin `net` capability, plugin
 * installer downloads). Unlike validateProxyTarget this intentionally allows
 * arbitrary PUBLIC https/http hosts — plugins legitimately reach the internet —
 * but still refuses cloud-metadata, link-local and ULA hosts so the app can't be
 * used to pivot at those. Returns the parsed URL or null.
 */
function validatePublicFetchTarget(targetUrl) {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isBlockedHost(u.hostname)) return null;
    return u;
}

/**
 * Returns an absolute, symlink-resolved path if rawPath is a real file inside one
 * of `allowedRoots`, else null. Roots that don't exist are skipped.
 */
function validateDownloadPath(rawPath, allowedRoots) {
    if (!rawPath) return null;
    let abs;
    try {
        abs = fs.realpathSync(path.resolve(rawPath)); // resolves symlinks too
        if (!fs.statSync(abs).isFile()) return null;
    } catch (e) {
        return null; // missing / unreadable / not a file
    }
    for (const root of allowedRoots || []) {
        let realRoot;
        try { realRoot = fs.realpathSync(root); } catch (e) { continue; }
        const rel = path.relative(realRoot, abs);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
    }
    return null;
}

function validatePreviewAssetPath(rawPath, userDataPath) {
    if (!userDataPath) return null;
    const previewsRoot = path.join(userDataPath, 'previews');
    return validateDownloadPath(rawPath, [previewsRoot]);
}

function validatePreviewUrl(targetUrl) {
    const pub = validatePublicFetchTarget(targetUrl);
    if (pub) return pub;
    let u;
    try { u = new URL(targetUrl); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isBlockedHost(u.hostname)) return null;
    if (isLoopbackHost(u.hostname)) return u;
    return null;
}

function normalizeLlmBaseUrl(base) {
    let b = String(base || 'http://127.0.0.1:1234').trim();
    if (!/^https?:\/\//i.test(b)) b = `http://${b}`;
    b = b.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/api$/, '');
    try {
        const u = new URL(b);
        let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '::1') u.hostname = '127.0.0.1';
        let out = `${u.protocol}//${u.hostname}`;
        if (u.port) out += `:${u.port}`;
        return out;
    } catch (e) {
        return b;
    }
}

module.exports = {
    isLoopbackHost,
    isBlockedHost,
    normOrigin,
    normalizeLlmBaseUrl,
    validateProxyTarget,
    validatePublicFetchTarget,
    validateDownloadPath,
    validatePreviewAssetPath,
    validatePreviewUrl
};
