const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

let GHOSTTRACE_DIR, OUTPUTS_DIR;

if (__dirname.includes('app.asar')) {
    const userData = path.join(os.homedir(), '.config', 'Agent Smith');
    GHOSTTRACE_DIR = path.join(userData, 'ghosttrace');
    OUTPUTS_DIR = path.join(userData, 'ghosttrace_outputs');
} else {
    GHOSTTRACE_DIR = path.join(__dirname, '..', 'data', 'ghosttrace');
    OUTPUTS_DIR = path.join(__dirname, '..', '..', 'ghosttrace_outputs');
}

const TRACES_FILE = path.join(GHOSTTRACE_DIR, 'pipeline_traces.jsonl');
const EVENTS_FILE = path.join(GHOSTTRACE_DIR, 'events.jsonl');
const RUN_BUNDLES_DIR = path.join(GHOSTTRACE_DIR, 'run_bundles');

// Make sure dirs exist (wrapped in try-catch to prevent fatal startup crashes)
try {
    [GHOSTTRACE_DIR, RUN_BUNDLES_DIR, OUTPUTS_DIR].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
} catch (e) {
    console.error('[GhostTrace] Directory init failed, running degraded:', e.message);
}

const ALLOWED_LAYERS = new Set([
    'input', 'routing', 'context', 'inference', 'tools', 'policy', 'verify', 'plugins', 'storage', 'output', 'observability'
]);

const ALLOWED_STAGES = new Set([
    'input.received', 'context.loaded', 'routing.selected_capability', 'inference.generate',
    'tools.execute', 'policy.check', 'verify.gate', 'verify.blocked', 'plugins.health', 'storage.write', 'output.finalize'
]);

const ALLOWED_OUTCOMES = new Set([
    'ok', 'skipped', 'skipped_upstream', 'error', 'denied', 'timeout', 'aborted'
]);

function generateId() {
    return 'gt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
}

class PipelineTrace {
    constructor(run_id = null, parent_run_id = null, request_id = null) {
        this.schema_version = '1.0';
        this.run_id = run_id || generateId();
        this.parent_run_id = parent_run_id;
        this.request_id = request_id;
        this.started_at = new Date().toISOString();
        this.closed_at = null;
        this.outcome = null;
        this.first_failure = null;
        this.steps = [];
        this._failed = false;
    }

    addStep(stage, layer, outcome, code, duration_ms, detail = "", related_resource = null) {
        if (!ALLOWED_STAGES.has(stage)) throw new Error(`Unregistered stage: ${stage}`);
        if (!ALLOWED_LAYERS.has(layer)) throw new Error(`Unregistered layer: ${layer}`);
        if (!ALLOWED_OUTCOMES.has(outcome)) throw new Error(`Unregistered outcome: ${outcome}`);

        // if we already failed, force skipped_upstream unless it's observability/output
        if (this._failed && outcome !== 'skipped_upstream' && layer !== 'output' && layer !== 'observability') {
            outcome = 'skipped_upstream';
            code = 'BLOCKED_BY_UPSTREAM_FAILURE';
        }

        const step = {
            stage,
            layer,
            outcome,
            code,
            duration_ms,
            detail,
            related_resource
        };

        this.steps.push(step);

        if (outcome !== 'ok' && outcome !== 'skipped' && outcome !== 'skipped_upstream' && !this.first_failure) {
            this.first_failure = step;
            this._failed = true;
            this.outcome = 'error'; // aggregate outcome
        }

        // log event
        fs.appendFileSync(EVENTS_FILE, JSON.stringify({ run_id: this.run_id, timestamp: new Date().toISOString(), ...step }) + '\n');
    }

    close(final_outcome = null) {
        this.closed_at = new Date().toISOString();
        if (!this.outcome) {
            this.outcome = final_outcome || 'ok';
        }
        
        const traceRecord = {
            schema_version: this.schema_version,
            run_id: this.run_id,
            parent_run_id: this.parent_run_id,
            request_id: this.request_id,
            started_at: this.started_at,
            closed_at: this.closed_at,
            outcome: this.outcome,
            first_failure: this.first_failure,
            steps: this.steps
        };

        fs.appendFileSync(TRACES_FILE, JSON.stringify(traceRecord) + '\n');
        return traceRecord;
    }
}

function compileExplanation(trace) {
    if (!trace.first_failure) {
        return {
            summary: "Run completed successfully.",
            failed_layer: null,
            failed_stage: null,
            stable_code: "OK",
            likely_cause: "No errors detected.",
            suggested_fix: "None required."
        };
    }

    const ff = trace.first_failure;
    let cause = "Unknown error occurred.";
    let fix = "Check system logs for details.";

    if (ff.layer === 'input') {
        cause = "Input validation or receiving failed.";
        fix = "Ensure the input format is correct and not empty.";
    } else if (ff.layer === 'context') {
        cause = "Failed to load required context or memory.";
        fix = "Check vector database connectivity and permissions.";
    } else if (ff.layer === 'routing') {
        cause = "Could not select an appropriate capability or model.";
        fix = "Verify model availability and routing rules.";
    } else if (ff.layer === 'inference') {
        cause = "The AI model failed to generate a response.";
        fix = "Check Ollama/LMS status and VRAM capacity.";
    } else if (ff.layer === 'tools') {
        cause = `Tool execution failed: ${ff.related_resource || 'unknown'}`;
        fix = "Verify tool parameters and external service health.";
    } else if (ff.layer === 'policy') {
        cause = "Action was denied by safety or guardrail policy.";
        fix = "Review the input against allowed policies.";
    } else if (ff.layer === 'plugins') {
        cause = "A required plugin was unhealthy or failed.";
        fix = "Check plugin configuration and connectivity.";
    } else if (ff.layer === 'storage') {
        cause = "Failed to write or read from storage.";
        fix = "Check disk space and file permissions.";
    }

    if (ff.detail) {
        cause += ` Details: ${ff.detail}`;
    }

    return {
        summary: `Run failed during the '${ff.stage}' stage in the '${ff.layer}' layer.`,
        failed_layer: ff.layer,
        failed_stage: ff.stage,
        stable_code: ff.code,
        likely_cause: cause,
        suggested_fix: fix
    };
}

function generateReport(trace, explanation, prompt = "", final_output = "") {
    // Redact secrets
    const redact = (str) => {
        if (!str) return "";
        return str.replace(/(ghp_|sk-|Bearer\s)[a-zA-Z0-9_\-]+/gi, '[REDACTED_SECRET]');
    };

    let report = `=== GhostTrace Diagnostic Report ===\n`;
    report += `Run ID: ${trace.run_id}\n`;
    report += `Outcome: ${trace.outcome}\n`;
    report += `Started: ${trace.started_at}\n`;
    report += `Closed: ${trace.closed_at}\n\n`;

    report += `--- Input ---\n${redact(prompt)}\n\n`;
    
    report += `--- Explanation ---\n`;
    report += `Summary: ${explanation.summary}\n`;
    report += `Failed Layer: ${explanation.failed_layer || 'N/A'}\n`;
    report += `Failed Stage: ${explanation.failed_stage || 'N/A'}\n`;
    report += `Stable Code: ${explanation.stable_code}\n`;
    report += `Likely Cause: ${redact(explanation.likely_cause)}\n`;
    report += `Suggested Fix: ${explanation.suggested_fix}\n\n`;

    report += `--- Execution Trace ---\n`;
    trace.steps.forEach((step, i) => {
        report += `${i+1}. [${step.layer}] ${step.stage} -> ${step.outcome} (${step.code}) | ${step.duration_ms}ms\n`;
    });

    report += `\n--- Final Output ---\n${redact(final_output)}\n`;

    const reportPath = path.join(OUTPUTS_DIR, `ghosttrace_run_${trace.run_id}.txt`);
    fs.writeFileSync(reportPath, report);
    return reportPath;
}

function exportBundle(run_id) {
    const bundleDir = path.join(RUN_BUNDLES_DIR, run_id);
    fs.mkdirSync(bundleDir, { recursive: true });

    let trace;
    if (fs.existsSync(TRACES_FILE)) {
        const traces = fs.readFileSync(TRACES_FILE, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
        trace = traces.find(t => t.run_id === run_id);
    }
    
    if (!trace) throw new Error(`Run ID ${run_id} not found.`);

    fs.writeFileSync(path.join(bundleDir, 'pipeline_trace.json'), JSON.stringify(trace, null, 2));

    if (fs.existsSync(EVENTS_FILE)) {
        const events = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
        const runEvents = events.filter(e => e.run_id === run_id);
        fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), runEvents.map(e => JSON.stringify(e)).join('\n'));
    }

    const manifest = {
        exported_at: new Date().toISOString(),
        run_id: run_id,
        version: "1.0"
    };
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const readme = `GhostTrace Debug Bundle for ${run_id}\n\npipeline_trace.json contains the structured run trace.\nevents.jsonl contains raw events.\n`;
    fs.writeFileSync(path.join(bundleDir, 'README.txt'), readme);

    const zipPath = path.join(OUTPUTS_DIR, `ghosttrace_run_${run_id}.zip`);
    execSync(`cd "${RUN_BUNDLES_DIR}" && python3 -m zipfile -c "${zipPath}" "${run_id}"`);
    
    fs.rmSync(bundleDir, { recursive: true, force: true });
    
    return zipPath;
}

function runScenario() {
    const trace = new PipelineTrace();
    
    trace.addStep('input.received', 'input', 'ok', 'INPUT_OK', 10);
    trace.addStep('context.loaded', 'context', 'ok', 'CTX_OK', 50);
    trace.addStep('inference.generate', 'inference', 'error', 'MODEL_OOM', 1200, 'CUDA out of memory ghp_secretTokenHere123');
    trace.addStep('tools.execute', 'tools', 'ok', 'TOOL_OK', 0);
    
    trace.close();
    
    const explanation = compileExplanation(trace);
    const reportPath = generateReport(trace, explanation, "test prompt with sk-12345 secret", "failed to output");
    
    console.log(`Diagnostic scenario run complete. Report saved to: ${reportPath}`);
}

module.exports = {
    PipelineTrace,
    compileExplanation,
    generateReport,
    exportBundle,
    runScenario
};