const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { createLmStudioManager } = require('./src/main/services/lmStudioManager.js');
const { createImageGenManager } = require('./src/main/services/imageGenManager.js');

// Resource Monitoring System
let resourceMonitorInterval = null;
function startResourceMonitor(win) {
    if (resourceMonitorInterval) clearInterval(resourceMonitorInterval);
    
    resourceMonitorInterval = setInterval(async () => {
        if (!win || win.isDestroyed()) return;
        
        try {
            const memoryInfo = await process.getProcessMemoryInfo();
            const systemMem = os.freemem();
            const totalMem = os.totalmem();
            const freePercent = (systemMem / totalMem) * 100;
            
            // RSS (Resident Set Size) is the actual RAM used by the process
            const rssMB = memoryInfo.residentSet / 1024 / 1024;
            
            let status = 'healthy';
            if (freePercent < 15 || rssMB > 1500) {
                status = 'congested';
            } else if (freePercent < 30 || rssMB > 1000) {
                status = 'warning';
            }
            
            if (status !== 'healthy') {
                console.log(`[RESOURCE MONITOR] Status: ${status} (Free RAM: ${freePercent.toFixed(1)}%, Process: ${rssMB.toFixed(0)}MB)`);
                pushEvent('resource-update', {
                    status,
                    freePercent,
                    rssMB,
                    timestamp: Date.now()
                });
            }
        } catch (e) {
            console.error('Resource monitor error:', e);
        }
    }, 5000); // Check every 5 seconds
}

// Hardware Optimizations & Crash Prevention
function applyHardwareOptimizations() {
    let vendor = 'GENERIC';
    try {
        let isNVIDIA = false;
        let isAMD = false;

        // Detect GPU — Linux via lspci; Windows via wmic (optional); skip quietly on failure
        if (process.platform === 'linux') {
            try {
                const lspciOut = execSync('lspci | grep -i "3d\\|display\\|vga"', { encoding: 'utf8' }).toLowerCase();
                isNVIDIA = lspciOut.includes('nvidia');
                isAMD = lspciOut.includes('amd') || lspciOut.includes('radeon');
                
                if (isAMD) {
                    console.log(`Hardware: AMD GPU Detected.`);
                    vendor = 'AMD';
                    if (lspciOut.includes('strix') || lspciOut.includes('880m') || lspciOut.includes('890m')) {
                        console.log('Hardware: Applying HSA_OVERRIDE_GFX_VERSION=11.0.0 for Strix Point compatibility.');
                        process.env.HSA_OVERRIDE_GFX_VERSION = '11.0.0';
                    }
                }
                if (isNVIDIA) {
                    console.log(`Hardware: NVIDIA GPU Detected.`);
                    vendor = 'NVIDIA';
                }
            } catch (e) {
                console.warn('Could not detect GPU via lspci');
            }
        } else if (process.platform === 'win32') {
            try {
                const psOut = execSync(
                    'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name -join \',\'"',
                    { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
                ).toLowerCase();
                isNVIDIA = psOut.includes('nvidia');
                isAMD = psOut.includes('amd') || psOut.includes('radeon');
                if (isNVIDIA) { vendor = 'NVIDIA'; console.log('Hardware: NVIDIA GPU Detected (Windows).'); }
                else if (isAMD) { vendor = 'AMD'; console.log('Hardware: AMD GPU Detected (Windows).'); }
            } catch (e) {
                console.log('Hardware: GPU detection skipped on Windows.');
            }
        }

        // Apply OS-level GPU fixes to prevent Electron crashes
        if (process.platform === 'linux' || process.platform === 'win32') {
            app.commandLine.appendSwitch('disable-gpu-sandbox');
            app.commandLine.appendSwitch('ignore-gpu-blocklist');
            app.commandLine.appendSwitch('disable-dev-shm-usage');
            app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
        }

        if (process.platform === 'linux') {
            app.commandLine.appendSwitch('disable-gpu-rasterization');
            app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
            app.commandLine.appendSwitch('disable-accelerated-video-decode');
            app.commandLine.appendSwitch('disable-zero-copy');
        }

        // Optimize threading based on CPU (Linux /proc/cpuinfo only)
        if (process.platform === 'linux') {
            try {
                const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8').toLowerCase();
                if (cpuInfo.includes('authenticamd')) {
                    console.log('Hardware: AMD CPU Detected. Optimizing threads.');
                    const cores = require('os').cpus();
                    const physicalCores = cores.length > 4 ? cores.length / 2 : cores.length;
                    process.env.OMP_NUM_THREADS = Math.floor(physicalCores).toString();
                }
            } catch (e) {
                console.warn('Hardware: could not read /proc/cpuinfo');
            }
        }

        // Prevent network service crashes on Linux Wayland/XWayland with AMD by disabling buggy rasterization flags
        if (process.platform === 'linux' && isAMD) {
            app.commandLine.appendSwitch('disable-gpu-rasterization');
            app.commandLine.appendSwitch('disable-zero-copy');
        }

    } catch (e) {
        console.warn('Hardware detection notice:', e.message);
    }
    return vendor;
}

function resolveAppIcon() {
    const candidates = [
        path.join(__dirname, 'build', 'icons', '512x512.png'),
        path.join(__dirname, 'build', 'icon.png'),
        path.join(__dirname, 'icon.png')
    ];
    for (const iconPath of candidates) {
        try {
            if (!fs.existsSync(iconPath)) continue;
            const img = nativeImage.createFromPath(iconPath);
            if (!img.isEmpty()) return { img, iconPath };
        } catch (_) { /* try next */ }
    }
    return { img: null, iconPath: null };
}

/** Linux: frameless + correct taskbar/dock icon need WM_CLASS and often X11 CSD. */
function applyLinuxWindowFlags() {
    if (process.platform !== 'linux') return;
    app.commandLine.appendSwitch('class', 'agent-smith');
    app.commandLine.appendSwitch('name', 'agent-smith');
    // Wayland compositors may keep a server titlebar alongside our custom chrome.
    // Default to X11 for reliable borderless windows; set AGENT_SMITH_WAYLAND=1 to opt out.
    if (process.env.AGENT_SMITH_WAYLAND !== '1') {
        app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    }
}

if (typeof app.setName === 'function') app.setName('Agent Smith');
applyLinuxWindowFlags();
const APP_ICON = resolveAppIcon();
if (APP_ICON.iconPath) console.log('[app] icon:', APP_ICON.iconPath);
else console.warn('[app] icon not found — taskbar will use the Electron default');

const gpuVendor = applyHardwareOptimizations();

if (process.env.XKALIBER_NO_GPU === '1') {
    app.disableHardwareAcceleration();
}

// Clear GPU Cache on startup to prevent NVIDIA corruption issues
const initUserDataPath = app.getPath('userData');
const gpuCachePath = path.join(initUserDataPath, 'GPUCache');
try {
    if (fs.existsSync(gpuCachePath)) {
        fs.rmSync(gpuCachePath, { recursive: true, force: true });
        console.log('Cleared GPUCache to prevent NVIDIA driver issues.');
    }
} catch (err) {
    console.error('Failed to clear GPUCache:', err);
}

// Wrap ipcMain.handle to save a copy for the web UI
const originalHandle = ipcMain.handle.bind(ipcMain);
const webHandlers = new Map();
ipcMain.handle = (channel, listener) => {
    webHandlers.set(channel, listener);
    return originalHandle(channel, listener);
};

let mainWindow;
const { createSseHub } = require('./src/main/server/sseHub.js');
const { createPushEvent } = require('./src/main/server/pushEvent.js');
const { handlePreviewRequest } = require('./src/main/server/previewRoutes.js');
const { createPreviewRunner } = require('./src/main/services/previewRunner.js');
const { createBrowserVerify } = require('./src/main/services/browserVerify.js');
const { createActionLog } = require('./src/main/services/actionLog.js');
const sseHub = createSseHub();
const getMainWindowRef = () => mainWindow;
const pushEvent = createPushEvent(getMainWindowRef, sseHub);

const registerWhatsAppIpc = require('./src/main/lifecycle/whatsapp.js');
// WhatsApp deps are optional (puppeteer/Chromium); never let a failure here abort startup.
try { registerWhatsAppIpc(ipcMain, getMainWindowRef, app, pushEvent); }
catch (e) { console.error('[startup] WhatsApp IPC registration skipped:', (e && e.message) || e); }

// v55.5: Piper TTS — the SPEAK RESPONSES toggle's real engine (main process).
const registerTtsIpc = require('./src/main/lifecycle/tts.js');
// v57: pushEvent carries voice-download progress ('tts-event') to desktop + web UIs.
try { registerTtsIpc(ipcMain, { pushEvent }); }
catch (e) { console.error('[startup] TTS IPC registration skipped:', (e && e.message) || e); }

// IPC domains (open-file-dialog, auth, history, agent, edit, project, plan,
// ledger, git, memory, plugins) are registered from src/main/ipc/* near the
// bottom of this file via registerAllIpc(ipcMain, ipcDeps). OS/lifecycle
// handlers (whatsapp, tts, gpu, app-reset, set-lms-url, web server, host/env
// /external-url) stay inline below.

// Persistent Session Memory Paths
const userDataPath = app.getPath('userData');
const AuthManager = require('./src/main/services/auth.js');
const authManager = new AuthManager(userDataPath);

const historyFile = path.join(userDataPath, 'xkaliber_agent_session_v38_5.json');
const legacyFiles = [
    'xkaliber_agent_session_v38_4.json',
    'xkaliber_agent_session_v38_3.json',
    'xkaliber_agent_session_v37_9_1.json',
    'xkaliber_agent_session_v37.json',
    'xkaliber_agent_session_v36.json',
    'xkaliber_agent_session_v35.json',
    'xkaliber_agent_session_v34.json',
    'xkaliber_agent_session_v33.json',
    'xkaliber_agent_session_v32.json',
    'xkaliber_agent_session_v30.json',
    'xkaliber_agent_session_v29.json',
    'xkaliber_agent_session.json'
];

// Agent Harness IPC Handlers
const projectContext = require('./src/main/services/projectContext.js');
const ChangeLedger = require('./src/main/services/changeLedger.js');
const EditEngine = require('./src/main/services/editEngine.js');

const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);

// Shared mutable state for the extracted IPC domains. currentPlanId is the
// fallback plan id when the renderer omits one; it is read/written across the
// plan, agent, edit, and ledger domains, so it must live in one shared object.
const ipcState = { currentPlanId: null };

function relPathFromRoot(absPath) {
    const root = projectContext.getRoot();
    return path.relative(root, absPath).replace(/\\/g, '/');
}

const { grepProject, hasRipgrep } = require('./src/shared/grepTool.js');
const { globFiles } = require('./src/shared/globTool.js');
const { buildRepoMap, invalidate: invalidateRepoMap } = require('./src/shared/repoMap.js');
const projectDetector = require('./src/main/services/projectDetector.js');
const verificationHarness = require('./src/shared/verificationHarness.js');
const gitIntegration = require('./src/shared/gitIntegration.js');
const { stepsForType } = require('./src/shared/planTemplates.js');
const webTools = require('./src/shared/webTools.js');

// Search Handler (Netrunner Mode) — shared with the engine's web_search tool.
ipcMain.handle('perform-search', async (event, query) => {
    try {
        console.log(`Searching for: ${query}`);
        return await webTools.webSearch(query);
    } catch (error) {
        console.error('Search error:', error);
        return { error: error.message };
    }
});

// v54 — Deep research handler (Agent Mode chat path + any future UI): search, read the top
// result pages in full, and return a detailed natural-language report of everything learned.
ipcMain.handle('perform-search-deep', async (event, opts) => {
    const query = typeof opts === 'string' ? opts : (opts && opts.query);
    try {
        console.log(`Deep research: ${query}`);
        return await webTools.researchWeb(query, opts && typeof opts === 'object' ? opts : {});
    } catch (error) {
        console.error('Deep research error:', error);
        return { error: error.message };
    }
});

function createWindow() {
    const winOpts = {
        width: 1000,
        height: 800,
        title: 'Agent Smith Reloaded',
        show: false,
        frame: false,
        backgroundColor: '#050705',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
        autoHideMenuBar: true
    };
    if (APP_ICON.img) winOpts.icon = APP_ICON.img;

    mainWindow = new BrowserWindow(winOpts);
    mainWindow.setMenu(null);

    // Content-Security-Policy: the renderer shows LLM/markdown-derived HTML, so lock down
    // what it can load/execute. 'unsafe-inline' for styles is needed by the existing UI;
    // scripts are restricted to self (the bundled renderer) — no remote/eval script.
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self'; " +
                    "script-src 'self'; " +
                    "style-src 'self' 'unsafe-inline'; " +
                    "img-src 'self' data: blob:; " +
                    "font-src 'self' data:; " +
                    "media-src 'self' blob: data:; " +
                    // connect-src is permissive: the app must reach arbitrary user-configured
                    // LLM endpoints. Script execution (the RCE vector) stays locked via script-src.
                    "connect-src 'self' http: https: ws: wss:; " +
                    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
                ]
            }
        });
    });

    // Block the renderer from navigating away or opening new windows to attacker URLs.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault();
    });

    mainWindow.webContents.on("console-message", (e, level, msg, line, sourceId) => console.log(`[Renderer] ${msg} (${sourceId}:${line})`));
    mainWindow.webContents.on("console-message", (e, level, msg, line, sourceId) => console.log(`[Renderer] ${msg} (${sourceId}:${line})`));
    mainWindow.once('ready-to-show', () => {
        if (APP_ICON.img) mainWindow.setIcon(APP_ICON.img);
        mainWindow.show();
    });
    mainWindow.loadFile('index.html');
    startResourceMonitor(mainWindow);
}

app.whenReady().then(() => {
    createWindow();

    // v54.8 — warm the Electron Depot: seed <userData>/electron-cache from vendor/ so a
    // packaging build can start immediately. Non-blocking; failure only means old behavior.
    try { electronDepot && electronDepot.ensureReady(); } catch (_) {}

    // v55.3 — auto-provision missing Electron Depot assets (vendor/ is no longer bundled).
    // Delayed 2 s so the window exists and can receive progress events; non-blocking, and a
    // failure only means build tools fall back to fetching from GitHub on demand.
    setTimeout(() => { try { electronAssets && electronAssets.ensureInstalled(); } catch (_) {} }, 2000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Flush any pending debounced session write on exit so a phone's token is never
// lost between the last verifyToken and process death (v52.1 session persistence).
app.on('will-quit', () => {
    try { authManager.flushSessions(); } catch (_) { /* non-fatal */ }
});

// --- VRAM & Crash Detection (v30) ---
let isTelemetryInProgress = false;

ipcMain.handle('get-gpu-telemetry', async () => {
    if (isTelemetryInProgress) return { error: 'Telemetry already in progress' };
    isTelemetryInProgress = true;

    return new Promise((resolve) => {
        // os module is already required at the top
        const systemRam = {
            total: Math.round(os.totalmem() / 1024 / 1024),
            free: Math.round(os.freemem() / 1024 / 1024),
            used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024)
        };

        const finalize = (data) => {
            isTelemetryInProgress = false;
            resolve(data);
        };

        // Try AMD first (sysfs)
        if (process.platform === 'linux' && fs.existsSync('/sys/class/drm/card0/device/mem_info_vram_total')) {
            try {
                const vramTotal = parseInt(fs.readFileSync('/sys/class/drm/card0/device/mem_info_vram_total', 'utf8')) || 0;
                const vramUsed = parseInt(fs.readFileSync('/sys/class/drm/card0/device/mem_info_vram_used', 'utf8')) || 0;
                let util = 0;
                try { util = parseInt(fs.readFileSync('/sys/class/drm/card0/device/gpu_busy_percent', 'utf8')); } catch(e){}
                
                finalize({
                    vendor: 'AMD',
                    memory: { 
                        total: Math.round(vramTotal / 1024 / 1024), 
                        used: Math.round(vramUsed / 1024 / 1024), 
                        free: Math.round((vramTotal - vramUsed) / 1024 / 1024) 
                    },
                    utilization: util,
                    is_high_pressure: (vramUsed / vramTotal) > 0.95,
                    systemRam
                });
                return;
            } catch (err) {
                console.error("Failed to read AMD sysfs:", err);
            }
        }

        // Fallback to NVIDIA
        exec('nvidia-smi --query-gpu=memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits', { timeout: 3000 }, (err, stdout) => {
            if (err) {
                finalize({ 
                    error: 'No compatible GPU telemetry found (AMD or NVIDIA)', 
                    details: err.message,
                    systemRam 
                });
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                const gpus = lines.map(line => {
                    const [total, used, free, util] = line.split(',').map(s => parseInt(s.trim()));
                    return { total, used, free, utilization: util };
                });
                
                const primaryGpu = gpus[0];
                finalize({
                    vendor: 'NVIDIA',
                    memory: { total: primaryGpu.total, used: primaryGpu.used, free: primaryGpu.free },
                    utilization: primaryGpu.utilization,
                    is_high_pressure: (primaryGpu.used / primaryGpu.total) > 0.95,
                    systemRam
                });
            } catch (e) {
                finalize({ error: 'Failed to parse nvidia-smi output', systemRam });
            }
        });
    });
});

ipcMain.handle('app-reset', async (event, { killBackends = false, sudoPass = '' } = {}) => {
    console.log('--- EMERGENCY RESET TRIGGERED ---');
    
    if (killBackends) {
        console.log('Attempting to kill/restart AI backends (Ollama/LM Studio)...');
        
        if (process.platform === 'linux') {
            const haveSudo = !!sudoPass;
            try {
                // 1. Graceful SIGTERM first to allow VRAM release (Crucial for AMD/ROCm and NVIDIA)
                exec('pkill -15 -f ollama || true');
                exec('pkill -15 "LM Studio" || true');
                exec('pkill -15 lms || true');
                
                // Wait 2.5 seconds for graceful shutdown and VRAM deallocation
                await new Promise(res => setTimeout(res, 2500));
                
                // 2. Force kill remaining orphans
                exec('pkill -9 -f ollama || true');
                exec('pkill -9 "LM Studio" || true');
                exec('pkill -9 lms || true');

                // Wait 1 second to ensure ports are freed
                await new Promise(res => setTimeout(res, 1000));

                // 3. Attempt to restart Ollama service if we have sudo. The password is
                // passed on sudo's stdin (-S) via spawn args — never interpolated into a
                // shell string — so it can't be injected and doesn't transit a shell.
                if (haveSudo) {
                    try {
                        console.log('Restarting Ollama service via systemctl...');
                        const sudoProc = spawn('sudo', ['-S', 'systemctl', 'restart', 'ollama'], { stdio: ['pipe', 'ignore', 'ignore'] });
                        sudoProc.stdin.write(sudoPass + '\n');
                        sudoProc.stdin.end();
                        await new Promise((res) => sudoProc.on('close', res));
                    } catch(e) {
                        console.log('systemctl restart failed or not applicable.');
                    }
                }
            } catch (e) {
                console.error('Failed to kill backends:', e);
            }
        } else if (process.platform === 'win32') {
            try {
                exec('taskkill /IM ollama.exe /T'); // Try graceful
                exec('taskkill /IM "LM Studio.exe" /T');
                await new Promise(res => setTimeout(res, 2000));
                exec('taskkill /F /IM ollama.exe /T'); // Force
                exec('taskkill /F /IM "LM Studio.exe" /T');
            } catch (e) {}
        }
    }

    setTimeout(() => {
        app.relaunch();
        app.exit(0);
    }, 1000);
    
    return { success: true };
});

// Vector Memory Integration (via memory.js)
const memoryManager = require('./src/main/services/memory.js');
if (typeof gpuVendor !== 'undefined') {
    memoryManager.setGpuVendor(gpuVendor);
}

// --- Web Hosting (Mobile Access) ---
const http = require('http');
// os module is already required at the top
let WEB_PORT = 3000;

// Host state for LM Studio proxying
let lmsHostUrl = 'http://127.0.0.1:1234';
// Let vector memory fall back to this server's /v1/embeddings when Ollama is absent.
try { memoryManager.setLlmBase(lmsHostUrl); } catch (e) { /* optional */ }

// --- SSRF / download hardening (pure logic in lib/netGuard.js) ---------------
const netGuard = require('./src/shared/netGuard.js');
const { createDownloadRegistry, resolveServablePath, explainDownloadRefusal } = require('./src/main/services/downloadRegistry.js');
const { isBlockedHost } = netGuard;
const { requiresToolPermission } = require('./src/shared/channelPolicy.js');
const { assessCommand } = require('./src/shared/commandPolicy.js');

// IPC: the renderer notifies the main process when the user changes the LLM backend
// URL (used for the /api/proxy origin allow-list and the embeddings fallback base).
// Previously this channel existed only on the web server, so the desktop renderer's
// invoke threw "Blocked IPC channel: set-lms-url" — aborting fetchModels() on a URL
// change so the model list never reloaded for the new backend.
ipcMain.handle('set-lms-url', async (event, arg) => {
    const raw = Array.isArray(arg) ? arg[0] : arg;
    // Optional second element: a SEPARATE base for memory embeddings. Used when the
    // chat/agent/code provider is a hosted API without an embeddings endpoint (Kimi
    // K3) while memory keeps using the local backend.
    const memoryRaw = Array.isArray(arg) && arg.length > 1 ? arg[1] : null;
    let candidate;
    try { candidate = new URL(String(raw)); } catch (e) { candidate = null; }
    if (!candidate || (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') || isBlockedHost(candidate.hostname)) {
        return { error: 'Invalid LLM server URL' };
    }
    lmsHostUrl = candidate.toString();
    let memoryBase = lmsHostUrl;
    if (memoryRaw) {
        try {
            const m = new URL(String(memoryRaw));
            if ((m.protocol === 'http:' || m.protocol === 'https:') && !isBlockedHost(m.hostname)) {
                memoryBase = m.toString();
            }
        } catch (e) { /* fall back to the primary base */ }
    }
    try { memoryManager.setLlmBase(memoryBase); } catch (e) { /* optional */ }
    return { success: true };
});

// Permit a proxy target only if it's loopback or the configured LLM server.
function validateProxyTarget(targetUrl) {
    return netGuard.validateProxyTarget(targetUrl, lmsHostUrl);
}

// Permit a download only for real files inside the project root / app data / downloads,
// OR files the agent itself produced (download registry — see downloadRegistry.js).
function validateDownloadPath(rawPath) {
    const roots = [];
    const projRoot = projectContext.getRootOrNull();
    if (projRoot) roots.push(projRoot);
    try { roots.push(app.getPath('userData')); } catch (e) {}
    try { roots.push(app.getPath('downloads')); } catch (e) {}
    return resolveServablePath(rawPath, { roots, registry: downloadRegistry, netGuard });
}

// Diagnostic variant for the /download_remote endpoint: the 403 body and the server
// log must say WHY (missing file vs blocked by policy), not just "not permitted".
function explainDownload(rawPath) {
    const roots = [];
    const projRoot = projectContext.getRootOrNull();
    if (projRoot) roots.push(projRoot);
    try { roots.push(app.getPath('userData')); } catch (e) {}
    try { roots.push(app.getPath('downloads')); } catch (e) {}
    return explainDownloadRefusal(rawPath, { roots, registry: downloadRegistry, netGuard });
}

// --- Plugin system (lib/pluginManager.js + pluginInstaller.js) ---------------
const PluginManager = require('./src/main/services/pluginManager.js');
const PluginInstaller = require('./src/main/services/pluginInstaller.js');

// Core agent tool names plugins may not shadow (kept in sync with PLAN_TOOLS).
const CORE_TOOL_NAMES = [
    'submit_plan', 'mark_step_done', 'mark_step_blocked', 'run_shell_command',
    'run_command', 'read_file', 'write_file', 'edit_file', 'list_directory',
    'list_project', 'delete_file', 'set_project_root', 'memory_search',
    'save_new_user_fact_only', 'read_process_log', 'send_input',
    'provide_file_download_link', 'web_search', 'send_whatsapp_message',
    'dynamic_schema_generate', 'grep_project', 'glob_files', 'get_repo_map',
    'apply_patch', 'apply_edits', 'add_files', 'drop_files', 'run_verify',
    'record_decision', 'init_project'
];

// Foreground command runner for a plugin's `shell` capability (project-root cwd).
function runCommandForPlugin(command) {
    return new Promise((resolve) => {
        const verdict = assessCommand(command);
        if (!verdict.allowed) {
            return resolve({ error: `Command blocked by safety policy (${verdict.reason}).`, stdout: '', stderr: '' });
        }
        const cwd = projectContext.getRoot();
        if (projectContext.isWindows()) {
            exec(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, { cwd, maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
                resolve({ error: error ? error.message : null, stdout, stderr });
            });
        } else {
            exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
                resolve({ error: error ? error.message : null, stdout, stderr });
            });
        }
    });
}

// Optional subsystems are initialized defensively. A throw here (e.g. puppeteer/Chromium
// missing on a fresh Linux box, LM Studio probing, or a bad plugin) must NOT abort startup
// before registerAllIpc() runs below — otherwise the window loads but every IPC channel
// reports "No handler registered for 'auth-register'". Each falls back to null and its
// feature degrades gracefully while sign-in and the core app keep working.
function safeInit(label, factory) {
    try {
        return factory();
    } catch (e) {
        console.error(`[startup] ${label} failed to initialize (continuing without it):`, (e && e.message) || e);
        return null;
    }
}

const pluginManager = safeInit('pluginManager', () => new PluginManager(userDataPath, {
    projectContext,
    runCommand: runCommandForPlugin,
    memory: {
        store: (text, metadata) => memoryManager.storeVector(text, metadata),
        query: (query, limit) => memoryManager.queryVectors(query, limit),
    },
    uiNotify: (pluginId, msg) => {
        pushEvent('plugin-ui-event', { pluginId, message: msg });
    },
    netGuard,
    coreToolNames: CORE_TOOL_NAMES,
}));
if (pluginManager) { try { pluginManager.discover(); } catch (e) { console.error('[plugins] discover failed:', e); } }

const pluginInstaller = pluginManager
    ? safeInit('pluginInstaller', () => new PluginInstaller(pluginManager.pluginsDir, { netGuard }))
    : null;

// --- Register the extracted IPC domains (src/main/ipc/*) --------------------
// Every service, helper, and shared-state reference the domain handlers need is
// injected here so the handler modules close over nothing global. `ipcMain` is
// the web-handler-wrapping version installed near the top of this file, so the
// mobile web UI's /api/invoke proxy keeps seeing every channel.
const registerAllIpc = require('./src/main/ipc/index.js');
let previewDesktopAllowed = false;
const previewRunner = safeInit('previewRunner', () => createPreviewRunner({
    projectContext,
    userDataPath,
    getMainWindow: getMainWindowRef,
    pushEvent,
    getWebServerPort: () => WEB_PORT,
    getLocalIP,
    isElectronDesktop: true,
    getAllowDesktopPreview: () => previewDesktopAllowed
}));
const browserVerify = safeInit('browserVerify', () => createBrowserVerify({ projectContext }));
const actionLog = safeInit('actionLog', () => createActionLog({ userDataPath }));
const downloadRegistry = safeInit('downloadRegistry', () => createDownloadRegistry({ userDataPath }));
const lmStudioManager = safeInit('lmStudioManager', () => createLmStudioManager());
// v54.8 — Electron Depot: pre-provisioned Electron runtimes + builder toolsets so Code Mode
// packaging builds (npm install / electron-builder) never pull ~120 MB from GitHub.
const { createElectronDepot } = require('./src/main/services/electronDepot.js');
const electronDepot = safeInit('electronDepot', () => createElectronDepot({ userDataPath, getAppPath: () => app.getAppPath() }));
const imageGenManager = safeInit('imageGenManager', () => createImageGenManager({
    userDataPath,
    pushEvent,
    registerDownload: (p) => { try { downloadRegistry && downloadRegistry.register(p); } catch (_) {} }
}));
// v55.3 — Electron Depot auto-provisioning: vendor/ is no longer bundled in the package, so on
// first launch detect which build assets are missing from the local cache and download them
// (with live progress events). Non-blocking; a failure degrades to the old behavior where the
// build tools fetch what they need from GitHub on demand.
const { createElectronAssets } = require('./src/main/services/electronAssets.js');
const electronAssets = safeInit('electronAssets', () => createElectronAssets({ userDataPath, pushEvent }));
registerAllIpc(ipcMain, {
    // electron + node
    dialog, fs, fsPromises, path, spawn, exec,
    // services
    authManager, projectContext, changeLedger, editEngine,
    memoryManager, gitIntegration, verificationHarness, projectDetector,
    pluginManager, pluginInstaller, netGuard,
    // search / repo-map tools
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
    stepsForType,
    // helpers + paths + shared mutable state
    relPathFromRoot, historyFile, legacyFiles, userDataPath,
    state: ipcState,
    getLmsUrl: () => lmsHostUrl,
    getMainWindow: getMainWindowRef,
    pushEvent,
    previewRunner,
    browserVerify,
    actionLog,
    downloadRegistry,
    lmStudioManager,
    electronDepot,
    imageGenManager,
    electronAssets,
    isElectronDesktop: true,
    setAllowDesktopPreview: (enabled) => { previewDesktopAllowed = !!enabled; },
});

// --- v52.5: EMBED ON STARTUP -------------------------------------------------
// Memory recall needs an embedding model loaded in LM Studio. Previously the user had to
// load one manually or memory silently failed on every store/query ("Embedding failed").
// At boot we now guarantee it: if no embedding instance is resident, load the best
// available one (XK_EMBED_MODEL override > smallest on disk) with --gpu off so it costs
// zero VRAM. Runs in the background — never blocks window creation; a failure only means
// memory recall degrades exactly as before, and the next startup retries.
if (lmStudioManager) {
    setTimeout(() => {
        lmStudioManager.ensureEmbeddingModel({ apiBaseUrl: lmsHostUrl }).then((res) => {
            if (!res || res.ok === false) {
                console.warn('[startup] embedding model not ready:', res?.reason || res?.error || 'unknown');
                return;
            }
            // Tell memory.js which id to request from /v1/embeddings so it never has to
            // guess (auto-detect still works, but an explicit pin is one less round-trip).
            try { if (res.model) memoryManager.setEmbeddingModel(res.model); } catch (_) {}
            console.log(`[startup] embedding model ready: ${res.loaded || res.model}${res.alreadyLoaded ? ' (already loaded)' : ''}`);
        }).catch((e) => console.warn('[startup] ensureEmbeddingModel failed:', e?.message || e));
    }, 1500); // let the window + first IPC traffic settle before touching lms
}

// GhostTrace append for Agent chat runs (renderer → main JSONL)
let ghostTraceEventsFile;
if (__dirname.includes('app.asar')) {
    ghostTraceEventsFile = path.join(os.homedir(), '.config', 'Agent Smith', 'ghosttrace', 'events.jsonl');
} else {
    ghostTraceEventsFile = path.join(__dirname, 'src', 'data', 'ghosttrace', 'events.jsonl');
}
ipcMain.handle('ghosttrace-append', async (_event, payload) => {
    try {
        const dir = path.dirname(ghostTraceEventsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify(Object.assign({ timestamp: new Date().toISOString() }, payload || {}));
        fs.appendFileSync(ghostTraceEventsFile, line + '\n');
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const webServer = http.createServer((req, res) => {
    // CORS Headers for Mobile Web Mode
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target-url');
    if (req.method === 'OPTIONS') return res.end();

    const url = req.url.split('?')[0];
    const authHeader = req.headers['authorization'];
    const parsedUrlForAuth = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const queryToken = parsedUrlForAuth.searchParams.get('token');
    const token = authHeader ? authHeader.replace('Bearer ', '') : queryToken;
    const user = authManager.verifyToken(token);
    const isAuthenticated = !!user;
    const canUseApp = isAuthenticated && user.permissions.canUseApp;
    const canUseTools = isAuthenticated && user.permissions.canUseTools;
    const openLanMode = !authManager.hasUsers();

    // SSE stream for web/mobile push events (code-event, whatsapp-*, resource-update, …)
    if (url === '/api/events' && req.method === 'GET') {
        if (!openLanMode && (!isAuthenticated || !canUseApp)) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Unauthorized — log in to receive live events.' }));
        }
        sseHub.addClient(res);
        return;
    }

    // Public routes (login/register)
    const isPublicApi = url === '/api/invoke' && req.method === 'POST' && (
        req.headers['x-auth-action'] === 'login' || 
        req.headers['x-auth-action'] === 'register' ||
        req.headers['x-auth-action'] === 'has-users'
    );

    const publicFiles = ['/index.html', '/', '/src/renderer/app.js', '/preload.js', '/style.css', '/icon.png'];
    const isPublicFile = publicFiles.includes(url) || url.endsWith('.css') || url.endsWith('.js') || url.endsWith('.png') || url.endsWith('.jpg');
    const isDownloadRemote = url.startsWith('/download_remote');

    // Validated file handoff — allowed in open LAN mode without login; otherwise requires auth.
    if (isDownloadRemote) {
        if (!openLanMode && !isAuthenticated) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        if (isAuthenticated && !canUseApp) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
        }
    } else if (!isAuthenticated && !isPublicApi && !isPublicFile) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    
    if (isAuthenticated && !canUseApp && !isPublicApi && !isPublicFile) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
    }

    // API Proxy for Ollama and LM Studio (Solves CORS and localhost binding issues)
    if (url.startsWith('/api/proxy/')) {
        if (!canUseApp) {
            res.writeHead(403); return res.end('Account pending admin approval');
        }
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            res.writeHead(400); return res.end('Missing x-target-url header');
        }
        const parsed = validateProxyTarget(targetUrl);
        if (!parsed) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Proxy target not allowed. Only the configured local LLM server may be proxied.' }));
        }
        try {
            const transport = parsed.protocol === 'https:' ? require('https') : require('http');
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: req.method,
                headers: { ...req.headers, host: parsed.host }
            };

            delete options.headers['origin'];
            delete options.headers['referer'];
            delete options.headers['x-target-url'];
            delete options.headers['accept-encoding'];
            // Don't leak the app's session token / cookies to the proxied target.
            delete options.headers['authorization'];
            delete options.headers['cookie'];
            
            const proxyReq = transport.request(options, (proxyRes) => {
                // Merge target headers with our required CORS headers
                const mergedHeaders = { ...proxyRes.headers };
                mergedHeaders['Access-Control-Allow-Origin'] = '*';
                // Remove some headers that might conflict with the browser's security model
                delete mergedHeaders['content-security-policy'];
                delete mergedHeaders['x-frame-options'];

                res.writeHead(proxyRes.statusCode, mergedHeaders);
                proxyRes.pipe(res);
            });
            
            proxyReq.on('error', e => {
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                }
                res.end(JSON.stringify({ error: 'Proxy failed to connect: ' + e.message }));
            });
            
            req.pipe(proxyReq);
        } catch (e) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            }
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // IPC Proxy for Web Clients
    if (url === '/api/invoke' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { channel, args } = JSON.parse(body);
                
                // Special handling for auth actions via proxy
                if (channel === 'auth-login' || channel === 'auth-register' || channel === 'auth-has-users') {
                    // These are allowed even if not authenticated if they come with x-auth-action header
                } else if (!isAuthenticated) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Unauthorized' }));
                } else if (!canUseApp && channel !== 'auth-check' && channel !== 'auth-logout') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
                } else if (requiresToolPermission(channel) && !canUseTools) {
                    // Gate by CAPABILITY, not name shape: code-run/git-*/edit-*/plugin-*
                    // expose shell + file writes just like agent-*, and must require tools.
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Tool usage restricted by Administrator' }));
                }

                // Special trap to let host know LMS server changed from web UI.
                // Validate it's a well-formed http(s) URL and not a metadata/link-local
                // host before trusting it (it feeds the proxy allowlist).
                if (channel === 'set-lms-url') {
                    let candidate;
                    try { candidate = new URL(String(args[0])); } catch (e) { candidate = null; }
                    if (!candidate || (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') || isBlockedHost(candidate.hostname)) {
                        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        return res.end(JSON.stringify({ error: 'Invalid LLM server URL' }));
                    }
                    lmsHostUrl = candidate.toString();
                    // Optional args[1]: separate memory/embeddings base (hosted Kimi K3
                    // for chat/agent/code + local backend for embeddings).
                    let memoryBase = lmsHostUrl;
                    if (args.length > 1 && args[1]) {
                        try {
                            const m = new URL(String(args[1]));
                            if ((m.protocol === 'http:' || m.protocol === 'https:') && !isBlockedHost(m.hostname)) {
                                memoryBase = m.toString();
                            }
                        } catch (e) { /* fall back to the primary base */ }
                    }
                    try { memoryManager.setLlmBase(memoryBase); } catch (e) { /* optional */ }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    return res.end(JSON.stringify({ success: true }));
                }

                const handler = webHandlers.get(channel);
                if (handler) {
                    // --- v48: wrap handler in a timeout so mobile/web clients don't hang forever.
                    // The default is 10 minutes; callers can override via the 'x-timeout-ms' header.
                    const handlerTimeoutMs = parseInt(req.headers['x-timeout-ms'] || '600000', 10);
                    let timedOut = false;
                    const hTimer = setTimeout(() => {
                        timedOut = true;
                        res.writeHead(408, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: `Request timed out after ${handlerTimeoutMs / 1000}s — the model is taking longer than expected to start generating. This is normal for large models on slower hardware.` }));
                    }, handlerTimeoutMs);

                    try {
                        const val = await handler({ sender: { send: () => {} } }, ...args);
                        if (!timedOut) {
                            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                            res.end(JSON.stringify(val));
                        }
                    } finally {
                        clearTimeout(hTimer);
                    }
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'No handler for ' + channel }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // File Download Endpoint — only files inside the project root / app data may be
    // served (previously any absolute path → arbitrary file read for authd users),
    // plus files the agent itself produced (download registry). Refusals are logged
    // WITH the precise reason and returned in the body — "missing file" and
    // "blocked by policy" are different problems with different fixes.
    if (url.startsWith('/download_remote')) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const fileToDownload = parsedUrl.searchParams.get('file');
        const verdict = explainDownload(fileToDownload);
        if (verdict.ok) {
            const safePath = verdict.path;
            const safeName = path.basename(safePath).replace(/["\r\n]/g, '_');
            res.writeHead(200, {
                'Content-Disposition': `attachment; filename="${safeName}"`,
                'Access-Control-Allow-Origin': '*'
            });
            const readStream = fs.createReadStream(safePath);
            readStream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
            readStream.pipe(res);
            return;
        } else {
            console.warn(`[download] refused (${verdict.code}): ${fileToDownload}`);
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(`Download refused (${verdict.code})\n\n${verdict.message}`);
            return;
        }
    }

    if (handlePreviewRequest(req, res, {
        projectContext,
        userDataPath,
        canUseApp,
        openLanMode,
        isAuthenticated
    })) {
        return;
    }

    // Static File Serving
    // Decode and contain within __dirname to prevent path traversal
    // (e.g. "/../../secret.js" — extensions like .js/.css bypass the auth gate above).
    let decodedUrl;
    try {
        decodedUrl = decodeURIComponent(url);
    } catch (e) {
        decodedUrl = url;
    }
    const appDir = path.resolve(__dirname);
    let filePath = path.resolve(appDir, '.' + (decodedUrl === '/' ? '/index.html' : decodedUrl));
    const relToApp = path.relative(appDir, filePath);
    if (relToApp.startsWith('..') || path.isAbsolute(relToApp)) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        return res.end('Forbidden');
    }
    fs.promises.readFile(filePath)
        .then(content => {
            const ext = path.extname(filePath);
            const contentType = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.jpg': 'image/jpeg'
            }[ext] || 'text/plain';
            // no-cache (revalidate): the app updates in place — a heuristically
            // cached renderer script would silently keep OLD UI/logic after an upgrade
            // (v57: the TTS dropdown shipped but the browser ran a stale app.js).
            res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
            res.end(content);
        })
        .catch(e => {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('Not Found');
        });
});

// Cloudflare quick tunnel (public phone-access URL). Extracted to a service in
// v53.9 so the "wait for the URL" behavior is unit-testable — see
// src/main/services/cloudflareTunnel.js and tests/cloudflareTunnel.test.js.
const { createCloudflareTunnel } = require('./src/main/services/cloudflareTunnel.js');
const cloudflareTunnel = createCloudflareTunnel({ app });
// Don't orphan cloudflared when the desktop app exits (it would keep holding a
// public URL pointing at a dead web server).
app.on('will-quit', () => { try { cloudflareTunnel.stop(); } catch (_) { /* non-fatal */ } });

// Resilient bind: a stale instance or another app on :3000 must NOT crash the
// desktop app. Without an 'error' handler, EADDRINUSE is an unhandled server
// error that takes down the whole main process. Retry on the next free port and,
// if none is free, keep the desktop app running with the web UI disabled.
const WEB_PORT_MAX_TRIES = 10;
function startWebServer(attempt = 0) {
    webServer.listen(WEB_PORT, '0.0.0.0', () => {
        console.log('\n=========================================');
        console.log(' Web Interface hosted at: http://' + getLocalIP() + ':' + WEB_PORT);
        console.log('=========================================\n');
        // Opt-out for headless / automated runs: skip the cloudflared download +
        // public tunnel (AGENT_SMITH_NO_TUNNEL=1). The local web UI still serves.
        if (!process.env.AGENT_SMITH_NO_TUNNEL) {
            cloudflareTunnel.start({ port: WEB_PORT }).catch(console.error);
        }
    });
}
webServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        if (WEB_PORT - 3000 < WEB_PORT_MAX_TRIES) {
            console.warn(`[web] port ${WEB_PORT} in use, trying ${WEB_PORT + 1}...`);
            WEB_PORT += 1;
            setTimeout(() => { try { webServer.close(); } catch {} startWebServer(); }, 50);
            return;
        }
        console.error(`[web] no free port in ${3000}-${WEB_PORT}; web UI disabled. Desktop app continues.`);
        return;
    }
    console.error('[web] server error (web UI disabled, desktop app continues):', (err && err.message) || err);
});
startWebServer();

ipcMain.handle('get-host-url', async () => {
    return {
        url: 'http://' + getLocalIP() + ':' + WEB_PORT,
        remoteUrl: cloudflareTunnel.remoteUrl
    };
});

function focusedWindow() {
    return BrowserWindow.getFocusedWindow() || mainWindow;
}

ipcMain.handle('window-minimize', () => { focusedWindow()?.minimize(); });
ipcMain.handle('window-maximize', () => {
    const win = focusedWindow();
    if (!win) return { maximized: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { maximized: win.isMaximized() };
});
ipcMain.handle('window-close', () => { focusedWindow()?.close(); });
ipcMain.handle('window-is-maximized', () => ({ maximized: !!focusedWindow()?.isMaximized() }));

// Render a QR of the best phone-reachable URL (public tunnel if up, else the LAN URL)
// so a user can scan it from the composer and open Agent Smith on their phone.
//
// v53.9 fix: WAIT for the tunnel URL before falling back to LAN. cloudflared
// takes several seconds after spawn to register its trycloudflare.com hostname,
// so the old synchronous read raced that window — a user who opened this modal
// during it got a QR encoding http://<LAN-IP>:3000 (or localhost), which their
// phone cannot reach. Now: if the tunnel is already up → instant; otherwise give
// it up to 15 s, and only encode the LAN URL when the tunnel genuinely isn't
// coming (download failed, no network, AGENT_SMITH_NO_TUNNEL).
ipcMain.handle('get-remote-qr', async () => {
    const lanUrl = 'http://' + getLocalIP() + ':' + WEB_PORT;
    let remote = cloudflareTunnel.remoteUrl;
    if (!remote && !process.env.AGENT_SMITH_NO_TUNNEL) {
        try { remote = await cloudflareTunnel.waitForRemoteUrl(15000); } catch (_) { remote = null; }
    }
    const best = remote || lanUrl;
    try {
        const QRCode = require('qrcode');
        // Standard high-contrast (black on white) for reliable scanning across phones.
        const qrDataUrl = await QRCode.toDataURL(best, { margin: 1, width: 320, color: { dark: '#000000', light: '#ffffff' } });
        return { qrDataUrl, url: best, lanUrl, remoteUrl: remote, isRemote: !!remote };
    } catch (e) {
        return { error: 'QR generator unavailable: ' + e.message, url: best, lanUrl, remoteUrl: remote, isRemote: !!remote };
    }
});

ipcMain.handle('open-external-url', async (event, url) => {
    // Only open real web URLs in the browser — never file:, javascript:, etc.
    let parsed;
    try { parsed = new URL(String(url)); } catch (e) { return { error: 'Invalid URL' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
        return { error: `Refusing to open non-web URL scheme: ${parsed.protocol}` };
    }
    try {
        await shell.openExternal(parsed.toString());
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-env-info', async () => {
    const selectedRoot = projectContext.getRootOrNull();
    return {
        platform: os.platform(),
        arch: os.arch(),
        homedir: os.homedir(),
        username: os.userInfo().username,
        // The agent must operate on the user-selected workspace, not the app's
        // own install dir. Report the project root as cwd; expose both fields so
        // callers can tell whether a workspace was actually chosen.
        cwd: projectContext.getRoot(),
        projectRoot: selectedRoot,
        appDir: process.cwd()
    };
});
