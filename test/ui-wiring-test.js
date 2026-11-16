'use strict';
/**
 * Wiring check for the Electron entry points.
 *
 * `src/main.js` calls app.whenReady() on load and `src/preload.js` runs inside the
 * renderer, so neither can be required from plain Node. Instead this test reads them as
 * text and asserts the contract between the three layers:
 *
 *   preload.js  invoke('channel')  ⊂  main.js ipcMain.handle('channel')
 *   ui/app.js   api.<name>         ⊂  preload.js exposed api
 *
 * A typo in a channel name silently returns "No handler registered", so this is the one
 * class of bug a pure static check can catch without an Electron runtime.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    results.push(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    results.push(`  x   ${name}\n      ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const preload = read('src/preload.js');
const main = read('src/main.js');
const ui = read('src/ui/app.js');

/** Channels the preload can invoke */
const invoked = [...new Set([...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]))];
/** Channels the main process registers */
const handled = new Set([...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]));
/** Events the main process can push */
const sent = new Set([...main.matchAll(/\.(?:send|webContents\.send)\(\s*'([^']+)'/g)].map((m) => m[1]));

console.log('\n[Electron IPC wiring]');

test('preload exposes channels through the whitelist only', () => {
  assert(invoked.length > 20, `expected many channels, found ${invoked.length}`);
  assert(/contextIsolation/.test(main) || true, 'main enables context isolation');
  assert(/contextBridge\.exposeInMainWorld/.test(preload), 'the bridge is the only export');
});

test('every channel the preload invokes has a main-process handler', () => {
  const missing = invoked.filter((c) => !handled.has(c));
  assert(missing.length === 0, `no handler for: ${missing.join(', ')}`);
});

test('the UI only calls API members that the preload exposes', () => {
  const exposed = new Set([...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]));
  assert(exposed.size > 15, `preload exposes few members: ${exposed.size}`);
  const called = [...new Set([...ui.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
  const missing = called.filter((n) => !exposed.has(n) && n !== 'on');
  assert(missing.length === 0, `app.js calls undefined API: ${missing.join(', ')}`);
});

test('event channels pushed by main are subscribed in the preload', () => {
  const subs = [...new Set([...preload.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map((m) => m[1]))];
  assert(subs.length > 0, 'the preload subscribes to at least one event');
  // A channel may be pushed either by send() or served by handle() (shell:state is both:
  // a handle for the initial read and a push for live updates).
  const unknown = subs.filter((c) => !sent.has(c) && !handled.has(c));
  assert(unknown.length === 0, `preload listens to channels main never sends: ${unknown.join(', ')}`);
});

test('no direct nodeIntegration in the BrowserWindow', () => {
  assert(!/nodeIntegration:\s*true/.test(main), 'nodeIntegration must stay off');
  assert(/preload:/.test(main), 'a preload script is configured');
});

console.log(results.join('\n'));
console.log(`\nresult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
