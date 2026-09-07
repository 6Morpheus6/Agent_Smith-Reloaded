// --- Polyfill for Non-Electron Environments (Mobile/Web) ---
const isWebMode = window.location.protocol.startsWith('http');
if (isWebMode) document.body.classList.add('web-mode');
else document.body.classList.add('electron-app');

function wireFramelessChrome() {
    if (isWebMode || !window.api) return;
    const minBtn = document.getElementById('win-minimize');
    const maxBtn = document.getElementById('win-maximize');
    const closeBtn = document.getElementById('win-close');
    const drag = document.querySelector('.titlebar-drag');
    const syncMaxIcon = async () => {
        if (!maxBtn) return;
        try {
            const { maximized } = await window.api.invoke('window-is-maximized');
            maxBtn.textContent = maximized ? '\u2750' : '\u25A1';
            maxBtn.title = maximized ? 'Restore' : 'Maximize';
            maxBtn.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
        } catch (_) { /* ignore */ }
    };
    minBtn?.addEventListener('click', () => { window.api.invoke('window-minimize').catch(() => {}); });
    maxBtn?.addEventListener('click', async () => {
        try { await window.api.invoke('window-maximize'); } catch (_) { /* ignore */ }
        syncMaxIcon();
    });
    closeBtn?.addEventListener('click', () => { window.api.invoke('window-close').catch(() => {}); });
    drag?.addEventListener('dblclick', async () => {
        try { await window.api.invoke('window-maximize'); } catch (_) { /* ignore */ }
        syncMaxIcon();
    });
    syncMaxIcon();
}
wireFramelessChrome();

/** Keep in sync with src/shared/ipcChannels.js RECEIVE_CHANNELS */
const WEB_RECEIVE_CHANNELS = [
    'whatsapp-qr', 'whatsapp-ready', 'whatsapp-error', 'whatsapp-disconnected',
    'resource-update', 'plugin-ui-event', 'code-event', 'preview-event'
];

function createWebApiPolyfill() {
    const channelHandlers = new Map();
    let eventSource = null;
    let eventSourceToken = null;

    function ensureEventSource() {
        const token = localStorage.getItem('auth_token') || '';
        if (eventSource && eventSourceToken === token) return;
        if (eventSource) {
            try { eventSource.close(); } catch (e) { /* ignore */ }
            eventSource = null;
        }
        eventSourceToken = token;
        const qs = token ? `?token=${encodeURIComponent(token)}` : '';
        eventSource = new EventSource(`/api/events${qs}`);
        WEB_RECEIVE_CHANNELS.forEach((channel) => {
            eventSource.addEventListener(channel, (ev) => {
                let payload = ev.data;
                try { payload = JSON.parse(ev.data); } catch (e) { /* raw string ok */ }
                const handlers = channelHandlers.get(channel);
                if (handlers) handlers.forEach((fn) => { try { fn(payload); } catch (e2) { console.error(e2); } });
            });
        });
        eventSource.onerror = () => {
            // EventSource auto-reconnects; token may have changed after login
            const current = localStorage.getItem('auth_token') || '';
            if (current !== eventSourceToken) ensureEventSource();
        };
    }

    return {
        invoke: async (channel, ...args) => {
            try {
                const token = localStorage.getItem('auth_token');
                const headers = { 'Content-Type': 'application/json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;

                if (['auth-login', 'auth-register', 'auth-has-users'].includes(channel)) {
                    headers['x-auth-action'] = channel.replace('auth-', '');
                }

                // --- v48: add timeout to /api/invoke so mobile/web clients don't hang forever.
                const invokeTimeoutMs = parseInt(localStorage.getItem('agentsmith_request_timeout') || '300000', 10);
                const invokeController = new AbortController();
                const invokeTimerId = setTimeout(() => {
                    invokeController.abort(new Error(`Request timed out after ${invokeTimeoutMs / 1000}s`));
                }, invokeTimeoutMs);

                const response = await fetch('/api/invoke', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ channel, args }),
                    signal: invokeController.signal
                }).finally(() => clearTimeout(invokeTimerId));
                let data;
                try {
                    data = await response.json();
                } catch (e) {
                    data = { error: response.statusText || 'Invalid server response' };
                }
                if (!response.ok) {
                    const errMsg = data.error || data.message || `HTTP ${response.status}`;
                    return { error: errMsg, status: response.status };
                }
                return data;
            } catch (e) {
                return { error: e.message };
            }
        },
        on: (channel, callback) => {
            if (!WEB_RECEIVE_CHANNELS.includes(channel)) {
                throw new Error(`Blocked IPC channel: ${channel}`);
            }
            if (!channelHandlers.has(channel)) channelHandlers.set(channel, new Set());
            channelHandlers.get(channel).add(callback);
            if (isWebMode) ensureEventSource();
            return () => {
                const set = channelHandlers.get(channel);
                if (set) set.delete(callback);
            };
        },
        send: () => {},
        /** Reconnect SSE after login/logout (call from auth flow). */
        reconnectEvents: () => {
            eventSourceToken = null;
            if (isWebMode) ensureEventSource();
        }
    };
}

if (!window.api) {
    window.api = createWebApiPolyfill();
}

if (!window.markedParse) {
    window.markedParse = (text) => {
        if (typeof marked !== 'undefined' && marked.parse) {
            return marked.parse(text);
        }
        return text; // Fallback to raw text if marked is not available
    };
}

if (isWebMode) {
    const originalFetch = window.fetch;
    window.fetch = async (input, init = {}) => {
        let urlStr = typeof input === 'string' ? input : input.url;
        
        const token = localStorage.getItem('auth_token');
        if (token) {
            init.headers = { ...init.headers, 'Authorization': `Bearer ${token}` };
        }

        // Proxy ALL absolute HTTP requests through the Node host proxy to bypass CORS
        if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
            // Mobile devices can't hit localhost directly, so we tell the host to route to 127.0.0.1
            if (urlStr.includes('localhost')) {
                urlStr = urlStr.replace('localhost', '127.0.0.1');
            }
            const targetUrl = urlStr;
            urlStr = '/api/proxy/';
            init.headers = { ...init.headers, 'x-target-url': targetUrl };
        }
        return originalFetch(urlStr, init);
    };
}

// DOM Elements
const modelSelect = document.getElementById('model-select');
const tempSlider = document.getElementById('temp-slider');
const tempVal = document.getElementById('temp-val');
const ctxSlider = document.getElementById('ctx-slider');
const ctxVal = document.getElementById('ctx-val');
const stepsSlider = document.getElementById('steps-slider');
const stepsVal = document.getElementById('steps-val');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const messagesContainer = document.getElementById('messages');
const mainChatEl = document.getElementById('main-chat');

function scrollMessagesToLatest(force) {
    const sf = window.XKScrollFollow && window.XKScrollFollow.get();
    if (sf) {
        sf.follow(force ? { force: true } : undefined);
        return;
    }
    if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

if (messagesContainer && mainChatEl && window.XKScrollFollow) {
    window.XKScrollFollow.mount(messagesContainer, mainChatEl);
}
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const attachBtn = document.getElementById('attach-btn');
const attachmentsBar = document.getElementById('attachments-bar');
const memoryToggle = document.getElementById('memory-toggle');
const sudoInput = document.getElementById('sudo-input');
const memoryIndicator = document.getElementById('memory-indicator');
const memoryCountBadge = document.getElementById('memory-count-badge');
const clearBtn = document.getElementById('clear-btn');
const localTtsToggle = document.getElementById('local-tts-toggle');
const testAudioBtn = document.getElementById('test-audio-btn');


function localSpeak(text) {
    if (!window.speechSynthesis) {
        addMessage('system', 'Web Speech API (TTS) is not supported in this browser.');
        return;
    }
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    // Use a slightly more natural rate
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    
    window.speechSynthesis.speak(utterance);
}
const netrunnerToggle = document.getElementById('netrunner-toggle');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');

// --- Hardware Guard Elements (v30) ---
const hardwareMonitor = document.getElementById('hardware-monitor');
const vramInfo = document.getElementById('vram-info');
const ramInfo = document.getElementById('ram-info');
const gpuLoad = document.getElementById('gpu-load');
const hardResetBtn = document.getElementById('hard-reset-btn');
const vramBarFill = document.getElementById('vram-bar-fill');
const ramBarFill = document.getElementById('ram-bar-fill');

// --- Uplink Mode & Server Config ---
const uplinkMode = { checked: true }; // Forced true in v39.4: Ollama removed from UI selection
const lmsServerContainer = document.getElementById('lms-server-container');
const lmsServerInput = document.getElementById('lms-server-input');

// v50: LM Studio is the ONLY model provider. The Kimi K3 cloud toggle (v48) is gone;
// these accessors stay so the many call sites below keep working unchanged — they now
// resolve to "local backend, no API key" always.
const kimiK3Toggle = document.getElementById('kimi-k3-toggle'); // null in v50 UI (kept for persistence guards)
function kimiK3Active() { return false; }
function kimiK3ApiKey() { return ''; }
function effectiveApiBase() { return currentApiBase; }
function activeApiKey() { return 'lm-studio'; }
function activeModel() {
    return modelSelect?.value;
}

// --- Auth Elements ---
const loginOverlay = document.getElementById('login-overlay');
const loginFields = document.getElementById('login-fields');
const registerFields = document.getElementById('register-fields');
const authTitle = document.getElementById('auth-title');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const loginBtn = document.getElementById('login-btn');
const authSwitchText = document.getElementById('auth-switch-text');
const regUsername = document.getElementById('reg-username');
const regPassword = document.getElementById('reg-password');
const regPasswordConfirm = document.getElementById('reg-password-confirm');
const registerSubmitBtn = document.getElementById('register-submit-btn');
const regSwitchText = document.getElementById('reg-switch-text');
const authError = document.getElementById('auth-error');
const currentUserDisplay = document.getElementById('current-user-display');
const logoutBtn = document.getElementById('logout-btn');
const adminPanelBtn = document.getElementById('admin-panel-btn');
const adminOverlay = document.getElementById('admin-overlay');
const adminUserList = document.getElementById('admin-user-list');
const closeAdminBtn = document.getElementById('close-admin-btn');
const agentToggle = document.getElementById('agent-toggle');
const agentModeHint = document.getElementById('agent-mode-hint');
const codeModeToggle = document.getElementById('code-mode-toggle');
const codeModeUi = document.getElementById('code-mode-ui');
const codeModeHint = document.getElementById('code-mode-hint');
const codePlanApprovalToggle = document.getElementById('code-plan-approval-toggle');
const codeGrindToggle = document.getElementById('code-grind-toggle');
const codeIsolatedToggle = document.getElementById('code-isolated-toggle');
const codeParallelMilestonesToggle = document.getElementById('code-parallel-milestones-toggle');
const codeMilestoneWorktreesToggle = document.getElementById('code-milestone-worktrees-toggle');
const codeMilestoneConcurrentToggle = document.getElementById('code-milestone-concurrent-toggle');
const codeReadinessChip = document.getElementById('code-readiness-chip');
const codeStatusBar = document.getElementById('code-status-bar');
const codeReviewMount = document.getElementById('code-review-mount');

const chatRunState = window.XKRunState?.chatRunState || { isBusy: false, abortController: null };
const codeRunState = window.XKRunState?.codeRunState || { isBusy: false, abortController: null };
let codeModeHandler = null;

(function migrateLocalStorageKeys() {
    const suffixes = ['build_mode', 'code_mode', 'agent_mode', 'workspace', 'section_collapsed'];
    for (const s of suffixes) {
        const legacy = 'xkaliber_' + s;
        const next = 'agentsmith_' + s;
        try {
            if (localStorage.getItem(next) === null) {
                const v = localStorage.getItem(legacy);
                if (v !== null) localStorage.setItem(next, v);
            }
        } catch (e) { /* non-fatal */ }
    }
    // build_mode → code_mode one-time migration
    try {
        if (localStorage.getItem('agentsmith_code_mode') === null) {
            const old = localStorage.getItem('agentsmith_build_mode');
            if (old !== null) localStorage.setItem('agentsmith_code_mode', old);
        }
    } catch (e) { /* non-fatal */ }
})();

// v51.2 PER-MESSAGE ROUTING — Chat, Agent and Code share one conversation, but each
// message is routed by src/shared/taskClassifier.js: a detected CODING task runs the
// main-process Code engine (project build pipeline); everything else — plain chat plus
// ordinary agent tasks (organize files, check disk, read logs) — runs the Agent Mode
// chat path with its full host-control tool surface. The v50 bug was that BOTH getters
// below were hard-coded (`isCodeModeEnabled() { return true; }`), so EVERY message ran
// the build pipeline and the agent could barely chat. Routing now happens in
// sendMessage() per message — these getters describe the conversation's run context,
// not a global mode lock. The hidden mode checkboxes stay in the DOM so all legacy
// bindings keep working.
function isCodeModeEnabled() { return false; }

function isAgentModeEnabled() { return true; }

// Per-mode chat state. Declared here — above updateCodeModeUI, which runs at module
// load and calls maybeSwitchModeChat(), which reads these — so they exist before first
// use. A `let`/`const` declared later would be in the temporal dead zone and throw,
// aborting app.js (the cause of the "can't log in" regression).
const histories = { chat: [], agent: [], code: [] };
// Snapshot of EACH mode's rendered messages container. The activity timeline (tool
// cards, code run output) is not message-replayable, so we keep the full rendered HTML
// per mode and restore it on switch/relaunch — that's why tools + messages + reasoning
// all survive switching between Chat / Agent / Code and an app reload.
const modeSnapshots = { chat: '', agent: '', code: '' };
// The single in-flight run (one at a time; isSending is global). Tracks which mode owns
// it and its live bubble so switching away and back keeps the same agent streaming.
let activeRun = null;
let currentMode = 'chat';
let historiesReady = false;

let currentSystemPrompt = '';

function updateCodeModeUI() {
    const codeOn = isCodeModeEnabled();
    const agentOn = isAgentModeEnabled();
    if (codeModeUi) codeModeUi.style.display = codeOn ? 'block' : 'none';
    if (codeOn) refreshReadinessChip();
    if (codeModeHint) codeModeHint.style.display = codeOn ? 'block' : 'none';
    if (agentModeHint) agentModeHint.style.display = agentOn ? 'block' : 'none';
    const hereIAmBtn = document.getElementById('here-i-am-btn');
    if (hereIAmBtn) hereIAmBtn.style.display = 'block';
    const wsStatus = document.getElementById('workspace-status');
    if (wsStatus) wsStatus.style.display = wsStatus.textContent ? 'block' : 'none';
    if (userInput) {
        // v50 unified harness: one prompt for everything — build, inspect, operate.
        userInput.placeholder = 'What should Agent Smith do, Mr. Anderson…';
    }
    enforceModeExclusivity();
    maybeSwitchModeChat();
}

function enforceModeExclusivity() {
    const codeOn = isCodeModeEnabled();
    let agentOn = agentToggle?.checked === true;

    if (codeOn && agentOn && agentToggle) {
        agentToggle.checked = false;
        agentOn = false;
        try { localStorage.setItem('agentsmith_agent_mode', 'false'); } catch (e) { /* non-fatal */ }
    }
    if (agentOn && codeModeToggle?.checked) {
        codeModeToggle.checked = false;
        try { localStorage.setItem('agentsmith_code_mode', 'false'); } catch (e) { /* non-fatal */ }
    }

    const agentRow = agentToggle?.closest('.toggle-row');
    if (agentToggle) {
        agentToggle.disabled = codeOn || !!codeRunState.isBusy;
        if (agentRow) {
            agentRow.style.opacity = (codeOn || codeRunState.isBusy) ? '0.5' : '';
            agentRow.title = codeOn ? 'Disabled while Code Mode is on' : '';
        }
    }

    const codeRow = codeModeToggle?.closest('.toggle-row');
    if (codeModeToggle && !codeRunState.isBusy) {
        codeModeToggle.disabled = agentOn;
        if (codeRow) {
            codeRow.style.opacity = agentOn ? '0.5' : '';
            codeRow.title = agentOn ? 'Disabled while Agent Mode is on' : '';
        }
    }

    ['netrunner-toggle'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const blockNet = codeOn || agentOn;
        if (blockNet && el.checked) el.checked = false;
        el.disabled = blockNet;
        const row = el.closest('.toggle-row');
        if (row) row.style.opacity = blockNet ? '0.5' : '';
    });

    if (agentModeHint) agentModeHint.style.display = agentOn ? 'block' : 'none';
    if (codeModeHint) codeModeHint.style.display = codeOn ? 'block' : 'none';
}

function setCodeLock(locked) {
    if (!codeModeToggle) return;
    codeModeToggle.disabled = !!locked;
    const row = codeModeToggle.closest('.toggle-row');
    if (row) {
        row.style.opacity = locked ? '0.6' : '';
        row.title = locked ? 'Locked while Code Mode is running' : '';
    }
}

/** Show STOP + lock toggles for any active Code run (SEND, plan approve, resume, planning). */
function setCodeRunActive(active) {
    const on = !!active;
    codeRunState.isBusy = on;
    if (stopBtn) stopBtn.style.display = on ? 'block' : 'none';
    const planStopBtn = document.getElementById('plan-stop-btn');
    if (planStopBtn) planStopBtn.style.display = on ? 'inline-block' : 'none';
    setCodeLock(on);
}

async function showCodeReview(sessionId) {
    if (!sessionId || !window.XKCodeRunUI) return;
    const res = await window.api.invoke('code-ledger-diff', sessionId);
    window.XKCodeRunUI.renderReviewPanel(codeReviewMount, res?.diff || '', sessionId, async (sid) => {
        const rev = await window.api.invoke('ledger-revert-all', sid);
        addMessage('system', rev.success
            ? `**Reverted** ${rev.reverted?.length || 0} changes.`
            : `**Revert errors:** ${(rev.errors || []).join(', ')}`);
    });
}

if (codeModeToggle) {
    // v51.2: the code engine is routed PER MESSAGE by taskClassifier.js — a manual
    // "always on" lock is gone (that was the v50 bug). The checkbox survives for legacy
    // binding compatibility; routing reads sendMessage()'s classifier, not this box.
    codeModeToggle.checked = false;
    if (agentToggle) { agentToggle.checked = true; }
    try { localStorage.setItem('agentsmith_code_mode', 'false'); } catch (e) { /* non-fatal */ }
    codeModeToggle.addEventListener('change', () => {
        if (codeModeToggle.disabled) return;
        if (codeModeToggle.checked && agentToggle?.checked) {
            agentToggle.checked = false;
            localStorage.setItem('agentsmith_agent_mode', 'false');
        }
        localStorage.setItem('agentsmith_code_mode', codeModeToggle.checked ? 'true' : 'false');
        updateCodeModeUI();
    });
    setCodeLock(false);
    updateCodeModeUI();
}

if (agentToggle) {
    // v51.2: the agent host-control toolset is ALWAYS available on the chat path — this
    // legacy toggle stays on so mode UI/lock bindings keep working.
    const savedAgent = localStorage.getItem('agentsmith_agent_mode');
    if (savedAgent === 'false') { /* still keep it on — routing no longer reads it */ }
    agentToggle.checked = true;
    try { localStorage.setItem('agentsmith_agent_mode', 'true'); } catch (e) { /* non-fatal */ }
    agentToggle.addEventListener('change', () => {
        if (agentToggle.disabled) return;
        if (!agentToggle.checked && codeModeToggle?.checked) {
            // Unified mode: keep the engine on regardless.
            localStorage.setItem('agentsmith_agent_mode', 'true');
        }
        updateCodeModeUI();
    });
}

if (ctxSlider && ctxVal) {
    ctxSlider.addEventListener('input', () => { ctxVal.textContent = ctxSlider.value; });
}

if (window.XKRuntimeProfileUI) {
    window.XKRuntimeProfileUI.mount({
        modelSelect,
        sliders: { tempSlider, tempVal, ctxSlider, ctxVal, stepsSlider, stepsVal },
        chipEl: document.getElementById('runtime-profile-chip'),
        toggleEl: document.getElementById('auto-tune-toggle'),
        getApiBaseUrl: () => effectiveApiBase(),
        isBusy: () => chatRunState.isBusy || codeRunState.isBusy
    });
}

// Manual tuning (temperature, thinking steps, context window) is only meaningful when
// Auto-tune is OFF — otherwise the runtime profile overwrites the sliders per model +
// hardware. Keep them out of sight so a "just go" user never has to think about them.
(function wireAutoTuneVisibility() {
    const autoToggle = document.getElementById('auto-tune-toggle');
    const fields = ['manual-tuning-fields', 'manual-ctx-field'];
    function syncAutoTuneVisibility() {
        const manual = !!(autoToggle && !autoToggle.checked); // show only when auto-tune is off
        fields.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.style.display = manual ? '' : 'none';
        });
    }
    if (autoToggle) autoToggle.addEventListener('change', syncAutoTuneVisibility);
    syncAutoTuneVisibility();
})();

// Build Mode always starts in PLAN (plan-then-execute) and always GRINDS (keep fixing
// until checks pass) — these are the engineered defaults, so they have no UI chip and
// can't be toggled off. ISO (isolated git-worktree runs) is unused and always off.
function getRequirePlanApproval() {
    return true;
}

function getGrindMode() {
    return true;
}

function getIsolatedRun() {
    return false;
}

function getParallelMilestones() {
    return codeParallelMilestonesToggle?.checked === true;
}

function getMilestoneWorktrees() {
    return codeMilestoneWorktreesToggle?.checked === true && getParallelMilestones();
}

function getMilestoneConcurrent() {
    return codeMilestoneConcurrentToggle?.checked === true && getMilestoneWorktrees();
}

async function refreshReadinessChip() {
    if (!codeReadinessChip || !isCodeModeEnabled()) return;
    try {
        const root = await window.api.invoke('project-get-root');
        const projectRoot = root?.projectRoot || root?.root;
        if (!projectRoot) {
            codeReadinessChip.style.display = 'none';
            return;
        }
        const r = await window.api.invoke('code-readiness', { projectRoot });
        if (r?.score != null) {
            codeReadinessChip.style.display = 'block';
            codeReadinessChip.textContent = `Readiness: ${r.score}/${r.maxScore}`;
        }
    } catch (e) {
        codeReadinessChip.style.display = 'none';
    }
}

if (codePlanApprovalToggle) {
    const savedPlan = localStorage.getItem('agentsmith_code_plan_approval');
    if (savedPlan === 'true') codePlanApprovalToggle.checked = true;
    codePlanApprovalToggle.addEventListener('change', () => {
        localStorage.setItem('agentsmith_code_plan_approval', codePlanApprovalToggle.checked ? 'true' : 'false');
    });
}

if (codeGrindToggle) {
    const savedGrind = localStorage.getItem('agentsmith_code_grind');
    if (savedGrind === 'false') codeGrindToggle.checked = false;
    codeGrindToggle.addEventListener('change', () => {
        localStorage.setItem('agentsmith_code_grind', codeGrindToggle.checked ? 'true' : 'false');
    });
}

if (codeIsolatedToggle) {
    const savedIso = localStorage.getItem('agentsmith_code_isolated');
    if (savedIso === 'true') codeIsolatedToggle.checked = true;
    codeIsolatedToggle.addEventListener('change', () => {
        localStorage.setItem('agentsmith_code_isolated', codeIsolatedToggle.checked ? 'true' : 'false');
    });
}

if (codeParallelMilestonesToggle) {
    const savedPar = localStorage.getItem('agentsmith_code_parallel_milestones');
    if (savedPar === 'true') codeParallelMilestonesToggle.checked = true;
    codeParallelMilestonesToggle.addEventListener('change', () => {
        localStorage.setItem('agentsmith_code_parallel_milestones', codeParallelMilestonesToggle.checked ? 'true' : 'false');
        if (!codeParallelMilestonesToggle.checked && codeMilestoneWorktreesToggle) {
            codeMilestoneWorktreesToggle.checked = false;
            localStorage.setItem('agentsmith_code_milestone_worktrees', 'false');
        }
        if (!codeParallelMilestonesToggle.checked && codeMilestoneConcurrentToggle) {
            codeMilestoneConcurrentToggle.checked = false;
            localStorage.setItem('agentsmith_code_milestone_concurrent', 'false');
        }
    });
}

if (codeMilestoneWorktreesToggle) {
    const savedWt = localStorage.getItem('agentsmith_code_milestone_worktrees');
    if (savedWt === 'true') codeMilestoneWorktreesToggle.checked = true;
    codeMilestoneWorktreesToggle.addEventListener('change', () => {
        localStorage.setItem('agentsmith_code_milestone_worktrees', codeMilestoneWorktreesToggle.checked ? 'true' : 'false');
        if (!codeMilestoneWorktreesToggle.checked && codeMilestoneConcurrentToggle) {
            codeMilestoneConcurrentToggle.checked = false;
            localStorage.setItem('agentsmith_code_milestone_concurrent', 'false');
        }
    });
}

if (codeMilestoneConcurrentToggle) {
    const savedConc = localStorage.getItem('agentsmith_code_milestone_concurrent');
    if (savedConc === 'true') codeMilestoneConcurrentToggle.checked = true;
    codeMilestoneConcurrentToggle.addEventListener('change', () => {
        localStorage.setItem('agentsmith_code_milestone_concurrent', codeMilestoneConcurrentToggle.checked ? 'true' : 'false');
    });
}

if (window.XKCodeMode) {
    codeModeHandler = window.XKCodeMode.mount({
        codeRunState,
        addMessage,
        markedParse: window.markedParse,
        updateEmptyState,
        getModel: () => activeModel(),
        getNumCtx: () => parseInt(ctxSlider?.value || '8192', 10),
        getMaxTurns: () => window.XKRuntimeProfileUI?.getMaxTurns?.() ?? 40,
        getCodeTemperature: () => window.XKRuntimeProfileUI?.getCodeTemperature?.() ?? 0.2,
        getRequirePlanApproval,
        getGrindMode,
        getIsolatedRun,
        getParallelMilestones,
        getMilestoneWorktrees,
        getMilestoneConcurrent,
        setCodeLock,
        setCodeRunActive,
        getProjectRoot: async () => {
            const r = await window.api.invoke('project-get-root');
            return r?.projectRoot || r?.root || null;
        },
        getApiBase: () => effectiveApiBase(),
        getApiKey: () => (kimiK3Active() ? kimiK3ApiKey() : null),
        flushContextSync: () => window.XKRuntimeProfileUI?.flushPendingContextSync?.(),
        onStatusUpdate: (st) => window.XKCodeRunUI?.updateStatusBar(codeStatusBar, st),
        onReview: (sid) => showCodeReview(sid),
        onTimelineChanged: scheduleCodeTimelinePersist
    });
    document.getElementById('plan-stop-btn')?.addEventListener('click', () => stopBtn?.click());
}

if (window.XKActivityTimeline && messagesContainer && !window.XKSharedTimeline) {
    window.XKActivityTimeline.mount(messagesContainer, {
        markedParse: window.markedParse,
        updateEmptyState
    });
}

// Wire the sidebar shell: collapsible sections, run-mode drawer/rail, pin, and the
// mobile settings overlay + plan bottom sheet.
if (window.XKSidebarLayout) window.XKSidebarLayout.init();
if (window.XKCodePlanPanel) window.XKCodePlanPanel.init();
if (window.XKPreviewPanel) window.XKPreviewPanel.init();

function getAllowDesktopPreview() {
    const el = document.getElementById('preview-desktop-toggle');
    return el?.checked === true;
}

function syncPreviewDesktopToMain() {
    try {
        window.api.invoke('preview-sync-desktop', { enabled: getAllowDesktopPreview() });
    } catch (e) { /* non-fatal */ }
}

const previewDesktopToggle = document.getElementById('preview-desktop-toggle');
if (previewDesktopToggle) {
    const savedPreviewDesktop = localStorage.getItem('agentsmith_preview_desktop');
    if (savedPreviewDesktop === 'true') previewDesktopToggle.checked = true;
    previewDesktopToggle.addEventListener('change', () => {
        localStorage.setItem('agentsmith_preview_desktop', previewDesktopToggle.checked ? 'true' : 'false');
        syncPreviewDesktopToMain();
    });
    syncPreviewDesktopToMain();
}

try {
    window.api.on('preview-event', (ev) => {
        window.XKPreviewPanel?.handleEvent(ev);
    });
} catch (e) { /* non-fatal */ }

function updateWorkspaceStatus(rootPath) {
    const el = document.getElementById('workspace-status');
    if (!el) return;
    if (rootPath) {
        el.textContent = `📁 Workspace: ${rootPath}`;
        el.style.color = '#3fb950';
    } else {
        el.textContent = '⚠️ No workspace selected — click "Here I am".';
        el.style.color = '#d29922';
    }
    el.style.display = 'block';
}

async function applyWorkspace(rootPath, { announce = true } = {}) {
    const rootRes = await window.api.invoke('project-set-root', rootPath);
    if (rootRes.success) {
        localStorage.setItem('agentsmith_workspace', rootRes.projectRoot);
        updateWorkspaceStatus(rootRes.projectRoot);
        if (announce) addMessage('system', `📍 **Workspace set to:** \`${rootRes.projectRoot}\`\nAgent will now perform tasks inside this directory.`);
        return true;
    }
    if (announce) addMessage('system', `❌ **Failed to set workspace:** ${rootRes.error}`);
    return false;
}

const hereBtn = document.getElementById('here-i-am-btn');
if (hereBtn) {
    hereBtn.addEventListener('click', async () => {
        const res = await window.api.invoke('select-directory');
        if (res && res.path) {
            await applyWorkspace(res.path);
        }
    });
}

// Restore the last-selected workspace across restarts (main-process root is in-memory only).
(async () => {
    const saved = localStorage.getItem('agentsmith_workspace');
    if (saved) {
        const ok = await applyWorkspace(saved, { announce: false });
        if (!ok) localStorage.removeItem('agentsmith_workspace');
    } else {
        updateWorkspaceStatus(null);
    }
})();

const OLLAMA_API = 'http://127.0.0.1:11434/api';
let currentApiBase = 'http://127.0.0.1:1234'; 

if (lmsServerInput) {
    lmsServerInput.addEventListener('change', () => {
        updateApiBase();
        fetchModels();
    });
}

function updateApiBase() {
    let server = lmsServerInput.value.trim();
    if (server.endsWith('/')) server = server.slice(0, -1);
    currentApiBase = server;
    // Notify host of URL change (proxy origin + embeddings fallback). Best-effort:
    // a failure here must NEVER abort the caller (it used to throw "Blocked IPC
    // channel: set-lms-url", which skipped fetchModels() so the model list never
    // reloaded for the new backend → "can't pick a model / can't build").
    // Second array element pins the MEMORY/embeddings base — when Kimi K3 is active
    // the chat/agent/code base is remote (no embeddings API), so memory keeps using
    // the local backend.
    try {
        const p = window.api.invoke('set-lms-url', [effectiveApiBase(), currentApiBase]);
        if (p && p.catch) p.catch(() => {});
    } catch (e) { /* host notification is optional */ }
}

// --- v50: LM Studio is the only provider (the Kimi K3 cloud toggle was removed) ----
// syncKimiK3UI stays as a no-op guard for legacy callers; the local backend URL field
// always drives memory embeddings + chat, and updateApiBase() pushes it to main.
function syncKimiK3UI() {
    if (modelSelect) modelSelect.disabled = false;
    if (lmsServerInput) lmsServerInput.disabled = false; // feeds memory embeddings too
}

// Push the local backend state to the main process (proxy allow-list + code fallback
// base + memory base) so a relaunch is correct from boot.
syncKimiK3UI();
updateApiBase();

let attachedFiles = [];
let abortController = null;
let chatHistory = [];

// --- Per-mode chat histories -------------------------------------------------
// Chat / Agent / Code each keep a SEPARATE, persisted conversation so switching
// modes never mixes their messages. `chatHistory` always points at the active
// mode's array; persist() saves all three to disk under one keyed object.
// NOTE: histories/currentMode/historiesReady/currentSystemPrompt are declared EARLIER
// (just above updateCodeModeUI) so they're initialized before that function's first
// module-load call reaches maybeSwitchModeChat — a later `let` would throw a TDZ error
// and abort app.js (which silently broke login).

function activeMode() {
    return isCodeModeEnabled() ? 'code' : (isAgentModeEnabled() ? 'agent' : 'chat');
}
function seedHistory(mode) {
    const base = currentSystemPrompt ? [{ role: 'system', content: currentSystemPrompt }] : [];
    if (mode === 'chat' && window.SmithPersona && window.SmithPersona.SMITH_GREETING) {
        base.push({ role: 'assistant', content: window.SmithPersona.SMITH_GREETING });
    }
    return base;
}
function snapshotCurrentMode() {
    if (!messagesContainer) return;
    // Save the CURRENT mode's full rendered view (messages + tool/activity cards) so it
    // can be restored verbatim on switch/relaunch. Ephemeral "running" pulses are stripped.
    modeSnapshots[currentMode] = window.XKHistoryPersistence
        ? window.XKHistoryPersistence.sanitizeCodeTimelineHtml(messagesContainer.innerHTML)
        : (messagesContainer.innerHTML || '');
}
let codeTimelinePersistTimer = null;
function scheduleCodeTimelinePersist() {
    clearTimeout(codeTimelinePersistTimer);
    codeTimelinePersistTimer = setTimeout(() => {
        codeTimelinePersistTimer = null;
        persist();
    }, 120);
}
function persist() {
    histories[currentMode] = chatHistory;
    snapshotCurrentMode();
    try {
        window.api.invoke('save-history', {
            __modes: true,
            chat: histories.chat,
            agent: histories.agent,
            code: histories.code,
            snapshots: modeSnapshots,
            codeTimelineHtml: modeSnapshots.code // back-compat with older loaders
        });
    } catch (e) { /* non-fatal */ }
}
function maybeSwitchModeChat() {
    if (!historiesReady) return;
    const m = activeMode();
    // Pure stash/restore/seed of the message arrays (unit-tested in tests/modeHistory.test.js).
    const res = window.XKModeHistory.planModeSwitch(histories, currentMode, chatHistory, m, seedHistory);
    if (!res.switched) return;
    // If a run is live in the OUTGOING mode, detach its bubble first so the snapshot holds
    // only settled content (it's re-attached on return, or committed on completion). The
    // element stays alive and keeps streaming while detached.
    if (activeRun && activeRun.mode === currentMode && activeRun.botDiv && activeRun.botDiv.parentNode) {
        activeRun.botDiv.remove();
    }
    // Snapshot the OUTGOING mode's full rendered view (messages + tool cards) BEFORE the
    // pointers flip, so nothing is lost. Switching is always allowed, even mid-run — the
    // run keeps streaming into its own bubble (re-attached below when you return).
    snapshotCurrentMode();
    currentMode = res.currentMode;
    chatHistory = res.chatHistory;
    if (window.XKSharedTimeline && window.XKSharedTimeline.reset) window.XKSharedTimeline.reset();
    if (modeSnapshots[currentMode]) {
        messagesContainer.innerHTML = modeSnapshots[currentMode]; // restore full view incl. tool cards
    } else {
        messagesContainer.innerHTML = '';
        renderHistory();
    }
    // If a run is live in the mode we just entered, re-attach its bubble so we see it
    // still streaming (the same agent, still running).
    if (activeRun && activeRun.mode === currentMode && activeRun.botDiv && messagesContainer) {
        messagesContainer.appendChild(activeRun.botDiv);
    }
    updateEmptyState();
    persist();
}


// --- WhatsApp wiring ---
const waLinkBtn = document.getElementById('wa-link-btn');
const qrModal = document.getElementById('qr-modal');
const qrImage = document.getElementById('qr-image');
const closeQr = document.getElementById('close-qr');
const phoneConnectBtn = document.getElementById('phone-connect-btn');
const qrTitle = document.getElementById('qr-title');
const qrCaption = document.getElementById('qr-caption');
const qrDetail = document.getElementById('qr-detail');
const WA_TITLE = 'Link WhatsApp — send & receive messages';
// True only while the user wants the WhatsApp QR shown. whatsapp-web.js re-emits a fresh
// 'qr' every ~20s; without this gate, closing the modal would let the next refresh
// re-spawn it. Closing also cancels the pending link (see closeQrModal).
let waQrActive = false;

// One modal, three uses: web-remote QR (phone button), WhatsApp QR, WhatsApp onboarding.
function showQrModal({ title, imgSrc, caption, detailHtml }) {
    if (!qrModal) return;
    if (qrTitle) qrTitle.textContent = title || 'CONNECT';
    if (qrImage) {
        if (imgSrc) { qrImage.src = imgSrc; qrImage.style.display = ''; }
        else { qrImage.removeAttribute('src'); qrImage.style.display = 'none'; }
    }
    if (qrCaption) { qrCaption.textContent = caption || ''; qrCaption.style.display = caption ? '' : 'none'; }
    if (qrDetail) qrDetail.innerHTML = detailHtml || '';
    qrModal.classList.add('qr-modal--open');
}

function hideQrModal() {
    if (qrModal) qrModal.classList.remove('qr-modal--open');
}

const escAttr = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');

async function ensureQrDataUrl(payload) {
    if (!payload?.url || payload.qrDataUrl) return payload;
    if (!window.qr?.toDataURL) return payload;
    try {
        payload.qrDataUrl = await window.qr.toDataURL(payload.url);
        if (payload.qrDataUrl) delete payload.error;
    } catch (e) {
        payload.error = payload.error || (`QR render failed: ${e.message}`);
    }
    return payload;
}

async function fetchRemoteQrPayload() {
    let res = null;
    try {
        res = await window.api.invoke('get-remote-qr');
    } catch (e) {
        // Older builds may lack get-remote-qr — fall back to the host URL readout.
        try {
            const host = await window.api.invoke('get-host-url');
            const url = host?.remoteUrl || host?.url || '';
            res = {
                url,
                isRemote: !!host?.remoteUrl,
                ...(url ? {} : { error: e.message })
            };
        } catch (e2) {
            res = { error: e.message || String(e) };
        }
    }
    return ensureQrDataUrl(res || {});
}

// 📱 composer button → QR to open the web UI on your phone (scan to open).
// Pointless when you're already in a browser/phone (web mode), so hide it there.
if (isWebMode && phoneConnectBtn) phoneConnectBtn.style.display = 'none';
if (phoneConnectBtn && !isWebMode) {
    phoneConnectBtn.addEventListener('click', async () => {
        showQrModal({
            title: 'OPEN ON YOUR PHONE',
            imgSrc: null,
            caption: '',
            detailHtml: '<div class="qr-loading"><div class="qr-spinner" aria-hidden="true"></div>Preparing link…</div>'
        });
        const res = await fetchRemoteQrPayload();
        const url = res?.url || '';
        const scope = res?.isRemote
            ? 'Works from anywhere — this is a secure public link.'
            : 'Keep your phone on the same Wi‑Fi as this computer.';
        const badge = res?.isRemote
            ? '<span class="qr-badge qr-badge--remote">⦿ REMOTE · works anywhere</span>'
            : '<span class="qr-badge qr-badge--lan">⌂ LAN · same Wi‑Fi</span>';
        const link = url ? `<a href="${escAttr(url)}" target="_blank" class="qr-link">${escAttr(url)}</a>` : '<span class="qr-note">(server URL unavailable)</span>';
        const note = res?.error ? escAttr(res.error) : scope;
        showQrModal({
            title: 'OPEN ON YOUR PHONE',
            imgSrc: res?.qrDataUrl || null,
            caption: res?.qrDataUrl ? 'Scan to open Agent Smith' : 'Open this URL on your phone:',
            detailHtml: `${badge}${link}<div class="qr-note">${note}</div>`
        });
    });
}

function showWhatsAppOnboarding() {
    const cmd = 'npm install whatsapp-web.js qrcode';
    showQrModal({
        title: 'LINK WHATSAPP',
        imgSrc: null,
        caption: 'WhatsApp isn’t set up on this computer yet.',
        detailHtml: `<div class="qr-note">Linking lets Agent Smith send & receive WhatsApp messages. It needs a one‑time install (pulls Chromium, ~150&nbsp;MB):</div>`
            + `<code class="qr-cmd" id="wa-install-cmd">${cmd}</code>`
            + `<button class="qr-copy-btn" id="wa-copy-cmd">COPY COMMAND</button>`
            + `<div class="qr-note">Then restart Agent Smith and press LINK WHATSAPP again to scan the QR.</div>`
    });
    wireWaCopyBtn('wa-copy-cmd', cmd);
}

function showWhatsAppChromeOnboarding() {
    const cmd = 'npx puppeteer browsers install chrome';
    showQrModal({
        title: 'LINK WHATSAPP',
        imgSrc: null,
        caption: 'Chrome is required to show the WhatsApp QR code.',
        detailHtml: `<div class="qr-note">WhatsApp linking opens a headless Chrome window via Puppeteer. If you already have Google Chrome installed, restart Agent Smith and try again. Otherwise run this once in the project folder (~150&nbsp;MB download):</div>`
            + `<code class="qr-cmd" id="wa-chrome-cmd">${cmd}</code>`
            + `<button class="qr-copy-btn" id="wa-copy-chrome-cmd">COPY COMMAND</button>`
            + `<div class="qr-note">Then restart Agent Smith and press LINK WHATSAPP again.</div>`
    });
    wireWaCopyBtn('wa-copy-chrome-cmd', cmd);
}

function wireWaCopyBtn(id, cmd) {
    const copyBtn = document.getElementById(id);
    if (copyBtn) copyBtn.addEventListener('click', () => {
        try { navigator.clipboard?.writeText(cmd); } catch (e) { /* ignore */ }
        copyBtn.textContent = 'COPIED ✓';
        setTimeout(() => { copyBtn.textContent = 'COPY COMMAND'; }, 1500);
    });
}

function handleWhatsAppInitError(errorText) {
    if (/not installed/i.test(errorText)) showWhatsAppOnboarding();
    else if (/could not find chrome|chrome not found|puppeteer browsers install/i.test(errorText)) showWhatsAppChromeOnboarding();
    else addMessage('system', `**WhatsApp Error:** ${errorText}`);
}

if (waLinkBtn) {
    waLinkBtn.addEventListener('click', async () => {
        waQrActive = true;
        waLinkBtn.disabled = true;
        waLinkBtn.title = 'Connecting WhatsApp…';
        let res;
        try { res = await window.api.invoke('whatsapp-init'); } catch (e) { res = { error: e.message }; }
        if (res?.error) {
            waQrActive = false;
            waLinkBtn.disabled = false;
            waLinkBtn.title = WA_TITLE;
            handleWhatsAppInitError(res.error);
        }
    });
}

window.api.on('whatsapp-qr', (dataUrl) => {
    if (!waQrActive) return; // user dismissed the modal — don't let a QR refresh re-spawn it
    // This is a WhatsApp ACCOUNT-LINKING code, not a web link — it must be scanned from
    // inside WhatsApp (Linked Devices), NOT the phone camera, or you get a dead link.
    showQrModal({
        title: 'LINK WHATSAPP',
        imgSrc: dataUrl,
        caption: 'Link Agent Smith to your WhatsApp',
        detailHtml:
            '<div class="qr-steps">'
            + '<div>On your <b>phone</b>, open <b>WhatsApp</b>, then:</div>'
            + '<div><b>1.</b> Tap <b>Settings</b> (iPhone) or <b>⋮ menu</b> (Android)</div>'
            + '<div><b>2.</b> <b>Linked Devices</b> → <b>Link a Device</b></div>'
            + '<div><b>3.</b> Point it at this code</div>'
            + '</div>'
            + '<div class="qr-note">Use WhatsApp’s own scanner — <b>not</b> your phone’s camera app. The camera can’t read a login code and will show a dead link.</div>'
    });
});

window.api.on('whatsapp-ready', () => {
    waQrActive = false;
    hideQrModal();
    if (waLinkBtn) { waLinkBtn.textContent = '✅'; waLinkBtn.title = 'WhatsApp linked'; waLinkBtn.disabled = true; }
    addMessage('system', 'WhatsApp linked successfully.');
});

window.api.on('whatsapp-error', (msg) => {
    waQrActive = false;
    addMessage('system', `**WhatsApp Auth Error:** ${msg}`);
    if (waLinkBtn) { waLinkBtn.disabled = false; waLinkBtn.textContent = '💬'; waLinkBtn.title = WA_TITLE; }
});

window.api.on('whatsapp-disconnected', () => {
    waQrActive = false;
    addMessage('system', 'WhatsApp disconnected.');
    if (waLinkBtn) { waLinkBtn.disabled = false; waLinkBtn.textContent = '💬'; waLinkBtn.title = WA_TITLE; }
});

// Closing the modal while a WhatsApp QR is pending also CANCELS the link attempt, so the
// background client stops emitting fresh QRs (and shuts its headless Chrome).
function closeQrModal() {
    if (waQrActive) {
        waQrActive = false;
        try { window.api.invoke('whatsapp-cancel'); } catch (e) { /* ignore */ }
        if (waLinkBtn) { waLinkBtn.disabled = false; waLinkBtn.textContent = '💬'; waLinkBtn.title = WA_TITLE; }
    }
    hideQrModal();
}

if (closeQr) {
    closeQr.addEventListener('click', closeQrModal);
}
if (qrModal) {
    qrModal.addEventListener('click', (e) => {
        if (e.target === qrModal) closeQrModal();
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && qrModal?.classList.contains('qr-modal--open')) closeQrModal();
});

// --- TTS (browser Web Speech API only; Piper removed) ---
if (testAudioBtn) {
    testAudioBtn.addEventListener('click', () => {
        localSpeak('Agent Smith audio is operational.');
    });
}

// --- Attachment Handling ---
const fileInput = document.getElementById('file-input');

if (attachBtn) {
    attachBtn.addEventListener('click', async () => {
        // If we're in a browser (not Electron), use the HTML input
        if (isWebMode) {
            fileInput.click();
        } else {
            const file = await window.api.invoke('open-file-dialog');
            if (file && !file.error) {
                attachedFiles.push(file);
                renderAttachments();
            } else if (file?.error) {
                addMessage('system', `**ATTACHMENT ERROR**: ${file.error}`);
            }
        }
    });
}

if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const isImage = file.type.startsWith('image/');
        const reader = new FileReader();
        
        reader.onload = async (event) => {
            let fileData;
            if (isImage) {
                if (file.size > 50 * 1024 * 1024) {
                    addMessage('system', 'Image file is too large (over 50MB limit).');
                    return;
                }
                const base64 = event.target.result.split(',')[1];
                fileData = {
                    fileName: file.name,
                    isImage: true,
                    base64: base64,
                    size: file.size
                };
            } else {
                let content = event.target.result;
                if (file.size >= 1024 * 1024) {
                    content = `[FILE TOO LARGE TO AUTO-READ: ${file.size} bytes. Use read_file tool if it exists on host.]`;
                }
                fileData = {
                    fileName: file.name,
                    isImage: false,
                    content: content,
                    size: file.size
                };
            }
            attachedFiles.push(fileData);
            renderAttachments();
            fileInput.value = ''; // Reset
        };

        if (isImage) {
            reader.readAsDataURL(file);
        } else {
            reader.readAsText(file);
        }
    });
}

function renderAttachments() {
    attachmentsBar.innerHTML = '';
    attachedFiles.forEach((file, index) => {
        const tag = document.createElement('div');
        tag.className = 'attachment-tag';
        tag.innerHTML = `${file.isImage ? '🖼️' : '📎'} ${file.fileName} <span class="remove-attach" data-index="${index}">×</span>`;
        attachmentsBar.appendChild(tag);
    });
    document.querySelectorAll('.remove-attach').forEach(btn => {
        btn.onclick = (e) => {
            attachedFiles.splice(parseInt(e.target.dataset.index), 1);
            renderAttachments();
        };
    });
}

// --- Param Displays ---
[tempSlider, stepsSlider, ctxSlider].forEach(s => s && s.addEventListener('input', () => {
    if (tempVal) tempVal.textContent = parseFloat(tempSlider.value).toFixed(1);
    if (stepsVal) stepsVal.textContent = stepsSlider.value;
    if (ctxVal && ctxSlider) ctxVal.textContent = ctxSlider.value;
}));
if (ctxVal && ctxSlider) ctxVal.textContent = ctxSlider.value;

// --- Memory helpers ---
async function pageOutModel(modelName) {
    if (!modelName || uplinkMode.checked) return;
    if (isSending) {
        console.warn(`[PAGING] Skipping page out for ${modelName} because a generation task is currently active.`);
        return;
    }
    console.log(`[PAGING] Paging out model: ${modelName} to free VRAM.`);
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        await fetch(`${OLLAMA_API}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, messages: [], keep_alive: 0 }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
    } catch(e) { console.warn(`[PAGING] Failed to page out ${modelName}`, e.message); }
}

async function updateMemoryCount() {
    if (memoryCountBadge) {
        try {
            const countRes = await window.api.invoke('mem-count');
            // Backend returns raw number on desktop, but might be wrapped or error in proxy
            let finalCount = 0;
            if (typeof countRes === 'number') finalCount = countRes;
            else if (countRes && typeof countRes.count === 'number') finalCount = countRes.count;
            else if (countRes && !countRes.error) finalCount = parseInt(countRes) || 0;
            
            memoryCountBadge.textContent = `[${finalCount} MEMS]`;
        } catch (e) {
            console.warn('Failed to update memory count:', e);
        }
    }
}

async function saveToMemory(text, metadata = {}) {
    if (!memoryToggle.checked || !text) return { error: "Memory disabled" };
    memoryIndicator.style.display = 'block';
    const res = await window.api.invoke('mem-store', { text, metadata });
    setTimeout(() => { memoryIndicator.style.display = 'none'; }, 2000);
    if (res?.success) updateMemoryCount();
    return res;
}

async function searchMemory(query) {
    const res = await window.api.invoke('mem-query', { query, limit: 5 });
    if (res?.success) return res.data.filter(r => r.similarity > 0.15);
    return [];
}

// --- Clear / Export / Import ---
if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
        await window.api.invoke('mem-clear');
        // Wipe only the ACTIVE mode's conversation; other modes are untouched.
        chatHistory = seedHistory(currentMode);
        histories[currentMode] = chatHistory;
        modeSnapshots[currentMode] = '';
        messagesContainer.innerHTML = '';
        if (window.XKSharedTimeline && window.XKSharedTimeline.reset) window.XKSharedTimeline.reset();
        showToast('Neural memory wiped.');
        persist();
        updateEmptyState();
        updateMemoryCount();
    });
}


if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
        if (chatHistory.length === 0) { addMessage('system', 'Nothing to export.'); return; }
        const result = await window.api.invoke('export-session', chatHistory);
        if (result?.success) addMessage('system', `Session exported to **${result.filePath}**`);
    });
}

if (importBtn) {
    importBtn.addEventListener('click', async () => {
        const data = await window.api.invoke('import-session');
        if (data?.error) { addMessage('system', `**Import Error:** ${data.error}`); return; }
        if (data && Array.isArray(data)) {
            chatHistory = data;
            histories[currentMode] = chatHistory; // import into the active mode
            messagesContainer.innerHTML = '';
            renderHistory();
            persist();
            addMessage('system', 'Session imported successfully.');
        }
    });
}

// --- Init & Connection ---
let authToken = localStorage.getItem('auth_token');

async function checkAuth() {
    if (!authToken) {
        showLogin();
        return;
    }
    const res = await window.api.invoke('auth-check', authToken);
    if (res?.error && isWebMode) {
        addMessage('system', `**Access denied:** ${res.error}`);
    }
    if (res.authenticated) {
        if (window.api.reconnectEvents) window.api.reconnectEvents();
        hideLogin(res.user);
    } else {
        localStorage.removeItem('auth_token');
        authToken = null;
        showLogin();
    }
}

function showLogin() {
    loginOverlay.style.display = 'flex';
    // Check if any users exist
    window.api.invoke('auth-has-users').then(res => {
        if (res && !res.hasUsers) {
            showRegister();
            authTitle.textContent = 'CREATE ADMIN ACCOUNT';
            if (regSwitchText) regSwitchText.style.display = 'none';
        }
    });
}

function hideLogin(user) {
    loginOverlay.style.display = 'none';
    currentUserDisplay.textContent = `User: ${user.username}`;

    if (user.role === 'admin') {
        adminPanelBtn.style.display = 'block';
    } else {
        adminPanelBtn.style.display = 'none';
    }

    if (!user.permissions.canUseTools) {
        agentToggle.checked = false;
        agentToggle.disabled = true;
        agentToggle.parentElement.style.opacity = '0.5';
        agentToggle.parentElement.title = 'Disabled by Administrator';
        if (codeModeToggle) {
            codeModeToggle.checked = false;
            codeModeToggle.disabled = true;
            const codeRow = codeModeToggle.closest('.toggle-row');
            if (codeRow) {
                codeRow.style.opacity = '0.5';
                codeRow.title = 'Disabled by Administrator';
            }
        }
    } else {
        agentToggle.disabled = false;
        agentToggle.parentElement.style.opacity = '1';
        agentToggle.parentElement.title = '';
        if (codeModeToggle && !codeRunState.isBusy) {
            codeModeToggle.disabled = isAgentModeEnabled();
        }
    }

    updateCodeModeUI();
    init();
}

function showRegister() {
    loginFields.style.display = 'none';
    registerFields.style.display = 'block';
    authTitle.textContent = 'CREATE ACCOUNT';
}

function showLoginForm() {
    registerFields.style.display = 'none';
    loginFields.style.display = 'block';
    authTitle.textContent = 'LOGIN REQUIRED';
}

if (authSwitchText) authSwitchText.addEventListener('click', showRegister);
if (regSwitchText) regSwitchText.addEventListener('click', showLoginForm);

if (loginBtn) {
    const doLogin = async () => {
        const username = authUsername.value.trim();
        const password = authPassword.value;
        authError.style.color = '';
        if (!username || !password) {
            authError.textContent = 'Enter a username and password.';
            return;
        }
        loginBtn.disabled = true;
        authError.textContent = '';
        try {
            const res = await window.api.invoke('auth-login', { username, password });
            if (res && res.success) {
                authToken = res.token;
                localStorage.setItem('auth_token', authToken);
                if (window.api.reconnectEvents) window.api.reconnectEvents();
                checkAuth();
                return;
            }
            // Surface the real reason (e.g. "Invalid username or password",
            // "Account pending admin approval") instead of a silent dead button.
            authError.textContent = (res && res.error) || 'Login failed';
        } catch (e) {
            // invoke itself threw (blocked channel, missing handler, IPC glitch).
            authError.textContent = `Login error: ${(e && e.message) || e}`;
        } finally {
            loginBtn.disabled = false;
        }
    };
    loginBtn.addEventListener('click', doLogin);
    if (authPassword) authPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

if (registerSubmitBtn) {
    const doRegister = async () => {
        const username = regUsername.value.trim();
        const password = regPassword.value;
        const confirm = regPasswordConfirm.value;
        authError.style.color = '';
        if (!username || !password) {
            authError.textContent = 'Enter a username and password.';
            return;
        }
        if (password !== confirm) {
            authError.textContent = 'Passwords do not match';
            return;
        }
        registerSubmitBtn.disabled = true;
        authError.textContent = '';
        try {
            const res = await window.api.invoke('auth-register', { username, password });
            if (res && res.success) {
                authError.style.color = 'var(--accent-color)';
                authError.textContent = 'Account created! Please sign in.';
                setTimeout(() => {
                    authError.style.color = '';
                    showLoginForm();
                }, 1500);
            } else {
                authError.textContent = (res && res.error) || 'Registration failed';
            }
        } catch (e) {
            authError.textContent = `Registration error: ${(e && e.message) || e}`;
        } finally {
            registerSubmitBtn.disabled = false;
        }
    };
    registerSubmitBtn.addEventListener('click', doRegister);
    if (regPasswordConfirm) regPasswordConfirm.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        if (authToken) await window.api.invoke('auth-logout', authToken);
        localStorage.removeItem('auth_token');
        authToken = null;
        location.reload();
    });
}

// --- Admin Panel Logic ---
if (adminPanelBtn) {
    adminPanelBtn.addEventListener('click', async () => {
        adminOverlay.style.display = 'flex';
        await renderAdminUserList();
    });
}

if (closeAdminBtn) {
    closeAdminBtn.addEventListener('click', () => {
        adminOverlay.style.display = 'none';
    });
}

async function renderAdminUserList() {
    adminUserList.innerHTML = '<p style="color:var(--text-color);">Loading users...</p>';
    const res = await window.api.invoke('auth-get-users', authToken);
    if (!res.success) {
        adminUserList.innerHTML = `<p style="color:#ff4444;">Error: ${res.error}</p>`;
        return;
    }

    adminUserList.innerHTML = '';
    res.users.forEach(user => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 4px; border: 1px solid var(--border-color);';
        
        const isSelf = currentUserDisplay.textContent.includes(user.username);
        
        row.innerHTML = `
            <div>
                <strong style="color: var(--accent-color);">${user.username}</strong>
                <span style="font-size: 0.7rem; color: #8b949e; margin-left: 5px;">[${user.role.toUpperCase()}]</span>
            </div>
            <div style="display: flex; gap: 15px;">
                <label style="display:flex; align-items:center; gap:5px; font-size:0.8rem; color:var(--text-color); cursor:${isSelf ? 'not-allowed' : 'pointer'};">
                    <input type="checkbox" class="perm-toggle" data-user="${user.username}" data-perm="canUseApp" ${user.permissions.canUseApp ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
                    App Access
                </label>
                <label style="display:flex; align-items:center; gap:5px; font-size:0.8rem; color:var(--text-color); cursor:${isSelf ? 'not-allowed' : 'pointer'};">
                    <input type="checkbox" class="perm-toggle" data-user="${user.username}" data-perm="canUseTools" ${user.permissions.canUseTools ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
                    Tool Access
                </label>
            </div>
        `;
        adminUserList.appendChild(row);
    });

    document.querySelectorAll('.perm-toggle').forEach(toggle => {
        toggle.addEventListener('change', async (e) => {
            const targetUsername = e.target.dataset.user;
            const perm = e.target.dataset.perm;
            const value = e.target.checked;
            
            e.target.disabled = true;
            const updateRes = await window.api.invoke('auth-update-user', {
                token: authToken,
                targetUsername: targetUsername,
                permissions: { [perm]: value }
            });
            
            if (!updateRes.success) {
                alert(`Failed to update permissions: ${updateRes.error}`);
                e.target.checked = !value; // Revert UI
            }
            e.target.disabled = false;
        });
    });
}

async function init() {
    try {
        const urlDispContainer = document.getElementById('host-url-container');
        const urlDisp = document.getElementById('host-url-display');
        if (isWebMode) {
            if (urlDispContainer) urlDispContainer.style.display = 'none';
        } else {
            const hostInfo = await window.api.invoke('get-host-url');
            if (hostInfo && urlDisp) {
                let displayHtml = `Local: ${hostInfo.url}`;
                if (hostInfo.remoteUrl) {
                    displayHtml += ` | Remote: <a href="${hostInfo.remoteUrl}" target="_blank" style="color: #00ff00;">${hostInfo.remoteUrl}</a>`;
                } else {
                    displayHtml += ` | Remote: (Starting...)`;
                    // Refresh every few seconds until remoteUrl is available
                    const refreshInterval = setInterval(async () => {
                        const updatedInfo = await window.api.invoke('get-host-url');
                        if (updatedInfo.remoteUrl) {
                            urlDisp.innerHTML = `Local: ${updatedInfo.url} | Remote: <a href="${updatedInfo.remoteUrl}" target="_blank" style="color: #00ff00;">${updatedInfo.remoteUrl}</a>`;
                            clearInterval(refreshInterval);
                        }
                    }, 5000);
                }
                urlDisp.innerHTML = displayHtml;
            }
        }
    } catch(e) {}

    try {
        await fetchModels();
        checkConnection();
        const loaded = await window.api.invoke('load-history');

        let envContext = "";
        try {
            const envInfo = await window.api.invoke('get-env-info');
            if (envInfo && !envInfo.error) {
                envContext = `\n\n[SYSTEM ENVIRONMENT]:\nOS: ${envInfo.platform} (${envInfo.arch})\nUser: ${envInfo.username}\nHome Dir: ${envInfo.homedir}\nCurrent Dir: ${envInfo.cwd}\n`;
            }
        } catch (e) {}

        const systemPrompt = window.SmithPersona.buildChatSystemPrompt(envContext);
        currentSystemPrompt = systemPrompt;

        // New keyed shape { __modes, chat, agent, code }; fall back to a legacy single
        // array (migrated into Chat).
        if (loaded && loaded.__modes) {
            histories.chat = Array.isArray(loaded.chat) ? loaded.chat : [];
            histories.agent = Array.isArray(loaded.agent) ? loaded.agent : [];
            histories.code = Array.isArray(loaded.code) ? loaded.code : [];
            if (loaded.snapshots && typeof loaded.snapshots === 'object') {
                modeSnapshots.chat = loaded.snapshots.chat || '';
                modeSnapshots.agent = loaded.snapshots.agent || '';
                modeSnapshots.code = loaded.snapshots.code || '';
            } else if (typeof loaded.codeTimelineHtml === 'string') {
                modeSnapshots.code = loaded.codeTimelineHtml; // back-compat
            }
        } else if (Array.isArray(loaded)) {
            histories.chat = loaded;
        }
        // Seed empty modes; keep the system prompt fresh at the head of each.
        ['chat', 'agent', 'code'].forEach(m => {
            const h = histories[m];
            if (!h || h.length === 0) {
                histories[m] = seedHistory(m);
            } else if (h[0] && h[0].role === 'system') {
                h[0].content = systemPrompt;
            } else {
                h.unshift({ role: 'system', content: systemPrompt });
            }
        });

        currentMode = activeMode();
        chatHistory = histories[currentMode];
        historiesReady = true;

        messagesContainer.innerHTML = '';
        if (modeSnapshots[currentMode]) {
            messagesContainer.innerHTML = modeSnapshots[currentMode]; // restore messages + tool cards
        } else {
            renderHistory();
        }
        updateEmptyState();
        updateMemoryCount();


        updateCodeModeUI();

    } catch (err) {
        setStatus(false, 'OFFLINE');
    }
}

async function fetchModels(retries = 3) {
    // Kimi K3 mode: the model id comes from the Kimi model input, not the local
    // server's model list. Keep the dropdown in sync (disabled) and skip probing.
    if (kimiK3Active()) { syncKimiK3UI(); return; }
    if (modelSelect) modelSelect.disabled = false;
    // Remember the current/last model so a transient empty list (LM Studio JIT loading,
    // where /v1/models returns []) does NOT wipe the selection and silently break chat.
    const remembered = (modelSelect.value && modelSelect.value !== 'Scanning...')
        ? modelSelect.value
        : (() => { try { return localStorage.getItem('agentsmith_last_model') || ''; } catch { return ''; } })();
    const ensureOption = (id) => {
        if (!id) return;
        if (![...modelSelect.options].some(o => o.value === id)) {
            modelSelect.insertAdjacentHTML('afterbegin', `<option value="${id}">${id}</option>`);
        }
        modelSelect.value = id;
    };
    try {
        // LM Studio / OpenAI Format (Primary UI backend in v39.4)
        // --- v48: add timeout so model list probing doesn't hang forever on slow networks/mobile.
        const modelsController = new AbortController();
        const modelsTimeoutId = setTimeout(() => modelsController.abort(new Error('Model list fetch timed out')), 15000);
        const res = await fetch(`${effectiveApiBase()}/v1/models`, {
            headers: { 'Authorization': `Bearer ${activeApiKey()}` },
            signal: modelsController.signal
        }).finally(() => clearTimeout(modelsTimeoutId));
        if (!res.ok) throw new Error('AI Backend Offline or Incorrect URL');
        const data = await res.json();
        const models = data.data || data;
        if (Array.isArray(models) && models.length > 0) {
            modelSelect.innerHTML = models.map(m => `<option value="${m.id || m}">${m.id || m}</option>`).join('');
            // Restore the prior selection if it's still available.
            if (remembered && models.some(m => (m.id || m) === remembered)) modelSelect.value = remembered;
            if (window.XKRuntimeProfileUI) {
                await window.XKRuntimeProfileUI.applyForCurrentModel();
            }
        } else {
            // Reachable, but LM Studio lists NO models right now (Just-In-Time loading, or
            // nothing "served" yet). Do NOT blank the dropdown — keep the remembered model so
            // the user can still chat; LM Studio loads it on demand when the request is sent.
            if (remembered) ensureOption(remembered);
            else if (!modelSelect.value) modelSelect.innerHTML = '<option value="" disabled selected>No model served — load one in LM Studio</option>';
        }
    } catch (err) {
        console.error(`Fetch Models Error (retries left: ${retries}):`, err);
        if (retries > 0) {
            // Don't wipe a usable selection while retrying.
            if (!modelSelect.value || modelSelect.value === 'Scanning...') modelSelect.innerHTML = `<option value="" disabled selected>Scanning... (Retrying)</option>`;
            await new Promise(r => setTimeout(r, 2000));
            return fetchModels(retries - 1);
        }
        if (remembered) ensureOption(remembered); // offline but we know a model — keep it usable
        else modelSelect.innerHTML = '<option value="" disabled selected>Error Loading Models</option>';
    }
}

// Remember the chosen model so chat survives an LM Studio JIT/empty model list and restarts.
modelSelect.addEventListener('change', () => {
    try { if (modelSelect.value) localStorage.setItem('agentsmith_last_model', modelSelect.value); } catch {}
});

function setStatus(online, text) {
    statusText.textContent = text;
    statusDot.className = `dot ${online ? 'connected' : ''}`;
    if (!isSending) {
        userInput.disabled = !online;
        sendBtn.disabled = !online;
    }
}

// --- v30: Hardware Guard Logic ---
let connectionFailureCount = 0;
let isHardwareMonitorActive = false;

async function checkHardwareHealth() {
    if (isWebMode) return;
    
    try {
        const telemetry = await window.api.invoke('get-gpu-telemetry');
        if (telemetry) {
            // Always show monitor if we have telemetry
            hardwareMonitor.style.display = 'block';
            
            if (telemetry.systemRam) {
                const sysPct = ((telemetry.systemRam.used / telemetry.systemRam.total) * 100).toFixed(0);
                if (ramInfo) ramInfo.textContent = `${telemetry.systemRam.used}MB / ${telemetry.systemRam.total}MB (${sysPct}%)`;
                if (ramBarFill) {
                    ramBarFill.style.width = `${sysPct}%`;
                    ramBarFill.style.backgroundColor = sysPct > 90 ? '#ff4444' : (sysPct > 80 ? '#ffb703' : 'var(--accent-dim)');
                }
            }

            if (!telemetry.error && telemetry.memory) {
                isHardwareMonitorActive = true;
                const usedMB = telemetry.memory.used;
                const totalMB = telemetry.memory.total;
                const vramPct = ((usedMB / totalMB) * 100).toFixed(0);
                
                vramInfo.textContent = `${usedMB}MB / ${totalMB}MB (${vramPct}%)`;
                vramInfo.style.color = telemetry.is_high_pressure ? '#ff4444' : (vramPct > 80 ? '#ffb703' : '#8b949e');
                
                if (vramBarFill) {
                    vramBarFill.style.width = `${vramPct}%`;
                    vramBarFill.style.backgroundColor = telemetry.is_high_pressure ? '#ff4444' : (vramPct > 80 ? '#ffb703' : 'var(--accent-color)');
                }
                
                gpuLoad.textContent = `${telemetry.utilization}%`;
                gpuLoad.style.color = telemetry.utilization > 90 ? '#ff4444' : (telemetry.utilization > 70 ? '#ffb703' : '#8b949e');

                if (telemetry.is_high_pressure && !isSending) {
                    console.warn('[WATCHDOG] High VRAM pressure detected.');
                }
            } else if (telemetry.error) {
                 vramInfo.textContent = 'NO NVIDIA GPU';
                 vramInfo.style.color = '#8b949e';
                 gpuLoad.textContent = '0%';
            }
        }
    } catch (e) {
        console.error('Hardware health check failed:', e);
    }
}

async function checkConnection() {
    const endpoint = `${effectiveApiBase()}/v1/models`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout for health check

    try {
        const res = await fetch(endpoint, { 
            headers: { 'Authorization': `Bearer ${activeApiKey()}` },
            signal: controller.signal 
        });        clearTimeout(timeoutId);
        
        if (res.ok) {
            setStatus(true, 'ONLINE');
            connectionFailureCount = 0;
        } else {
            throw new Error('Endpoint returned error');
        }
    } catch (err) {
        clearTimeout(timeoutId);
        connectionFailureCount++;
        setStatus(false, connectionFailureCount > 2 ? 'BACKEND HUNG' : 'OFFLINE');
        
        if (connectionFailureCount >= 3 && !isSending) {
            console.error('[WATCHDOG] AI Backend is not responding. VRAM might be full.');
            if (connectionFailureCount === 3) {
                addMessage('system', '⚠️ **Hardware Watchdog Alert:** AI backend is not responding. This often happens when VRAM is exhausted by a large model. If the app is locked, use **EMERGENCY RESET** in the sidebar.');
            }
        }
    }
    
    // Periodically sync memory count
    updateMemoryCount();
    
    // Check hardware telemetry
    checkHardwareHealth();
}
setInterval(checkConnection, 5000);

if (hardResetBtn) {
    hardResetBtn.addEventListener('click', async () => {
        const sudoPass = document.getElementById('sudo-input')?.value || '';
        const confirmed = confirm("This will attempt to gracefully stop AI backends and RESTART Agent Smith.\n\nIf you have provided a Sudo Password, it will also attempt to restart the Ollama service properly to clear VRAM locks.\n\nContinue?");
        if (confirmed) {
            addMessage('system', 'Initiating emergency hardware reset. Please wait 3-5 seconds for VRAM to clear...');
            await window.api.invoke('app-reset', { killBackends: true, sudoPass });
        }
    });
}

function ensureToastHost() {
    let host = document.getElementById('as-toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'as-toast-host';
        document.body.appendChild(host);
    }
    return host;
}
function showToast(text, opts = {}) {
    const host = ensureToastHost();
    const toast = document.createElement('div');
    const isError = opts.error || /^\s*(❌|⚠️|\*\*Failed|\*\*Error|Error:|\[BLOCKED)/i.test(text);
    toast.className = 'as-toast' + (isError ? ' as-toast--error' : '');
    const iconMatch = text.match(/^\s*([\p{Emoji_Presentation}\p{Extended_Pictographic}❌⚠️📍✓✗])\s*/u);
    const icon = iconMatch ? iconMatch[1] : (isError ? '⚠️' : '●');
    const body = iconMatch ? text.slice(iconMatch[0].length) : text;
    toast.innerHTML =
        `<span class="as-toast__icon">${icon}</span>` +
        `<div class="as-toast__body">${window.markedParse ? window.markedParse(body) : body}</div>`;
    host.appendChild(toast);
    const ttl = opts.ttl || (isError ? 6500 : 4200);
    setTimeout(() => {
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 280);
    }, ttl);
    return toast;
}

function displayWebSearchResults(query, resultText) {
    if (!resultText) return;
    const cleanText = resultText.split('[SYSTEM NUDGE]')[0].trim();
    if (!cleanText || cleanText.includes('No web results found')) return;
    
    const div = document.createElement('div');
    div.className = 'message bot-message';
    div.style.borderLeft = '3px solid #ffb703';
    div.style.backgroundColor = 'rgba(255, 183, 3, 0.05)';
    div.style.fontSize = '0.85em';
    div.style.marginTop = '10px';
    div.style.marginBottom = '10px';
    
    let md = `**🌐 Search Sources Retrieved:** "${query}"\n\n`;
    const sources = cleanText.split('\n\n');
    sources.forEach(src => {
        md += `* ${src.split(': ')[0]}\n`; // Only show Title (URL) to keep it compact
    });
    
    div.innerHTML = window.markedParse ? window.markedParse(md) : md;
    messagesContainer.appendChild(div);
    scrollMessagesToLatest();
}

function addMessage(role, text) {
    // System messages render as iOS-style toasts, not inline chat bubbles.
    if (role === 'system') {
        return showToast(text);
    }
    const div = document.createElement('div');
    div.className = `message ${role === 'user' ? 'user-message' : 'bot-message'}`;
    div.innerHTML = role === 'user' ? text : window.markedParse(text);
    messagesContainer.appendChild(div);
    scrollMessagesToLatest(role === 'user');
    updateEmptyState();
    return div;
}

// Show the onboarding empty state only while the chat has no content yet.
function updateEmptyState() {
    const empty = document.getElementById('empty-state');
    if (!empty) return;
    const hasContent = messagesContainer.querySelector(
        '.message, .agent-log, .activity-turn, .activity-thinking, .search-results-log, '
        + '.code-resume-banner, .activity-advisory, .activity-retry'
    ) || document.body.classList.contains('code-run-visible');
    empty.style.display = hasContent ? 'none' : 'flex';
}

// ---------------------------------------------------------------------------
// Activity timeline: each agent tool call renders a live row that starts in a
// "running" state and is updated in place with its result (✓/✗ + collapsible
// output) once the harness reports back via onToolResult. Rows are grouped under
// per-step headers so the timeline reads as a build log, not a JSON dump.
// ---------------------------------------------------------------------------
const toolActivityEls = new Map();
let lastTimelineStepId = null;

function resetTimelineState() {
    toolActivityEls.clear();
    lastTimelineStepId = null;
}

function escapeTimelineHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// One-line, human-readable summary of tool args for the row header.
function compactToolArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const preferred = args.filepath || args.path || args.command || args.query || args.pattern || args.reason || args.result;
    if (typeof preferred === 'string') return preferred.length > 80 ? preferred.slice(0, 80) + '…' : preferred;
    const json = (() => { try { return JSON.stringify(args); } catch (e) { return ''; } })();
    return json.length > 80 ? json.slice(0, 80) + '…' : json;
}

// Failure heuristic: tool results are strings; harness errors begin with a known marker.
function toolResultIsFailure(result) {
    return /^\s*(Error|\[BLOCKED|Cannot |\[VERIFY FAILED|\[SYNTAX|\[UNVERIFIED|No match|Tool ")/i.test(String(result || ''));
}

function nowClock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// Insert a step divider into the timeline when the active step changes.
function maybeInsertStepHeader(anchor) {
    // Legacy timeline step headers — no-op in Code Mode (tools stream inline).
}

function appendToolActivity(anchor, name, args, id) {
    if (window.XKSharedTimeline) {
        window.XKSharedTimeline.setAnchor(anchor);
        window.XKSharedTimeline.handleCodeEvent({ type: 'tool_start', name, args, callId: id }, { botDiv: anchor, anchor });
        return null;
    }
    maybeInsertStepHeader(anchor);
    const el = document.createElement('div');
    el.className = 'agent-log running';
    const labelled = window.SmithPersona
        ? window.SmithPersona.formatToolDisplayLabel(name, args)
        : { label: name, raw: name };
    el.innerHTML =
        `<div class="agent-log-head">` +
        `<span class="agent-log-status">●</span>` +
        `<span class="agent-log-name" title="${escapeTimelineHtml(labelled.raw)}">${escapeTimelineHtml(labelled.label)}</span>` +
        `<span class="agent-log-args">${escapeTimelineHtml(compactToolArgs(args))}</span>` +
        `<span class="agent-log-time">${nowClock()}</span>` +
        `</div>`;
    if (anchor && anchor.parentNode === messagesContainer) messagesContainer.insertBefore(el, anchor);
    else messagesContainer.appendChild(el);
    if (id != null) toolActivityEls.set(id, el);
    scrollMessagesToLatest();
    updateEmptyState();
    return el;
}

function updateToolActivity(id, name, result) {
    if (window.XKSharedTimeline) {
        const failed = toolResultIsFailure(result);
        window.XKSharedTimeline.handleCodeEvent({
            type: 'tool_result',
            name,
            ok: !failed,
            result: typeof result === 'string' ? { output: result } : result,
            callId: id
        }, {});
        return;
    }
    const el = id != null ? toolActivityEls.get(id) : null;
    if (!el) return;
    const failed = toolResultIsFailure(result);
    el.classList.remove('running');
    el.classList.add(failed ? 'fail' : 'ok');
    const statusEl = el.querySelector('.agent-log-status');
    if (statusEl) statusEl.textContent = failed ? '✗' : '✓';
    const resStr = String(result == null ? '' : result).trim();
    if (resStr) {
        const det = document.createElement('details');
        det.className = 'agent-log-result';
        const sum = document.createElement('summary');
        const firstLine = resStr.split('\n')[0];
        sum.textContent = firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
        const pre = document.createElement('pre');
        pre.textContent = resStr.length > 4000 ? resStr.slice(0, 4000) + '\n…[truncated]' : resStr;
        det.appendChild(sum);
        det.appendChild(pre);
        el.appendChild(det);
    }
    if (id != null) toolActivityEls.delete(id);
    scrollMessagesToLatest();
}

function renderHistory() {
    chatHistory.forEach(m => {
        if (m.role === 'user') addMessage('user', m.content);
        else if (m.role === 'assistant' && m.content) addMessage('bot', m.content);
        else if (m.role === 'assistant' && m.tool_calls) {
            m.tool_calls.forEach(t => {
                const l = document.createElement('div');
                l.className = 'agent-log';
                l.textContent = `⚡ Exec: ${t.function.name}\nArgs: ${typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments, null, 2)}`;
                messagesContainer.appendChild(l);
            });
        }
        else if (m.role === 'tool' && m.name === 'web_search') {
            displayWebSearchResults("Web Search Results", m.content);
        }
    });
    updateEmptyState();
}

function stripMarkdown(text) {
    return text.replace(/[#*`_~\[\]()>]/g, '');
}

// Build a throttled, CHEAP streaming renderer for an agent task's bot bubble.
// Per-token markdown+highlight of the whole growing buffer froze the UI (O(n^2),
// worst with small models that stream tool calls as plain text). During streaming
// we now show a capped plain-text tail (no markdown/highlight, O(1) per paint),
// throttled to ~10fps; the full formatted result is rendered once at the end.
function makeAgentDeltaRenderer(botDiv) {
    const throttle = (window.createThrottledRenderer || ((fn) => { const f = (...a) => fn(...a); f.cancel = () => {}; f.flush = () => {}; return f; }));
    return throttle((text, turn) => {
        const preview = (text || '').slice(-1500);
        botDiv.textContent = '';
        const pulse = document.createElement('span');
        pulse.className = 'loading-pulse';
        pulse.textContent = turn ? `Step ${turn}… ` : 'Working… ';
        const pre = document.createElement('span');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.opacity = '0.75';
        pre.textContent = preview;
        botDiv.appendChild(pulse);
        botDiv.appendChild(document.createElement('br'));
        botDiv.appendChild(pre);
    }, 100);
}

// During a build the run card is the primary surface, so the chat bubble is demoted to
// a small status line + a collapsed "Model notes" stream (raw tokens no longer fight
// the structured timeline). The final summary still replaces the bubble at the end.
function makeModelNotesRenderer(botDiv) {
    const throttle = (window.createThrottledRenderer || ((fn) => { const f = (...a) => fn(...a); f.cancel = () => {}; f.flush = () => {}; return f; }));
    return throttle((text, turn) => {
        const preview = (text || '').slice(-1200);
        botDiv.innerHTML = '';
        const head = document.createElement('div');
        head.innerHTML = '<span class="loading-pulse">Building…</span> <span style="opacity:.55;font-size:.85em">activity streams below; plan steps in the drawer</span>';
        const det = document.createElement('details');
        det.className = 'model-notes';
        const sum = document.createElement('summary');
        sum.textContent = turn ? `Model notes (turn ${turn})` : 'Model notes';
        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.opacity = '0.7';
        pre.textContent = preview;
        det.appendChild(sum);
        det.appendChild(pre);
        botDiv.appendChild(head);
        botDiv.appendChild(det);
    }, 120);
}

let currentResourceStatus = 'healthy';
window.api.on('resource-update', (data) => {
    currentResourceStatus = data.status;
    const statusDot = document.getElementById('resource-status-dot');
    if (statusDot) {
        statusDot.className = `status-dot ${data.status}`;
        statusDot.title = `Resource Status: ${data.status.toUpperCase()} (RAM: ${data.freePercent.toFixed(1)}% free, Proc: ${data.rssMB.toFixed(0)}MB)`;
    }
    
    if (data.status === 'congested') {
        console.warn(`[RESOURCE GUARD] High resource pressure detected. RSS: ${data.rssMB.toFixed(0)}MB. Triggering proactive cleanup on next payload generation.`);
        // Removed global UI prune to protect user history
    }
});

// Context is rebuilt from Plan state in agent mode; chat mode keeps full history.
// Keep the model's context from ballooning across tool-using turns. Big tool outputs
// (especially full-page browser snapshots) are re-sent every step; left unchecked the
// context overflows within a few steps — the model slows ("processing context…"),
// gets cut off, repeats, and starts hallucinating. We keep the few most-recent tool
// results (the relevant ones) capped in size and collapse older ones to a stub. User
// and assistant messages are left intact.
function pruneChatHistory(historyArray) {
    if (window.XKContextPrune && window.XKContextPrune.pruneChatHistory) {
        return window.XKContextPrune.pruneChatHistory(historyArray);
    }
    return historyArray;
}

// --- Main send logic (unified streaming) ---
class PipelineTrace {
    constructor(run_id) {
        this.run_id = run_id || `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this._failed = false;
    }
    addStep(stage, layer, outcome, code, duration_ms, detail, related_resource) {
        if (!isWebMode && window.api) {
            try {
                window.api.invoke('ghosttrace-append', {
                    run_id: this.run_id, stage, layer, outcome, code,
                    duration_ms: duration_ms || 0, detail: detail || '', related_resource
                });
            } catch (e) { /* non-fatal */ }
        }
    }
    close() { return { run_id: this.run_id }; }
}
const compileExplanation = () => ({ summary: "See GhostTrace events.jsonl for Agent run details." });
const generateReport = () => {};

let isSending = false;

stopBtn.addEventListener('click', async () => {
    if (codeRunState.isBusy && codeModeHandler) {
        await codeModeHandler.stop();
        addMessage('system', 'Code run stopped.');
        setCodeRunActive(false);
        return;
    }
    if (abortController) {
        abortController.abort();
        addMessage('system', 'Neural link terminated.');
    }
    chatRunState.isBusy = false;
});

async function sendMessage() {
    let text = userInput.value.trim();
    if (!text) return;

    // Plugin slash-command expansion (e.g. "/greet Ada" -> injected prompt text).
    // Desktop only; resolves against enabled plugin commands in the main process.
    if (!isSending && text[0] === '/' && !isWebMode && window.api) {
        const expanded = await resolvePluginCommand(text);
        if (expanded != null) text = expanded;
    }
    // Fire-and-forget onMessageSend hook so plugins can observe/log user input.
    if (!isWebMode && window.api) {
        try { window.api.invoke('plugin-fire-hook', { hookEvent: 'onMessageSend', payload: { text } }); } catch (e) {}
    }

    if (isSending || chatRunState.isBusy || codeRunState.isBusy) {
        addMessage('system', 'Wait for the current run to finish, or press STOP.');
        return;
    }

    await window.XKRuntimeProfileUI?.flushPendingContextSync?.();

    // v51.2 PER-MESSAGE ROUTING — classify THIS message (taskClassifier.js). Coding task →
    // Code engine; chat / ordinary agent work → the Agent Mode chat path with its host-
    // control tools. `code: <prompt>` / `agent: <prompt>` prefix forces a route (the token
    // is stripped from the prompt). The v50 bug routed everything to code — no more.
    // Classify on the user's own words + attached FILE NAMES (not file contents, so an
    // attached source file doesn't drag "explain this" into Code Mode).
    const routeInput = [text, ...attachedFiles.map(f => f.fileName)].filter(Boolean).join(' ');
    const routing = window.XKTaskClassifier?.routeMessage ? window.XKTaskClassifier.routeMessage(routeInput) : { mode: 'code', prompt: text, override: false };
    let codeModeEnabled = routing.mode === 'code';
    let agentEnabled = routing.mode === 'agent';

    // A coding task in an ACTIVE Code run (plan awaiting approval / execution mid-flight):
    // the engine is busy with that project — keep the message inside the code conversation.
    if (!codeModeEnabled && codeRunState.isBusy) {
        codeModeEnabled = true;
        agentEnabled = false;
    }

    const trace = new PipelineTrace(null, null, `req_${Date.now()}`);
    trace.addStep('input.received', 'input', 'ok', 'INPUT_OK', 0);

    const model = activeModel();
    if (kimiK3Active() && !kimiK3ApiKey()) {
        trace.addStep('routing.selected_capability', 'routing', 'error', 'NO_API_KEY', 0, 'Kimi K3 API key missing');
        trace.close();
        addMessage('system', '**Kimi K3 API key required.** The KIMI K3 API toggle is on but no API key is set. Paste your Moonshot API key into **KIMI API KEY** in the CONNECT section (get one at platform.kimi.ai), or turn the toggle off to use your local backend.');
        return;
    }
    if (!model || model === "Scanning...") {
        trace.addStep('routing.selected_capability', 'routing', 'error', 'NO_MODEL', 0, 'No model selected');
        trace.close();
        addMessage('system', '**No model selected.** LM Studio isn\'t serving a model the app can see. In LM Studio, load a model (or enable the local server / JIT), then pick it from the model dropdown — or just reselect it once and the app will remember it.');
        return;
    }

    isSending = true;
    chatRunState.isBusy = true; // mark Chat/Agent run busy so mode switches are blocked mid-run
    userInput.value = '';

    // The route token ("code:" / "agent:") is a UI affordance, not part of the task — strip
    // it from everything downstream (display bubble, memory search, model prompt).
    if (routing.override) text = routing.prompt;

    // Mobile reliable clear: force blur and small delay
    userInput.blur();
    setTimeout(() => { userInput.value = ''; }, 10);

    abortController = new AbortController();
    stopBtn.style.display = 'block';
    let finalPrompt = text;
    let images = [];

    if (attachedFiles.length > 0) {
        finalPrompt += "\n\n[ATTACHMENTS]:\n" + attachedFiles.map(f => {
            if (f.isImage) { images.push(f.base64); return `[IMAGE: ${f.fileName}]`; }
            return `--- ${f.fileName} ---\n${f.content}`;
        }).join('\n');
        attachedFiles = [];
        renderAttachments();
    }

    let transientMemoryContext = "";
    if (memoryToggle.checked) {
        const startMem = Date.now();
        try {
            // OPTIMIZATION: Embeddings are now forced to CPU in v31.3, so we no longer need to page out the main model.
            // This prevents the 'hang' caused by constant VRAM swapping.
            const mem = await searchMemory(text);
            
            trace.addStep('context.loaded', 'context', 'ok', 'MEM_LOADED', Date.now() - startMem);
            if (mem && mem.length > 0) {
                transientMemoryContext = "\n\n[READ-ONLY BACKGROUND DATABASE]\n" + mem.map(m => `- ${m.text}`).join('\n') + "\n(END OF READ-ONLY DATABASE. DO NOT re-save any of the above facts into memory. You MUST ONLY save completely new facts from the user's latest input.)";
            }
        } catch (err) {
            trace.addStep('context.loaded', 'context', 'error', 'MEM_FAIL', Date.now() - startMem, err.message);
            console.warn('Memory search failed/timed out:', err);
            addMessage('system', '**Neural-Core Warning:** Memory search failed.');
        }
    }

    if (netrunnerToggle?.checked && !agentEnabled && !codeModeEnabled) {
        try {
            const searchResults = await window.api.invoke('perform-search', text);
            if (searchResults && !searchResults.error && searchResults.length > 0) {
                const webCtx = searchResults.map(r => `Source: ${r.title}. Details: ${r.snippet}`).join(' ');
                finalPrompt = `I need you to write a conversational news report based on the following web data.

CRITICAL INSTRUCTIONS:
- You must write this as a flowing, continuous essay consisting only of paragraphs.
- You must speak in the first person (e.g., "I discovered that...").
- Do NOT use bullet points. Do NOT use dashes. Do NOT use numbered lists. Do NOT use tables.

Web Data to use:
${webCtx}

My Query: ${text}`;
                const searchLog = document.createElement('div');
                searchLog.className = 'search-results-log';
                searchLog.innerHTML = `<strong>NETRUNNER:</strong> Found ${searchResults.length} results<ul>${searchResults.map(r => `<li><a href="${r.url}" target="_blank">${r.title}</a></li>`).join('')}</ul>`;
                messagesContainer.appendChild(searchLog);
            }
        } catch (e) { console.error('Netrunner search failed:', e); }
    }

    addMessage('user', text);
    // Capture this run's conversation array + mode so a mode switch mid-run can't redirect
    // the model's reply into the wrong (or no) history. All pushes below go to `convo`,
    // which stays bound to this mode's history even if the user switches away.
    const runMode = currentMode;
    const convo = chatHistory;
    convo.push({ role: 'user', content: finalPrompt, ...(images.length > 0 ? { images } : {}) });

    const botDiv = addMessage('bot', '');
    botDiv.innerHTML = `<span class="loading-pulse">${window.SmithPersona.pickLoadingPhrase('chat', 0)}</span>`;
    activeRun = { mode: runMode, botDiv };

    if (!codeModeEnabled && !agentEnabled && window.XKScrollFollow && window.XKScrollFollow.get()) {
        window.XKScrollFollow.get().beginRun();
    }
    if (agentEnabled && window.XKScrollFollow && window.XKScrollFollow.get()) {
        window.XKScrollFollow.get().beginRun();
    }

    try {
        persist();

        if (codeModeEnabled && codeModeHandler) {
            setCodeRunActive(true);
            // v51.2: one-time notice the FIRST time a message auto-routes to Code Mode, so
            // users understand why "build me X" got the full build pipeline while chat did not.
            if (routing.override || !codeRunState.isBusy) {
                try {
                    if (!localStorage.getItem('agentsmith_v512_route_notice')) {
                        addMessage('system', '**Auto-routing on:** coding tasks run Code Mode; everything else chats or acts with the agent tools. Prefix a message with `code:` or `agent:` to force a route.');
                        localStorage.setItem('agentsmith_v512_route_notice', 'true');
                    }
                } catch (e) { /* non-fatal */ }
            }
            // v51.2: this branch runs for messages CLASSIFIED as coding tasks (or during an
            // active Code run, where the engine owns the conversation — plan approval,
            // resume, follow-ups). A run works without a selected workspace — the engine
            // defaults to HOME and the host tools carry the job. A picked folder just
            // becomes the project root for build containment instead of blocking the run.
            let rootCheck = null;
            try { rootCheck = await window.api.invoke('project-get-root'); } catch (e) {}
            if (!rootCheck?.projectRoot && messagesContainer) {
                addMessage('system', 'No workspace selected — running on your home folder. Use **📍 Here I am** to build inside a project.');
            }
            await codeModeHandler.run(finalPrompt, botDiv);
            // Code Mode renders into the activity timeline, not chatHistory — persist the
            // run's final summary so the Code conversation survives a reload.
            const codeSummary = (botDiv.textContent || '').trim();
            convo.push({ role: 'assistant', content: codeSummary || '(code run complete)' });
            persist();
            setCodeRunActive(false);
            trace.close();
            return;
        }

        if (codeModeEnabled && !codeModeHandler) {
            botDiv.innerHTML = window.markedParse('**Code Mode unavailable:** code handler did not load. Reload the app.');
            trace.close();
            return;
        }

        // --- Chat path: conversation, or Agent Mode (shell + read-only tools).
        if (!chatHistory || chatHistory.length === 0 || chatHistory[0].role !== 'system') {
            let envContext = "";
            try {
                const envInfo = await window.api.invoke('get-env-info');
                if (envInfo && !envInfo.error) {
                    envContext = `\n\n[SYSTEM ENVIRONMENT]:\nOS: ${envInfo.platform} (${envInfo.arch})\nUser: ${envInfo.username}\nHome Dir: ${envInfo.homedir}\nCurrent Dir: ${envInfo.cwd}\n`;
                }
            } catch (e) {}
            
            let systemPrompt = window.SmithPersona.buildChatSystemPrompt(envContext, {
                compact: window.XKModelHarness?.getModelHarness?.(model)?.nativeTools === false
            });
            if (agentEnabled && window.XKAgentTools?.AGENT_MODE_SYSTEM_APPENDIX) {
                systemPrompt += '\n\n' + window.XKAgentTools.AGENT_MODE_SYSTEM_APPENDIX;
            }
            if (!chatHistory) chatHistory = [];
            chatHistory.unshift({ role: "system", content: systemPrompt });
        } else if (agentEnabled && window.XKAgentTools?.AGENT_MODE_SYSTEM_APPENDIX) {
            const appendix = window.XKAgentTools.AGENT_MODE_SYSTEM_APPENDIX;
            // Guard on the bracket-free phrase "operating in AGENT MODE" — the old guard
            // searched for "[AGENT MODE", which never occurs, so a v50/v51.2 session would
            // re-append the full appendix to the system prompt on EVERY message (prompt
            // bloat + duplicated instructions).
            if (chatHistory[0]?.role === 'system' && !String(chatHistory[0].content).includes('operating in AGENT MODE')) {
                chatHistory[0].content += '\n\n' + appendix;
            }
        }

        // --- BUG FIX FOR PAYLOAD CLONING ---
        // Now that chatHistory has both the system prompt AND the new user prompt,
        // we can safely clone it into payloadHistory so the AI actually sees the instruction.
        let payloadHistory = JSON.parse(JSON.stringify(chatHistory));

        console.log(`Connecting to Uplink at ${effectiveApiBase()}...`);
        let finished = false;
        let turnCount = 0;
        window._recentToolSigs = []; // per-run sliding window for the anti-loop guard
        const maxSteps = parseInt(stepsSlider?.value || "20");
        
        trace.addStep('routing.selected_capability', 'routing', 'ok', 'ROUTE_OK', 0, model);

        while (!finished && turnCount < maxSteps) {
            turnCount++;
            
            // RESOURCE OPTIMIZATION: Prune history if needed before each turn, passing turnCount
            payloadHistory = pruneChatHistory(payloadHistory);

            let body, endpoint;
            
            // Provide visual feedback for the current step
            if (turnCount > 1) {
                 botDiv.innerHTML = `<span class="loading-pulse">${window.SmithPersona.pickLoadingPhrase('chat', turnCount)} — Step ${turnCount}/${maxSteps}</span>`;
            }
            
            let activeTools = [];
            if (window.XKAgentTools) {
                activeTools = window.XKAgentTools.toolsForChatMode({
                    agentEnabled,
                    memoryEnabled: !!memoryToggle?.checked
                });
            }

            if (uplinkMode.checked) {
                // LM Studio / OpenAI Format (also used for the hosted Kimi K3 API)
                endpoint = `${effectiveApiBase()}/v1/chat/completions`;
                
                const messages = [];
                const pendingToolCalls = []; 

                for (let i = 0; i < payloadHistory.length; i++) {
                    const m = payloadHistory[i];
                    if (!m.role) continue;

                    let msg = { role: m.role };

                    if (m.role === 'system') {
                        msg.content = String(m.content || "You are a helpful assistant.");
                        if (transientMemoryContext) {
                            msg.content += transientMemoryContext;
                        }
                        const currentDate = new Date().toLocaleString();
                        msg.content += `\n\n[SYSTEM CLOCK] The current host date and time is: ${currentDate}. Always use this exact time when asked.`;
                    } 
                    else if (m.role === 'user') {
                        msg.content = String(m.content || "");

                        if (m.images && m.images.length > 0) {
                            msg.content = [
                                { type: "text", text: msg.content },
                                ...m.images.map(img => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img}` } }))
                            ];
                        }
                    } 
                    else if (m.role === 'assistant') {
                        // Ensure content is at least an empty string if tool_calls exist, some models fail on null
                        msg.content = (m.content && m.content.trim()) ? String(m.content) : "";
                        
                        if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                            msg.tool_calls = m.tool_calls.map(tc => {
                                // Preserve ID if it exists in history, otherwise generate once
                                if (!tc.id) tc.id = `call_${Math.random().toString(36).substring(2, 10)}`;
                                return {
                                    id: tc.id,
                                    type: 'function',
                                    function: {
                                        name: tc.function?.name || 'unknown_function',
                                        arguments: typeof tc.function?.arguments === 'string' 
                                            ? tc.function.arguments 
                                            : JSON.stringify(tc.function?.arguments || {})
                                    }
                                };
                            });
                        } else if (!msg.content) {
                            // Assistant message must have content or tool_calls
                            continue; 
                        }
                    } 
                    else if (m.role === 'tool' || m.role === 'function') {
                        msg.role = 'tool';
                        msg.content = String(m.content || "Success");
                        msg.tool_call_id = m.tool_call_id || `call_${Math.random().toString(36).substring(2, 10)}`;
                        if (m.name) msg.name = m.name;
                    }

                    messages.push(msg);
                }

                if (messages.length === 0) {
                    messages.push({ role: 'user', content: finalPrompt });
                }

                // Strict hosted APIs (Kimi/Moonshot) 400 on tool/tool_call mismatches.
                // Restored/interrupted histories can contain unpaired entries.
                if (window.XKToolPairing?.sanitizeToolPairing) {
                    const sanitized = window.XKToolPairing.sanitizeToolPairing(messages);
                    messages.length = 0;
                    messages.push(...sanitized);
                }

                body = {
                    model,
                    messages,
                    stream: true,
                    // Family-mandated temperature pins (kimi-k3 rejects anything but 1).
                    temperature: (window.XKModelHarness?.pinTemperatureForModel?.(
                        model,
                        (tempSlider && !isNaN(parseFloat(tempSlider.value))) ? parseFloat(tempSlider.value) : 0.7
                    )) ?? 0.7,
                    // Hosted APIs (Kimi/Moonshot) reject max_tokens:-1 — send a concrete budget.
                    max_tokens: kimiK3Active() ? 8192 : -1
                };
                
                // LM Studio strictly enforces tool payload schemas
                if (activeTools.length > 0) {
                    const nameOverrides = window.XKModelHarness?.toolNameOverridesFor?.(model) || {};
                    body.tools = activeTools.map(t => ({
                        type: "function",
                        function: {
                            // kimi: web_search → internet_search (Moonshot reserves the
                            // former as its server-side builtin, which is broken on k3)
                            name: nameOverrides[t.function.name] || t.function.name,
                            description: t.function.description || "",
                            parameters: t.function.parameters || { type: "object", properties: {} }
                        }
                    }));
                }

                // Keep the system prompt consistent with the wire tool names.
                if (window.XKModelHarness?.adaptSystemPromptForModel) {
                    body.messages = body.messages.map(m =>
                        (m && m.role === 'system' && typeof m.content === 'string')
                            ? { ...m, content: window.XKModelHarness.adaptSystemPromptForModel(m.content, model) }
                            : m);
                }

                // Per-family prompt adaptation (modelHarness table): Gemma folds system
                // into the first user turn, serializes prior tool turns to text, and
                // injects the {"name","parameters"} preamble. No-op for native families.
                if (window.XKModelHarness?.adaptMessagesForModel) {
                    body.messages = window.XKModelHarness.adaptMessagesForModel(body.messages, model, {
                        toolNames: activeTools.map(t => t.function.name),
                        serializeToolHistory: true
                    });
                }
            } else {
                // Ollama Format
                endpoint = `${currentApiBase}/chat`;
                
                // Deep copy chatHistory to inject transient context
                const messagesForOllama = payloadHistory.map(m => {
                    let msg = { role: m.role, content: m.content || "" };
                    if (m.role === 'tool' || m.role === 'function') {
                        msg.role = 'tool';
                        if (m.name) msg.name = m.name;
                        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
                    }
                    if (m.images) msg.images = m.images;
                    if (m.role === 'assistant' && m.tool_calls) {
                        msg.tool_calls = m.tool_calls.map(tc => ({
                            function: {
                                name: tc.function.name,
                                arguments: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
                            }
                        }));
                    }
                    return msg;
                });

                if (messagesForOllama.length > 0) {
                    const systemIdx = messagesForOllama.findIndex(m => m.role === 'system');
                    if (systemIdx !== -1) {
                        if (transientMemoryContext) {
                            messagesForOllama[systemIdx].content += transientMemoryContext;
                        }
                        const currentDate = new Date().toLocaleString();
                        messagesForOllama[systemIdx].content += `\n\n[SYSTEM CLOCK] The current host date and time is: ${currentDate}. Always use this exact time when asked.`;
                    }
                }

                body = {
                    model,
                    messages: messagesForOllama,
                    stream: true,
                    options: { temperature: parseFloat(tempSlider.value), num_ctx: parseInt(ctxSlider?.value || 8192) },
                    keep_alive: -1
                };
                if (activeTools.length > 0) body.tools = activeTools;
            }

            const startGen = Date.now();

            // --- v48: configurable request timeout so large-model first-chunk waits don't hang forever.
            // The streaming readWithTimeout already handles per-chunk timeouts (900s first chunk, 5min rest),
            // but the initial HTTP connect + first-byte needs its own guard because browsers silently hang
            // on long-pending fetches and eventually throw "failed to fetch" with no context.
            const REQUEST_TIMEOUT_MS = parseInt(localStorage.getItem('agentsmith_request_timeout') || '300000', 10); // default 5 min
            let requestTimedOut = false;
            const reqTimeoutId = setTimeout(() => {
                requestTimedOut = true;
                abortController.abort(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s — the model is taking longer than expected to start generating. This is normal for large models on slower hardware.`));
            }, REQUEST_TIMEOUT_MS);

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${activeApiKey()}`
                },
                body: JSON.stringify(body),
                signal: abortController.signal
            }).finally(() => clearTimeout(reqTimeoutId));

            if (requestTimedOut) {
                throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s — the model is taking longer than expected to start generating. This is normal for large models on slower hardware.`);
            }

            if (!res.ok) {
                const errorText = await res.text();
                console.error("Payload that failed:", JSON.stringify(body, null, 2));
                trace.addStep('inference.generate', 'inference', 'error', 'API_HTTP_ERR', Date.now() - startGen, errorText);
                throw new Error(`Uplink Error (${res.status}): ${errorText || res.statusText}`);
            }

            trace.addStep('inference.generate', 'inference', 'ok', 'GEN_OK', Date.now() - startGen);
            console.log("Neural link established. Receiving stream...");

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let reasoningContent = ''; // qwen3 etc. stream their <think> as delta.reasoning_content
            let toolCalls = null;
            // Provide visual feedback for the current step while keeping previous output
            const existingText = botDiv.innerHTML.replace(/<span class="loading-pulse">[\s\S]*?<\/span>(<br><br>)?/g, '').trim();
            if (existingText) {
                 botDiv.innerHTML = `<span class="loading-pulse">${window.SmithPersona.pickLoadingPhrase('chat', turnCount)} — Step ${turnCount}/${maxSteps}</span><br><br>${existingText}`;
            } else {
                 botDiv.innerHTML = `<span class="loading-pulse">${window.SmithPersona.pickLoadingPhrase('chat', turnCount)} — Step ${turnCount}/${maxSteps}</span>`;
            }

            const readWithTimeout = (reader, timeoutMs) => {
                return new Promise((resolve, reject) => {
                    const timeoutId = setTimeout(() => reject(new Error('Stream timeout: Uplink is hung. VRAM may be heavily congested.')), timeoutMs);
                    reader.read().then((result) => {
                        clearTimeout(timeoutId);
                        resolve(result);
                    }).catch(err => {
                        clearTimeout(timeoutId);
                        reject(err);
                    });
                });
            };

            let leftover = '';
            let isFirstChunk = true;
            let finishReason = null;
            // Throttle stream rendering. Markdown-parsing + innerHTML on the FULL growing
            // buffer on every token is O(n^2) and freezes the whole UI on long replies
            // (reasoning models like qwen3 emit huge outputs). Coalesce to ~1 paint/80ms
            // via the shared helper; the heavy work (strip + markdown + innerHTML) runs in
            // the throttled callback, not per token.
            const STRIP_CTRL = (s) => s.replace(/<\|channel>.*?<channel\|>/gs, '').replace(/<\|.*?\|>/gs, '');
            // Collapsible reasoning panel for models that stream a separate thinking channel.
            const thinkingBlock = (open) => reasoningContent.trim()
                ? `<details class="thinking"${open ? ' open' : ''}><summary class="thinking-summary">💭 Reasoning</summary><div class="thinking-body">${window.markedParse(STRIP_CTRL(reasoningContent))}</div></details>`
                : '';
            const paintHtml = (raw) => `<span class="loading-pulse">${window.SmithPersona.pickLoadingPhrase('chat', turnCount)} — Step ${turnCount}/${maxSteps}</span><br><br>${existingText ? existingText + '<br><br>' : ''}${thinkingBlock(true)}${window.markedParse(STRIP_CTRL(raw))}`;
            const paintStream = (typeof window.createThrottledRenderer === 'function')
                ? window.createThrottledRenderer((raw) => { botDiv.innerHTML = paintHtml(raw); }, 80)
                : null;
            const emitStream = (raw) => { if (paintStream) paintStream(raw); else botDiv.innerHTML = paintHtml(raw); };
            while (true) {
                // Increase timeout significantly for the first chunk to allow for model reloading/context processing after a VRAM flush.
                // 15 minutes for the first chunk, 5 minutes for subsequent chunks.
                const currentTimeoutMs = isFirstChunk ? 900000 : 300000; 
                
                if (isFirstChunk) {
                    botDiv.innerHTML = `<span class="loading-pulse" style="color: var(--warning-color)">Warming up model and processing context... (This may take a moment after a resource flush)</span><br><br>${existingText}`;
                }

                const { done, value } = await readWithTimeout(reader, currentTimeoutMs);
                isFirstChunk = false;
                
                if (done) break;
                
                const chunk = decoder.decode(value);
                const lines = (leftover + chunk).split('\n');
                leftover = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    if (uplinkMode.checked) {
                        // OpenAI / LM Studio Format: "data: {...}"
                        if (trimmed === 'data: [DONE]') continue;
                        if (trimmed.startsWith('data:')) {
                            try {
                                const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
                                const json = JSON.parse(jsonStr);
                                const delta = json.choices?.[0]?.delta;
                                if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                                if (delta?.content) {
                                    fullContent += delta.content;
                                    emitStream(fullContent); // throttled render; strip+markdown happen in the coalesced paint
                                }
                                if (delta?.reasoning_content) {
                                    reasoningContent += delta.reasoning_content;
                                    emitStream(fullContent); // repaint so the thinking panel streams live
                                }
                                if (delta?.tool_calls) {
                                    if (!toolCalls) toolCalls = [];
                                    delta.tool_calls.forEach(tc => {
                                        const idx = tc.index;
                                        if (idx !== undefined) {
                                            if (!toolCalls[idx]) {
                                                toolCalls[idx] = tc;
                                                if (!toolCalls[idx].id) toolCalls[idx].id = `call_${Math.random().toString(36).substring(2, 10)}`;
                                                if (toolCalls[idx].function && !toolCalls[idx].function.arguments) {
                                                    toolCalls[idx].function.arguments = '';
                                                }
                                            } else {
                                                if (tc.function?.arguments) {
                                                    toolCalls[idx].function.arguments += tc.function.arguments;
                                                }
                                                if (tc.id) toolCalls[idx].id = tc.id;
                                                if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                                            }
                                        }
                                    });
                                }
                            } catch (e) { console.warn('Failed to parse LMS chunk:', trimmed, e); }
                        }
                    } else {
                        // Ollama Format
                        try {
                            const json = JSON.parse(trimmed);
                            if (json.error) {
                                throw new Error(`Ollama Error: ${json.error}`);
                            }
                            if (json.done_reason) finishReason = json.done_reason;
                            
                            // Support both /api/chat and /api/generate formats
                            let contentDelta = "";
                            if (json.message && typeof json.message.content === 'string') {
                                contentDelta = json.message.content;
                            } else if (typeof json.response === 'string') {
                                contentDelta = json.response;
                            }

                            if (contentDelta) {
                                fullContent += contentDelta;
                                emitStream(fullContent);
                            }
                            // V38: Better tool call handling for Ollama - append instead of overwrite
                            if (json.message?.tool_calls?.length > 0) {
                                if (!toolCalls) toolCalls = [];
                                json.message.tool_calls.forEach(tc => {
                                    if (!tc.id) tc.id = `call_${Math.random().toString(36).substring(2, 10)}`;
                                    // Check if this tool call already exists (avoid duplicates in some streaming modes)
                                    const exists = toolCalls.some(existing => existing.id === tc.id || (existing.function.name === tc.function.name && JSON.stringify(existing.function.arguments) === JSON.stringify(tc.function.arguments)));
                                    if (!exists) toolCalls.push(tc);
                                });
                            }
                        } catch (e) { console.warn('Failed to parse Ollama chunk:', trimmed, e); }
                    }
                }
                scrollMessagesToLatest();
            }

            // Stop the throttled painter and clean the buffer once (the per-paint strip was
            // display-only; do it once here for the content saved to history / sent back).
            if (paintStream) paintStream.cancel();
            fullContent = STRIP_CTRL(fullContent);

            if (finishReason === 'length') {
                console.warn("[GUARD RAIL] Generation cut off due to context limits.");
                botDiv.innerHTML += `<br><br><span style="color:var(--danger-color); font-size: 0.85rem;"><strong>Generation cut off:</strong> Response exceeded context. Try a shorter prompt or increase context window.</span>`;
                convo.push({ role: 'assistant', content: fullContent });
                payloadHistory.push({ role: 'assistant', content: fullContent });
                finished = true;
                persist();
                continue;
            }

            // Fallback parser: small models (esp. Gemma) frequently emit the tool call as
            // raw JSON in the text body instead of via the native tool_calls API. Recover
            // ANY known tool — not just web_search — otherwise multi-step agent flows
            // (e.g. write_file after read_file) stall silently. See agentTools.extractTextToolCalls.
            if ((!toolCalls || toolCalls.length === 0) && fullContent && window.XKAgentTools?.extractTextToolCalls) {
                // Match the names the model actually SAW (wire names after overrides).
                const nameOverrides = window.XKModelHarness?.toolNameOverridesFor?.(model) || {};
                const known = activeTools.map(t => nameOverrides[t.function.name] || t.function.name);
                const textCalls = window.XKAgentTools.extractTextToolCalls(fullContent, known);
                if (textCalls.length > 0) {
                    toolCalls = textCalls.map(tc => ({
                        id: `call_fb_${Math.random().toString(36).substring(2, 10)}`,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.arguments }
                    }));
                    // Strip the raw JSON blocks so the user sees only the prose.
                    for (const tc of textCalls) { if (tc.raw) fullContent = fullContent.split(tc.raw).join(''); }
                    fullContent = fullContent.trim();
                    console.log(`Fallback tool parser recovered ${toolCalls.length} text tool call(s): ${textCalls.map(t => t.name).join(', ')}`);
                }
            }

            if (toolCalls?.length > 0 && activeTools.length > 0) {
                // For OpenAI format, tool_calls arguments might be strings that need parsing
                toolCalls = toolCalls.map(tc => {
                    // Map wire tool names back to canonical (kimi: internet_search → web_search)
                    // so validation + dispatch see the app's real tool names.
                    if (tc.function?.name && window.XKModelHarness?.canonicalToolName) {
                        tc.function.name = window.XKModelHarness.canonicalToolName(model, tc.function.name);
                    }
                    if (typeof tc.function.arguments === 'string') {
                        try {
                            tc.function.arguments = JSON.parse(tc.function.arguments);
                        } catch (e) { console.warn('Failed to parse tool arguments:', tc.function.arguments); }
                    }
                    return tc;
                });

                // --- V29 GUARD RAILS: Validation ---
                let validToolCalls = [];
                let hallucinations = [];

                for (const tc of toolCalls) {
                    const toolName = tc.function?.name;
                    const toolExists = activeTools.some(t => t.function.name === toolName);
                    
                    if (!toolExists) {
                        console.warn(`Hallucination detected: Tool "${toolName}" does not exist.`);
                        hallucinations.push(`Unknown tool: ${toolName}`);
                        continue;
                    }

                    // Simple argument check - if it's supposed to be an object but isn't
                    if (!tc.function.arguments || typeof tc.function.arguments !== 'object') {
                         console.warn(`Hallucination detected: Tool "${toolName}" has invalid arguments.`);
                         hallucinations.push(`Invalid arguments for ${toolName}`);
                         continue;
                    }

                    validToolCalls.push(tc);
                }

                if (hallucinations.length > 0) {
                    console.log("Blocking suspected hallucination and asking for clarification...");
                    convo.push({ role: 'assistant', content: fullContent || "I attempted to perform a task but got confused." });
                    payloadHistory.push({ role: 'assistant', content: fullContent || "I attempted to perform a task but got confused." });
                    convo.push({ role: 'user', content: `[GUARD RAIL]: I noticed you tried to use tools that don't exist or provided invalid parameters: ${hallucinations.join(', ')}. If you are unsure of how to proceed, please ask me for clarification instead of guessing.` });
                    payloadHistory.push({ role: 'user', content: `[GUARD RAIL]: I noticed you tried to use tools that don't exist or provided invalid parameters: ${hallucinations.join(', ')}. If you are unsure of how to proceed, please ask me for clarification instead of guessing.` });
                    botDiv.innerHTML = window.markedParse(fullContent + "\n\n*(Neural-Core intercepted a suspected hallucination. Nudging model for clarification...)*");
                    continue; 
                }

                // Anti-looping guard — sliding window, not just the previous call, so an
                // ALTERNATING loop (click → click …) is also caught. CRITICAL: read-only /
                // verification tools (snapshot, waits, lists, reads) are EXCLUDED — repeating
                // them is benign (the model is just re-checking the page) and must never be
                // mistaken for a stuck loop or trigger a false "I failed" message. Only
                // repeated MUTATING calls (same click/type/etc. args) count.
                const READONLY_TOOLS = new Set(['list_processes', 'read_process_log', 'list_directory', 'read_file', 'grep_project', 'glob_files', 'memory_search']);
                const allReadOnly = validToolCalls.length > 0 && validToolCalls.every(t => READONLY_TOOLS.has(t.function?.name));
                const currentSig = JSON.stringify(validToolCalls.map(t => ({ name: t.function?.name, args: t.function?.arguments })));
                window._recentToolSigs = window._recentToolSigs || [];
                if (!allReadOnly) {
                    const repeats = window._recentToolSigs.filter(s => s === currentSig).length;
                    if (repeats >= 3) {
                        // Genuinely stuck repeating the SAME mutating action. Stop honestly.
                        console.warn("Tool loop: hard stop after repeated identical mutating calls.");
                        const msg = "I repeated the same action several times without it changing anything, so I stopped to avoid spinning. If you can see what's blocking it (or tell me to try a different element), I'll continue.";
                        convo.push({ role: 'assistant', content: msg });
                        payloadHistory.push({ role: 'assistant', content: msg });
                        botDiv.innerHTML = window.markedParse(msg);
                        finished = true; persist(); continue;
                    }
                    if (repeats >= 1 && turnCount > 1) {
                        console.warn("Tool loop detected (repeat in window). Nudging.");
                        const nudge = "[GUARD RAIL] You already made this exact tool call. If it didn't move you forward, do something DIFFERENT (a different element, or report what you see). If it DID work (e.g. your message now appears in the thread), say so and finish — do not repeat it.";
                        convo.push({ role: 'user', content: nudge });
                        payloadHistory.push({ role: 'user', content: nudge });
                        window._recentToolSigs.push(currentSig);
                        if (window._recentToolSigs.length > 8) window._recentToolSigs.shift();
                        continue;
                    }
                    window._recentToolSigs.push(currentSig);
                    if (window._recentToolSigs.length > 8) window._recentToolSigs.shift();
                }

                const apiToolCalls = validToolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) } }));
                convo.push({ role: 'assistant', content: fullContent, tool_calls: apiToolCalls });
                payloadHistory.push({ role: 'assistant', content: fullContent, tool_calls: apiToolCalls });

                // OPTIMIZATION: Memory tools (mem_store, memory_search) now run on CPU in v31.3.
                // We no longer need to page out the main model here, saving significant time.

                if (window.XKChatLoop && window.XKAgentTools) {
                    if (window.XKSharedTimeline) window.XKSharedTimeline.setAnchor(botDiv);
                    const batch = await window.XKChatLoop.executeAgentToolBatch(validToolCalls, {
                        api: window.api,
                        trace,
                        emitAgentEvent: (ev) => {
                            if (window.XKSharedTimeline) {
                                window.XKSharedTimeline.handleCodeEvent(ev, { botDiv, anchor: botDiv });
                            }
                        },
                        executeTool: (n, a) => window.XKAgentTools.executeAgentChatTool(n, a, {
                            api: window.api,
                            getSudoPassword: () => sudoInput?.value || '',
                            saveToMemory,
                            searchMemory
                        })
                    });
                    for (const item of batch) {
                        if (item.tool.function.name === 'web_search') {
                            try {
                                const args = typeof item.tool.function.arguments === 'string' ? JSON.parse(item.tool.function.arguments) : item.tool.function.arguments;
                                showToast(`🌐 **Web Search Executed:** "${args.query}"`);
                                displayWebSearchResults(args.query, item.result);
                            } catch (e) {
                                showToast(`🌐 **Web Search Executed**`);
                                displayWebSearchResults("Unknown Query", item.result);
                            }
                        }
                        convo.push({
                            role: 'tool',
                            name: item.tool.function.name,
                            content: item.result,
                            tool_call_id: item.tool.id
                        });
                        payloadHistory.push({
                            role: 'tool',
                            name: item.tool.function.name,
                            content: item.result,
                            tool_call_id: item.tool.id
                        });
                    }
                } else for (const t of validToolCalls) {
                    const toolId = t.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    appendToolActivity(botDiv, t.function.name, t.function.arguments, toolId);

                    let result;
                    const startTool = Date.now();
                    try {
                        if (window.XKAgentTools) {
                            result = await window.XKAgentTools.executeAgentChatTool(
                                t.function.name,
                                t.function.arguments,
                                {
                                    api: window.api,
                                    getSudoPassword: () => sudoInput?.value || '',
                                    saveToMemory,
                                    searchMemory
                                }
                            );
                            if (t.function.name === 'web_search') {
                                try {
                                    const args = typeof t.function.arguments === 'string' ? JSON.parse(t.function.arguments) : t.function.arguments;
                                    showToast(`🌐 **Web Search Executed:** "${args.query}"`);
                                    displayWebSearchResults(args.query, result);
                                } catch (e) {
                                    showToast(`🌐 **Web Search Executed**`);
                                    displayWebSearchResults("Unknown Query", result);
                                }
                            }
                        } else {
                            result = 'Error: Agent tools module not loaded';
                        }
                        trace.addStep('tools.execute', 'tools', 'ok', 'TOOL_OK', Date.now() - startTool, t.function.name, t.function.name);
                    } catch (e) {
                        result = `Error: ${e.message}`;
                        trace.addStep('tools.execute', 'tools', 'error', 'TOOL_ERR', Date.now() - startTool, e.message, t.function.name);
                    }
                    updateToolActivity(toolId, t.function.name, result);
                    scrollMessagesToLatest();
                    convo.push({ role: 'tool', name: t.function.name, content: String(result), tool_call_id: t.id });
                    payloadHistory.push({ role: 'tool', name: t.function.name, content: String(result), tool_call_id: t.id });
                }
                if (window.XKChatLoop) {
                    /* batch path already pushed history */
                } else {
                    /* legacy loop pushed above */
                }
                botDiv.innerHTML = `<span class="loading-pulse">Step ${turnCount} contained. ${window.SmithPersona.pickLoadingPhrase('chat', turnCount)}</span><br><br>${existingText ? existingText + '<br><br>' : ''}${thinkingBlock(false)}${window.markedParse(fullContent)}`;
                await new Promise(r => setTimeout(r, 1500)); // Increased VRAM relief delay
                continue; // V38 FIX: Ensure loop restarts to send tool results back to the model
            } else {
                window._lastToolCallSignature = null; window._recentToolSigs = []; // Clear on success
                // BUG FIX: If model is silent after tool results, nudge it.
                if (turnCount > 1 && (!fullContent || fullContent.trim().length < 2)) {
                    console.log("Neural link active but model is silent after tool results. Nudging for final response...");
                    convo.push({ role: 'user', content: "Please summarize the results above and provide the final answer." });
                    payloadHistory.push({ role: 'user', content: "Please summarize the results above and provide the final answer." });
                    continue; 
                }

                convo.push({ role: 'assistant', content: fullContent });
                payloadHistory.push({ role: 'assistant', content: fullContent });

                botDiv.innerHTML = `${existingText ? existingText + '<br><br>' : ''}${thinkingBlock(false)}${window.markedParse(fullContent)}`;
                persist(); // snapshot AFTER the final render so the saved view holds the answer, not the streaming pulse
                
                if (fullContent && localTtsToggle?.checked) {
                    localSpeak(stripMarkdown(fullContent));
                }
                
                finished = true;
                
                trace.addStep('output.finalize', 'output', 'ok', 'DONE', 0);
            }
        }
        
        trace.close();
        if (trace._failed) {
            const explanation = compileExplanation(trace);
            generateReport(trace, explanation, text, fullContent);
        }
        
    } catch (e) {
        if (e.name === 'AbortError') {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: Request aborted by user.</span>`;
            // Remove the user message we just added since it was cancelled (from THIS run's
            // conversation, not whatever mode is active now if the user switched mid-run).
            if (convo.length > 0 && convo[convo.length - 1].role === 'user') {
                convo.pop();
            }
            trace.addStep('inference.generate', 'inference', 'aborted', 'USER_ABORT', 0, 'User stopped generation');
        } else if (e.message.includes('timeout')) {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: Model timed out. VRAM may be heavily congested. Try clearing memory or restarting Ollama.</span>`;
            trace.addStep('inference.generate', 'inference', 'timeout', 'REQ_TIMEOUT', 0, e.message);
        } else {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: ${e.message}</span>`;
            trace.addStep('inference.generate', 'inference', 'error', 'EXEC_ERR', 0, e.message);
        }
        
        trace.close();
        const explanation = compileExplanation(trace);
        generateReport(trace, explanation, text, "");
        
    } finally {
        isSending = false;
        chatRunState.isBusy = false;
        // Commit the run's bubble into its mode's snapshot so it survives a switch/relaunch.
        // If the user is viewing the run's mode, persist() already snapshots it (bubble is in
        // the container). If they switched away, the bubble is detached — fold its final HTML
        // into that mode's snapshot so returning shows the completed result + tool cards.
        if (activeRun && activeRun.botDiv && activeRun.mode !== currentMode) {
            const finalHtml = window.XKHistoryPersistence
                ? window.XKHistoryPersistence.sanitizeCodeTimelineHtml(activeRun.botDiv.outerHTML)
                : (activeRun.botDiv.outerHTML || '');
            modeSnapshots[activeRun.mode] = (modeSnapshots[activeRun.mode] || '') + finalHtml;
            try { persist(); } catch (e) { /* non-fatal */ }
        }
        activeRun = null;
        await window.XKRuntimeProfileUI?.flushPendingContextSync?.();

        if (!codeRunState.isBusy && window.XKScrollFollow && window.XKScrollFollow.get()) {
            window.XKScrollFollow.get().endRun();
        }

        sendBtn.style.display = 'block';
        if (!codeRunState.isBusy) stopBtn.style.display = 'none';
        const planStopBtn = document.getElementById('plan-stop-btn');
        if (planStopBtn && !codeRunState.isBusy) planStopBtn.style.display = 'none';
        abortController = null;
        setCodeLock(codeRunState.isBusy);
        updateCodeModeUI();
        if (!isWebMode) userInput.focus();
    }
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

// Onboarding suggestion chips: prefill the input (and flip Code Mode for coding starters).
const emptyStateEl = document.getElementById('empty-state');
if (emptyStateEl) {
    emptyStateEl.addEventListener('click', (e) => {
        const chip = e.target.closest('.suggest-chip');
        if (!chip) return;
        if (chip.dataset.build === '1') {
            const t = document.getElementById('code-mode-toggle');
            if (t && !t.checked) { t.checked = true; t.dispatchEvent(new Event('change')); }
        }
        userInput.value = chip.dataset.prompt || '';
        userInput.focus();
        try { userInput.dispatchEvent(new Event('input')); } catch (e2) {}
        userInput.setSelectionRange(userInput.value.length, userInput.value.length);
    });
}
checkAuth();


// Intercept download links to append auth token and prevent UI crash
document.addEventListener('click', (e) => {
    const target = e.target.closest('a');
    if (target && target.getAttribute('href')?.startsWith('/download_remote')) {
        e.preventDefault();
        void (async () => {
            const token = localStorage.getItem('auth_token');
            let url = target.getAttribute('href');

            // Self-heal stale links: a link from an older session/build carries a path
            // the download registry never saw. Re-register it on click and AWAIT it
            // (main verifies the file exists first) so the server sees the
            // registration before the GET arrives. Truly missing files still land
            // on the server's reason page.
            try {
                const fp = new URL(url, 'http://x').searchParams.get('file');
                if (fp && window.api?.invoke) {
                    await window.api.invoke('agent-register-download', fp).catch(() => null);
                }
            } catch (err) { /* best effort — the server explains any refusal */ }

            if (token) {
                url += url.includes('?') ? `&token=${token}` : `?token=${token}`;
            }

            // If we are in Electron, use the host to open it safely in the default browser or trigger download
            if (!isWebMode) {
                window.api.invoke('get-host-url').then(hostInfo => {
                    if (hostInfo && hostInfo.url) {
                        const fullUrl = hostInfo.url + url;
                        window.api.invoke('open-external-url', fullUrl);
                    }
                });
            } else {
                // In web mode, just navigate (it's safe in a real browser as it triggers a download)
                window.location.href = url;
            }
        })();
    }
});


// ===========================================================================
// Plugin system UI (desktop only — installing/enabling plugins from a tunneled
// phone would be a security hazard, so the panel is hidden in web mode).
// ===========================================================================
(function initPluginsUI() {
    const panel = document.getElementById('plugins-panel');
    const listEl = document.getElementById('plugin-list');
    const urlInput = document.getElementById('plugin-install-url');
    const installBtn = document.getElementById('plugin-install-btn');
    const statusEl = document.getElementById('plugin-install-status');
    if (!panel || !listEl) return;

    if (isWebMode || !window.api) { panel.style.display = 'none'; return; }

    const CAP_HINT = {
        fs: 'read/write files in the project', shell: 'run shell commands',
        net: 'make network requests', memory: 'read/write vector memory',
        ui: 'show notifications', log: 'write to the log',
    };

    function setStatus(msg, isError) {
        if (!statusEl) return;
        statusEl.style.display = msg ? 'block' : 'none';
        statusEl.textContent = msg || '';
        statusEl.style.color = isError ? '#ff4444' : '#8b949e';
    }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    async function refreshPlugins() {
        let plugins = [];
        try { plugins = await window.api.invoke('plugins-list'); } catch (e) { return; }
        if (!plugins.length) { listEl.innerHTML = 'No plugins installed.'; return; }

        listEl.innerHTML = plugins.map(p => {
            const caps = (p.capabilities || []).join(', ') || 'none';
            const contrib = `${p.tools.length} tool${p.tools.length === 1 ? '' : 's'}, ${p.commands.length} cmd, ${p.hooks.length} hook`;
            const err = p.error ? `<div style="color:#ff4444; font-size:0.62rem; margin-top:2px;">⚠ ${esc(p.error)}</div>` : '';
            return `
            <div class="plugin-row" data-id="${esc(p.id)}" style="border:1px solid var(--border-color); border-radius:4px; padding:5px; margin-bottom:5px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:var(--text-color); font-weight:bold;">${esc(p.name)} <span style="color:#8b949e; font-weight:normal;">v${esc(p.version)}</span></span>
                    <label class="toggle-label" style="margin:0;">
                        <input type="checkbox" class="plugin-toggle" ${p.enabled ? 'checked' : ''} ${p.error ? 'disabled' : ''}>
                    </label>
                </div>
                <div style="color:#8b949e; font-size:0.62rem; margin-top:2px;">${esc(p.description || '')}</div>
                <div style="color:#00e5ff; font-size:0.62rem; margin-top:2px;">caps: ${esc(caps)} · ${esc(contrib)}</div>
                ${err}
                <button class="plugin-uninstall clear-btn" style="font-size:0.6rem; padding:2px 6px; margin-top:4px;">UNINSTALL</button>
            </div>`;
        }).join('');

        // Wire row controls.
        listEl.querySelectorAll('.plugin-row').forEach(row => {
            const id = row.getAttribute('data-id');
            const p = plugins.find(x => x.id === id);
            const toggle = row.querySelector('.plugin-toggle');
            if (toggle) toggle.addEventListener('change', async () => {
                if (toggle.checked && (p.capabilities || []).length) {
                    const lines = p.capabilities.map(c => ` • ${c} — ${CAP_HINT[c] || c}`).join('\n');
                    const ok = confirm(`Enable "${p.name}"?\n\nThis plugin runs trusted code and requests these capabilities:\n${lines}\n\nOnly enable plugins you trust.`);
                    if (!ok) { toggle.checked = false; return; }
                }
                const grantedCaps = toggle.checked ? p.capabilities : [];
                await window.api.invoke('plugin-set-enabled', { id, enabled: toggle.checked, grantedCaps });
                refreshPlugins();
            });
            const uninstall = row.querySelector('.plugin-uninstall');
            if (uninstall) uninstall.addEventListener('click', async () => {
                if (!confirm(`Uninstall "${p.name}"? This deletes its folder.`)) return;
                await window.api.invoke('plugin-uninstall', { id });
                refreshPlugins();
            });
        });
    }

    async function resolveAndInstall() {
        const url = (urlInput.value || '').trim();
        if (!url) return;
        setStatus('Installing…');
        installBtn.disabled = true;
        try {
            const res = await window.api.invoke('plugin-install', { url });
            if (res && res.success) {
                setStatus(`Installed "${res.id}". Enable it below to grant its capabilities.`);
                urlInput.value = '';
                refreshPlugins();
            } else {
                setStatus(`Install failed: ${res && res.error ? res.error : 'unknown error'}`, true);
            }
        } catch (e) {
            setStatus(`Install failed: ${e.message || e}`, true);
        } finally {
            installBtn.disabled = false;
        }
    }

    if (installBtn) installBtn.addEventListener('click', resolveAndInstall);
    if (urlInput) urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); resolveAndInstall(); } });

    // Surface host.ui.notify() messages from plugins.
    try {
        window.api.on('plugin-ui-event', (data) => {
            if (data && data.message) addMessage('system', `🧩 **${data.pluginId}:** ${data.message}`);
        });
    } catch (e) {}

    refreshPlugins();
})();

// Resolve a "/name args" slash command against enabled plugin commands.
// Returns the expanded text, or null if it isn't a known plugin command.
async function resolvePluginCommand(raw) {
    const m = raw.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return null;
    try {
        const res = await window.api.invoke('plugin-run-command', { name: m[1], argText: m[2] });
        return res && typeof res.text === 'string' ? res.text : null;
    } catch (e) {
        return null;
    }
}
