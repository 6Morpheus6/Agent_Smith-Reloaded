/**
 * Separate run state per mode — no shared busy/abort between Chat and Code.
 */
(function (global) {
    'use strict';

    function createRunState() {
        return {
            isBusy: false,
            abortController: null,
            sessionId: null
        };
    }

    const chatRunState = createRunState();
    const codeRunState = createRunState();

    const api = {
        chatRunState,
        codeRunState,
        createRunState,
        Mode: { CHAT: 'chat', CODE: 'code' }
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKRunState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
