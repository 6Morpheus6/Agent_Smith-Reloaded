/**
 * HTTP handlers for /preview/project/* and /preview/asset/*
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { assetPathForId } = require('../services/previewService.js');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json'
};

function previewCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
}

function stripFrameHeaders(res) {
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Frame-Options');
}

/**
 * @returns {boolean} true if handled
 */
function handlePreviewRequest(req, res, deps) {
    const { projectContext, userDataPath, canUseApp, openLanMode, isAuthenticated } = deps;
    const urlPath = req.url.split('?')[0];

    if (!urlPath.startsWith('/preview/')) return false;

    if (!openLanMode && !isAuthenticated) {
        previewCors(res);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return true;
    }
    if (!canUseApp && !openLanMode) {
        previewCors(res);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Account pending approval' }));
        return true;
    }

    if (urlPath.startsWith('/preview/project/')) {
        let rel = decodeURIComponent(urlPath.slice('/preview/project/'.length));
        rel = rel.replace(/^[/\\]+/, '');
        if (!rel || rel.includes('..')) {
            previewCors(res);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return true;
        }
        const resolved = projectContext.resolvePath(rel);
        if (resolved.error) {
            previewCors(res);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end(resolved.error);
            return true;
        }
        fs.readFile(resolved.path, (err, content) => {
            previewCors(res);
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Not Found');
            }
            const ext = path.extname(resolved.path).toLowerCase();
            const ct = MIME[ext] || 'application/octet-stream';
            stripFrameHeaders(res);
            res.writeHead(200, { 'Content-Type': ct });
            res.end(content);
        });
        return true;
    }

    if (urlPath.startsWith('/preview/asset/')) {
        const name = decodeURIComponent(urlPath.slice('/preview/asset/'.length));
        const safe = path.basename(name);
        const ext = path.extname(safe).toLowerCase();
        const id = safe.replace(ext, '');
        if (!id || id.includes('..')) {
            previewCors(res);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return true;
        }
        const abs = assetPathForId(userDataPath, id, ext.replace(/^\./, '') || 'png');
        if (!abs) {
            previewCors(res);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return true;
        }
        fs.readFile(abs, (err, content) => {
            previewCors(res);
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Not Found');
            }
            const ct = ext === '.json' ? MIME['.json'] : (MIME[ext] || 'application/octet-stream');
            stripFrameHeaders(res);
            res.writeHead(200, { 'Content-Type': ct });
            res.end(content);
        });
        return true;
    }

    previewCors(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return true;
}

module.exports = { handlePreviewRequest, MIME };
