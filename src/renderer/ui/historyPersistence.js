/**
 * Crash-safe renderer history helpers.
 */
(function (global) {
    'use strict';

    const DURABLE_CODE_EVENTS = new Set([
        'planning_start',
        'plan_awaiting_approval',
        'plan_approved',
        'plan_step_update',
        'plan_rejected',
        'run_start',
        'turn_start',
        'tool_result',
        'verify_blocked',
        'run_continue',
        'final_summary',
        'done',
        'error'
    ]);

    function sanitizeCodeTimelineHtml(html) {
        return String(html || '').replace(
            /<div\b[^>]*class=["'][^"']*\bbot-message\b[^"']*["'][^>]*>\s*<span\b[^>]*class=["'][^"']*\bloading-pulse\b[^"']*["'][^>]*>[\s\S]*?<\/span>\s*<\/div>/gi,
            ''
        );
    }

    function shouldCheckpointCodeEvent(event) {
        return DURABLE_CODE_EVENTS.has(event?.type);
    }

    const api = { sanitizeCodeTimelineHtml, shouldCheckpointCodeEvent };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKHistoryPersistence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
