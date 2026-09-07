/**
 * Unified push: Electron webContents + SSE hub (web/mobile clients).
 * Desktop receives IPC only; SSE clients receive the same payload in parallel.
 */
'use strict';

function createPushEvent(getMainWindow, sseHub) {
    return function pushEvent(channel, payload) {
        const win = getMainWindow?.();
        if (win && !win.isDestroyed()) {
            win.webContents.send(channel, payload);
        }
        if (sseHub) {
            sseHub.broadcast(channel, payload);
        }
    };
}

module.exports = { createPushEvent };
