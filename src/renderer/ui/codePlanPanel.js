/**
 * Code Mode plan drawer — approval gate + execution progress (Option B).
 */
(function (global) {
    'use strict';

    let mountEl = null;
    let state = { sessionId: null, codePlan: null, goal: '', phase: 'idle', gateBlockerCount: 0 };

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function stepRows(steps, editable) {
        const list = Array.isArray(steps) ? steps : [];
        if (editable) {
            return `<ol class="arc-step-edit">${list.map((s, i) =>
                `<li><input class="arc-step-input" data-step-idx="${i}" value="${escapeHtml(s.title || '')}"></li>`
            ).join('')}</ol>`;
        }
        return `<ul class="arc-steplist">${list.map((s, i) => {
            const cls = s.status === 'done' ? 'arc-st-done'
                : (s.status === 'active' ? 'arc-st-active' : '');
            const mark = s.status === 'done' ? '✓' : (s.status === 'active' ? '▸' : '○');
            return `<li class="${cls}">${mark} ${i + 1}. ${escapeHtml(s.title || '')}</li>`;
        }).join('')}</ul>`;
    }

    function progressLabel(codePlan, gateBlockerCount) {
        if (!codePlan?.steps?.length) return '0/0';
        const total = codePlan.steps.length;
        const done = codePlan.steps.filter(s => s.status === 'done').length;
        const blockers = gateBlockerCount ?? state.gateBlockerCount ?? 0;
        if (done >= total) {
            return blockers > 0
                ? `${done}/${total} done · ${blockers} blocker(s)`
                : `${done}/${total} done`;
        }
        const activeIdx = codePlan.steps.findIndex(s => s.status === 'active');
        const stepNum = activeIdx >= 0 ? activeIdx + 1 : Math.min(done + 1, total);
        return `${done}/${total} done · step ${stepNum}`;
    }

    function currentStepLabel(codePlan, gateBlockerCount) {
        const steps = codePlan?.steps || [];
        const cur = steps.find(s => s.status === 'active');
        if (cur) return cur.title;
        const allDone = steps.length && steps.every(s => s.status === 'done');
        if (allDone) {
            const blockers = gateBlockerCount ?? state.gateBlockerCount ?? 0;
            if (blockers > 0) return `Verifying — ${blockers} blocker(s) remain`;
            return 'Plan steps complete — finishing verification';
        }
        return 'Working…';
    }

    function renderApproval({ goal, codePlan, sessionId, onApprove, onReject }) {
        if (!mountEl) return;
        state = { sessionId, codePlan, goal, phase: 'approval' };
        const steps = codePlan?.steps || [];
        mountEl.innerHTML = `
            <div class="agent-run-card arc-approval">
                <div class="arc-header">
                    <span class="arc-phase arc-approval">APPROVAL</span>
                    <span class="arc-progress">${steps.length} steps</span>
                    <span class="arc-goal" title="${escapeHtml(goal || '')}">${escapeHtml(goal || '')}</span>
                </div>
                <div class="arc-body">
                    <div class="arc-section-label">Review plan <span class="arc-risk">edit steps before approving</span></div>
                    ${stepRows(steps, true)}
                    <p class="arc-note">The agent explored read-only, then proposed these steps. Edit titles if needed, then approve to start execution.</p>
                </div>
                <div class="arc-footer">
                    <button type="button" class="arc-btn arc-btn-danger" id="code-plan-reject-btn">REJECT</button>
                    <button type="button" class="arc-btn arc-btn-primary" id="code-plan-approve-btn">APPROVE &amp; RUN</button>
                </div>
            </div>`;

        mountEl.querySelector('#code-plan-reject-btn')?.addEventListener('click', () => {
            if (onReject) onReject(sessionId);
        });
        mountEl.querySelector('#code-plan-approve-btn')?.addEventListener('click', () => {
            const inputs = mountEl.querySelectorAll('.arc-step-input');
            const steps = Array.from(inputs).map(el => el.value.trim()).filter(Boolean);
            if (onApprove) onApprove(sessionId, steps);
        });

        if (window.XKSidebarLayout?.enterPlanMode) {
            window.XKSidebarLayout.enterPlanMode({ stepLabel: `${steps.length} steps` });
        }
    }

    function renderExecuting({ goal, codePlan, takeover = false, gateBlockerCount, gateBlockers }) {
        if (!mountEl) return;
        if (gateBlockerCount != null) state.gateBlockerCount = gateBlockerCount;
        state = { ...state, codePlan, goal, phase: 'executing' };
        const prog = progressLabel(codePlan, gateBlockerCount);
        const nowLabel = currentStepLabel(codePlan, gateBlockerCount);
        const blockerNote = (gateBlockers?.length && (gateBlockerCount ?? state.gateBlockerCount) > 0)
            ? `<ul class="arc-steplist arc-blockers">${gateBlockers.slice(0, 4).map(m =>
                `<li>${escapeHtml(m.replace(/^\[(DOM|ARTIFACT)\]\s*/i, ''))}</li>`
            ).join('')}</ul>`
            : '';
        mountEl.innerHTML = `
            <div class="agent-run-card arc-executing">
                <div class="arc-header">
                    <span class="arc-phase arc-executing">EXECUTING</span>
                    <span class="arc-progress">${prog}</span>
                    <span class="arc-goal" title="${escapeHtml(goal || '')}">${escapeHtml(goal || '')}</span>
                </div>
                <div class="arc-body">
                    <div class="arc-current"><strong>Now:</strong> ${escapeHtml(nowLabel)}</div>
                    ${blockerNote}
                    <details class="arc-allsteps" open>
                        <summary>All steps</summary>
                        ${stepRows(codePlan?.steps || [], false)}
                    </details>
                </div>
            </div>`;

        if (takeover && window.XKSidebarLayout?.enterPlanMode) {
            window.XKSidebarLayout.enterPlanMode({ stepLabel: prog });
        } else if (window.XKSidebarLayout?.updatePlanChip) {
            window.XKSidebarLayout.updatePlanChip(prog);
        }
    }

    /** Code run without an approved step plan — still uses full-sidebar takeover. */
    function renderRunActive({ goal, sessionId, takeover = true }) {
        if (!mountEl) return;
        state = { sessionId, codePlan: null, goal, phase: 'executing' };
        mountEl.innerHTML = `
            <div class="agent-run-card arc-executing">
                <div class="arc-header">
                    <span class="arc-phase arc-executing">EXECUTING</span>
                    <span class="arc-progress">…</span>
                    <span class="arc-goal" title="${escapeHtml(goal || '')}">${escapeHtml(goal || '')}</span>
                </div>
                <div class="arc-body">
                    <p class="arc-note">Code Mode is running. Activity streams in the chat timeline.</p>
                </div>
            </div>`;
        if (takeover && window.XKSidebarLayout?.enterPlanMode) {
            window.XKSidebarLayout.enterPlanMode({ stepLabel: '…' });
        }
    }

    function renderPlanning({ goal }) {
        if (!mountEl) return;
        state = { ...state, goal, phase: 'planning' };
        mountEl.innerHTML = `
            <div class="agent-run-card arc-paused">
                <div class="arc-header">
                    <span class="arc-phase arc-approval">PLANNING</span>
                    <span class="arc-goal">${escapeHtml(goal || '')}</span>
                </div>
                <div class="arc-body">
                    <p class="arc-note loading-pulse">Exploring project read-only…</p>
                </div>
            </div>`;
        if (window.XKSidebarLayout?.enterPlanMode) {
            window.XKSidebarLayout.enterPlanMode({ stepLabel: '…' });
        }
    }

    function updateProgress(codePlan, opts = {}) {
        if (!codePlan) return;
        state.codePlan = codePlan;
        if (opts.gateBlockerCount != null) state.gateBlockerCount = opts.gateBlockerCount;
        if (state.phase === 'executing') {
            renderExecuting({
                goal: state.goal,
                codePlan,
                takeover: false,
                gateBlockerCount: opts.gateBlockerCount,
                gateBlockers: opts.gateBlockers
            });
        } else if (window.XKSidebarLayout?.updatePlanChip) {
            window.XKSidebarLayout.updatePlanChip(progressLabel(codePlan, opts.gateBlockerCount));
        }
    }

    function clear() {
        state = { sessionId: null, codePlan: null, goal: '', phase: 'idle', gateBlockerCount: 0 };
        if (mountEl) mountEl.innerHTML = '';
        if (window.XKSidebarLayout?.exitPlanMode) window.XKSidebarLayout.exitPlanMode();
    }

    function init() {
        mountEl = document.getElementById('plan-panel-mount');
        const chipOpen = document.getElementById('plan-chip-open');
        const exitBtn = document.getElementById('plan-exit-btn');
        chipOpen?.addEventListener('click', () => window.XKSidebarLayout?.openPlanDrawer?.());
        exitBtn?.addEventListener('click', () => window.XKSidebarLayout?.collapsePlanDrawer?.());
    }

    const api = {
        init,
        renderApproval,
        renderExecuting,
        renderRunActive,
        renderPlanning,
        updateProgress,
        clear,
        getState: () => ({ ...state })
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKCodePlanPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
