'use strict';
/**
 * Real QEMU integration test (needs qemu-system-x86_64 locally)
 *
 * Checks:
 *  1. ApkStart's QEMU arguments are accepted and run stably
 *  2. qemu-img creates a usable disk
 *  3. QEMU monitor (TCP) handshake, sendkey and graceful quit
 *
 * Run: node test/qemu-real-test.js   (skips when QEMU is missing)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

process.env.APPDATA = path.join(os.tmpdir(), `apkstart-qemu-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'apkstart'), { recursive: true });

const CANDIDATES = [
  'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',
  path.join(__dirname, '..', 'engine', 'qemu', 'qemu-system-x86_64.exe'),
];
const QEMU = CANDIDATES.find((c) => fs.existsSync(c));
const QEMU_IMG = QEMU && path.join(path.dirname(QEMU), 'qemu-img.exe');

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; out.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; out.push(`  ✗ ${name}\n    ${e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  if (!QEMU) {
    console.log('(skipped: QEMU not found; install qemu-system-x86 and retry)');
    process.exit(0);
  }
  const ver = execFileSync(QEMU, ['--version'], { encoding: 'utf8' });
  console.log(`QEMU: ${ver.split('\n')[0].trim()}\n`);

  const store = require('../src/core/store');
  const { Runtime } = require('../src/core/engine');

  const work = path.join(process.env.APPDATA, 'apkstart', 'runtime', 'images');
  fs.mkdirSync(work, { recursive: true });
  const disk = path.join(work, 'test.qcow2');

  await test('qemu-img creates a virtual disk', () => {
    execFileSync(QEMU_IMG, ['create', '-f', 'qcow2', disk, '2G'], { timeout: 30000 });
    assert(fs.existsSync(disk) && fs.statSync(disk).size > 0, 'disk was not created');
  });

  await test('real QEMU accepts the launch arguments', async () => {
    store.saveSettings({
      engine: { memoryMB: 1024, cores: 2 },
      runtime: { diskPath: disk, headless: true },
    });
    const rt = new Runtime(path.join(__dirname, '..'));
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false, headless: true });

    const proc = spawn(QEMU, args, { windowsHide: true, stdio: 'ignore' });
    let exited = null;
    proc.on('exit', (c) => { exited = c; });

    await new Promise((r) => setTimeout(r, 4000));
    assert(exited === null, `QEMU exited within 4 s (code=${exited}); arguments may be rejected`);
    assert(!proc.killed, 'the process should be alive');

    await test('monitor protocol against real QEMU', async () => {
      const buf = await rt.monitorCmd('info status', { timeout: 5000 });
      assert(/running|paused/i.test(buf), `unexpected monitor reply: ${buf.slice(-80)}`);
      await rt.monitorCmd('sendkey ctrl-alt-delete');
    });

    await test('monitor graceful quit', async () => {
      await rt.monitorCmd('quit');
      await new Promise((r) => setTimeout(r, 1500));
      assert(exited !== null || proc.killed, 'QEMU should have exited');
    });
    try { proc.kill(); } catch (_) { /* ignore */ }
  });

  console.log(out.join('\n'));
  console.log(`\nresult: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(process.env.APPDATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
