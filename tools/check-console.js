'use strict';
/**
 * Hidden-window check: spawn the emulator the way the main process does and verify
 * that stray console windows stay hidden (Linux: no console windows exist).
 *
 * Code inspection alone is not enough; only a real window enumeration counts.
 *
 * Usage: node tools/check-console.js [appRoot]
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const INSTALL = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'apkstart');
const EMU = path.join(INSTALL, 'resources', 'runtime', 'emulator', 'emulator.exe');
const AVD_HOME = path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const ROOT = path.join(INSTALL, 'resources', 'runtime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ROOT]);
  console.log('agent ready, port=', agent.port);

  const list = async () => {
    const r = await agent.call({ cmd: 'consoles' }, 4000);
    return (r && r.list) || [];
  };

  const before = await list();
  console.log('visible console windows before launch:', JSON.stringify(before));

  // Same as the main process: detached + no console + pipe
  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();

  let sawConsole = 0;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const l = await list();
    const ours = l.filter((w) => w.ours);
    if (ours.length > sawConsole) {
      sawConsole = ours.length;
      console.log(`[${(i + 1) * 0.5}s] console window appeared:`, JSON.stringify(ours));
    }
  }
  const afterSpawn = (await list()).filter((w) => w.ours);
  console.log('console windows still visible without hiding:', JSON.stringify(afterSpawn));

  console.log('--- enabling boot-hide ---');
  const r = await agent.bootHide();
  console.log('bootHide:', JSON.stringify(r));
  await sleep(1500);
  const afterHide = (await list()).filter((w) => w.ours);
  console.log('console windows left after hiding:', JSON.stringify(afterHide));

  console.log('');
  console.log(afterHide.length === 0
    ? `result: pass (${sawConsole} console windows appeared, none visible after hiding)`
    : 'result: fail (a console window is still visible)');

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(afterHide.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
