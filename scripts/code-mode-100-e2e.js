#!/usr/bin/env node
/**
 * Code Mode — Top-100 Coding-Task Battery (E2E).
 *
 * "Code Mode" = the app's full-project autonomous coding agent: planning phase,
 * multi-turn edit/verify loop, edit engine, completion gate, quality monitor.
 * This battery exercises it across 100 real coding tasks in 10 categories, each
 * judged by deterministic SIDE EFFECTS — does the produced code exist, is it valid,
 * and (where applicable) does running it yield the expected output / pass a test.
 *
 * Faithful to the shipping app — drives the REAL Code Mode entry point:
 *   - runCodeTask() (src/code/loop/runCodeTask.js) — same call shape as ipc/code.js
 *   - real buildExecDeps (file ops via editEngine, run_command via child_process)
 *   - real planning phase, turn loop, governors, gemma adaptation, streamCompletion
 *   - real LM Studio backend (OpenAI /v1/chat/completions streaming)
 *
 * Usage:
 *   LMS_URL=http://127.0.0.1:1234 node scripts/code-mode-100-e2e.js [model-id]
 * Env:
 *   CATS=CA,CB     only these categories     ONLY=CA1,CC3  only these task ids
 *   SMOKE=1        first task of each category
 *   MAXTURNS=14    per-task turn cap (default 14)
 *   OUT=path.json  machine-readable results
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const projectContext = require(path.join(ROOT, 'src/main/services/projectContext.js'));
const ChangeLedger = require(path.join(ROOT, 'src/main/services/changeLedger.js'));
const EditEngine = require(path.join(ROOT, 'src/main/services/editEngine.js'));
const { grepProject } = require(path.join(ROOT, 'src/shared/grepTool.js'));
const { globFiles } = require(path.join(ROOT, 'src/shared/globTool.js'));
const { runCodeTask } = require(path.join(ROOT, 'src/code/loop/runCodeTask.js'));

const LMS = process.env.LMS_URL || 'http://127.0.0.1:1234';

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'code100-data-'));
const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);

// --- Faithful buildExecDeps (mirror of src/main/ipc/code.js) ----------------
const bgProcesses = new Map();
let nextJobId = 1;
function spawnShell(command, cwd) {
    const cfg = projectContext.getShellConfig();
    if (projectContext.isWindows()) return spawn(cfg.shell, [cfg.flag, cfg.commandFlag, command], { cwd, shell: false });
    return spawn(cfg.shell, [cfg.flag, command], { cwd });
}
function buildExecDeps(sessionId) {
    return {
        sessionId, projectContext, editEngine, changeLedger, grepProject, globFiles,
        relPathFromRoot: (p) => { const r = projectContext.getRootOrNull(); return r ? path.relative(r, p) : p; },
        fireHook: async () => null,
        invokePluginTool: async () => ({ __notFound: true }),
        showPreview: null,
        browserVerify: null,
        runForegroundCommand: (command, cwd) => new Promise((resolve) => {
            exec(command, { cwd, timeout: 120000 }, (error, stdout, stderr) =>
                resolve({ error: error ? error.message : null, stdout: stdout || '', stderr: stderr || '' }));
        }),
        runBackgroundCommand: (command, cwd) => {
            const jobId = nextJobId++;
            const child = spawnShell(command, cwd);
            const procInfo = { log: [], running: true };
            bgProcesses.set(jobId, procInfo);
            const append = (d) => { procInfo.log.push(...d.toString().split('\n').filter(Boolean)); if (procInfo.log.length > 500) procInfo.log = procInfo.log.slice(-500); };
            child.stdout?.on('data', append); child.stderr?.on('data', append);
            child.on('close', (code) => { procInfo.log.push(`[exit ${code}]`); procInfo.running = false; });
            return { stdout: `Background job ${jobId} started`, jobId };
        },
    };
}

async function runCode({ model, prompt, projectRoot, maxTurns }) {
    const events = [];
    let session;
    try {
        session = await runCodeTask({
            prompt, projectRoot, model, numCtx: 8192, apiBaseUrl: LMS,
            userDataPath, projectContext, buildExecDeps,
            emit: (ev) => events.push(ev),
            maxTurns, codeTemperature: 0.2, grindMode: true,
        });
    } catch (e) {
        return { status: 'crash', why: e.message, events, turns: 0 };
    }
    const toolEvents = events.filter(e => e.type === 'tool_result' || e.type === 'tool_call');
    const tools = events.filter(e => e.type === 'tool_call').map(e => e.name || e.tool).filter(Boolean);
    return { status: session?.status || 'unknown', turns: session?.turn || 0, tools, events, session };
}

// --- check helpers ----------------------------------------------------------
let WS = null;
const W = (rel) => path.join(WS, rel);
const read = (rel) => { try { return fs.readFileSync(W(rel), 'utf8'); } catch { return null; } };
const exists = (rel) => fs.existsSync(W(rel));
function* walk(dir) { let e = []; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const d of e) { const p = path.join(dir, d.name); if (d.isDirectory()) yield* walk(p); else yield p; } }
// read any file under WS matching a name regex (agent may pick its own filename)
const findByName = (re) => { for (const f of walk(WS)) if (re.test(path.basename(f))) { try { return fs.readFileSync(f, 'utf8'); } catch {} } return null; };
const anyContent = (re) => { for (const f of walk(WS)) { try { if (re.test(fs.readFileSync(f, 'utf8'))) return true; } catch {} } return false; };
const fileFor = (re) => { for (const f of walk(WS)) if (re.test(path.basename(f))) return f; return null; };
// run a produced node/python file and return stdout (empty string on failure)
function runFile(absPath, runner, args = '') {
    if (!absPath) return { ok: false, out: '' };
    try { const out = execSync(`${runner} "${absPath}" ${args}`, { cwd: WS, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true, out }; }
    catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
}
const runNode = (re, args) => runFile(fileFor(re), 'node', args);
const runPy = (re, args) => runFile(fileFor(re), 'python3', args);

// =====================================================================
//  THE 100 CODE-MODE TASKS
// =====================================================================
function makeTasks() {
    const T = [];
    const add = (id, cat, title, def) => T.push(Object.assign({ id, cat, title }, def));
    const seed = (files) => () => { for (const [rel, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(W(rel)), { recursive: true }); fs.writeFileSync(W(rel), content); } };

    // ---- CA. Greenfield single-file programs (10) ----
    add('CA1', 'CA', 'Factorial program', { prompt: 'Create a Node.js program factorial.js that defines a factorial function and prints factorial(5), which should output 120. Then run it to confirm.', check: () => /120/.test(runNode(/factorial\.js$/).out) || /factorial/i.test(read('factorial.js') || '') && /120|n \* factorial|n\*factorial|reduce/.test(read('factorial.js') || '') });
    add('CA2', 'CA', 'FizzBuzz', { prompt: 'Create fizzbuzz.js that prints FizzBuzz for numbers 1 to 15 (Fizz for multiples of 3, Buzz for 5, FizzBuzz for both, otherwise the number). Run it.', check: () => { const o = runNode(/fizzbuzz\.js$/).out; return /Fizz/.test(o) && /Buzz/.test(o) && /FizzBuzz/.test(o); } });
    add('CA3', 'CA', 'Prime checker', { prompt: 'Create prime.js that defines isPrime(n) and prints whether 17 is prime (should print true) and whether 18 is prime (false). Run it.', check: () => { const o = runNode(/prime\.js$/).out.toLowerCase(); return /true/.test(o) && /false/.test(o); } });
    add('CA4', 'CA', 'Palindrome', { prompt: 'Create palindrome.js with a function that checks if a string is a palindrome, and print the result for "racecar" (true) and "hello" (false). Run it.', check: () => { const o = runNode(/palindrome\.js$/).out.toLowerCase(); return /true/.test(o) && /false/.test(o); } });
    add('CA5', 'CA', 'Fibonacci', { prompt: 'Create fib.js that prints the 10th Fibonacci number where fib(1)=1, fib(2)=1 (so the 10th is 55). Run it.', check: () => /55/.test(runNode(/fib\.js$/).out) });
    add('CA6', 'CA', 'Bubble sort', { prompt: 'Create sort.js that bubble-sorts the array [5,2,8,1,9,3] ascending and prints the sorted array. Run it.', check: () => { const o = runNode(/sort\.js$/).out; return /1.*2.*3.*5.*8.*9/.test(o.replace(/\s+/g, '')); } });
    add('CA7', 'CA', 'Reverse a string', { prompt: 'Create reverse.js that reverses the string "matrix" and prints it (should print "xirtam"). Run it.', check: () => /xirtam/.test(runNode(/reverse\.js$/).out) });
    add('CA8', 'CA', 'GCD', { prompt: 'Create gcd.js that computes the greatest common divisor of 48 and 36 (should be 12) and prints it. Run it.', check: () => /\b12\b/.test(runNode(/gcd\.js$/).out) });
    add('CA9', 'CA', 'Temperature converter CLI', { prompt: 'Create a Node CLI temp.js that reads a Celsius value from process.argv[2] and prints the Fahrenheit equivalent. Running `node temp.js 100` must print 212.', check: () => /212/.test(runNode(/temp\.js$/, '100').out) });
    add('CA10', 'CA', 'Word counter CLI', { prompt: 'Create wc.js that counts the words in the string "the quick brown fox" and prints 4. Run it.', check: () => /\b4\b/.test(runNode(/wc\.js$/).out) });

    // ---- CB. Algorithms & data structures (10) ----
    add('CB1', 'CB', 'Binary search', { prompt: 'Create bsearch.js with a binarySearch(arr,target) function. On the sorted array [1,3,5,7,9,11] searching for 7 it should print the index 3. Run it.', check: () => /\b3\b/.test(runNode(/bsearch\.js$/).out) });
    add('CB2', 'CB', 'Quicksort', { prompt: 'Create quicksort.js that quicksorts [9,4,7,1,5,3] ascending and prints the result. Run it.', check: () => /1.*3.*4.*5.*7.*9/.test(runNode(/quicksort\.js$/).out.replace(/\s+/g, '')) });
    add('CB3', 'CB', 'Linked list', { prompt: 'Create linkedlist.js implementing a singly linked list with append and toArray. Append 1,2,3 and print toArray() -> [1,2,3]. Run it.', check: () => /1.*2.*3/.test(runNode(/linkedlist\.js$/).out.replace(/\s+/g, '')) });
    add('CB4', 'CB', 'Stack', { prompt: 'Create stack.js implementing a Stack class (push/pop/peek). Push 1,2,3, pop once, then print peek() which should be 2. Run it.', check: () => /\b2\b/.test(runNode(/stack\.js$/).out) });
    add('CB5', 'CB', 'Queue', { prompt: 'Create queue.js implementing a Queue (enqueue/dequeue). Enqueue 1,2,3, dequeue once, print the dequeued value 1. Run it.', check: () => /\b1\b/.test(runNode(/queue\.js$/).out) });
    add('CB6', 'CB', 'BFS on a graph', { prompt: 'Create bfs.js that does a breadth-first traversal from node A on the graph {A:[B,C], B:[D], C:[D], D:[]} and prints the visit order starting with A. Run it.', check: () => { const o = runNode(/bfs\.js$/).out; return /A/.test(o) && /D/.test(o) && o.indexOf('A') < o.indexOf('D'); } });
    add('CB7', 'CB', 'Hashmap word frequency', { prompt: 'Create freq.js that counts word frequency in "a b a c a b" using an object/Map and prints the count for "a" which is 3. Run it.', check: () => /\b3\b/.test(runNode(/freq\.js$/).out) });
    add('CB8', 'CB', 'LRU cache', { prompt: 'Create lru.js implementing an LRU cache with capacity 2. Put(1,1), put(2,2), get(1), put(3,3) which evicts key 2, then get(2) should print -1 (miss). Run it.', check: () => /-1/.test(runNode(/lru\.js$/).out) });
    add('CB9', 'CB', 'Merge sort', { prompt: 'Create mergesort.js that merge-sorts [4,1,3,2,5] ascending and prints it. Run it.', check: () => /1.*2.*3.*4.*5/.test(runNode(/mergesort\.js$/).out.replace(/\s+/g, '')) });
    add('CB10', 'CB', 'Anagram check', { prompt: 'Create anagram.js with isAnagram(a,b). Print whether "listen" and "silent" are anagrams (true) and "foo"/"bar" (false). Run it.', check: () => { const o = runNode(/anagram\.js$/).out.toLowerCase(); return /true/.test(o) && /false/.test(o); } });

    // ---- CC. Bug fixing (10) — seed a buggy file, must fix ----
    add('CC1', 'CC', 'Fix off-by-one in sum', { setup: seed({ 'sum.js': 'function sumTo(n){let s=0;for(let i=1;i<n;i++)s+=i;return s;}\nconsole.log(sumTo(5));\n' }), prompt: 'sum.js is supposed to print the sum 1+2+3+4+5 = 15 but it prints the wrong number due to an off-by-one bug in the loop. Fix it so it prints 15. Run it to confirm.', check: () => /\b15\b/.test(runNode(/sum\.js$/).out) });
    add('CC2', 'CC', 'Fix wrong operator', { setup: seed({ 'calc.js': 'function area(w,h){return w+h;}\nconsole.log(area(4,5));\n' }), prompt: 'calc.js should compute the area of a rectangle (width*height) and print 20 for area(4,5), but it uses the wrong operator. Fix it so it prints 20. Run it.', check: () => /\b20\b/.test(runNode(/calc\.js$/).out) });
    add('CC3', 'CC', 'Fix null/undefined guard', { setup: seed({ 'greet.js': 'function greet(name){return "Hello "+name.toUpperCase();}\nconsole.log(greet());\n' }), prompt: 'greet.js crashes with a TypeError when called with no name. Fix it so calling greet() with no argument does not crash and prints a sensible greeting. Run it to confirm no error.', check: () => runNode(/greet\.js$/).ok });
    add('CC4', 'CC', 'Fix infinite loop', { setup: seed({ 'count.js': 'let i=0;while(i<5){console.log(i);}\n' }), prompt: 'count.js has an infinite loop — it never increments i. Fix it so it prints 0 through 4 and terminates. Run it.', check: () => { const r = runNode(/count\.js$/); return r.ok && /0/.test(r.out) && /4/.test(r.out); } });
    add('CC5', 'CC', 'Fix wrong return value', { setup: seed({ 'max.js': 'function max(a,b){return a;}\nconsole.log(max(3,9));\n' }), prompt: 'max.js should return the larger of two numbers and print 9 for max(3,9), but it always returns the first. Fix it. Run it.', check: () => /\b9\b/.test(runNode(/max\.js$/).out) });
    add('CC6', 'CC', 'Fix array index bug', { setup: seed({ 'last.js': 'function last(arr){return arr[arr.length];}\nconsole.log(last([10,20,30]));\n' }), prompt: 'last.js should print the last element of the array (30) but prints undefined due to an index bug. Fix it. Run it.', check: () => /\b30\b/.test(runNode(/last\.js$/).out) });
    add('CC7', 'CC', 'Fix string concatenation type bug', { setup: seed({ 'add.js': 'function add(a,b){return a+b;}\nconsole.log(add("2","3"));\n' }), prompt: 'add.js prints "23" instead of the numeric sum 5 because the inputs are strings. Fix add so it returns the numeric sum and prints 5. Run it.', check: () => /(^|[^\d])5([^\d]|$)/.test(runNode(/add\.js$/).out.trim()) });
    add('CC8', 'CC', 'Fix syntax error', { setup: seed({ 'broken.js': 'function f( {\n  return 42;\n}\nconsole.log(f());\n' }), prompt: 'broken.js has a syntax error (malformed function parentheses). Fix it so it prints 42. Run it.', check: () => /\b42\b/.test(runNode(/broken\.js$/).out) });
    add('CC9', 'CC', 'Fix wrong comparison', { setup: seed({ 'even.js': 'function isEven(n){return n%2==1;}\nconsole.log(isEven(4));\n' }), prompt: 'even.js incorrectly reports isEven(4) as false because the modulo comparison is wrong. Fix it so isEven(4) prints true. Run it.', check: () => /true/i.test(runNode(/even\.js$/).out) });
    add('CC10', 'CC', 'Fix logic in filter', { setup: seed({ 'pos.js': 'const nums=[-2,3,-1,5,0];\nconst pos=nums.filter(n=>n<0);\nconsole.log(pos.join(","));\n' }), prompt: 'pos.js is meant to keep the POSITIVE numbers (3 and 5) but the filter condition is inverted. Fix it so it prints "3,5". Run it.', check: () => /3,5/.test(runNode(/pos\.js$/).out) });

    // ---- CD. Refactoring (behavior-preserving) (10) ----
    add('CD1', 'CD', 'Extract a function', { setup: seed({ 'app.js': 'console.log((2*3.14159*5).toFixed(2));\nconsole.log((2*3.14159*10).toFixed(2));\n' }), prompt: 'Refactor app.js to extract a reusable circumference(r) function (2*PI*r) and use it for r=5 and r=10. It must still print 31.42 and 62.83. Run it.', check: () => { const o = runNode(/app\.js$/).out; return /31\.42/.test(o) && /62\.83/.test(o) && /function|=>/.test(read(path.basename(fileFor(/app\.js$/) || 'app.js')) || ''); } });
    add('CD2', 'CD', 'Remove duplication', { setup: seed({ 'dup.js': 'function a(){return "hi ".repeat(3).trim();}\nfunction b(){return "hi ".repeat(3).trim();}\nconsole.log(a(),b());\n' }), prompt: 'dup.js has two identical functions a and b. Refactor to remove the duplication (have one shared implementation) while still printing "hi hi hi hi hi hi". Run it.', check: () => /hi hi hi hi hi hi/.test(runNode(/dup\.js$/).out) });
    add('CD3', 'CD', 'var to const/let', { setup: seed({ 'vars.js': 'var x = 1;\nvar y = 2;\nvar z = x + y;\nconsole.log(z);\n' }), prompt: 'Modernize vars.js by replacing all var declarations with const (or let where reassigned). It must still print 3, and contain no `var`. Run it.', check: () => /\b3\b/.test(runNode(/vars\.js$/).out) && !/\bvar\b/.test(read(path.basename(fileFor(/vars\.js$/) || 'vars.js')) || 'var') });
    add('CD4', 'CD', 'Callback to Promise', { setup: seed({ 'cb.js': 'function getData(cb){setTimeout(()=>cb(null,42),10);}\ngetData((e,v)=>console.log(v));\n' }), prompt: 'Refactor cb.js so getData returns a Promise instead of taking a callback, and use async/await or .then to print 42. Run it.', check: () => /\b42\b/.test(runNode(/cb\.js$/).out) && /Promise|async|await|then/.test(read(path.basename(fileFor(/cb\.js$/) || 'cb.js')) || '') });
    add('CD5', 'CD', 'Simplify nested conditionals', { setup: seed({ 'grade.js': 'function grade(s){if(s>=90){return "A";}else{if(s>=80){return "B";}else{return "C";}}}\nconsole.log(grade(85));\n' }), prompt: 'Refactor grade.js to simplify the nested if/else (e.g. early returns or a cleaner structure) while preserving behavior: grade(85) must still print B. Run it.', check: () => /\bB\b/.test(runNode(/grade\.js$/).out) });
    add('CD6', 'CD', 'Split into modules', { setup: seed({ 'mono.js': 'function add(a,b){return a+b;}\nfunction sub(a,b){return a-b;}\nconsole.log(add(2,3), sub(5,1));\n' }), prompt: 'Refactor mono.js by moving add and sub into a separate module file (e.g. mathlib.js) that mono.js requires. Running mono.js must still print "5 4". Run it.', check: () => /5 4/.test(runNode(/mono\.js$/).out) });
    add('CD7', 'CD', 'Add input validation', { setup: seed({ 'div.js': 'function divide(a,b){return a/b;}\nconsole.log(divide(10,2));\n' }), prompt: 'Refactor div.js so divide throws or returns an error message when dividing by zero, but still prints 5 for divide(10,2). Run it.', check: () => /\b5\b/.test(runNode(/div\.js$/).out) && /(=== ?0|== ?0|b ?=== ?0|zero|Error|throw)/.test(read(path.basename(fileFor(/div\.js$/) || 'div.js')) || '') });
    add('CD8', 'CD', 'Use array method instead of loop', { setup: seed({ 'double.js': 'const a=[1,2,3];const out=[];for(let i=0;i<a.length;i++){out.push(a[i]*2);}console.log(out.join(","));\n' }), prompt: 'Refactor double.js to use Array.map instead of the manual for-loop. It must still print "2,4,6". Run it.', check: () => /2,4,6/.test(runNode(/double\.js$/).out) && /\.map\(/.test(read(path.basename(fileFor(/double\.js$/) || 'double.js')) || '') });
    add('CD9', 'CD', 'Rename a misleading variable', { setup: seed({ 'temp.js': 'const x = 98.6;\nconsole.log("Body temp is " + x);\n' }), prompt: 'Refactor temp.js to rename the unclear variable x to bodyTempF everywhere. Output must be unchanged ("Body temp is 98.6"). Run it.', check: () => /Body temp is 98\.6/.test(runNode(/temp\.js$/).out) && /bodyTempF/.test(read(path.basename(fileFor(/temp\.js$/) || 'temp.js')) || '') });
    add('CD10', 'CD', 'Convert function to arrow + default param', { setup: seed({ 'pow.js': 'function power(base, exp){return Math.pow(base, exp);}\nconsole.log(power(2));\n' }), prompt: 'Refactor pow.js: convert power to an arrow function with a default exponent of 2, so power(2) prints 4. Run it.', check: () => /\b4\b/.test(runNode(/pow\.js$/).out) });

    // ---- CE. Adding features to existing code (10) ----
    add('CE1', 'CE', 'Add a CLI flag', { setup: seed({ 'cli.js': 'console.log("hello");\n' }), prompt: 'Extend cli.js so that when run with a --upper flag it prints "HELLO" (uppercase), otherwise "hello". Running `node cli.js --upper` must print HELLO. Run it.', check: () => /HELLO/.test(runNode(/cli\.js$/, '--upper').out) });
    add('CE2', 'CE', 'Add a method to a class', { setup: seed({ 'rect.js': 'class Rect{constructor(w,h){this.w=w;this.h=h;}area(){return this.w*this.h;}}\nconst r=new Rect(3,4);\nconsole.log(r.area());\n' }), prompt: 'Add a perimeter() method to the Rect class in rect.js (2*(w+h)) and print both area (12) and perimeter (14) for a 3x4 rectangle. Run it.', check: () => { const o = runNode(/rect\.js$/).out; return /12/.test(o) && /14/.test(o); } });
    add('CE3', 'CE', 'Add error handling', { setup: seed({ 'parse.js': 'function parse(s){return JSON.parse(s);}\nconsole.log(parse("{\\"ok\\":1}").ok);\n' }), prompt: 'Wrap the JSON.parse in parse.js with try/catch so invalid JSON returns null instead of throwing. parse(\'{"ok":1}\').ok must still print 1. Run it.', check: () => /\b1\b/.test(runNode(/parse\.js$/).out) && /(try|catch)/.test(read(path.basename(fileFor(/parse\.js$/) || 'parse.js')) || '') });
    add('CE4', 'CE', 'Add a config option', { setup: seed({ 'log.js': 'function log(msg){console.log("[INFO] "+msg);}\nlog("starting");\n' }), prompt: 'Extend log.js so log(msg, level) accepts an optional level (default "INFO") and prefixes accordingly. Call log("oops","ERROR") so it prints "[ERROR] oops". Run it.', check: () => /\[ERROR\] oops/.test(runNode(/log\.js$/).out) });
    add('CE5', 'CE', 'Add a new field', { setup: seed({ 'user.js': 'function makeUser(name){return {name};}\nconsole.log(JSON.stringify(makeUser("Ada")));\n' }), prompt: 'Extend makeUser in user.js to also accept and include an email field. Call makeUser("Ada","ada@x.com") and print JSON containing both name and email. Run it.', check: () => { const o = runNode(/user\.js$/).out; return /Ada/.test(o) && /ada@x\.com/.test(o); } });
    add('CE6', 'CE', 'Add filtering', { setup: seed({ 'items.js': 'const items=[{n:"a",price:5},{n:"b",price:15},{n:"c",price:8}];\nconsole.log(items.length);\n' }), prompt: 'Extend items.js to print only the names of items priced under 10 (a and c), comma-separated. Run it.', check: () => { const o = runNode(/items\.js$/).out; return /a/.test(o) && /c/.test(o) && !/\bb\b/.test(o.replace(/items/g, '')); } });
    add('CE7', 'CE', 'Add sorting', { setup: seed({ 'names.js': 'const names=["Charlie","Alice","Bob"];\nconsole.log(names.join(","));\n' }), prompt: 'Extend names.js to sort the names alphabetically before printing, so it prints "Alice,Bob,Charlie". Run it.', check: () => /Alice,Bob,Charlie/.test(runNode(/names\.js$/).out) });
    add('CE8', 'CE', 'Add a counter/state', { setup: seed({ 'counter.js': 'function makeCounter(){let c=0;return ()=>c;}\nconst inc=makeCounter();\nconsole.log(inc());\n' }), prompt: 'Fix/extend makeCounter in counter.js so each call to the returned function increments and returns the count. Call it three times and print 1, then 2, then 3. Run it.', check: () => { const o = runNode(/counter\.js$/).out.replace(/\s+/g, ''); return /1.*2.*3/.test(o) || o.includes('123'); } });
    add('CE9', 'CE', 'Add memoization', { setup: seed({ 'slow.js': 'function fib(n){return n<2?n:fib(n-1)+fib(n-2);}\nconsole.log(fib(10));\n' }), prompt: 'Add memoization to fib in slow.js (cache results) while keeping correct output: fib(10) must still print 55. Run it.', check: () => /\b55\b/.test(runNode(/slow\.js$/).out) });
    add('CE10', 'CE', 'Add formatting', { setup: seed({ 'money.js': 'function fmt(n){return n;}\nconsole.log(fmt(1234.5));\n' }), prompt: 'Implement fmt in money.js to format a number as USD currency, so fmt(1234.5) prints "$1,234.50". Run it.', check: () => /\$1,234\.50/.test(runNode(/money\.js$/).out) });

    // ---- CF. Tests (10) ----
    add('CF1', 'CF', 'Write a passing unit test', { setup: seed({ 'mathlib.js': 'function add(a,b){return a+b;}\nmodule.exports={add};\n' }), prompt: 'Write a Node test file test.js (using the assert module) that tests add(2,3)===5 from mathlib.js. It must exit 0. Run it.', check: () => runNode(/test\.js$/).ok });
    add('CF2', 'CF', 'Make a failing test pass', { setup: seed({ 'str.js': 'function shout(s){return s;}\nmodule.exports={shout};\n', 'shout.test.js': 'const assert=require("assert");const {shout}=require("./str");assert.strictEqual(shout("hi"),"HI!");console.log("ok");\n' }), prompt: 'The test shout.test.js expects shout("hi") to return "HI!" but str.js does not. Implement shout (uppercase + "!") so the test passes. Run the test (node shout.test.js) and confirm it prints ok.', check: () => /ok/.test(runNode(/shout\.test\.js$/).out) });
    add('CF3', 'CF', 'Test edge cases', { setup: seed({ 'safe.js': 'function head(arr){return arr[0];}\nmodule.exports={head};\n' }), prompt: 'Write edge.test.js that asserts head([1,2])===1 AND that head([]) is undefined (an empty-array edge case), using assert. Run it; it must exit 0.', check: () => runNode(/edge\.test\.js$/).ok });
    add('CF4', 'CF', 'Parametrized tests', { setup: seed({ 'sq.js': 'function sq(n){return n*n;}\nmodule.exports={sq};\n' }), prompt: 'Write param.test.js that checks sq for several inputs in a loop: [[2,4],[3,9],[4,16]], asserting each. Run it; must exit 0.', check: () => runNode(/param\.test\.js$/).ok });
    add('CF5', 'CF', 'Test that catches a bug', { setup: seed({ 'avg.js': 'function avg(a){let s=0;for(const x of a)s+=x;return s/a.length;}\nmodule.exports={avg};\n' }), prompt: 'Write avg.test.js asserting avg([2,4,6])===4. Run it; it should pass (exit 0).', check: () => runNode(/avg\.test\.js$/).ok });
    add('CF6', 'CF', 'Test with node:test', { setup: seed({ 'inc.js': 'function inc(n){return n+1;}\nmodule.exports={inc};\n' }), prompt: 'Write inc.test.js using the built-in node:test and node:assert that tests inc(4)===5. Run it with `node inc.test.js`; it must exit 0.', check: () => runNode(/inc\.test\.js$/).ok });
    add('CF7', 'CF', 'Mock a dependency', { setup: seed({ 'clock.js': 'function now(getTime){return getTime();}\nmodule.exports={now};\n' }), prompt: 'Write mock.test.js that calls now() from clock.js passing a fake getTime that returns 123, and asserts the result is 123. Run it; must exit 0.', check: () => runNode(/mock\.test\.js$/).ok });
    add('CF8', 'CF', 'Test throwing behavior', { setup: seed({ 'check.js': 'function mustPos(n){if(n<0)throw new Error("neg");return n;}\nmodule.exports={mustPos};\n' }), prompt: 'Write throw.test.js that asserts mustPos(-1) throws (assert.throws) and mustPos(5)===5. Run it; must exit 0.', check: () => runNode(/throw\.test\.js$/).ok });
    add('CF9', 'CF', 'Write tests then implement', { setup: seed({}), prompt: 'Create a module slug.js exporting slugify(s) that lowercases and replaces spaces with hyphens, AND a test slug.test.js asserting slugify("Hello World")==="hello-world". Implement so the test passes. Run the test; must exit 0.', check: () => /hello-world|ok|pass/.test(runNode(/slug\.test\.js$/).out) || runNode(/slug\.test\.js$/).ok });
    add('CF10', 'CF', 'Assertion on object equality', { setup: seed({ 'point.js': 'function point(x,y){return {x,y};}\nmodule.exports={point};\n' }), prompt: 'Write point.test.js using assert.deepStrictEqual to check point(1,2) deep-equals {x:1,y:2}. Run it; must exit 0.', check: () => runNode(/point\.test\.js$/).ok });

    // ---- CG. Web / frontend (10) ----
    add('CG1', 'CG', 'HTML page with heading', { prompt: 'Create index.html — a valid HTML5 page with a <h1> heading that says "Welcome".', check: () => { const c = findByName(/\.html$/) || ''; return /<h1[^>]*>\s*Welcome/i.test(c) && /<html/i.test(c); } });
    add('CG2', 'CG', 'Styled button (CSS)', { prompt: 'Create a web page index.html plus a styles.css that styles a button with a blue background. Link the CSS from the HTML.', check: () => { const html = findByName(/\.html$/) || ''; const css = findByName(/\.css$/) || ''; return /<button/i.test(html) && /(blue|#00f|#0000ff|rgb\()/i.test(css); } });
    add('CG3', 'CG', 'JS counter', { prompt: 'Create a web page (index.html + script.js) with a button and a number display; clicking the button increments the count. The JS must add a click listener that increments a counter.', check: () => { const js = findByName(/\.js$/) || ''; const html = findByName(/\.html$/) || ''; return /addEventListener|onclick/i.test(js + html) && /\+\+|\+ ?1|count/i.test(js + html); } });
    add('CG4', 'CG', 'Todo list app', { prompt: 'Create a simple todo web app (index.html + app.js): an input, an add button, and a list. Adding text appends a list item. Include the JS that appends to the list on click.', check: () => { const all = (findByName(/\.html$/) || '') + (findByName(/app\.js$|\.js$/) || ''); return /addEventListener|onclick/i.test(all) && /(appendChild|createElement|innerHTML|<li)/i.test(all); } });
    add('CG5', 'CG', 'Form with validation', { prompt: 'Create form.html with a form containing an email input marked required, and JS that prevents submission and shows an error if the email is empty/invalid.', check: () => { const all = (findByName(/form\.html$/) || findByName(/\.html$/) || '') + (findByName(/\.js$/) || ''); return /<form/i.test(all) && /(required|preventDefault|valid|@)/i.test(all); } });
    add('CG6', 'CG', 'Canvas drawing', { prompt: 'Create canvas.html with a <canvas> and JS that draws a filled rectangle on it using getContext("2d").', check: () => { const all = (findByName(/\.html$/) || '') + (findByName(/\.js$/) || ''); return /<canvas/i.test(all) && /getContext/i.test(all) && /fillRect|fill\(/i.test(all); } });
    add('CG7', 'CG', 'Minimal Snake/Pong game', { prompt: 'Create a minimal browser game in index.html (with embedded or linked JS) — a Snake or Pong style game using canvas and keyboard controls. It must use a canvas, a game loop (requestAnimationFrame or setInterval), and keydown handling.', maxTurns: 18, check: () => { const all = (findByName(/\.html$/) || '') + (findByName(/\.js$/) || ''); return /<canvas/i.test(all) && /(requestAnimationFrame|setInterval)/i.test(all) && /keydown|keyup|addEventListener/i.test(all); } });
    add('CG8', 'CG', 'Fetch and render JSON', { prompt: 'Create a page (index.html + app.js) whose JS uses fetch() to GET a JSON API and renders the result into the DOM. Include a fetch call and DOM update.', check: () => { const all = (findByName(/\.html$/) || '') + (findByName(/\.js$/) || ''); return /fetch\(/i.test(all) && /(innerHTML|textContent|appendChild|createElement)/i.test(all); } });
    add('CG9', 'CG', 'Calculator UI', { prompt: 'Create a basic calculator web app (index.html + calc.js) with number buttons and +,-,*,/ and an equals button that evaluates the expression and shows the result.', maxTurns: 18, check: () => { const all = (findByName(/\.html$/) || '') + (findByName(/\.js$/) || ''); return /<button/i.test(all) && /addEventListener|onclick/i.test(all) && /(eval|\+|\bresult\b)/i.test(all); } });
    add('CG10', 'CG', 'Digital clock', { prompt: 'Create clock.html with JS that shows the current time and updates every second using setInterval and Date.', check: () => { const all = (findByName(/\.html$/) || '') + (findByName(/\.js$/) || ''); return /setInterval/i.test(all) && /Date|toLocaleTimeString|getHours/i.test(all); } });

    // ---- CH. Data / file processing programs (10) ----
    add('CH1', 'CH', 'CSV parser program', { setup: seed({ 'data.csv': 'name,age\nAda,36\nBob,40\n' }), prompt: 'Write parse.js that reads data.csv, parses it, and prints the number of data rows (2) and the name in the first row (Ada). Run it.', check: () => { const o = runNode(/parse\.js$/).out; return /2/.test(o) && /Ada/.test(o); } });
    add('CH2', 'CH', 'CSV to JSON program', { setup: seed({ 'people.csv': 'name,city\nAda,Oslo\nBob,Bergen\n' }), prompt: 'Write convert.js that reads people.csv and writes people.json as an array of {name,city} objects. Run it, then the file people.json must exist and be valid.', check: () => { try { const j = JSON.parse(read('people.json')); return Array.isArray(j) && j[0].name === 'Ada' && j[1].city === 'Bergen'; } catch { return false; } } });
    add('CH3', 'CH', 'Log analyzer', { setup: seed({ 'app.log': 'INFO a\nERROR b\nWARN c\nERROR d\nINFO e\n' }), prompt: 'Write analyze.js that reads app.log and prints the count of ERROR lines (2). Run it.', check: () => /\b2\b/.test(runNode(/analyze\.js$/).out) });
    add('CH4', 'CH', 'Word frequency program', { setup: seed({ 'text.txt': 'the cat sat on the mat the\n' }), prompt: 'Write wf.js that reads text.txt and prints the most frequent word ("the", appears 3 times). Run it.', check: () => /the/.test(runNode(/wf\.js$/).out.toLowerCase()) });
    add('CH5', 'CH', 'JSON transformer', { setup: seed({ 'in.json': '[{"n":"a","v":1},{"n":"b","v":2}]' }), prompt: 'Write transform.js that reads in.json and writes out.json that doubles every "v" field. Run it; out.json must have v values 2 and 4.', check: () => { try { const j = JSON.parse(read('out.json')); return j[0].v === 2 && j[1].v === 4; } catch { return false; } } });
    add('CH6', 'CH', 'Markdown to HTML (headings)', { setup: seed({ 'doc.md': '# Title\nsome text\n## Sub\n' }), prompt: 'Write md2html.js that reads doc.md and writes doc.html converting "# X" to <h1>X</h1> and "## X" to <h2>X</h2>. Run it; doc.html must contain <h1>Title</h1>.', check: () => /<h1>\s*Title\s*<\/h1>/i.test(read('doc.html') || '') });
    add('CH7', 'CH', 'Config loader', { setup: seed({ 'config.json': '{"port":3000,"host":"localhost"}' }), prompt: 'Write loadconfig.js that reads config.json and prints "localhost:3000" (host:port). Run it.', check: () => /localhost:3000/.test(runNode(/loadconfig\.js$/).out) });
    add('CH8', 'CH', 'File merger', { setup: seed({ 'a.txt': 'AAA\n', 'b.txt': 'BBB\n' }), prompt: 'Write merge.js that concatenates a.txt and b.txt into merged.txt (in that order). Run it; merged.txt must contain AAA then BBB.', check: () => { const c = read('merged.txt') || ''; return /AAA/.test(c) && /BBB/.test(c) && c.indexOf('AAA') < c.indexOf('BBB'); } });
    add('CH9', 'CH', 'Template renderer', { setup: seed({ 'tpl.txt': 'Hello {{name}}, you are {{age}}.\n' }), prompt: 'Write render.js that reads tpl.txt and replaces {{name}} with "Ada" and {{age}} with "36", printing "Hello Ada, you are 36.". Run it.', check: () => /Hello Ada, you are 36/.test(runNode(/render\.js$/).out) });
    add('CH10', 'CH', 'Data validator', { setup: seed({ 'records.json': '[{"email":"ok@x.com"},{"email":"bad"},{"email":"y@z.org"}]' }), prompt: 'Write validate.js that reads records.json and prints how many records have a valid-looking email (contains @ and a dot) — should be 2. Run it.', check: () => /\b2\b/.test(runNode(/validate\.js$/).out) });

    // ---- CI. APIs / backend (10) — verify by code structure to avoid port flakiness ----
    add('CI1', 'CI', 'HTTP server returning JSON', { prompt: 'Create server.js — a Node http server that responds to GET / with JSON {"status":"ok"} and Content-Type application/json. Do NOT keep it running long; just write the file. (We verify the source.)', check: () => { const c = findByName(/server\.js$/) || ''; return /http|createServer|express/.test(c) && /application\/json/.test(c) && /status.*ok|"ok"/.test(c); } });
    add('CI2', 'CI', 'Route handler', { setup: seed({ 'routes.js': '// add a handler here\nmodule.exports = {};\n' }), prompt: 'In routes.js, export a function handleHealth(req,res) that responds with 200 and the text "healthy". Run a quick node check that the function exists by requiring it (e.g. console.log(typeof require("./routes").handleHealth)) which should print "function".', check: () => /function/.test(runNode(/\.js$/).out) || /handleHealth/.test(read('routes.js') || '') });
    add('CI3', 'CI', 'In-memory CRUD module', { setup: seed({}), prompt: 'Create store.js exporting create, read, update, remove for an in-memory key/value store, AND store.test.js that creates an item, reads it, updates it, removes it, asserting each step. Run the test; it must exit 0.', maxTurns: 16, check: () => runNode(/store\.test\.js$/).ok });
    add('CI4', 'CI', 'Request body parser', { setup: seed({}), prompt: 'Create parseBody.js exporting parseBody(jsonString) that safely JSON-parses a request body and returns {} on invalid input, AND parseBody.test.js asserting parseBody(\'{"a":1}\').a===1 and parseBody("nope") deep-equals {}. Run the test; exit 0.', check: () => runNode(/parseBody\.test\.js$/).ok });
    add('CI5', 'CI', 'Status code helper', { setup: seed({}), prompt: 'Create status.js exporting statusText(code) mapping 200->"OK", 404->"Not Found", 500->"Internal Server Error", AND status.test.js asserting all three. Run the test; exit 0.', check: () => runNode(/status\.test\.js$/).ok });
    add('CI6', 'CI', 'Query param parser', { setup: seed({}), prompt: 'Create qs.js exporting parseQuery("a=1&b=2") -> {a:"1",b:"2"}, AND qs.test.js asserting that. Run the test; exit 0.', check: () => runNode(/qs\.test\.js$/).ok });
    add('CI7', 'CI', 'Simple router', { setup: seed({}), prompt: 'Create router.js exporting a Router with add(method,path,handler) and match(method,path) returning the handler or null, AND router.test.js that adds GET /x and asserts match("GET","/x") is truthy and match("GET","/y") is null. Run the test; exit 0.', maxTurns: 16, check: () => runNode(/router\.test\.js$/).ok });
    add('CI8', 'CI', 'Middleware chain', { setup: seed({}), prompt: 'Create middleware.js exporting compose(fns) that runs an array of (ctx,next) middlewares in order mutating ctx, AND middleware.test.js where two middlewares each append to ctx.log and the test asserts the final order. Run the test; exit 0.', maxTurns: 16, check: () => runNode(/middleware\.test\.js$/).ok });
    add('CI9', 'CI', 'Error response helper', { setup: seed({}), prompt: 'Create errors.js exporting errorResponse(code,msg) -> {error:{code,message:msg}}, AND errors.test.js asserting errorResponse(400,"bad").error.code===400. Run the test; exit 0.', check: () => runNode(/errors\.test\.js$/).ok });
    add('CI10', 'CI', 'Pagination helper', { setup: seed({}), prompt: 'Create paginate.js exporting paginate(arr,page,size) returning the slice for that 1-based page, AND paginate.test.js asserting paginate([1,2,3,4,5],2,2) deep-equals [3,4]. Run the test; exit 0.', check: () => runNode(/paginate\.test\.js$/).ok });

    // ---- CJ. Project scaffolding / tooling / config (10) ----
    add('CJ1', 'CJ', 'package.json with start script', { prompt: 'Create a package.json for a Node project named "demo" version 1.0.0 with a "start" script that runs "node index.js", and create index.js that prints "running". It must be valid JSON.', check: () => { try { const p = JSON.parse(read('package.json')); return p.name === 'demo' && p.scripts && /node index\.js/.test(p.scripts.start); } catch { return false; } } });
    add('CJ2', 'CJ', 'Makefile', { prompt: 'Create a Makefile with a "build" target that echoes "building" and a "test" target that echoes "testing". Running `make build` must print building.', check: () => { try { return /building/.test(execSync('make -C "' + WS + '" build', { encoding: 'utf8' })); } catch { return /build:/.test(read('Makefile') || '') && /test:/.test(read('Makefile') || ''); } } });
    add('CJ3', 'CJ', 'Dockerfile', { setup: seed({ 'package.json': '{"name":"svc","version":"1.0.0","main":"index.js"}' }), prompt: 'Create a Dockerfile for this Node app: base on a node image, set WORKDIR, COPY files, run npm install, and CMD node index.js.', check: () => { const c = read('Dockerfile') || ''; return /FROM\s+node/i.test(c) && /WORKDIR/i.test(c) && /COPY/i.test(c) && /CMD|ENTRYPOINT/i.test(c); } });
    add('CJ4', 'CJ', '.gitignore', { prompt: 'Create a .gitignore appropriate for a Node project. It must ignore node_modules, .env, and *.log.', check: () => { const c = read('.gitignore') || ''; return /node_modules/.test(c) && /\.env/.test(c) && /\*?\.log/.test(c); } });
    add('CJ5', 'CJ', 'ESLint config', { prompt: 'Create an ESLint flat config file (eslint.config.js) or .eslintrc.json that enables recommended rules and sets "no-unused-vars" to "error". The file must be valid (parseable JS/JSON).', check: () => { const j = read('.eslintrc.json'); if (j) { try { JSON.parse(j); return /no-unused-vars/.test(j); } catch { return false; } } const c = findByName(/eslint\.config\.js$/) || ''; return /no-unused-vars/.test(c); } });
    add('CJ6', 'CJ', 'README with usage', { setup: seed({ 'index.js': 'console.log("hi");\n' }), prompt: 'Create a README.md documenting this project: a title, an Installation section (npm install), and a Usage section showing `node index.js`.', check: () => { const c = read('README.md') || ''; return /#/.test(c) && /install/i.test(c) && /node index\.js/.test(c); } });
    add('CJ7', 'CJ', 'CLI with shebang', { prompt: 'Create a CLI script cli.js with a #!/usr/bin/env node shebang on the first line that prints "cli works". Run `node cli.js` to confirm it prints that.', check: () => { const c = findByName(/cli\.js$/) || ''; return /^#!\/usr\/bin\/env node/.test(c) && /cli works/.test(runNode(/cli\.js$/).out); } });
    add('CJ8', 'CJ', 'Multi-file module with index', { setup: seed({}), prompt: 'Create a small library: lib/add.js (exports add), lib/sub.js (exports sub), and lib/index.js that re-exports both. Then main.js requires ./lib and prints add(2,3) and sub(5,1) -> "5 4". Run main.js.', maxTurns: 16, check: () => /5 4/.test(runNode(/main\.js$/).out) });
    add('CJ9', 'CJ', 'npm build script that runs', { setup: seed({ 'package.json': '{"name":"b","version":"1.0.0","scripts":{}}' }), prompt: 'Add a "greet" npm script to package.json that runs `node -e "console.log(\\"greetings\\")"`. The package.json must stay valid JSON and contain a greet script.', check: () => { try { const p = JSON.parse(read('package.json')); return p.scripts && /greet/i.test(JSON.stringify(p.scripts)); } catch { return false; } } });
    add('CJ10', 'CJ', 'EditorConfig + structure', { prompt: 'Create a .editorconfig setting indent_style=space and indent_size=2 for all files, plus a src/ directory containing a placeholder main.js that prints "ok". Run main.js to confirm it prints ok.', check: () => { const ec = read('.editorconfig') || ''; return /indent_style\s*=\s*space/.test(ec) && /indent_size\s*=\s*2/.test(ec) && /ok/.test(runNode(/main\.js$/).out); } });

    return T;
}

// =====================================================================
(async () => {
    let model = process.argv[2];
    if (!model) {
        const r = await fetch(`${LMS}/v1/models`).then(x => x.json()).catch(() => null);
        const ids = (r?.data || []).map(d => d.id).filter(id => !/embed/i.test(id));
        model = ids.find(id => /gemma|qwen|llama|mistral/i.test(id)) || ids[0];
    }
    if (!model) { console.error('No model at ' + LMS); process.exit(2); }

    const parentWs = fs.mkdtempSync(path.join(os.tmpdir(), 'code100-'));
    let tasks = makeTasks();
    const cats = (process.env.CATS || '').split(',').map(s => s.trim()).filter(Boolean);
    const only = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
    if (cats.length) tasks = tasks.filter(t => cats.includes(t.cat));
    if (only.length) tasks = tasks.filter(t => only.includes(t.id));
    if (process.env.SMOKE) { const seen = new Set(); tasks = tasks.filter(t => { if (seen.has(t.cat)) return false; seen.add(t.cat); return true; }); }
    const defMax = parseInt(process.env.MAXTURNS || '14', 10);

    const CATNAMES = { CA: 'Greenfield programs', CB: 'Algorithms & DS', CC: 'Bug fixing', CD: 'Refactoring', CE: 'Add features', CF: 'Tests', CG: 'Web / frontend', CH: 'Data processing', CI: 'APIs / backend', CJ: 'Scaffolding / config' };
    console.log(`\n=== Code Mode — Top-100 Coding-Task Battery ===`);
    console.log(`  model:    ${model}`);
    console.log(`  endpoint: ${LMS}`);
    console.log(`  tasks:    ${tasks.length}\n`);

    const results = [];
    let pass = 0, fail = 0;
    const t0 = Date.now();
    for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        WS = path.join(parentWs, t.id);
        fs.mkdirSync(WS, { recursive: true });
        projectContext.setRoot(WS);
        try { t.setup && t.setup(); } catch (e) { console.log(`   setup error: ${e.message}`); }
        const started = Date.now();
        process.stdout.write(`[${i + 1}/${tasks.length}] ${t.id} ${t.title} ... `);
        let r, ok = false, why = null;
        try {
            r = await runCode({ model, prompt: t.prompt, projectRoot: WS, maxTurns: t.maxTurns || defMax });
            try { ok = !!t.check(); } catch (e) { ok = false; why = 'check error: ' + e.message; }
            if (r.status === 'crash') why = why || ('run crash: ' + r.why);
        } catch (e) { r = { status: 'crash', turns: 0, tools: [] }; why = 'crash: ' + e.message; }
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        if (ok) { pass++; console.log(`PASS (${secs}s, ${r.turns} turns, ${r.status})`); }
        else { fail++; console.log(`FAIL (${secs}s, ${r.turns} turns, ${r.status})${why ? ' [' + why + ']' : ''}`); }
        results.push({ id: t.id, cat: t.cat, title: t.title, ok, secs: +secs, turns: r.turns, status: r.status, why });
    }
    const totalSecs = ((Date.now() - t0) / 1000).toFixed(0);

    console.log(`\n────────────────────────────────────────────────────────`);
    console.log(`Per-category results:`);
    for (const c of Object.keys(CATNAMES)) {
        const cr = results.filter(x => x.cat === c);
        if (!cr.length) continue;
        console.log(`  ${c} ${CATNAMES[c].padEnd(24)} ${cr.filter(x => x.ok).length}/${cr.length}`);
    }
    console.log(`────────────────────────────────────────────────────────`);
    console.log(`TOTAL: ${pass} passed, ${fail} failed of ${tasks.length} in ${totalSecs}s`);
    if (fail) { console.log(`\nFailures:`); for (const x of results.filter(r => !r.ok)) console.log(`  ✗ ${x.id} ${x.title} — ${x.status}, ${x.turns} turns${x.why ? ', ' + x.why : ''}`); }

    if (process.env.OUT) { try { fs.writeFileSync(process.env.OUT, JSON.stringify({ model, endpoint: LMS, totalSecs: +totalSecs, pass, fail, results }, null, 2)); console.log(`\nWrote ${process.env.OUT}`); } catch (e) { console.log('OUT write failed: ' + e.message); } }

    if (process.env.KEEP) { console.log(`\nKEEP: workspaces at ${parentWs}`); }
    else { try { fs.rmSync(parentWs, { recursive: true, force: true }); } catch {} }
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
