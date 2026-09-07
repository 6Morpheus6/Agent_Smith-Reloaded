/**
 * Runtime profile UI — auto-tune existing TUNING sliders on model change.
 */
(function (global) {
    'use strict';

    const LS_AUTO = 'agentsmith_auto_tune';
    const LS_OVERRIDE = 'agentsmith_profile_override';
    // v52.7: agentsmith_max_turns is no longer written — turns are infinite (see getMaxTurns).
    const LS_CODE_TEMP = 'agentsmith_code_temperature';

    function buildProfile(modelId, telemetry) {
        const fn = global.XKRuntimeProfile?.buildRuntimeProfile;
        if (!fn) return null;
        return fn({ modelId, telemetry });
    }

    function applyProfileToSliders(profile, els) {
        if (!profile || !els) return;
        const { tempSlider, tempVal, ctxSlider, ctxVal } = els;
        // v52.7: the "Thinking Steps" slider is gone — turns are infinite in every mode, so
        // there is no steps value to apply (maxSteps/maxTurns on the profile are vestigial).
        if (tempSlider) {
            tempSlider.value = String(profile.temperature);
            if (tempVal) tempVal.textContent = profile.temperature.toFixed(1);
        }
        if (ctxSlider) {
            ctxSlider.value = String(profile.numCtx);
            if (ctxVal) ctxVal.textContent = String(profile.numCtx);
        }
    }

    let _els = null;
    let _chipEl = null;
    let _toggleEl = null;
    let _modelSelect = null;
    let _lastProfile = null;
    let _applying = false;
    let _invoke = null;
    let _getApiBaseUrl = null;
    let _isBusy = null;
    let _debounceMs = 350;
    let _ctxTimer = null;
    let _pendingSync = null;
    let _syncing = false;
    // v51.5 — last VERIFIED loaded context for the selected model (from LM Studio's own state,
    // not a computed default). Cached so sendMessage() can enforce the min-ctx gate without
    // an extra round-trip. null until first successful verification.
    let _loadedCtx = null;
    let _refreshTimer = null;
    // v52.5 — model id whose load was JUST handled by a swap (lmstudio-swap-model). While
    // set, applyForModel skips its own context sync: the swap already loaded this model at
    // exactly the context we asked for, and re-syncing would trigger a second full reload
    // of a 20GB+ model seconds after the first one finished.
    let _swapHandledCtx = null;
    let _swapHandledAt = 0;

    function isAutoTuneEnabled() {
        return localStorage.getItem(LS_AUTO) !== 'false';
    }

    function setOverride(flag) {
        localStorage.setItem(LS_OVERRIDE, flag ? 'true' : 'false');
    }

    function hasOverride() {
        return localStorage.getItem(LS_OVERRIDE) === 'true';
    }

    function persistCodeFields(profile) {
        if (!profile) return;
        // v52.7: max turns are infinite — nothing to persist for them anymore.
        localStorage.setItem(LS_CODE_TEMP, String(profile.codeTemperature));
    }

    function updateChip(profile) {
        if (!_chipEl) return;
        if (!profile) {
            _chipEl.textContent = '';
            _chipEl.title = '';
            return;
        }
        let text = profile.summary;
        if (profile.warnings?.length) text += ' — ' + profile.warnings[0];
        _chipEl.textContent = text;
        _chipEl.title = (profile.warnings || []).join('\n');
    }

    function setChipStatus(text, title) {
        if (!_chipEl) return;
        _chipEl.textContent = text || '';
        _chipEl.title = title || '';
    }

    function apiInvoke() {
        return _invoke || global.window?.api?.invoke || global.api?.invoke;
    }

    /**
     * v51.5 — REFLECT: ask the main process what LM Studio ACTUALLY has loaded for this model
     * (the user's own context setting in LM Studio) and mirror it over the slider, so the app
     * never shows a computed default that disagrees with reality. The chip stays owned by the
     * auto-tune profile / sync status — reflection only moves the slider + caches the verified
     * value for the min-ctx gate; unmanaged/remote endpoints clear the cache (nothing to verify).
     */
    async function refreshLoadedContext(modelId) {
        if (!modelId || !_els?.ctxSlider) return null;
        const invoke = apiInvoke();
        if (typeof invoke !== 'function') return null;
        let result = null;
        try {
            result = await invoke('lmstudio-get-status', { apiBaseUrl: currentApiBase(), model: modelId });
        } catch (e) { /* status is advisory — fall through to the computed profile */ }
        _loadedCtx = Number(result?.managed === true ? result.loadedContext : NaN);
        if (!Number.isFinite(_loadedCtx)) _loadedCtx = null;
        if (_loadedCtx > 0 && String(_els.ctxSlider.value) !== String(_loadedCtx)) {
            // The loaded window is ground truth for the slider — override whatever was set.
            _applying = true;
            _els.ctxSlider.value = String(Math.min(_loadedCtx, Number(_els.ctxSlider.max) || _loadedCtx));
            if (_els.ctxVal) _els.ctxVal.textContent = String(_loadedCtx);
            _applying = false;
        }
        return _loadedCtx;
    }

    /** Verified loaded context for the current selection, or null when unverified. */
    function getVerifiedLoadedCtx() {
        return _loadedCtx;
    }

    function currentApiBase() {
        if (typeof _getApiBaseUrl === 'function') return _getApiBaseUrl();
        return global.currentApiBase || 'http://127.0.0.1:1234';
    }

    function busyNow() {
        try {
            return typeof _isBusy === 'function' && _isBusy();
        } catch (e) {
            return false;
        }
    }

    function syncLabel(result) {
        if (!result) return '';
        if (result.managed === false) {
            if (result.reason === 'remote_endpoint') return 'server-managed context';
            return result.warning || result.error || 'LM Studio unmanaged';
        }
        if (result.fallbackUsed) return `fallback ctx ${result.loadedContext}`;
        if (result.loadedContext) return `LM Studio ctx ${result.loadedContext}`;
        return 'LM Studio ready';
    }

    function applyLoadedContext(result) {
        const loaded = Number(result?.loadedContext);
        if (!Number.isFinite(loaded) || loaded <= 0 || !_els?.ctxSlider) return;
        if (String(_els.ctxSlider.value) === String(loaded)) return;
        _applying = true;
        _els.ctxSlider.value = String(loaded);
        if (_els.ctxVal) _els.ctxVal.textContent = String(loaded);
        _applying = false;
    }

    async function syncContextForModel(modelId, contextLength) {
        if (!modelId || !contextLength) return null;
        const request = {
            apiBaseUrl: currentApiBase(),
            model: modelId,
            contextLength: parseInt(contextLength, 10)
        };
        if (busyNow()) {
            _pendingSync = request;
            setChipStatus(`Context change queued (${request.contextLength})`, 'Will reload LM Studio after the active run finishes.');
            return { queued: true };
        }
        const invoke = apiInvoke();
        if (typeof invoke !== 'function') return null;
        _syncing = true;
        setChipStatus(`Reloading LM Studio ctx ${request.contextLength}...`, '');
        try {
            const result = await invoke('lmstudio-ensure-model', request);
            if (result?.managed === false) {
                setChipStatus(syncLabel(result), result.warning || result.error || '');
                return result;
            }
            applyLoadedContext(result);
            setChipStatus(syncLabel(result), result?.warning || '');
            return result;
        } catch (e) {
            setChipStatus('LM Studio sync failed', e.message || String(e));
            return { managed: false, error: e.message || String(e) };
        } finally {
            _syncing = false;
        }
    }

    async function flushPendingContextSync() {
        if (!_pendingSync || busyNow() || _syncing) return null;
        const pending = _pendingSync;
        _pendingSync = null;
        // v52.5: the selection moved on (a model swap queued/executed after this sync was
        // captured) — running it would load the OLD model again right after a swap freed
        // it. Drop stale syncs instead of executing them.
        const current = _modelSelect?.value;
        if (current && pending.model && String(current) !== String(pending.model)) return null;
        return syncContextForModel(pending.model, pending.contextLength);
    }

    async function applyForModel(modelId) {
        if (!modelId || !isAutoTuneEnabled() || hasOverride()) return null;
        let telemetry = null;
        try {
            telemetry = await window.api.invoke('get-gpu-telemetry');
        } catch (e) { /* telemetry optional */ }

        const profile = buildProfile(modelId, telemetry);
        if (!profile) return null;

        _lastProfile = profile;
        _applying = true;
        applyProfileToSliders(profile, _els);
        persistCodeFields(profile);
        updateChip(profile);
        _applying = false;
        // v51.5: LM Studio's ACTUAL loaded window for this model (the user's own setting) is
        // ground truth — mirror it over the computed profile, then sync to that value. While a
        // run is busy, syncContextForModel queues itself and reports "queued" on the chip.
        await refreshLoadedContext(modelId);
        const sliderValue = _els.ctxSlider ? parseInt(_els.ctxSlider.value, 10) : profile.numCtx;
        // v52.5: a model swap (lmstudio-swap-model) JUST loaded this selection at exactly the
        // context we asked for — skip the redundant re-sync or LM Studio reloads a multi-GB
        // model twice in a row. The flag is single-use and expires after 60s so it can never
        // swallow a later, legitimate sync (e.g. auto-tune toggled off then back on).
        if (_swapHandledCtx === modelId && Date.now() - _swapHandledAt < 60000) {
            _swapHandledCtx = null;
            setChipStatus(syncLabel({ managed: true, loadedContext: sliderValue || profile.numCtx }), '');
            return profile;
        }
        await syncContextForModel(modelId, sliderValue || profile.numCtx);
        return profile;
    }

    /** v52.5 — app.js calls this after a successful lmstudio-swap-model for the current selection. */
    function markSwapHandled(modelId) {
        _swapHandledCtx = modelId || null;
        _swapHandledAt = Date.now();
    }

    async function applyForCurrentModel() {
        const modelId = _modelSelect?.value;
        if (!modelId) return null;
        return applyForModel(modelId);
    }

    /** Re-read LM Studio's loaded window for the current selection (user may have reloaded). */
    async function refreshCurrentLoadedContext() {
        const modelId = _modelSelect?.value;
        if (!modelId) return null;
        return refreshLoadedContext(modelId);
    }

    /** Periodic re-read so a manual LM Studio reload (different ctx) shows up without a restart. */
    function startCtxRefreshLoop(intervalMs) {
        stopCtxRefreshLoop();
        const ms = Number.isFinite(intervalMs) ? intervalMs : 10000;
        _refreshTimer = setInterval(() => {
            if (!busyNow()) refreshCurrentLoadedContext();
        }, ms);
        // Keep the loop from pinning Node's event open (unit tests mount this UI and must exit).
        if (_refreshTimer.unref) _refreshTimer.unref();
    }

    function stopCtxRefreshLoop() {
        if (_refreshTimer) clearInterval(_refreshTimer);
        _refreshTimer = null;
    }

    function mount(opts = {}) {
        _modelSelect = opts.modelSelect;
        _els = opts.sliders || {};
        _chipEl = opts.chipEl;
        _toggleEl = opts.toggleEl;
        _invoke = opts.invoke || opts.api?.invoke || null;
        _getApiBaseUrl = opts.getApiBaseUrl || null;
        _isBusy = opts.isBusy || null;
        _debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : _debounceMs;

        if (_toggleEl) {
            _toggleEl.checked = isAutoTuneEnabled();
            _toggleEl.addEventListener('change', () => {
                localStorage.setItem(LS_AUTO, _toggleEl.checked ? 'true' : 'false');
                if (_toggleEl.checked && !hasOverride()) {
                    applyForCurrentModel();
                }
            });
        }

        if (_modelSelect) {
            _modelSelect.addEventListener('change', () => {
                setOverride(false);
                // v51.5: selection changed → the previous model's verified ctx no longer applies.
                _loadedCtx = null;
                refreshCurrentLoadedContext();
                if (isAutoTuneEnabled()) applyForCurrentModel();
            });
        }

        const sliders = [_els.tempSlider, _els.ctxSlider].filter(Boolean);
        sliders.forEach((s) => {
            s.addEventListener('input', () => {
                if (_applying) return;
                setOverride(true);
                if (s === _els.ctxSlider) {
                    if (_ctxTimer) clearTimeout(_ctxTimer);
                    _ctxTimer = setTimeout(() => {
                        _ctxTimer = null;
                        syncContextForModel(_modelSelect?.value, _els.ctxSlider?.value);
                    }, _debounceMs);
                    if (_ctxTimer.unref) _ctxTimer.unref(); // don't pin Node's event loop in tests
                }
            });
        });

        // v51.5: reflect LM Studio's real loaded window on mount (auto-tune off or not) and keep
        // re-reading it so a manual reload in LM Studio shows up live.
        refreshCurrentLoadedContext();
        startCtxRefreshLoop(opts.ctxRefreshMs);
    }

    // v52.7: INFINITE TURNS — the "Thinking Steps" slider is gone and no per-run cap exists.
    // Returns -1 (the JSON-safe "infinite" sentinel; EarlyStopDetector maps 0/-1/null → ∞).
    function getMaxTurns() {
        return -1;
    }

    function getCodeTemperature() {
        const t = parseFloat(localStorage.getItem(LS_CODE_TEMP) || '0.2');
        return Number.isFinite(t) ? t : 0.2;
    }

    function getLastProfile() {
        return _lastProfile;
    }

    const api = {
        mount,
        applyForCurrentModel,
        applyForModel,
        applyProfileToSliders,
        syncContextForModel,
        flushPendingContextSync,
        refreshLoadedContext,
        refreshCurrentLoadedContext,
        markSwapHandled,
        getVerifiedLoadedCtx,
        stopCtxRefreshLoop,
        getMaxTurns,
        getCodeTemperature,
        getLastProfile
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKRuntimeProfileUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
