# GhostTrace Diagnostics System

GhostTrace is a project-agnostic, trace-first diagnostics system for Agent Smith. It ensures that every user-visible outcome can be reconstructed from a single ordered machine trace with stable stage and code pairs.

## Core Concepts

GhostTrace answers the following questions deterministically:
- What happened?
- Where did it fail?
- Why did it fail?
- What system layer failed first?
- What action would fix it?

It does this without relying on an LLM to guess the failure reason.

### Run Identity
Every workflow execution is assigned a `run_id`. All events, traces, and tool calls attach to this ID.

### The Diagnostics Registry
GhostTrace operates on a strict schema. Random string errors are not allowed.

**Allowed Layers:**
- `input`
- `routing`
- `context`
- `inference`
- `tools`
- `policy`
- `plugins`
- `storage`
- `output`
- `observability`

**Allowed Outcomes:**
- `ok`
- `skipped`
- `skipped_upstream`
- `error`
- `denied`
- `timeout`
- `aborted`

### First Failure Logic
GhostTrace calculates the `first_failure` automatically. Once a step fails (outcome is not `ok` or `skipped`), all subsequent steps are recorded as `skipped_upstream`. This prevents downstream symptoms from masking the actual root cause.

## CLI Usage

### Run a Test Scenario
To verify GhostTrace is working and see an example report:

```bash
node scripts/ghosttrace-cli.js run
```
This generates a mock trace and saves a report to `ghosttrace_outputs/`.

### Export a Debug Bundle
To export a full diagnostic bundle for a specific `run_id`:

```bash
node scripts/ghosttrace-cli.js export <run_id>
```
This creates a `.zip` file containing:
- `manifest.json`
- `pipeline_trace.json`
- `events.jsonl`
- `README.txt`

## Adding GhostTrace to Code

To trace a workflow, initialize a `PipelineTrace`:

```javascript
const { PipelineTrace, compileExplanation, generateReport } = require('../src/ghosttrace/index.js');

const trace = new PipelineTrace();

// Log successful step
trace.addStep('input.received', 'input', 'ok', 'INPUT_OK', 15);

// Log failed step
trace.addStep('inference.generate', 'inference', 'error', 'MODEL_OOM', 1200, 'Out of memory');

// Close and generate report
trace.close();
const explanation = compileExplanation(trace);
generateReport(trace, explanation, "my input prompt", "my output");
```

## Privacy & Security
GhostTrace automatically redacts standard secret formats (e.g., `ghp_...`, `sk-...`, `Bearer ...`) from the generated text reports to ensure safe sharing of diagnostic data.
