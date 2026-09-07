/**
 * Preview drawer — live project iframe, web snapshots, desktop source picker.
 */
(function (global) {
    'use strict';

    let mountEl = null;
    let state = { liveUrl: null, previewId: null, kind: null };

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Plan-approval priority: never AUTO-open the preview drawer over the Build Plan while
    // Code Mode is planning or awaiting approval — the approval controls must stay reachable
    // (show_preview is a read tool the model can call during planning). The content is still
    // rendered into the panel, so manual open / execution-time previews show it; only the
    // automatic drawer takeover is suppressed. Manual open and post-approval previews work.
    function previewAutoOpenBlocked() {
        try {
            const phase = window.XKCodePlanPanel?.getState?.().phase;
            return phase === 'planning' || phase === 'approval';
        } catch (e) { return false; }
    }
    function maybeEnterPreview(label) {
        if (previewAutoOpenBlocked()) return;
        window.XKSidebarLayout?.enterPreviewMode?.({ label });
    }

    // The preview HTTP route (/preview/*) is auth-gated, but the iframe/img load is a
    // cross-origin request that can't carry the session cookie — so it 401s and renders
    // blank. The desktop renderer holds the session token; append it as ?token= (the
    // server reads queryToken) so the preview actually loads. No-op if no token / already set.
    function withAuth(url) {
        if (!url) return url;
        try {
            const token = (typeof localStorage !== 'undefined') ? localStorage.getItem('auth_token') : null;
            if (!token || /[?&]token=/.test(url)) return url;
            return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
        } catch (e) { return url; }
    }

    function toolbarHtml(showReload) {
        return `
            <div class="preview-toolbar">
                ${showReload ? '<button type="button" class="arc-btn" id="preview-reload-btn">RELOAD</button>' : ''}
                <button type="button" class="arc-btn" id="preview-open-ext-btn">OPEN EXTERNAL</button>
                <button type="button" class="arc-btn arc-btn-danger" id="preview-close-btn">CLOSE</button>
            </div>`;
    }

    function renderLive(ev) {
        if (!mountEl) return;
        state = { liveUrl: ev.liveUrl, previewId: ev.previewId, kind: ev.kind, target: ev.relPath };
        mountEl.innerHTML = `
            <div class="agent-run-card arc-executing preview-card">
                <div class="arc-header">
                    <span class="arc-phase">LIVE</span>
                    <span class="arc-goal">${escapeHtml(ev.caption || ev.relPath || 'Preview')}</span>
                </div>
                <div class="arc-body preview-body">
                    <iframe class="preview-frame" id="preview-iframe" src="${escapeHtml(withAuth(ev.liveUrl) || '')}" title="Project preview"></iframe>
                </div>
                ${toolbarHtml(true)}
            </div>`;
        wireToolbar(ev);
        maybeEnterPreview(ev.relPath || 'live');
    }

    function renderSnapshot(ev) {
        if (!mountEl) return;
        state = { liveUrl: null, snapshotUrl: ev.snapshotUrl, previewId: ev.previewId, kind: ev.kind, target: ev.target };
        mountEl.innerHTML = `
            <div class="agent-run-card arc-done preview-card">
                <div class="arc-header">
                    <span class="arc-phase arc-done">SNAPSHOT</span>
                    <span class="arc-goal">${escapeHtml(ev.caption || ev.target || 'Preview')}</span>
                </div>
                <div class="arc-body preview-body">
                    <img class="preview-snapshot" src="${escapeHtml(withAuth(ev.snapshotUrl) || '')}" alt="Preview snapshot">
                </div>
                ${toolbarHtml(false)}
            </div>`;
        wireToolbar(ev);
        maybeEnterPreview('snapshot');
    }

    function renderSourcePicker(ev) {
        if (!mountEl) return;
        state = { previewId: ev.previewId, kind: ev.kind, picking: true };
        mountEl.innerHTML = `
            <div class="agent-run-card arc-paused preview-card">
                <div class="arc-header">
                    <span class="arc-phase arc-approval">PICK SOURCE</span>
                    <span class="arc-goal">${escapeHtml(ev.caption || 'Select screen or window')}</span>
                </div>
                <div class="arc-body preview-body">
                    <p class="arc-note loading-pulse">Loading sources…</p>
                    <div class="preview-source-picker" id="preview-source-grid"></div>
                </div>
                ${toolbarHtml(false)}
            </div>`;
        wireToolbar(ev);
        maybeEnterPreview('pick');
        loadSources(ev.previewId);
    }

    async function loadSources(previewId) {
        const grid = document.getElementById('preview-source-grid');
        if (!grid || !window.api) return;
        const res = await window.api.invoke('preview-list-sources');
        if (res?.error) {
            grid.innerHTML = `<p class="arc-note">${escapeHtml(res.error)}</p>`;
            return;
        }
        const sources = res.sources || [];
        if (!sources.length) {
            grid.innerHTML = '<p class="arc-note">No capture sources available.</p>';
            return;
        }
        grid.innerHTML = sources.map(s => `
            <button type="button" class="preview-source-item" data-id="${escapeHtml(s.id)}">
                ${s.thumbnail ? `<img src="${s.thumbnail}" alt="">` : ''}
                <span>${escapeHtml(s.name)}</span>
            </button>`).join('');
        grid.querySelectorAll('.preview-source-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                const sourceId = btn.getAttribute('data-id');
                btn.disabled = true;
                await window.api.invoke('preview-capture-source', { sourceId, previewId });
            });
        });
    }

    function wireToolbar(ev) {
        document.getElementById('preview-reload-btn')?.addEventListener('click', () => {
            const iframe = document.getElementById('preview-iframe');
            if (iframe && state.liveUrl) iframe.src = withAuth(state.liveUrl);
        });
        document.getElementById('preview-open-ext-btn')?.addEventListener('click', () => {
            const url = withAuth(state.liveUrl || ev.snapshotUrl) || ev.target;
            if (url && window.api) window.api.invoke('open-external-url', url);
        });
        document.getElementById('preview-close-btn')?.addEventListener('click', async () => {
            if (window.api) await window.api.invoke('preview-close');
            clear();
        });
    }

    function handleEvent(ev) {
        if (!ev?.type) return;
        switch (ev.type) {
        case 'live':
            renderLive(ev);
            break;
        case 'snapshot':
            renderSnapshot(ev);
            break;
        case 'pick_source':
            renderSourcePicker(ev);
            break;
        case 'closed':
            clear();
            break;
        default:
            break;
        }
    }

    function clear() {
        state = { liveUrl: null, previewId: null, kind: null };
        if (mountEl) mountEl.innerHTML = '';
        window.XKSidebarLayout?.exitPreviewMode?.();
    }

    function init() {
        mountEl = document.getElementById('preview-panel-mount');
        const chipOpen = document.getElementById('preview-chip-open');
        const exitBtn = document.getElementById('preview-exit-btn');
        chipOpen?.addEventListener('click', () => window.XKSidebarLayout?.openPreviewDrawer?.());
        exitBtn?.addEventListener('click', () => window.XKSidebarLayout?.collapsePreviewDrawer?.());
    }

    const api = { init, handleEvent, clear };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKPreviewPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
