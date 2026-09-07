#!/usr/bin/env node
/**
 * GhostTrace diagnostics CLI — peripheral to the Build Mode loop.
 * Usage: node scripts/ghosttrace-cli.js run
 *        node scripts/ghosttrace-cli.js export <run_id>
 */
const ghosttrace = require('../src/ghosttrace/index.js');

const args = process.argv.slice(2);
if (args[0] === 'run') {
    ghosttrace.runScenario();
} else if (args[0] === 'export' && args[1]) {
    const zipPath = ghosttrace.exportBundle(args[1]);
    console.log(`Exported bundle to: ${zipPath}`);
} else {
    console.log('Usage: node scripts/ghosttrace-cli.js [run | export <run_id>]');
    process.exit(1);
}
