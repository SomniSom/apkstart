'use strict';
/**
 * End-to-end check that launching an app shows only that app's window:
 *   1) start a real ApkStart with sandboxed XDG dirs and `--apk` to install a test APK;
 *   2) then `--launch <package>` to open the app;
 *   3) enumerate visible top-level windows throughout: no emulator, qemu or netsimd
 *      window may appear, and the app window must show up.
 *
 * Usage: node tools/check-launch-clean.js [apkPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Like the other window checks, the runtime and data dirs can be overridden
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`test APK not found: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // ---- 1) install ----
  console.log('- installing the APK (first run cold-boots the emulator, 40-90 s)...');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* not written yet */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `installed: ${pkg || '(timeout)'}`);
  // Wait until the first instance really exits before starting the second: while the
  // single-instance lock is held the second exits at once and looks like a missing window.
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\nresult: fail (the app was not installed, skipping the rest)');
    process.exit(1);
  }

  // ---- 2) launch the app ----
  console.log('- launching the app...');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // A cold boot (~23 s) plus app start (~17 s) needs 120 s; 60 s failed on slow machines
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] unexpected visible window:`, JSON.stringify(hit));
    }
    // The app window is an ordinary titled window that is not an emulator or console
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/apkstart|ApkStart|Program Manager|Settings|Desktop|Icons/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)}s] app window appeared`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `emulator/console windows never visible (${leaked} leaks)`);
  check(sawAppWin, 'the app window appeared (frames are inside our window)');
  console.log('  visible window titles:', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('--- tail of app.log ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('(no app.log)'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  sandbox kept at: ${sandbox}`);
  }
  console.log('');
  console.log(`result: ${pass ? 'pass' : 'fail'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
