'use strict';
/**
 * Update-path self-check (no real release needed, the current install is untouched).
 *
 * 1) can the latest GitHub release be read and the right asset picked for this flavour;
 * 2) version comparison;
 * 3) the unpack/overwrite/restart script really runs: a fake install dir is overwritten.
 *
 * Usage: node tools/check-update.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Updater, cmpVer } = require('../src/core/updater');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => console.log(`${c ? '✓' : '✗'} ${m}`);

(async () => {
  let pass = true;
  const check = (c, m) => { ok(c, m); if (!c) pass = false; };

  // ---- 1. version comparison ----
  check(cmpVer('v0.3.2', '0.3.1') === 1, 'v0.3.2 > 0.3.1');
  check(cmpVer('0.3.1', 'v0.3.1') === 0, 'a v prefix does not affect equality');
  check(cmpVer('v0.10.0', '0.9.9') === 1, '0.10.0 > 0.9.9 (numeric, not string comparison)');
  check(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 < 1.0.1');

  // ---- 2. GitHub release ----
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upd-'));
  const install = path.join(sandbox, 'install');
  fs.mkdirSync(install, { recursive: true });

  const u = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  let info = null;
  try {
    info = await u.check();
    check(!!info && !!info.version, `latest version read: ${info && info.tag}`);
    check(info.hasUpdate === true, '0.0.0 -> an update is detected');
    check(!!info.asset && /\.(zip|AppImage|tar\.gz)$/i.test(info.asset.name), `portable flavour picks ${info.asset && info.asset.name}`);
  } catch (e) {
    check(false, `GitHub check failed: ${e.message}`);
  }

  // An installed flavour should pick the installer artifact
  fs.writeFileSync(path.join(install, 'Uninstall ApkStart.exe'), 'stub');
  const u2 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  check(u2.flavor === 'setup', 'detected an installed flavour');

  // ---- 3. the overwrite script really runs ----
  const payload = path.join(sandbox, 'payload');
  fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload, 'resources', 'app', 'main.js'), 'new-main');
  fs.writeFileSync(path.join(install, 'ApkStart.exe'), 'old-exe');

  // Use a process that exits at once as the "old process" being waited on
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], { stdio: 'ignore' });

  const script = u.apply(
    { mode: 'zip', payload, version: '9.9.9' },
    { waitPid: decoy.pid, spawn: false },
  );
  check(/while kill/.test(script) && /cp |tar /.test(script), 'the script waits and overwrites');

  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Do not actually launch the fake binary; only verify the copy step
  const body = script.replace(/if \(Test-Path[^\r\n]*relaunched' \}/, "'skipped relaunch'");
  const b64 = Buffer.from(body, 'utf16le').toString('base64');
  try {
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      stdio: 'ignore', timeout: 60000, windowsHide: true,
    });
  } catch (e) {
    check(false, `overwrite script failed: ${e.message}`);
  }
  await sleep(600);
  const newExe = fs.readFileSync(path.join(install, 'ApkStart.exe'), 'utf8');
  const newMain = fs.readFileSync(path.join(install, 'resources', 'app', 'main.js'), 'utf8');
  check(newExe === 'new-exe', 'the binary in the install dir was replaced');
  check(newMain === 'new-main', 'files in subdirectories are replaced too');

  // ---- 4. apply() spawns a process to swap files (async, no network) ----
  const install2 = path.join(sandbox, 'install2');
  const payload2 = path.join(sandbox, 'payload2');
  fs.mkdirSync(install2, { recursive: true });
  fs.mkdirSync(payload2, { recursive: true });
  fs.writeFileSync(path.join(install2, 'ApkStart.exe'), 'old-exe');
  fs.writeFileSync(path.join(install2, 'marker.txt'), 'old');
  fs.writeFileSync(path.join(payload2, 'ApkStart.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload2, 'marker.txt'), 'new');

  const u3 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install2, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  const decoy2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { stdio: 'ignore' });
  u3.apply({ mode: 'zip', payload: payload2, version: '9.9.8' }, { waitPid: decoy2.pid });
  let asyncOk = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      if (fs.readFileSync(path.join(install2, 'marker.txt'), 'utf8') === 'new') { asyncOk = true; break; }
    } catch (_) { /* still replacing */ }
  }
  check(asyncOk, 'apply() completed in a background process (async path works)');

  try { decoy.kill(); } catch (_) { /* ignore */ }
  try { decoy2.kill(); } catch (_) { /* ignore */ }
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log('');
  console.log(pass ? 'result: pass' : 'result: failures');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
