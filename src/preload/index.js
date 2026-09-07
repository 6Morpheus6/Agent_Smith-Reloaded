const { contextBridge, ipcRenderer } = require('electron');
const markedModule = require('marked');

try {
    const hljs = require('highlight.js');
    markedModule.use({
        renderer: {
            code(tokenOrText, langArg) {
                const text = typeof tokenOrText === 'object' ? tokenOrText.text : tokenOrText;
                const lang = typeof tokenOrText === 'object' ? tokenOrText.lang : langArg;
                try {
                    if (lang && hljs.getLanguage(lang)) {
                        return `<pre><code class="hljs language-${lang}">${hljs.highlight(text, { language: lang }).value}</code></pre>`;
                    }
                    return `<pre><code class="hljs">${hljs.highlightAuto(text).value}</code></pre>`;
                } catch (e) {
                    return `<pre><code>${text}</code></pre>`;
                }
            }
        }
    });
} catch (e) {
    // highlight.js not installed — code blocks render without highlighting
}

// Channel whitelists are declared once in src/shared/ipcChannels.js.
const { INVOKE_CHANNELS, SEND_CHANNELS, RECEIVE_CHANNELS } = require('../shared/ipcChannels.js');

let qrModule = null;
try { qrModule = require('qrcode'); } catch (_) { /* optional — phone QR falls back to link-only */ }

const QR_RENDER_OPTS = { margin: 1, width: 320, color: { dark: '#000000', light: '#ffffff' } };

contextBridge.exposeInMainWorld('api', {
    invoke: (channel, ...args) => {
        if (!INVOKE_CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
        return ipcRenderer.invoke(channel, ...args);
    },
    send: (channel, ...args) => {
        if (!SEND_CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
        ipcRenderer.send(channel, ...args);
    },
    on: (channel, callback) => {
        if (!RECEIVE_CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
        const handler = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    }
});

contextBridge.exposeInMainWorld('markedParse', (text) => markedModule.parse(text));

contextBridge.exposeInMainWorld('qr', {
    toDataURL: (text) => {
        if (!qrModule) return Promise.reject(new Error('qrcode not installed'));
        return qrModule.toDataURL(String(text), QR_RENDER_OPTS);
    }
});
