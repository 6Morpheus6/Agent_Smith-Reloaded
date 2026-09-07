/**
 * Code Mode renderer bridge — IPC + activity timeline + resume banner.
 */
(function (global) {
    'use strict';

    let eventUnsub = null;
    let activeSessionId = null;
    // v53.1 — the session whose `done`/`error` event we just handled. The post-run
    // "Resume Code run?" check must NOT offer it: on a slow (mobile) connection the
    // code-list-sessions round-trip can land before main's terminal save, so the finished
    // session still reads 'running' and tapping Resume re-runs the whole task. The banner
    // is for genuinely INTERRUPTED runs (app closed mid-build), not for the run that just ended.
    let lastFinishedSessionId = null;
    let depsRef = null;
    let timeline = null;
    let resumeBannerEl = null;
    // Composer-anchored verify popup — transient harness status (retries, verification).
    // Muted via localStorage; never appended to #messages (keeps transcript clean).
    const LS_VERIFY_MUTED = 'agentsmith_verify_popup_muted';
    let verifyPopupEl = null;
    let verifyMutedChipEl = null;
    let verifyPopupMuted = localStorage.getItem(LS_VERIFY_MUTED) === 'true';
    let lastVerifyText = '';

    function verifyHost() {
        return document.getElementById('verify-popup-host');
    }

    function ensureMutedChip(host) {
        if (verifyMutedChipEl) return verifyMutedChipEl;
        verifyMutedChipEl = document.createElement('button');
        verifyMutedChipEl.type = 'button';
        verifyMutedChipEl.className = 'verify-muted-chip';
        verifyMutedChipEl.textContent = 'Verify alerts muted — click to restore';
        verifyMutedChipEl.title = 'Show verification status popups again';
        verifyMutedChipEl.addEventListener('click', () => {
            verifyPopupMuted = false;
            localStorage.setItem(LS_VERIFY_MUTED, 'false');
            verifyMutedChipEl.hidden = true;
            if (lastVerifyText) setRunStatus(lastVerifyText);
        });
        host.appendChild(verifyMutedChipEl);
        return verifyMutedChipEl;
    }

    function ensureVerifyPopup() {
        const host = verifyHost();
        if (!host) return null;
        if (!verifyPopupEl) {
            verifyPopupEl = document.createElement('div');
            verifyPopupEl.className = 'verify-popup';
            verifyPopupEl.setAttribute('role', 'status');
            verifyPopupEl.innerHTML =
                '<span class="verify-popup-spinner" aria-hidden="true">↻</span>' +
                '<span class="verify-popup-text"></span>' +
                '<button type="button" class="verify-popup-mute" title="Mute verification alerts">Mute</button>' +
                '<button type="button" class="verify-popup-close" title="Dismiss" aria-label="Dismiss">×</button>';
            verifyPopupEl.querySelector('.verify-popup-mute')?.addEventListener('click', () => {
                verifyPopupMuted = true;
                localStorage.setItem(LS_VERIFY_MUTED, 'true');
                hideVerifyPopup();
                const chip = ensureMutedChip(host);
                chip.hidden = false;
            });
            verifyPopupEl.querySelector('.verify-popup-close')?.addEventListener('click', () => {
                hideVerifyPopup();
            });
            host.appendChild(verifyPopupEl);
        }
        if (verifyPopupMuted) {
            const chip = ensureMutedChip(host);
            chip.hidden = false;
        }
        return verifyPopupEl;
    }

    function hideVerifyPopup() {
        if (verifyPopupEl) {
            verifyPopupEl.hidden = true;
            verifyPopupEl.classList.remove('verify-popup--visible');
        }
    }

    function setRunStatus(text) {
        lastVerifyText = text || '';
        const host = verifyHost();
        if (!host) return;
        if (verifyPopupMuted) {
            const chip = ensureMutedChip(host);
            chip.hidden = false;
            return;
        }
        const el = ensureVerifyPopup();
        if (!el) return;
        el.querySelector('.verify-popup-text').textContent = text;
        el.hidden = false;
        el.classList.add('verify-popup--visible');
        if (verifyMutedChipEl) verifyMutedChipEl.hidden = true;
    }

    function clearRunStatus() {
        lastVerifyText = '';
        hideVerifyPopup();
    }

    function getTimeline() {
        return timeline || window.XKSharedTimeline || null;
    }

    function hideEmptyStateOverlay() {
        const empty = document.getElementById('empty-state');
        if (empty) empty.style.display = 'none';
        document.body.classList.add('code-run-visible');
        depsRef?.updateEmptyState?.();
    }

    function clearCodeRunVisible() {
        document.body.classList.remove('code-run-visible');
        depsRef?.updateEmptyState?.();
    }

    /** Plan approve / resume / run_start may not have a sendMessage bot bubble — create one. */
    function ensureCodeRunAnchor(initialHtml) {
        const messagesEl = document.getElementById('messages');
        if (!messagesEl || !depsRef) return null;

        hideEmptyStateOverlay();

        if (!depsRef.botDivRef || !depsRef.botDivRef.isConnected) {
            const div = document.createElement('div');
            div.className = 'message bot-message code-run-anchor';
            div.innerHTML = initialHtml || '<span class="loading-pulse">Code Mode — running…</span>';
            messagesEl.appendChild(div);
            depsRef.botDivRef = div;
        } else if (initialHtml) {
            depsRef.botDivRef.innerHTML = initialHtml;
        }

        const tl = getTimeline();
        if (tl?.setAnchor) tl.setAnchor(depsRef.botDivRef);
        return depsRef.botDivRef;
    }

    function dispatchTimeline(ev, extra) {
        const tl = getTimeline();
        if (!tl?.handleCodeEvent) return;
        tl.handleCodeEvent(ev, {
            botDiv: depsRef?.botDivRef,
            anchor: depsRef?.botDivRef,
            ...(extra || {})
        });
    }

    // ── v52.4 live status indicator — kawaii face + verb + tokens + elapsed ─────────────
    const TOOL_VERBS = {
        write_file: 'writing code',
        append_file: 'extending file',
        patch: 'editing code',
        read_file: 'reading files',
        grep: 'searching code',
        glob: 'scanning files',
        list_project: 'exploring project',
        run_command: 'running command',
        show_preview: 'opening preview',
        browser_verify: 'verifying in browser',
        query_run_trace: 'checking run trace',
        mark_code_step_done: 'checking off step',
        web_search: 'searching the web',
        fetch_url: 'fetching page'
    };

    function liveVerbForTool(name) {
        return TOOL_VERBS[name] || null;
    }

    function startLiveIndicator(verb) {
        const el = document.getElementById('code-status-bar');
        window.XKCodeRunUI?.startLive(el, verb);
    }

    function stopLiveIndicator() {
        window.XKCodeRunUI?.stopLive();
    }

    async function showResumeBannerIfAny() {
        if (!depsRef?.getProjectRoot || !window.api) return;
        try {
            const root = await depsRef.getProjectRoot();
            const res = await window.api.invoke('code-list-sessions', { projectRoot: root });
            const sessions = res?.sessions || [];
            // v53.1: never offer Resume for the session that JUST finished (see
            // lastFinishedSessionId) — on slow links its terminal save may not have landed
            // yet, and re-running a completed task is exactly the "task loops after done" bug.
            const candidates = sessions.filter(x => !(lastFinishedSessionId && x.id === lastFinishedSessionId));
            if (!candidates.length) {
                if (resumeBannerEl) resumeBannerEl.remove();
                resumeBannerEl = null;
                return;
            }
            const s = candidates[0];
            const messagesEl = document.getElementById('messages');
            if (!messagesEl) return;
            const awaiting = s.status === 'awaiting_approval';
            if (!resumeBannerEl) {
                resumeBannerEl = document.createElement('div');
                resumeBannerEl.className = 'code-resume-banner';
                messagesEl.prepend(resumeBannerEl);
            }
            const goal = (s.goal || 'task').slice(0, 80);
            if (awaiting) {
                resumeBannerEl.innerHTML =
                    `<strong>Plan awaiting approval</strong> — ${goal.replace(/</g, '&lt;')} ` +
                    `<button type="button" id="code-resume-btn">Review plan</button> ` +
                    `<button type="button" id="code-dismiss-resume">Dismiss</button>`;
            } else {
                resumeBannerEl.innerHTML =
                    `<strong>Resume Code run?</strong> Turn ${s.turn || 0}: ${goal.replace(/</g, '&lt;')} ` +
                    `<button type="button" id="code-resume-btn">Resume</button> ` +
                    `<button type="button" id="code-dismiss-resume">Dismiss</button>`;
            }
            document.getElementById('code-dismiss-resume')?.addEventListener('click', () => {
                resumeBannerEl?.remove();
                resumeBannerEl = null;
            });
            document.getElementById('code-resume-btn')?.addEventListener('click', async () => {
                const model = depsRef.getModel();
                const numCtx = depsRef.getNumCtx();
                const apiBaseUrl = depsRef.getApiBase();
                resumeBannerEl.innerHTML = '<span class="loading-pulse">Resuming…</span>';
                ensureCodeRunAnchor('<span class="loading-pulse">Code Mode — resuming…</span>');
                const tl = getTimeline();
                tl?.reset?.();
                await depsRef.flushContextSync?.();
                depsRef.setCodeRunActive?.(true);
                let resumeRes;
                try {
                    resumeRes = await window.api.invoke('code-resume', {
                        sessionId: s.id,
                        model,
                        numCtx,
                        apiBaseUrl,
                        apiKey: depsRef.getApiKey?.() || null,
                        projectRoot: root
                    });
                } finally {
                    depsRef.setCodeRunActive?.(false);
                    clearCodeRunVisible();
                }
                // v53.1: surface a refusal (e.g. "Session already finished") instead of
                // silently dropping the banner — the user tapped Resume and deserves to see
                // why nothing happened.
                if (resumeRes?.error) {
                    addMessage('system', `**Resume refused:** ${resumeRes.error}`);
                }
                resumeBannerEl?.remove();
                resumeBannerEl = null;
            });
        } catch (e) { /* non-fatal */ }
    }

    function handleEvent(ev) {
        if (!ev || !ev.type || !depsRef) return;
        const { addMessage, onStatusUpdate, onReview, getModel, getNumCtx, getApiBase, getApiKey } = depsRef;
        const planPanel = window.XKCodePlanPanel;

        if (ev.type === 'run_start' || ev.type === 'planning_start' || ev.type === 'plan_approved') {
            ensureCodeRunAnchor();
        }

        dispatchTimeline(ev);

        // Live status indicator: start on run events, follow tool activity, stop at end.
        if (ev.type === 'run_start') startLiveIndicator('working');
        else if (ev.type === 'planning_start') startLiveIndicator('brainstorming');
        else if (ev.type === 'plan_approved') startLiveIndicator('executing plan');
        // v52.7: LIVE TOKEN GENERATION — the in-flight request reports its own state from
        // the wire ('waiting' → prompt processing, 'generating' → tokens flowing). This is
        // model-agnostic: it fires for whatever LM Studio is serving, and while either is up
        // nothing may cut the reply off (swaps/syncs queue until it clears).
        else if (ev.type === 'gen_state') {
            window.XKCodeRunUI?.setLiveGenState(ev.state);
        } else if (ev.type === 'tool_start' && liveVerbForTool(ev.name)) {
            // A tool is executing — the model is no longer generating; clear the gen state.
            window.XKCodeRunUI?.setLiveGenState('idle');
            window.XKCodeRunUI?.setLiveVerb(liveVerbForTool(ev.name));
        } else if (ev.type === 'run_status') {
            if (Number.isFinite(ev.tokensTotal)) window.XKCodeRunUI?.setLiveTokens(ev.tokensTotal);
            if (onStatusUpdate) onStatusUpdate({ turn: ev.turn, phase: ev.phase });
        } else if (ev.type === 'verify_blocked') {
            window.XKCodeRunUI?.setLiveVerb('fixing issues');
        } else if (ev.type === 'done' || ev.type === 'error') {
            stopLiveIndicator();
        }

        switch (ev.type) {
        case 'planning_start':
            window.XKSidebarLayout?.exitPreviewMode?.(); // clear any stale preview from a prior run
            planPanel?.renderPlanning({ goal: ev.goal });
            depsRef.setCodeRunActive?.(true);
            addMessage('system', '**Code Mode:** Planning — read-only exploration before approval.');
            break;
        case 'plan_awaiting_approval':
            depsRef.setCodeRunActive?.(false);
            activeSessionId = ev.sessionId || activeSessionId;
            planPanel?.renderApproval({
                goal: ev.goal,
                codePlan: ev.codePlan,
                sessionId: ev.sessionId,
                onApprove: async (sessionId, steps) => {
                    ensureCodeRunAnchor('<span class="loading-pulse">Code Mode — executing plan…</span>');
                    getTimeline()?.reset?.();
                    await depsRef.flushContextSync?.();
                    depsRef.setCodeRunActive?.(true);
                    try {
                        const res = await window.api.invoke('code-plan-approve', {
                            sessionId,
                            steps,
                            model: getModel?.(),
                            numCtx: getNumCtx?.(),
                            apiBaseUrl: getApiBase?.(),
                            apiKey: getApiKey?.() || null
                        });
                        if (res?.error) addMessage('system', `**Plan approval failed:** ${res.error}`);
                    } finally {
                        depsRef.setCodeRunActive?.(false);
                        clearCodeRunVisible();
                    }
                },
                onReject: async (sessionId) => {
                    await window.api.invoke('code-plan-reject', { sessionId });
                    planPanel?.clear();
                    depsRef.setCodeRunActive?.(false);
                }
            });
            addMessage('system', '**Plan ready** — review steps in the sidebar, then **Approve & Run**.');
            break;
        case 'plan_approved':
            clearRunStatus();
            planPanel?.renderExecuting({
                goal: ev.codePlan?.goal || ev.goal,
                codePlan: ev.codePlan,
                takeover: true
            });
            addMessage('system', '**Plan approved** — executing steps.');
            break;
        case 'plan_step_update':
            planPanel?.updateProgress(ev.codePlan, {
                gateBlockerCount: ev.gateBlockerCount,
                gateBlockers: ev.gateBlockers
            });
            if (onStatusUpdate && ev.codePlan) {
                const total = ev.codePlan.steps?.length || 0;
                const done = ev.codePlan.steps?.filter(s => s.status === 'done').length || 0;
                const blockers = ev.gateBlockerCount ?? 0;
                const activeIdx = ev.codePlan.steps?.findIndex(s => s.status === 'active') ?? -1;
                const stepNum = activeIdx >= 0 ? activeIdx + 1 : Math.min(done + 1, total);
                let prog;
                if (done >= total) {
                    prog = blockers > 0
                        ? `${done}/${total} done · ${blockers} blocker(s)`
                        : `${done}/${total} done`;
                } else {
                    prog = `${done}/${total} done · step ${stepNum}`;
                }
                onStatusUpdate({ planProgress: prog });
            }
            break;
        case 'plan_rejected':
            planPanel?.clear();
            depsRef.setCodeRunActive?.(false);
            addMessage('system', '**Plan rejected.**');
            break;
        case 'run_start':
            window.XKSidebarLayout?.exitPreviewMode?.(); // a new run supersedes any prior preview drawer
            clearRunStatus();
            depsRef.setCodeRunActive?.(true);
            activeSessionId = ev.sessionId;
            lastFinishedSessionId = null; // v53.1: fresh run — the just-finished guard no longer applies
            if (planPanel) {
                const st = planPanel.getState();
                if (ev.codePlan) {
                    planPanel.renderExecuting({
                        goal: ev.goal || ev.codePlan.goal,
                        codePlan: ev.codePlan,
                        takeover: true
                    });
                } else if (st.phase === 'idle') {
                    planPanel.renderRunActive({
                        goal: ev.goal,
                        sessionId: ev.sessionId,
                        takeover: true
                    });
                }
            }
            if (onStatusUpdate) onStatusUpdate({ turn: 0, sessionId: ev.sessionId });
            break;
        case 'turn_start':
            if (onStatusUpdate) {
                onStatusUpdate({
                    turn: ev.turn,
                    sessionId: activeSessionId,
                    toolCount: ev.toolCountSoFar,
                    phase: ev.phase,
                    planProgress: ev.planProgress
                        ? `${ev.planProgress.current}/${ev.planProgress.total}`
                        : undefined
                });
            }
            break;
        case 'context_budget':
            if (onStatusUpdate) {
                onStatusUpdate({
                    turn: ev.turn,
                    budgetPct: ev.total ? Math.round((ev.used / ev.total) * 100) : null,
                    toolCount: ev.toolCountSoFar
                });
            }
            break;
        case 'verify_blocked': {
            // Surface only the single most actionable next step on the live status
            // line. The full issue list lands in the final summary at run end.
            const msgs = ev.messages || [];
            const next = msgs.find(m => /create the file at|missing on disk/i.test(m)) || msgs[0] || '';
            const hint = next
                ? next.replace(/^\[[A-Z]+\]\s*/, '').replace(/\s*\(it is missing on disk\)/i, '').trim().slice(0, 140)
                : `resolving ${msgs.length} issue(s)`;
            setRunStatus(`Verifying — ${hint}`);
            const st = planPanel?.getState?.();
            if (st?.codePlan) {
                planPanel.updateProgress(st.codePlan, {
                    gateBlockerCount: msgs.length,
                    gateBlockers: msgs.slice(0, 5)
                });
            }
            break;
        }
        case 'run_continue': {
            // gate_retry fires just before verify_blocked, which carries the more
            // specific next-step text and wins (last update). Both share one line.
            if (ev.reason === 'harness_scaffold') {
                const prev = ev.previewOpened ? ' Preview opened.' : '';
                setRunStatus(`Continuing — harness wrote ${ev.path || 'missing file'}.${prev} Finishing verification…`);
            } else if (ev.reason === 'truncation_retry') {
                setRunStatus(`Reply was cut off — retrying with a smaller file (${ev.attempt || 1}/3)…`);
            } else if (ev.reason === 'gate_retry') {
                setRunStatus('Working — more changes needed before done…');
            }
            break;
        }
        case 'harness_scaffold':
            break;
        case 'output_truncated':
            break;
        case 'delta':
        case 'tool_start':
        case 'tool_result':
        case 'final_summary':
        case 'assistant_done':
            break;
        case 'done': {
            clearRunStatus();
            clearCodeRunVisible();
            depsRef.setCodeRunActive?.(false);
            // v53.1: remember which session just ended so the post-run resume check can't
            // offer it (see showResumeBannerIfAny).
            lastFinishedSessionId = ev.sessionId || activeSessionId;
            const label = ev.status && ev.status !== 'done'
                ? `Code run ${ev.status.toUpperCase()}`
                : 'Code run complete';
            addMessage('system', `**${label}** — ${ev.toolCount || 0} tool calls, ${ev.turn || 0} turns.`);
            window.XKCodePlanPanel?.clear();
            if (onReview) onReview(ev.sessionId);
            showResumeBannerIfAny();
            break;
        }
        case 'error':
            clearRunStatus();
            clearCodeRunVisible();
            depsRef.setCodeRunActive?.(false);
            // v53.1: an errored/aborted run is terminal too — same resume-banner guard as done.
            lastFinishedSessionId = ev.sessionId || activeSessionId;
            addMessage('system', `**Code Mode:** ${ev.message || 'error'}`);
            if (/stopped|aborted|rejected/i.test(ev.message || '')) {
                window.XKCodePlanPanel?.clear();
            }
            if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                window.XKScrollFollow.get().endRun();
            }
            break;
        default:
            break;
        }

        if (window.XKHistoryPersistence?.shouldCheckpointCodeEvent(ev)) {
            depsRef.onTimelineChanged?.(ev);
        }
    }

    function mount(deps) {
        depsRef = deps;
        if (verifyPopupMuted) {
            const host = verifyHost();
            if (host) ensureMutedChip(host).hidden = false;
        }
        const messagesEl = document.getElementById('messages');
        if (window.XKActivityTimeline && messagesEl) {
            timeline = window.XKActivityTimeline.mount(messagesEl, {
                markedParse: deps.markedParse,
                updateEmptyState: deps.updateEmptyState,
                onStatusUpdate: deps.onStatusUpdate
            });
        }

        if (eventUnsub) eventUnsub();
        eventUnsub = window.api.on('code-event', handleEvent);

        showResumeBannerIfAny();

        return {
            async run(prompt, botDiv) {
                const { codeRunState } = deps;
                await deps.flushContextSync?.();
                deps.setCodeRunActive?.(true);
                codeRunState.abortController = new AbortController();
                depsRef.botDivRef = botDiv;
                hideEmptyStateOverlay();

                if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                    window.XKScrollFollow.get().beginRun();
                }

                const tl = getTimeline();
                if (tl) {
                    tl.reset();
                    tl.setAnchor(botDiv);
                }

                const model = deps.getModel();
                const numCtx = deps.getNumCtx();
                const maxTurns = deps.getMaxTurns?.() ?? 40;
                const codeTemperature = deps.getCodeTemperature?.() ?? 0.2;
                const projectRoot = await deps.getProjectRoot();
                const apiBaseUrl = deps.getApiBase();
                const apiKey = deps.getApiKey?.() || null;

                botDiv.innerHTML = `<span class="loading-pulse">Code Mode — starting…</span>`;

                let res;
                try {
                    res = await window.api.invoke('code-run', {
                        prompt,
                        model,
                        numCtx,
                        maxTurns,
                        codeTemperature,
                        projectRoot,
                        apiBaseUrl,
                        apiKey,
                        requirePlanApproval: deps.getRequirePlanApproval?.() === true,
                        grindMode: deps.getGrindMode?.() !== false,
                        isolatedRun: deps.getIsolatedRun?.() === true,
                        parallelMilestones: deps.getParallelMilestones?.() === true,
                        milestoneWorktrees: deps.getMilestoneWorktrees?.() === true,
                        milestoneConcurrent: deps.getMilestoneConcurrent?.() === true
                    });
                } finally {
                    if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                        window.XKScrollFollow.get().endRun();
                    }
                    // Planning-only return (awaiting approval) — execution hasn't started yet.
                    if (res?.awaitingApproval) {
                        deps.setCodeRunActive?.(false);
                    } else {
                        clearCodeRunVisible();
                    }
                    codeRunState.abortController = null;
                    await deps.flushContextSync?.();
                }

                if (res?.error && botDiv) {
                    deps.setCodeRunActive?.(false);
                    botDiv.innerHTML = deps.markedParse(`**Code Mode error:** ${res.error}`);
                }
                if (res?.sessionId) {
                    activeSessionId = res.sessionId;
                    codeRunState.sessionId = res.sessionId;
                }
                return res;
            },

            async stop() {
                await window.api.invoke('code-stop');
                deps.setCodeRunActive?.(false);
                await deps.flushContextSync?.();
            },

            getSessionId() { return activeSessionId; },
            refreshResumeBanner: showResumeBannerIfAny
        };
    }

    const api = { mount, handleEvent };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKCodeMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
