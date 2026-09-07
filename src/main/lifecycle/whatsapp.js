const path = require('path');
const fs = require('fs');

/**
 * WhatsApp integration — peripheral lifecycle handler (SMITH.md §5).
 * Not part of the durable plan loop; kept for users who need it via CONNECTION panel.
 *
 * `whatsapp-web.js` + `qrcode` are OPTIONAL dependencies: they pull in puppeteer (a
 * ~150MB Chromium download + Linux system libs) which routinely breaks `npm install`
 * on Linux. They are loaded LAZILY here so the app installs and runs fine without them;
 * the IPC handlers still register, and only return a friendly error if WhatsApp is used
 * without the optional packages present.
 */

const SYSTEM_CHROME_CANDIDATES = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

/** Puppeteer's downloaded Chrome, else a system Chrome/Chromium install. */
function resolveChromeExecutable() {
    try {
        const puppeteer = require('puppeteer');
        const bundled = puppeteer.executablePath();
        if (bundled && fs.existsSync(bundled)) return bundled;
    } catch (_) { /* puppeteer cache empty — fall through to system browsers */ }

    for (const candidate of SYSTEM_CHROME_CANDIDATES) {
        try {
            if (candidate && fs.existsSync(candidate)) return candidate;
        } catch (_) { /* ignore */ }
    }
    return null;
}

function chromeMissingMessage() {
    return 'Chrome not found for WhatsApp linking. Install Google Chrome or Chromium on this computer, '
        + 'or run once in the project folder: npx puppeteer browsers install chrome';
}

function loadWhatsAppDeps() {
    try {
        const { Client, LocalAuth } = require('whatsapp-web.js');
        const qrcode = require('qrcode');
        return { Client, LocalAuth, qrcode };
    } catch (e) {
        return null;
    }
}

module.exports = function registerWhatsAppIpc(ipcMain, getMainWindow, app, pushEvent) {
    const send = (channel, payload) => {
        if (pushEvent) pushEvent(channel, payload);
        else {
            const mainWindow = getMainWindow();
            if (mainWindow) mainWindow.webContents.send(channel, payload);
        }
    };
    let whatsappClient = null;

    ipcMain.handle('whatsapp-init', async () => {
        if (whatsappClient) return { status: 'already_init' };

        const deps = loadWhatsAppDeps();
        if (!deps) {
            return { error: 'WhatsApp support is not installed. Run: npm install whatsapp-web.js qrcode (this also pulls Chromium via puppeteer).' };
        }
        const { Client, LocalAuth, qrcode } = deps;

        const executablePath = resolveChromeExecutable();
        if (!executablePath) {
            return { error: chromeMissingMessage() };
        }

        whatsappClient = new Client({
            authStrategy: new LocalAuth({ dataPath: path.join(app.getPath('userData'), 'wa_auth') }),
            puppeteer: {
                headless: true,
                executablePath,
                handleSIGINT: false,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            }
        });

        whatsappClient.on('qr', async (qr) => {
            const qrImage = await qrcode.toDataURL(qr);
            send('whatsapp-qr', qrImage);
        });

        whatsappClient.on('ready', () => {
            send('whatsapp-ready');
            console.log('WhatsApp is ready!');
        });

        whatsappClient.on('authenticated', () => {
            console.log('WhatsApp Authenticated');
        });

        whatsappClient.on('auth_failure', (msg) => {
            send('whatsapp-error', msg);
        });

        whatsappClient.on('disconnected', () => {
            send('whatsapp-disconnected');
            whatsappClient = null;
        });

        try {
            await whatsappClient.initialize();
            return { success: true };
        } catch (err) {
            return { error: err.message };
        }
    });

    // Cancel a pending link (user closed the QR). Destroys the client so it stops emitting
    // QR refreshes and shuts its headless Chrome. No‑op if nothing is connecting.
    ipcMain.handle('whatsapp-cancel', async () => {
        if (!whatsappClient) return { success: true };
        const client = whatsappClient;
        whatsappClient = null;
        try { await client.destroy(); } catch (e) { /* ignore */ }
        return { success: true };
    });

    ipcMain.handle('whatsapp-send', async (event, { number, message }) => {
        if (!whatsappClient) return { error: 'WhatsApp not initialized' };
        try {
            const sanitizedNum = number.includes('@') ? number : `${number.replace(/\D/g, '')}@c.us`;
            await whatsappClient.sendMessage(sanitizedNum, message);
            return { success: true };
        } catch (err) {
            return { error: err.message };
        }
    });
};

module.exports.resolveChromeExecutable = resolveChromeExecutable;
