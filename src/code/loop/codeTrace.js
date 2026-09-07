/**
 * GhostTrace adapter for Code Mode runs.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { PipelineTrace, compileExplanation, generateReport } = require('../../ghosttrace/index.js');

class CodeRunTrace {
    constructor(runId) {
        this.runId = runId;
        this.trace = new PipelineTrace(runId);
        this._t0 = Date.now();
        this._closed = false;
    }

    inputReceived(detail) {
        this.trace.addStep('input.received', 'input', 'ok', 'CODE_RUN_START', 0, detail || '');
    }

    contextLoaded(detail) {
        this.trace.addStep('context.loaded', 'context', 'ok', 'CTX_OK', Date.now() - this._t0, detail || '');
    }

    inferenceOk(ms) {
        this.trace.addStep('inference.generate', 'inference', 'ok', 'LLM_OK', ms || 0, '');
    }

    inferenceError(ms, detail) {
        this.trace.addStep('inference.generate', 'inference', 'error', 'LLM_ERROR', ms || 0, detail || '');
    }

    toolExecute(tool, ok, detail) {
        this.trace.addStep(
            'tools.execute',
            'tools',
            ok ? 'ok' : 'error',
            ok ? 'TOOL_OK' : 'TOOL_FAIL',
            0,
            detail || '',
            tool
        );
    }

    verifyBlocked(detail, reflection) {
        this.trace.addStep('verify.blocked', 'verify', 'error', 'GATE_BLOCKED', 0, `reflection ${reflection || ''}: ${detail || ''}`.trim());
    }

    verifyGate(status, detail) {
        const ok = status === 'done';
        this.trace.addStep('verify.gate', 'verify', ok ? 'ok' : 'error', ok ? 'VERIFIED' : `GATE_${String(status || 'fail').toUpperCase()}`, 0, detail || '');
    }

    finalize(outcome, detail) {
        this._closed = true;
        this.trace.addStep('output.finalize', 'output', outcome === 'done' ? 'ok' : 'error', 'FINALIZE', 0, detail || '');
        return this.trace.close(outcome === 'done' ? 'ok' : outcome || 'error');
    }

    exportToUserData(userDataPath, prompt, summary) {
        if (!this._closed) this.trace.close();
        const record = { run_id: this.runId, steps: this.trace.steps, outcome: this.trace.outcome };
        const explanation = compileExplanation(record);
        try {
            generateReport(record, explanation, prompt, summary || '');
        } catch (e) { /* non-fatal */ }
        const bundleDir = path.join(userDataPath, 'ghosttrace', this.runId);
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.writeFileSync(path.join(bundleDir, 'pipeline_trace.json'), JSON.stringify(record, null, 2));
        return bundleDir;
    }

    /** Query in-memory trace steps for verify-phase diagnostics. */
    query(opts = {}) {
        const failuresOnly = opts.failuresOnly !== false;
        const toolFilter = opts.tool ? String(opts.tool).toLowerCase() : null;
        const lastN = Math.min(50, Math.max(1, parseInt(opts.lastN, 10) || 20));

        let steps = (this.trace.steps || []).slice();
        if (failuresOnly) {
            steps = steps.filter(s => s.status === 'error' || /fail|block|error/i.test(s.code || ''));
        }
        if (toolFilter) {
            steps = steps.filter(s => (s.tool || s.detail || '').toLowerCase().includes(toolFilter));
        }
        steps = steps.slice(-lastN);

        const summary = {
            total: this.trace.steps?.length || 0,
            returned: steps.length,
            failures: (this.trace.steps || []).filter(s => s.status === 'error').length,
            outcome: this.trace.outcome
        };

        return {
            steps: steps.map(s => ({
                stage: s.stage,
                status: s.status,
                code: s.code,
                tool: s.tool,
                detail: String(s.detail || '').slice(0, 500),
                ms: s.ms
            })),
            summary
        };
    }
}

module.exports = { CodeRunTrace };
