/**
 * v55.3 — Electron Depot auto-provisioning UI (sidebar "BUILD ASSETS" section).
 *
 * The app no longer bundles vendor/ (~635 MB of Electron runtimes + builder toolsets) in the
 * AppImage/.deb; on first launch the main process detects what is missing from the local cache
 * and downloads it. This panel surfaces that: live "downloading… X/Y MB (N%)" progress while a
 * transfer runs, an honest final state (ready / partial with retry), and a RETRY button after
 * failures. Events arrive over 'electron-assets-event' (push); initial state via
 * 'electron-assets-status' (invoke) in case events fired before this listener attached.
 */
(function (global) {
    'use strict';

    const $ = (id) => document.getElementById(id);
    let wired = false;
    let unsubEvent = null;
    let active = false; // true while scanning/downloading/verifying — drives auto-expand + bar

    function api() { return global.window && global.window.api; }

    function fmtSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const mb = bytes / (1024 * 1024);
        if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
        if (mb >= 1) return `${mb.toFixed(1)} MB`;
        return `${Math.round(bytes / 1024)} KB`;
    }

    function setProgress(text, showBar, pct) {
        const wrap = $('electron-assets-progress-wrap');
        const nameEl = $('electron-assets-progress-name');
        const fill = $('electron-assets-progress-fill');
        if (!wrap || !nameEl || !fill) return;
        if (showBar && text) {
            wrap.style.display = '';
            nameEl.textContent = text;
            fill.style.width = `${Math.max(0, Math.min(100, pct == null ? 0 : pct))}%`;
        } else {
            wrap.style.display = 'none';
            fill.style.width = '0%';
        }
    }

    function setStatus(text, isError) {
        const el = $('electron-assets-status-line');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('chip-note--error', !!isError);
    }

    function setRetryVisible(show) {
        const btn = $('electron-assets-retry-btn');
        if (btn) btn.style.display = show ? '' : 'none';
    }

    /** Expand the section while work is in flight so first-launch users actually SEE it. */
    function setActive(isActive) {
        active = !!isActive;
        const section = document.querySelector('[data-section="buildassets"]');
        if (!section) return;
        if (active && section.classList.contains('collapsed')) section.classList.remove('collapsed');
    }

    /** Render from a full status object (invoke response or final event). */
    function renderStatus(st) {
        if (!st || typeof st !== 'object') return;
        const total = st.total || 0;
        const failed = Array.isArray(st.failed) ? st.failed : [];
        if (st.phase === 'scanning' || st.phase === 'downloading' || st.phase === 'verifying') {
            setActive(true);
            setStatus(`Checking build assets… (${total} total)`);
            setRetryVisible(false);
            return;
        }
        setActive(false);
        if (st.phase === 'complete') {
            setStatus(`✅ Build assets ready — ${total}/${total} cached for offline packaging.`);
            setProgress('', false);
            setRetryVisible(false);
        } else if (st.phase === 'complete-with-errors') {
            const ok = total - failed.length;
            setStatus(`⚠ Build assets: ${ok}/${total} ready — ${failed.length} failed (${failed.join(', ')})`, true);
            setProgress('', false);
            setRetryVisible(true);
        } else if (st.phase === 'error') {
            setStatus(`✗ Build asset check failed: ${st.error || 'unknown error'}`, true);
            setRetryVisible(true);
        } else {
            // idle — nothing has run yet this session; the main process kicks it off at startup.
            setStatus('Checking…');
        }
    }

    function wireEvents() {
        const a = api();
        if (!a || !a.on) return;
        unsubEvent && unsubEvent();
        unsubEvent = a.on('electron-assets-event', (ev) => {
            if (!ev || typeof ev !== 'object') return;
            switch (ev.phase) {
                case 'scanning':
                    setActive(true);
                    setStatus(`Checking build assets… ${ev.present != null ? `${ev.present}/${ev.total} already cached` : ''}${ev.missing ? `, downloading ${ev.missing}` : ''}`);
                    setRetryVisible(false);
                    break;
                case 'downloading': {
                    setActive(true);
                    const got = ev.received || 0;
                    const tot = ev.totalBytes || 0;
                    const pctTxt = ev.pct != null ? ` ${ev.pct}%` : '';
                    setStatus(`⬇ Downloading build assets…`);
                    setProgress(`${ev.name} — ${fmtSize(got)}${tot ? ' / ' + fmtSize(tot) : ''}${pctTxt}`, true, ev.pct);
                    break;
                }
                case 'verifying':
                    setActive(true);
                    setStatus(`⬇ Downloading build assets…`);
                    setProgress(`${ev.name} — verifying checksum…`, true, 100);
                    break;
                case 'done':
                    // per-file completion; the final phase event carries the summary.
                    break;
                case 'error':
                    setStatus(`✗ ${ev.name}: ${ev.error || 'download failed'}`, true);
                    setRetryVisible(true);
                    break;
                case 'complete':
                case 'complete-with-errors': {
                    setActive(false);
                    const total = ev.total != null ? ev.total : 0;
                    const failedCount = Array.isArray(ev.failed) ? ev.failed.length : (ev.installed != null && ev.present != null ? Math.max(0, total - ev.installed - ev.present) : 0);
                    if (!failedCount || ev.phase === 'complete') {
                        setStatus(`✅ Build assets ready — ${total}/${total} cached for offline packaging.`);
                        setRetryVisible(false);
                    } else {
                        const ok = Math.max(0, total - failedCount);
                        setStatus(`⚠ Build assets: ${ok}/${total} ready — ${failedCount} failed`, true);
                        setRetryVisible(true);
                    }
                    setProgress('', false);
                    break;
                }
            }
        });
    }

    function wireButtons() {
        const btn = $('electron-assets-retry-btn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            setStatus('Retrying download…');
            setActive(true);
            try { await api().invoke('electron-assets-retry'); } catch (_) {}
            // the final event (or a fresh status poll) repaints the real outcome
            try { renderStatus(await api().invoke('electron-assets-status')); } catch (_) {}
            btn.disabled = false;
        });
    }

    async function init() {
        if (wired) return;
        wired = true;
        wireEvents();
        wireButtons();
        // Catch up: events may have fired before this listener attached.
        try { renderStatus(await api().invoke('electron-assets-status')); } catch (_) {}
    }

    const apiObj = { init };
    if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
    if (global.window) global.window.XKElectronAssetsPanel = apiObj;

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : globalThis);
