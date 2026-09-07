/**
 * Pure mode-switch history logic — the stash/restore/seed decision behind the
 * "Chat, Agent and Code each keep a SEPARATE, persisted conversation" rule.
 *
 * Extracted from app.js so the invariant is unit-testable without a DOM: this function
 * touches ONLY the plain `histories` object and a caller-supplied seed function. All DOM
 * work (timeline snapshot/restore, re-render, persist) stays in app.js, driven by the
 * flags returned here.
 */
(function (global) {
    'use strict';

    /**
     * Compute a mode switch.
     *
     * @param {{chat:Array,agent:Array,code:Array}} histories  per-mode conversations; the
     *        outgoing mode is stashed and an empty target is seeded IN PLACE (matches app.js).
     * @param {string} currentMode  'chat' | 'agent' | 'code'
     * @param {Array}  chatHistory  the live array app.js currently points at
     * @param {string} targetMode   the mode being switched to
     * @param {(mode:string)=>Array} seedFn  builds a fresh history for a never-visited mode
     * @returns {{switched:boolean, currentMode:string, chatHistory:Array, seeded:boolean,
     *           snapshotLeavingCode:boolean, restoreCodeTimeline:boolean}}
     */
    function planModeSwitch(histories, currentMode, chatHistory, targetMode, seedFn) {
        if (targetMode === currentMode) {
            return {
                switched: false,
                currentMode,
                chatHistory,
                seeded: false,
                snapshotLeavingCode: false,
                restoreCodeTimeline: false
            };
        }

        // Stash the conversation we're leaving so its messages survive the switch.
        histories[currentMode] = chatHistory;
        const snapshotLeavingCode = currentMode === 'code';

        // Activate the target conversation; seed a fresh one only on first visit.
        let next = histories[targetMode];
        let seeded = false;
        if (!next || next.length === 0) {
            next = seedFn(targetMode);
            histories[targetMode] = next;
            seeded = true;
        }

        return {
            switched: true,
            currentMode: targetMode,
            chatHistory: next,
            seeded,
            snapshotLeavingCode,
            restoreCodeTimeline: targetMode === 'code'
        };
    }

    const api = { planModeSwitch };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKModeHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
