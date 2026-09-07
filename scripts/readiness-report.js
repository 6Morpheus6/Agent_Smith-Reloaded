#!/usr/bin/env node
'use strict';

const path = require('path');
const { scoreReadiness } = require('../src/code/governor/readiness.js');

const root = process.argv[2] || process.cwd();
const r = scoreReadiness(path.resolve(root));

console.log(`Readiness: ${r.score}/${r.maxScore}\n`);
for (const p of r.pillars) {
    console.log(`  ${p.name}: ${p.score}/5 — ${p.note}`);
}
if (r.recommendations.length) {
    console.log('\nRecommendations:');
    r.recommendations.forEach(rec => console.log(`  - ${rec}`));
}
process.exit(r.score >= r.maxScore * 0.5 ? 0 : 1);
