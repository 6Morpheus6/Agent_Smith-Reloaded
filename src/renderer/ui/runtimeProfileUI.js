/**
 * Runtime profile UI — auto-tune existing TUNING sliders on model change.
 *
 * v55.9.1 — MIN-CTX AUTO-RELOAD: the 10s refresh loop (and every send) re-reads what LM
 * Studio ACTUALLY has loaded for the selected model; if that verified window is below the
 * app-wide minimum (ctxGate.minCtx, 32000), auto-tune reloads THAT model in LM Studio at
 * the floor automatically — instead of letting the send gate wall the user off with
 * "Minimum context not met" and telling them to fix it by hand.
 */
(function (global) {
    'use strict';

    // v55.9.1: the app-wide minimum ctx lives in ctxGate (shared, env-overridable). The
    // renderer has no `process` global (nodeIntegration:false), so load it through a guarded
    // require — esbuild bundles it into dist/renderer/bundle.js; in Node tests it resolves
    // from disk. If both fail (shouldn't happen) fall back to ctxGate's own default.
    let _minCtxFn = null;
    try { _minCtxFn = require('../shared/ctxGate.js').minCtx; } catch (e) { /* bundled build */ }
    function minCtxFloor() {
        try {
            const n = typeof _minCtxFn === 'function' ? _minCtxFn() : NaN;
            if (Number.isFinite(n) && n > 0) return Math.floor(n);
        } catch (e) { /* fall through */ }
        return 32000; // ctxGate.DEFAULT_MIN_CTX — keep in sync
    }

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
    // v55.9.2 — explicit APPLY button next to the ctx slider (manual-ctx-field). The user sets
    // ANY context value and presses it to reload LM Studio at exactly that window; while a
    // manual apply is in flight, reflection must not fight the button over the slider.
    let _applyBtn = null;
    // v56.0.1 — typed custom-context field (next to the Auto-tune toggle). The user types ANY
    // ctx value and presses APPLY/Enter → applyCtx reloads LM Studio at exactly that window.
    // The 10s reflection loop mirrors what's ACTUALLY loaded into it (when not being typed in),
    // so it doubles as a live "current ctx" readout.
    let _customCtxInput = null;
    let _customApplyBtn = null;
    let _applyingCtx = false;
    let _lastProfile = null;
    let _applying = false;
    let _invoke = null;
    let _getApiBaseUrl = null;
    let _isBusy = null;
    // v55.9.2: the ctx slider's debounced auto-sync is gone (the APPLY button owns it), so the
    // _debounceMs/_ctxTimer bookkeeping went with it.
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
    // v55.9.1 — min-ctx auto-reload bookkeeping:
    //   _minReloadInFlight — a below-min reload is running (the 10s loop must not stack another).
    //   _minReloadModel — the model that in-flight reload targets (for status messaging).
    //   _lastMinReloadFail — { model, at } of the last FAILED below-min reload; while set we
    //     back off for 60s so an unfixable state (hardware can't hold 32K) doesn't churn a
    //     multi-GB unload/load every refresh tick. A successful reload clears it.
    let _minReloadInFlight = false;
    let _minReloadModel = null;
    let _lastMinReloadFail = null;
    // v55.9.1 — the in-flight auto-reload operation (promise), so awaitMinCtxReload can join it.
    let _minReloadOp = null;

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
     *
     * v55.9.1 — MIN-CTX AUTO-RELOAD: when the VERIFIED loaded window is below the app-wide
     * minimum, auto-tune reloads that model in LM Studio at the floor automatically (see
     * ensureMinCtx) instead of waiting for the send gate to wall the user off.
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
        // v55.9.2: while a MANUAL APPLY is in flight, the button owns the slider — reflection
        // must not repaint it with the pre-reload window mid-operation (the reload takes
        // seconds on multi-GB models and the 10s loop would otherwise fight the button).
        if (_loadedCtx > 0 && !_applyingCtx && String(_els.ctxSlider.value) !== String(_loadedCtx)) {
            // The loaded window is ground truth for the slider — override whatever was set.
            _applying = true;
            _els.ctxSlider.value = String(Math.min(_loadedCtx, Number(_els.ctxSlider.max) || _loadedCtx));
            if (_els.ctxVal) _els.ctxVal.textContent = String(_loadedCtx);
            _applying = false;
        }
        // v56.0.1 — mirror the verified window into the typed custom-context field too (never
        // while the user is typing in it or a manual apply owns the value).
        mirrorCustomCtx(_loadedCtx);
        // v55.9.1: verified-but-too-small → fix it in LM Studio now, for the user.
        if (_loadedCtx > 0 && _loadedCtx < minCtxFloor()) {
            ensureMinCtx(modelId);
        }
        return _loadedCtx;
    }

    /**
     * v55.9.1 — MIN-CTX AUTO-RELOAD: the selected model is VERIFIED loaded below the app-wide
     * minimum (32000). Reload it in LM Studio at exactly that floor, for the user:
     *   - only when auto-tune is ON and no manual override is active (a deliberate slider pick
     *     is respected — same contract as every other auto-tune action);
     *   - never while a run is busy or another reload/sync is in flight (the 10s refresh loop
     *     re-checks on its next tick, so nothing is lost by waiting);
     *   - with a 60s back-off after a FAILED attempt, so hardware that genuinely cannot hold
     *     the floor doesn't churn a multi-GB unload/load every ten seconds.
     * Returns the in-flight operation promise (or null when it did not start one), so the send
     * gate can await the fix instead of walling the user off mid-reload.
     */
    function ensureMinCtx(modelId) {
        const min = minCtxFloor();
        if (!modelId || !isAutoTuneEnabled() || hasOverride()) return null;
        if (_minReloadInFlight || _syncing || busyNow()) return null;
        if (_lastMinReloadFail && _lastMinReloadFail.model === modelId
            && Date.now() - _lastMinReloadFail.at < 60000) {
            setChipStatus(`ctx ${_loadedCtx} below min ${min} — retry in a moment`, 'Auto-reload failed; backing off before trying again.');
            return null;
        }
        const invoke = apiInvoke();
        if (typeof invoke !== 'function') return null;
        _minReloadInFlight = true;
        _minReloadModel = modelId;
        setChipStatus(`ctx ${_loadedCtx} below min — reloading LM Studio at ${min}...`, '');
        const op = (async () => {
            try {
                const result = await invoke('lmstudio-ensure-model', { apiBaseUrl: currentApiBase(), model: modelId, contextLength: min });
                if (result?.managed === false) {
                    // Unreachable / unmanaged — nothing to reload against. Back off so the loop
                    // doesn't hammer a dead endpoint every tick; the send gate stays permissive
                    // for unverifiable endpoints anyway.
                    _lastMinReloadFail = { model: modelId, at: Date.now() };
                    setChipStatus(syncLabel(result), result.warning || result.error || '');
                    return result;
                }
                const loaded = Number(result?.loadedContext);
                if (Number.isFinite(loaded) && loaded >= min) {
                    _lastMinReloadFail = null; // success — clear any back-off
                    applyLoadedContext(result);
                    setChipStatus(syncLabel(result), result?.warning || '');
                } else {
                    // LM Studio could not reach the floor (VRAM). Report honestly and back off.
                    _lastMinReloadFail = { model: modelId, at: Date.now() };
                    applyLoadedContext(result);
                    setChipStatus(`ctx ${loaded || '?'} — below min ${min}, retry in a moment`, result?.warning || 'LM Studio could not load the minimum context.');
                }
                return result;
            } catch (e) {
                _lastMinReloadFail = { model: modelId, at: Date.now() };
                setChipStatus('ctx auto-reload failed', e.message || String(e));
                return { managed: false, error: e.message || String(e) };
            } finally {
                _minReloadInFlight = false;
                _minReloadModel = null;
            }
        })();
        const tracked = op.finally(() => { if (_minReloadOp === tracked) _minReloadOp = null; });
        _minReloadOp = tracked;
        return tracked;
    }

    /**
     * v55.9.1 — send gate: a below-min auto-reload for THIS model is in flight (refreshLoadedContext
     * just kicked it off). Await it (bounded) and re-verify, so the user's message goes out against
     * the fixed window instead of being walled off while the fix runs. Returns true when the model
     * now verifies at/above the floor; false otherwise (gate falls back to its normal messaging).
     */
    async function awaitMinCtxReload(modelId, timeoutMs = 240000) {
        if (!modelId || !_minReloadOp || _minReloadModel !== modelId) return false;
        const op = _minReloadOp;
        try {
            // The timer is unref'd so a slow/never-finishing reload can't pin Node's event loop
            // (unit tests mount this UI and must exit).
            await Promise.race([op, new Promise(r => {
                const to = setTimeout(() => r(false), timeoutMs);
                if (to.unref) to.unref();
            })]);
        } catch (e) { /* the operation never rejects — it reports via its result */ }
        try {
            const v = await refreshLoadedContext(modelId);
            return typeof v === 'number' && Number.isFinite(v) && v >= minCtxFloor();
        } catch (e) { return false; }
    }

    /**
     * v55.9.1 — status for the send gate (sendMessage): is a below-min auto-reload running or
     * in back-off for THIS model? Lets the gate say "auto-fixing, retry in a moment" instead
     * of the old manual "unload and reload it yourself" wall.
     */
    function getMinCtxReloadState(modelId) {
        const min = minCtxFloor();
        if (_minReloadInFlight && _minReloadModel === modelId) return { state: 'in_flight', min };
        if (_lastMinReloadFail && _lastMinReloadFail.model === modelId
            && Date.now() - _lastMinReloadFail.at < 60000) return { state: 'backoff', min };
        return { state: null, min };
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

    /**
     * v56.0.1 — mirror a verified loaded context into the typed custom-context field, so it
     * reads as "what LM Studio actually has right now". Skipped while the user is typing in
     * the field (focused) or a manual apply is in flight — those own the value until done.
     */
    function mirrorCustomCtx(loadedCtx) {
        if (!_customCtxInput || _applyingCtx) return;
        const n = Number(loadedCtx);
        if (!Number.isFinite(n) || n <= 0) return;
        try {
            if (typeof document !== 'undefined' && document.activeElement === _customCtxInput) return; // user is typing — don't clobber
            _customCtxInput.value = String(Math.floor(n));
        } catch (e) { /* element may be gone */ }
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

    /**
     * v55.9.2 — MANUAL CTX APPLY: the user set a context value on the slider and pressed APPLY.
     * Reload LM Studio at EXACTLY that window (any value is accepted, including well above the
     * 32000 minimum) and mirror what actually loaded back onto the slider + chip. This is the
     * explicit counterpart to auto-tune's sync: it works whether Auto-tune is on or off, never
     * queues behind a busy run (the user asked for it NOW — the main-process manager serializes
     * against in-flight operations), and reports VRAM fallbacks honestly instead of snapping
     * the slider back to whatever was loaded before.
     *
     * v56.0.1 — TYPED VALUES: `contextLength` may come from the custom-context text field next
     * to the Auto-tune toggle (any integer, e.g. "49152"). The same exact-value contract holds;
     * what actually loaded is mirrored back onto BOTH the slider and the typed field.
     */
    async function applyCtx(modelId, contextLength) {
        const model = String(modelId || _modelSelect?.value || '');
        let requested = parseInt(contextLength ?? _els?.ctxSlider?.value, 10);
        if (!Number.isFinite(requested)) requested = parseInt(_customCtxInput?.value, 10);
        if (!model || !Number.isFinite(requested)) return null;
        requested = Math.max(2048, Math.min(Number(_els?.ctxSlider?.max) || 262144, requested));
        const invoke = apiInvoke();
        if (typeof invoke !== 'function') return null;
        _applyingCtx = true;
        setApplyBtnBusy(true);
        // A manual apply is a deliberate user action — it wins over auto-tune's profile.
        setOverride(true);
        setChipStatus(`Reloading LM Studio ctx ${requested}...`, '');
        try {
            const result = await invoke('lmstudio-ensure-model', { apiBaseUrl: currentApiBase(), model, contextLength: requested });
            if (result?.managed === false) {
                // Unreachable / unmanaged endpoint — nothing to reload against. The slider keeps
                // the user's value; the chip says why it could not be applied.
                setChipStatus(syncLabel(result), result.warning || result.error || 'LM Studio unmanaged');
                return result;
            }
            const loaded = Number(result?.loadedContext);
            if (Number.isFinite(loaded) && loaded > 0) {
                _applying = true; // keep the 10s reflection loop from fighting us mid-write
                _els.ctxSlider.value = String(Math.min(loaded, Number(_els.ctxSlider.max) || loaded));
                if (_els.ctxVal) _els.ctxVal.textContent = String(loaded);
                _applying = false;
            }
            // v56.0.1 — the typed field shows what ACTUALLY loaded (fallbacks included), so it
            // never claims a window LM Studio didn't honor.
            if (_customCtxInput && Number.isFinite(loaded) && loaded > 0) _customCtxInput.value = String(Math.floor(loaded));
            setChipStatus(syncLabel(result), result?.warning || '');
            return result;
        } catch (e) {
            setChipStatus('LM Studio ctx apply failed', e.message || String(e));
            return { managed: false, error: e.message || String(e) };
        } finally {
            _applyingCtx = false;
            setApplyBtnBusy(false);
        }
    }

    function setApplyBtnBusy(busy) {
        // v56.0.1 — both APPLY buttons (slider + typed field) share the in-flight state.
        const buttons = [_applyBtn, _customApplyBtn].filter(Boolean);
        for (const b of buttons) {
            try {
                b.disabled = !!busy;
                b.textContent = busy ? 'APPLYING…' : 'APPLY';
            } catch (e) { /* element may be gone */ }
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
        // v55.9.1: refresh may have just kicked off a below-min AUTO-RELOAD for this model —
        // it owns the load now; syncing on top of it would double-invoke lmstudio-ensure-model.
        if (_minReloadInFlight) return profile;
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
        // v55.9.1: a below-min auto-reload for THIS model just failed and is in its 60s
        // back-off — don't stack another doomed full reload on top of it (the refresh loop
        // retries after the back-off). Manual slider changes are unaffected (they set an
        // override, which skips this whole path).
        if (_lastMinReloadFail && _lastMinReloadFail.model === modelId
            && Date.now() - _lastMinReloadFail.at < 60000) {
            setChipStatus(`ctx ${_loadedCtx ?? '?'} below min — retry in a moment`, 'Auto-reload failed; backing off before trying again.');
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
        // v55.9.2 — explicit APPLY button next to the ctx slider (see applyCtx).
        _applyBtn = opts.applyBtn || null;
        // v56.0.1 — typed custom-context field + its own APPLY button (next to Auto-tune).
        _customCtxInput = opts.customCtxInput || null;
        _customApplyBtn = opts.customApplyBtn || null;
        if (_customCtxInput && _customApplyBtn) {
            const commitTypedCtx = () => {
                try {
                    applyCtx(_modelSelect?.value, _customCtxInput.value);
                } catch (e) { /* reported via the chip */ }
            };
            _customApplyBtn.addEventListener('click', commitTypedCtx);
            // Enter in the field commits — same as pressing APPLY.
            _customCtxInput.addEventListener('keydown', (ev) => {
                if (ev && ev.key === 'Enter') { ev.preventDefault(); commitTypedCtx(); }
            });
        }
        _invoke = opts.invoke || opts.api?.invoke || null;
        _getApiBaseUrl = opts.getApiBaseUrl || null;
        _isBusy = opts.isBusy || null;

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
                // v55.9.2 — the ctx slider no longer auto-syncs on every drag: an explicit APPLY
                // button (applyCtx, wired in app.js) is now the only thing that reloads LM Studio
                // from this field. Dragging just marks a manual override + updates the display;
                // pressing APPLY commits it. (The old debounced auto-sync made every slider tick
                // queue a full model reload — and its result was what "snapped" the value back.)
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
        // v55.9.2 — explicit APPLY button next to the ctx slider (manual ctx reload).
        applyCtx,
        refreshLoadedContext,
        refreshCurrentLoadedContext,
        markSwapHandled,
        getVerifiedLoadedCtx,
        stopCtxRefreshLoop,
        // v55.9.1 — min-ctx auto-reload (below-min loaded ctx → LM Studio reload at the floor)
        ensureMinCtx,
        awaitMinCtxReload,
        getMinCtxReloadState,
        getMaxTurns,
        getCodeTemperature,
        getLastProfile
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKRuntimeProfileUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
