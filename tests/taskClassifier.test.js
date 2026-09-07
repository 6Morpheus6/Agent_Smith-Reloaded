const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreText, isCodingTask, routeMessage } = require('../src/shared/taskClassifier.js');

// --- Coding tasks → code mode -------------------------------------------------

test('detects classic project-build asks', () => {
    const coding = [
        'Build a todo app in Python with SQLite storage and tests',
        'Create a landing page using React and Tailwind',
        'Write a CLI tool that converts CSV files to JSON',
        'Implement a REST API server for user profiles in Node.js',
        'Make me a snake game with HTML, CSS and JavaScript',
        'Develop a Discord bot that posts weather updates',
        'Scaffold a new Django project for an internal dashboard'
    ];
    for (const t of coding) {
        assert.ok(isCodingTask(t), `expected CODE: "${t}" (score ${scoreText(t)})`);
    }
});

test('detects bug-fix / repo-maintenance asks', () => {
    const coding = [
        'Fix the null pointer exception in src/auth/login.js',
        'Debug why my Flask app crashes on startup — here is the stack trace',
        'Refactor the payment module to use dependency injection',
        'Update package.json to add a test script and run npm install',
        'Port this bash script to Python'
    ];
    for (const t of coding) {
        assert.ok(isCodingTask(t), `expected CODE: "${t}" (score ${scoreText(t)})`);
    }
});

// --- Chat / agent tasks → NOT code mode ----------------------------------------

test('plain chat stays out of code mode', () => {
    const chatting = [
        'Hey, how are you doing today?',
        'What is the meaning of life?',
        'Explain what a stack trace is in simple terms',
        'Summarize the plot of The Matrix in one paragraph',
        "Today's weather looks nice — do you think it'll rain?",
        'Remember that my birthday is on March 3rd'
    ];
    for (const t of chatting) {
        assert.ok(!isCodingTask(t), `expected AGENT: "${t}" (score ${scoreText(t)})`);
    }
});

test('ordinary agent tasks stay out of code mode', () => {
    const agentWork = [
        'Organize my Downloads folder — move pictures into Pictures and installers elsewhere',
        'Check how much disk space is left on the main drive',
        'What processes are running that use more than 50% CPU?',
        'Read /var/log/syslog and tell me what failed last night',
        'Download this file from https://example.com/setup.iso into my Downloads folder',
        'Translate "bonjour, comment ça va" to English'
    ];
    for (const t of agentWork) {
        assert.ok(!isCodingTask(t), `expected AGENT: "${t}" (score ${scoreText(t)})`);
    }
});

// --- routeMessage shape + overrides --------------------------------------------

test('routeMessage returns mode, prompt and override flag', () => {
    const r1 = routeMessage('Build me a snake game in JavaScript');
    assert.equal(r1.mode, 'code');
    assert.equal(r1.prompt, 'Build me a snake game in JavaScript');
    assert.equal(r1.override, false);

    const r2 = routeMessage('hello there');
    assert.equal(r2.mode, 'agent');
    assert.equal(r2.override, false);
});

test('code: and agent: prefixes force the route and are stripped', () => {
    // "fix my code" alone is NOT a build task — but the user said CODE.
    const r1 = routeMessage('code: fix my code');
    assert.equal(r1.mode, 'code');
    assert.equal(r1.prompt, 'fix my code');
    assert.equal(r1.override, true);

    // A genuine coding ask can be pulled back to chat with agent:.
    const r2 = routeMessage('agent: build a todo app in python (just explain the plan first)');
    assert.equal(r2.mode, 'agent');
    assert.ok(r2.prompt.startsWith('build a todo app'));
    assert.equal(r2.override, true);

    // Slash-tolerant and case-insensitive.
    assert.equal(routeMessage('/Code: make a web page').mode, 'code');
    assert.equal(routeMessage('/CODE: make a web page').prompt, 'make a web page');
});

test('route tokens are not stripped from mid-sentence mentions', () => {
    const r = routeMessage('the agent: architecture diagram looks off');
    // "agent:" only counts at the start of the message.
    assert.equal(r.override, false);
    assert.equal(r.prompt, 'the agent: architecture diagram looks off');
});

test('empty and null input routes to agent (chat)', () => {
    assert.equal(routeMessage('').mode, 'agent');
    assert.equal(routeMessage(null).mode, 'agent');
});

// --- Scoring sanity ------------------------------------------------------------

test('scoreText is deterministic and bounded', () => {
    const a = scoreText('Build a web app in Python with tests');
    const b = scoreText('Build a web app in Python with tests');
    assert.equal(a, b);
    assert.ok(a >= 0 && a <= 20, `score out of sane range: ${a}`);
});
