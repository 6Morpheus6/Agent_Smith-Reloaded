/**
 * Shared preview orchestration — used by IPC and Code Mode executor.
 */
'use strict';

const previewService = require('./previewService.js');

function createPreviewRunner(deps) {
    const {
        projectContext, userDataPath, getMainWindow, pushEvent,
        getWebServerPort, getLocalIP, isElectronDesktop, getAllowDesktopPreview
    } = deps;

    const pendingCaptures = new Map();
    // Pending desktop captures expire after this long — a stale id left in the map
    // must not authorize a capture the user did not just consent to.
    const PENDING_CAPTURE_TTL_MS = 5 * 60 * 1000;

    function emit(ev) {
        if (pushEvent) pushEvent('preview-event', ev);
        else {
            const win = getMainWindow?.();
            if (win && !win.isDestroyed()) win.webContents.send('preview-event', ev);
        }
    }

    function hostPortToken(opts) {
        const port = getWebServerPort?.() || 3000;
        const host = getLocalIP?.() || '127.0.0.1';
        const token = opts?.authToken || null;
        return { port, host, token };
    }

    async function show(args) {
        const kind = args?.kind || 'project_file';
        const caption = String(args?.caption || '').slice(0, 500);
        const viewport = args?.viewport || {};
        const scope = args?.scope || 'window';
        const allowDesktop = typeof getAllowDesktopPreview === 'function'
            ? !!getAllowDesktopPreview()
            : false;
        const { port, host, token } = hostPortToken(args);

        if (kind === 'project_file') {
            const rel = args?.target || 'index.html';
            const resolved = previewService.resolveProjectFile(projectContext, rel);
            if (resolved.error) return { error: resolved.error };

            const previewId = previewService.newPreviewId();
            const liveUrl = previewService.buildProjectPreviewUrl(host, port, resolved.relPath, token);
            emit({
                type: 'live',
                previewId,
                kind,
                caption,
                liveUrl,
                relPath: resolved.relPath
            });
            return {
                success: true,
                previewId,
                kind,
                liveUrl,
                caption,
                note: `Live preview opened for ${resolved.relPath}. User can interact in the sidebar Preview panel.`
            };
        }

        if (kind === 'web_url') {
            const target = args?.target;
            if (!target) return { error: 'target URL is required for web_url preview.' };
            const cap = await previewService.captureWebUrl(target, viewport, {});
            if (cap.error) return { error: cap.error };

            const saved = await previewService.saveSnapshot(userDataPath, cap.pngBuffer, {
                kind, target, caption, url: cap.url
            });
            const snapshotUrl = previewService.buildAssetUrl(host, port, saved.previewId, 'png', token);
            emit({
                type: 'snapshot',
                previewId: saved.previewId,
                kind,
                caption,
                snapshotUrl,
                target
            });
            return {
                success: true,
                previewId: saved.previewId,
                kind,
                snapshotUrl,
                caption,
                note: 'Web page captured as snapshot in Preview panel.'
            };
        }

        if (kind === 'screenshot') {
            if (!isElectronDesktop) {
                return { error: 'Desktop screenshot is only available in the Electron desktop app.' };
            }

            if (scope === 'app') {
                const cap = await previewService.captureAppWindow(getMainWindow);
                if (cap.error) return { error: cap.error };
                const saved = await previewService.saveSnapshot(userDataPath, cap.pngBuffer, {
                    kind, scope: 'app', caption
                });
                const snapshotUrl = previewService.buildAssetUrl(host, port, saved.previewId, 'png', token);
                emit({ type: 'snapshot', previewId: saved.previewId, kind, caption, snapshotUrl, scope: 'app' });
                return {
                    success: true,
                    previewId: saved.previewId,
                    kind,
                    snapshotUrl,
                    caption,
                    note: 'Captured Agent Smith window.'
                };
            }

            if (!allowDesktop) {
                return { error: 'Desktop capture disabled — enable DESKTOP PREVIEW in ADVANCED settings.' };
            }

            const previewId = previewService.newPreviewId();
            pendingCaptures.set(previewId, { caption, scope, createdAt: Date.now() });
            emit({ type: 'pick_source', previewId, kind, caption, scope });
            return {
                success: true,
                pending: true,
                previewId,
                kind,
                caption,
                note: 'Waiting for user to pick a screen or window in the Preview panel.'
            };
        }

        return { error: `Unknown preview kind: ${kind}` };
    }

    async function captureSource(opts) {
        const sourceId = opts?.sourceId;
        const previewId = opts?.previewId;
        if (!sourceId) return { error: 'sourceId is required' };

        // Non-app desktop captures must be bound to a valid, non-expired pending
        // previewId. Previously captureSource accepted any sourceId even when
        // previewId was missing or not found, so a renderer/web caller with preview
        // permission could skip the pick-source flow and capture any source id it
        // had learned from preview-list-sources, bypassing the consent association.
        const pending = previewId ? pendingCaptures.get(previewId) : null;
        if (!pending) {
            return { error: 'No pending desktop capture for this previewId. Request a screenshot via preview({kind:"screenshot"}) first — the user must pick a source before capture.' };
        }
        if (Date.now() - pending.createdAt > PENDING_CAPTURE_TTL_MS) {
            pendingCaptures.delete(previewId);
            return { error: 'The pending desktop capture request expired. Request a new screenshot via preview({kind:"screenshot"}).' };
        }
        pendingCaptures.delete(previewId);

        const cap = await previewService.captureDesktopSource(sourceId, {});
        if (cap.error) return { error: cap.error };

        const caption = opts?.caption || pending.caption || '';
        const saved = await previewService.saveSnapshot(userDataPath, cap.pngBuffer, {
            kind: 'screenshot',
            scope: pending.scope || opts?.scope || 'window',
            caption,
            sourceId
        });

        const { port, host, token } = hostPortToken(opts);
        const snapshotUrl = previewService.buildAssetUrl(host, port, saved.previewId, 'png', token);
        emit({
            type: 'snapshot',
            previewId: saved.previewId,
            kind: 'screenshot',
            caption,
            snapshotUrl
        });
        return { success: true, previewId: saved.previewId, snapshotUrl };
    }

    function close() {
        emit({ type: 'closed' });
        pendingCaptures.clear();
        return { success: true };
    }

    return { show, captureSource, close, emit, listSources: () => previewService.listDesktopSources() };
}

module.exports = { createPreviewRunner };
