/**
 * v56.2 — APP UPDATE UI (sidebar "APP UPDATE" section).
 *
 * The main process (src/main/lifecycle/updater.js) owns the GitHub Releases API,
 * the download + SHA-256 verification, and the install (AppImage swap / apt hand-off).
 * This panel drives it: CHECK FOR UPDATES → status line + release notes; DOWNLOAD UPDATE
 * → live progress bar; INSTALL UPDATE → relaunch (AppImage) or apt (deb). Progress events
 * arrive over 'update-event' (push); initial state via 'updater-status' (invoke) in case
 * events fired before this listener attached.
 */
(function (global) {
    'use strict';

    const $ = (id) => document.getElementById(id);
    let wired = false;
    let unsubEvent = null;
    let active = false; // true while checking/downloading/installing — drives auto-expand + bar
    let updateAvailable = false;
    let downloadedFile = null;

    function api() { return global.window && global.window.api; }

    function fmtSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const mb = bytes / (1024 * 1024);
        if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
        if (mb >= 1) return `${mb.toFixed(1)} MB`;
        return `${Math.round(bytes / 1024)} KB`;
    }

    function setProgress(text, showBar, pct) {
        const wrap = $('updater-progress-wrap');
        const nameEl = $('updater-progress-name');
        const fill = $('updater-progress-fill');
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
        const el = $('updater-status-line');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('chip-note--error', !!isError);
    }

    function setNotes(html) {
        const el = $('updater-release-notes');
        if (!el) return;
        if (html) { el.innerHTML = html; el.style.display = ''; }
        else { el.innerHTML = ''; el.style.display = 'none'; }
    }

    /** Escape user-controlled text before it touches innerHTML. */
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function setButtons(checkDisabled, downloadDisabled, installDisabled) {
        const c = $('updater-check-btn'); if (c) c.disabled = !!checkDisabled;
        const d = $('updater-download-btn'); if (d) d.disabled = !!downloadDisabled;
        const i = $('updater-install-btn'); if (i) i.disabled = !!installDisabled;
    }

    /** Expand the section while work is in flight so users actually SEE it. */
    function setActive(isActive) {
        active = !!isActive;
        const section = document.querySelector('[data-section="appupdate"]');
        if (!section) return;
        if (active && section.classList.contains('collapsed')) section.classList.remove('collapsed');
    }

    /** Render from a full status object (invoke response). */
    function renderStatus(st) {
        if (!st || typeof st !== 'object') return;
        const cur = st.currentVersion || '?';
        if (!st.lastCheck) {
            setStatus(`Running v${cur} — press CHECK FOR UPDATES.`);
            setButtons(false, true, true);
            return;
        }
        renderChecked(st.lastCheck);
    }

    /** Render from a check result (updater-check response or lastCheck). */
    function renderChecked(chk) {
        if (!chk || typeof chk !== 'object') return;
        const cur = chk.currentVersion || '?';
        const latest = chk.latestVersion || (chk.release && chk.release.tag);
        updateAvailable = !!chk.updateAvailable;
        setButtons(false, !updateAvailable, false);
        if (!latest) { setStatus(`Running v${cur} — no release info.`, true); return; }
        if (updateAvailable) {
            setStatus(`⬆ Update available: v${cur} → v${latest}`);
            const notes = chk.release && chk.release.body ? esc(chk.release.body).slice(0, 600) : '';
            setNotes(notes ? `<strong>${esc(latest)}</strong><br>${notes}${chk.release.body.length > 600 ? '…' : ''}` : '');
        } else {
            setStatus(`✅ Up to date — v${cur} is the latest release.`);
            setNotes('');
        }
    }

    function wireEvents() {
        const a = api();
        if (!a || !a.on) return;
        unsubEvent && unsubEvent();
        unsubEvent = a.on('update-event', (ev) => {
            if (!ev || typeof ev !== 'object') return;
            switch (ev.phase) {
                case 'checking':
                    setActive(true);
                    setStatus('Checking GitHub Releases…');
                    setButtons(true, true, true);
                    break;
                case 'checked':
                    // The invoke response carries the full result — it repaints.
                    break;
                case 'downloading': {
                    setActive(true);
                    const got = ev.received || 0;
                    const tot = ev.totalBytes || 0;
                    const pctTxt = ev.pct != null ? ` ${ev.pct}%` : '';
                    setStatus('⬇ Downloading update…');
                    setProgress(`${ev.name} — ${fmtSize(got)}${tot ? ' / ' + fmtSize(tot) : ''}${pctTxt}`, true, ev.pct);
                    break;
                }
                case 'verifying':
                    setActive(true);
                    setStatus('⬇ Downloading update…');
                    setProgress(`${ev.name} — verifying SHA-256 checksum…`, true, 100);
                    break;
                case 'downloaded':
                    downloadedFile = ev.file || null;
                    setActive(false);
                    setStatus(`✅ Update ready (${fmtSize(ev.size || 0)}${ev.verified ? ', checksum verified' : ''}) — press INSTALL UPDATE.`);
                    setProgress('', false);
                    setButtons(false, true, false);
                    break;
                case 'installing':
                    setActive(true);
                    setStatus('⚙ Installing update…');
                    setButtons(true, true, true);
                    break;
                case 'installed':
                    setActive(false);
                    if (ev.relaunched) {
                        setStatus('✅ Update installed — restarting into the new version…');
                    } else {
                        setStatus('✅ Update swapped in place.');
                    }
                    setProgress('', false);
                    break;
                case 'handed-off':
                    setActive(false);
                    setStatus(`✅ ${ev.method || 'package manager'} finished — restart Agent Smith to run the new version.`);
                    setProgress('', false);
                    setButtons(false, true, true);
                    break;
                case 'error':
                    setActive(false);
                    setStatus(`✗ ${ev.error || 'update failed'}`, true);
                    setProgress('', false);
                    // Re-enable the flow from where it can sensibly resume.
                    setButtons(false, updateAvailable, !!downloadedFile);
                    break;
            }
        });
    }

    function wireButtons() {
        const checkBtn = $('updater-check-btn');
        if (checkBtn) {
            checkBtn.addEventListener('click', async () => {
                setButtons(true, true, true);
                setStatus('Checking GitHub Releases…');
                setActive(true);
                try {
                    const res = await api().invoke('updater-check');
                    if (!res.ok) throw new Error(res.error || 'check failed');
                    renderChecked(res);
                } catch (err) {
                    setStatus(`✗ ${(err && err.message) || 'check failed'}`, true);
                    setButtons(false, false, false);
                } finally {
                    setActive(false);
                }
            });
        }

        const dlBtn = $('updater-download-btn');
        if (dlBtn) {
            dlBtn.addEventListener('click', async () => {
                setButtons(true, true, true);
                setStatus('⬇ Downloading update…');
                setActive(true);
                try {
                    const res = await api().invoke('updater-download');
                    if (!res.ok) throw new Error(res.error || 'download failed');
                    downloadedFile = res.file;
                    // The 'downloaded' event already painted the ready state.
                } catch (err) {
                    setStatus(`✗ ${(err && err.message) || 'download failed'}`, true);
                    setButtons(false, updateAvailable, false);
                } finally {
                    setActive(false);
                }
            });
        }

        const installBtn = $('updater-install-btn');
        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                // .deb installs need root — pass the SUDO OVERRIDE password when present.
                const sudoInput = $('sudo-input');
                const payload = { file: downloadedFile || undefined };
                if (sudoInput && sudoInput.value) payload.sudoPass = sudoInput.value;
                setButtons(true, true, true);
                setStatus('⚙ Installing update…');
                setActive(true);
                try {
                    const res = await api().invoke('updater-install', payload);
                    if (!res.ok) throw new Error(res.error || 'install failed');
                    // 'installed' / 'handed-off' events paint the final state.
                } catch (err) {
                    setStatus(`✗ ${(err && err.message) || 'install failed'}`, true);
                    setButtons(false, updateAvailable, !!downloadedFile);
                } finally {
                    setActive(false);
                }
            });
        }
    }

    async function init() {
        if (wired) return;
        wired = true;
        wireEvents();
        wireButtons();
        // Catch up: events may have fired before this listener attached.
        try { renderStatus(await api().invoke('updater-status')); } catch (_) {}
    }

    const apiObj = { init };
    if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
    if (global.window) global.window.XKAppUpdatePanel = apiObj;

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : globalThis);
