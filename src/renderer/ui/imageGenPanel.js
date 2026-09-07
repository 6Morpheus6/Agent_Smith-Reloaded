/**
 * imageGenPanel — v51.7 Image Generation UI (sidebar section + 🎨 IMG chip state).
 *
 * Wires the IMAGE GEN sidebar section to the main-process imagegen IPC domain and
 * keeps the cockpit chip / hidden checkbox in sync with persisted state. Also
 * renders live progress events (engine/model download, sampling steps) into the
 * status line so long first-run downloads are visible.
 */
(function (global) {
    'use strict';

    const $ = (id) => document.getElementById(id);
    let wired = false;
    let unsubEvent = null;

    function api() { return global.window && global.window.api ? global.window.api : null; }

    async function invoke(channel, ...args) {
        const a = api();
        if (!a || !a.invoke) throw new Error('IPC unavailable');
        return a.invoke(channel, ...args);
    }

    function fmtSize(bytes) {
        if (!bytes && bytes !== 0) return '';
        if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
        if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
        return `${Math.round(bytes / 1024)} KB`;
    }

    function setStatus(text, isError) {
        const el = $('imagegen-status-line');
        if (!el) return;
        el.textContent = text || '';
        el.style.color = isError ? 'var(--danger-color)' : '';
    }

    function setProgress(text, show) {
        const el = $('imagegen-progress-line');
        if (!el) return;
        el.style.display = show && text ? 'block' : 'none';
        if (text) el.textContent = text;
    }

    async function refresh() {
        let st;
        try { st = await invoke('imagegen-status'); } catch (e) { setStatus(`Image gen unavailable: ${e.message}`, true); return null; }
        if (!st || st.error) { setStatus(st?.error || 'Image gen status failed', true); return null; }

        // Enabled state — keep chip + hidden checkbox + section check in sync.
        const toggle = $('image-gen-toggle');
        const check = $('imagegen-enabled-check');
        if (toggle && toggle.checked !== st.enabled) { toggle.checked = !!st.enabled; toggle.dispatchEvent(new Event('change', { bubbles: true })); }
        if (check) check.checked = !!st.enabled;

        // Settings sliders.
        const s = st.settings || {};
        const setVal = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
        const setLabel = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
        setVal('imagegen-width', s.width); setLabel('imagegen-width-val', s.width);
        setVal('imagegen-height', s.height); setLabel('imagegen-height-val', s.height);
        setVal('imagegen-steps', s.steps); setLabel('imagegen-steps-val', s.steps);
        setVal('imagegen-cfg', s.cfgScale); setLabel('imagegen-cfg-val', Number(s.cfgScale).toFixed(1));
        const sampler = $('imagegen-sampler'); if (sampler && document.activeElement !== sampler) sampler.value = s.sampler || 'euler';
        const neg = $('imagegen-neg-prompt'); if (neg && document.activeElement !== neg) neg.value = s.negativePrompt || '';

        // Model list.
        const list = $('imagegen-model-list');
        if (list) {
            const models = st.models || [];
            if (!models.length) {
                list.innerHTML = '<div>No models detected — first image request auto-downloads the default.</div>';
            } else {
                list.innerHTML = '';
                for (const m of models) {
                    const row = document.createElement('label');
                    row.className = 'chip-note';
                    row.style.display = 'flex';
                    row.style.alignItems = 'center';
                    row.style.gap = '0.5rem';
                    row.style.cursor = 'pointer';
                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = 'imagegen-model';
                    radio.checked = st.selectedModel === m.name;
                    radio.addEventListener('change', async () => {
                        try { await invoke('imagegen-select-model', m.name); refresh(); } catch (e) { setStatus(e.message, true); }
                    });
                    const label = document.createElement('span');
                    label.textContent = `${m.name} (${fmtSize(m.size)})`;
                    row.appendChild(radio);
                    row.appendChild(label);

                    const rm = document.createElement('button');
                    rm.className = 'test-btn btn-ghost';
                    rm.style.marginLeft = 'auto';
                    rm.textContent = '✕';
                    rm.title = 'Remove this model file';
                    rm.addEventListener('click', async (ev) => {
                        ev.preventDefault();
                        if (!confirm(`Delete ${m.name}?`)) return;
                        try { await invoke('imagegen-remove-model', m.name); refresh(); } catch (e) { setStatus(e.message, true); }
                    });
                    row.appendChild(rm);
                    list.appendChild(row);
                }
            }
        }

        // v51.8: reflect a live download even when the user opens the section mid-download
        // (the status snapshot carries engineBusy/modelBusy — no push event needed).
        let busyNote = '';
        if (st.modelBusy) {
            const mb = st.modelBusy;
            busyNote = ` · ⬇ downloading ${mb.name} (${fmtSize(mb.received)}${mb.total ? '/' + fmtSize(mb.total) : ''})`;
        } else if (st.engineBusy === 'download') {
            busyNote = ' · ⬇ downloading engine';
        } else if (st.engineBusy === 'extract') {
            busyNote = ' · 📦 extracting engine';
        }

        const modelLabel = st.resolvedModelPath ? st.selectedModel || 'auto-detected' : `will auto-download ${st.defaultModel}`;
        setStatus(`Engine: ${st.engineReady ? 'ready' : (st.engineBusy ? 'downloading…' : 'downloads on first use')} · Model: ${modelLabel}${busyNote}`);
        return st;
    }

    function wireSettings() {
        const save = () => {
            const settings = {
                width: parseInt($('imagegen-width')?.value, 10),
                height: parseInt($('imagegen-height')?.value, 10),
                steps: parseInt($('imagegen-steps')?.value, 10),
                cfgScale: parseFloat($('imagegen-cfg')?.value),
                sampler: $('imagegen-sampler')?.value || 'euler',
                negativePrompt: $('imagegen-neg-prompt')?.value || ''
            };
            invoke('imagegen-update-settings', settings).catch(() => {});
        };
        for (const id of ['imagegen-width', 'imagegen-height', 'imagegen-steps', 'imagegen-cfg']) {
            const el = $(id);
            if (!el) continue;
            el.addEventListener('input', () => {
                const valEl = $(`${id}-val`);
                if (valEl) valEl.textContent = id === 'imagegen-cfg' ? Number(el.value).toFixed(1) : el.value;
            });
            el.addEventListener('change', save);
        }
        for (const id of ['imagegen-sampler', 'imagegen-neg-prompt']) {
            const el = $(id);
            if (el) el.addEventListener('change', save);
        }
    }

    function wireButtons() {
        $('imagegen-import-btn')?.addEventListener('click', async () => {
            try {
                const res = await invoke('imagegen-pick-file');
                if (res && !res.canceled) refresh();
            } catch (e) { setStatus(e.message, true); }
        });
        $('imagegen-refresh-btn')?.addEventListener('click', () => refresh());
        $('imagegen-import-url-btn')?.addEventListener('click', async () => {
            const url = ($('imagegen-import-url')?.value || '').trim();
            if (!url) return;
            setProgress(`⬇ Downloading ${url} …`, true);
            try {
                await invoke('imagegen-import-url', url);
                // v51.8: clear the progress line on success (the 'import' done event also fires).
                setProgress('', false);
                refresh();
            } catch (e) { setStatus(e.message, true); }
        });

        const check = $('imagegen-enabled-check');
        check?.addEventListener('change', async () => {
            const toggle = $('image-gen-toggle');
            if (toggle && toggle.checked !== check.checked) {
                toggle.checked = check.checked;
                toggle.dispatchEvent(new Event('change', { bubbles: true })); // app.js persists + updates toolset
            } else {
                try { await invoke('imagegen-set-enabled', !!check.checked); } catch (_) {}
            }
        });

        const toggle = $('image-gen-toggle');
        toggle?.addEventListener('change', async () => {
            try { await invoke('imagegen-set-enabled', !!toggle.checked); } catch (_) {}
            if (check) check.checked = !!toggle.checked;
        });
    }

    function wireEvents() {
        const a = api();
        if (!a || !a.on) return;
        unsubEvent && unsubEvent();
        unsubEvent = a.on('imagegen-event', (ev) => {
            if (!ev || typeof ev !== 'object') return;
            if (ev.phase === 'engine' || ev.phase === 'model' || ev.phase === 'import') {
                const name = ev.name || (ev.phase === 'engine' ? 'image engine' : 'model');
                if (ev.status === 'downloading') {
                    // v51.8: show REAL bytes moved even when the server omits content-length
                    // (pct null) — "no proof it's downloading" was the v51.7 complaint.
                    const pct = ev.pct != null ? ` ${ev.pct}%` : '';
                    const bytes = ev.received ? `${fmtSize(ev.received)}${ev.total ? '/' + fmtSize(ev.total) : ''}` : 'connecting…';
                    setProgress(`⬇ Downloading ${name} — ${bytes}${pct}`, true);
                } else if (ev.status === 'extracting') {
                    setProgress(`📦 Extracting ${name}…`, true);
                } else if (ev.status === 'ready') {
                    setProgress('', false);
                    refresh();
                } else if (ev.status === 'error') {
                    setStatus(`${ev.phase === 'engine' ? 'Engine download failed' : 'Model download failed'}: ${ev.error || 'unknown error'}`, true);
                    setProgress(`✗ Download failed — ${name}: ${ev.error || ''}`, true);
                }
            } else if (ev.phase === 'generate') {
                if (ev.status === 'sampling' && ev.step != null) setProgress(`🎨 Rendering image… step ${ev.step}/${ev.total}`, true);
                else if (ev.status === 'provisioning') setProgress('⬇ First run: downloading engine + model — this can take several minutes…', true);
                else if (ev.status === 'starting') setProgress('🎨 Starting renderer…', true);
                else if (ev.status === 'done') { setProgress('', false); refresh(); }
                else if (ev.status === 'error') { setStatus(`Image generation failed: ${ev.error || 'unknown'}`, true); setProgress(`✗ Generation failed — no image created`, true); }
            }
        });
    }

    function init() {
        if (wired) return;
        wired = true;
        wireSettings();
        wireButtons();
        wireEvents();
        refresh();
    }

    const apiObj = { init, refresh };
    if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
    if (global.window) global.window.XKImageGenPanel = apiObj;

    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : globalThis);
