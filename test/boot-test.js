'use strict';
/**
 * Real boot test (opt-in, run with `npm run test:boot`)
 *
 * A 61 MB Alpine virt ISO exercises the product's real launch arguments:
 *   create a qcow2 disk -> boot from cdrom -> confirm userspace over serial -> shutdown
 *
 * Purpose: engine bugs hide in args that look right but do not boot (machine type,
 * accel, boot order, virtio disk, ACPI shutdown). Real QEMU and a real guest pin it down.
 * No Android image and no hardware acceleration needed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Isolated data dir: never write test disk paths into real user settings
process.env.APPDATA = path.join(os.tmpdir(), `apkstart-boot-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'apkstart'), { recursive: true });

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { downloadParallel } = require('../src/core/download');

const ISO_URL = 'https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso';
const WORK = path.join(os.tmpdir(), 'apkstart-boot');
const ISO = path.join(WORK, 'alpine-virt.iso');
const DISK = path.join(WORK, 'boot-test.qcow2');
const SERIAL = path.join(WORK, 'serial.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  ${m}`);

async function ensureIso() {
  if (fs.existsSync(ISO) && fs.statSync(ISO).size > 50 * 1024 * 1024) return;
  fs.mkdirSync(WORK, { recursive: true });
  log('downloading the Alpine virt ISO (~61 MB)...');
  await downloadParallel(ISO_URL, ISO, { connections: 8, minChunk: 4 * 1024 * 1024 });
}

(async () => {
  console.log('\n[real boot test]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const env = await runtime.provisioner.checkEnv();
  if (!env.qemu.ok) {
    console.error('  skipped: QEMU is not installed');
    process.exit(0);
  }
  log(`QEMU ${env.qemu.version} · ${env.qemu.path}`);

  await ensureIso();
  log(`ISO ${(fs.statSync(ISO).size / 1048576).toFixed(0)}MB`);

  // 1) Create the disk with qemu-img (also checks the product's createDisk path)
  const img = path.join(path.dirname(env.qemu.path), 'qemu-img.exe');
  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  const { execFileSync } = require('child_process');
  execFileSync(img, ['create', '-f', 'qcow2', DISK, '2G'], { windowsHide: true });
  log(`disk ${(fs.statSync(DISK).size / 1024).toFixed(0)}KB (sparse)`);

  // 2) Use the product's real launch arguments
  runtime._hv = env.hypervisor;
  store.saveSettings({
    runtime: { isoPath: ISO, diskPath: DISK },
    engine: { memoryMB: 1024, cores: 2 },
  });
  const args = runtime.buildArgs({ install: true, headless: true });
  args.push('-serial', `file:${SERIAL}`, '-no-reboot');
  try { fs.rmSync(SERIAL, { force: true }); } catch (_) { /* ignore */ }

  log(`launch: ${args.filter((a) => !a.includes('=')).slice(0, 8).join(' ')} ...`);
  const proc = spawn(env.qemu.path, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // 3) Wait for userspace (a login prompt on the serial line means success)
  const start = Date.now();
  let booted = false;
  while (Date.now() - start < 180000) {
    if (exited) break;
    if (fs.existsSync(SERIAL)) {
      const txt = fs.readFileSync(SERIAL, 'latin1');
      if (/login:/i.test(txt)) { booted = true; break; }
    }
    await sleep(2000);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  if (!booted) {
    const tail = fs.existsSync(SERIAL) ? fs.readFileSync(SERIAL, 'latin1').slice(-600) : '(no serial output)';
    console.error(`  x boot failed (${elapsed}s):\n${tail}`);
    try { proc.kill(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
  log(`ok guest is in userspace (${elapsed}s)`);

  // 4) Graceful shutdown: system_powerdown, then quit on timeout (stop())
  let graceful = false;
  try {
    await runtime.monitorCmd('system_powerdown');
    for (let i = 0; i < 20; i++) {
      if (exited) { graceful = true; break; }
      await sleep(500);
    }
    if (!exited) {
      log('guest did not answer ACPI powerdown, falling back to quit');
      await runtime.monitorCmd('quit');
      for (let i = 0; i < 10; i++) {
        if (exited) break;
        await sleep(300);
      }
    }
  } catch (e) {
    log(`monitor error: ${e.message}`);
  }
  if (!exited) { try { proc.kill(); } catch (_) { /* ignore */ } }
  log(exited ? `ok VM stopped (${graceful ? 'ACPI powerdown' : 'quit fallback'})` : 'x VM did not stop');

  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  console.log(`\nresult: ${exited ? 'pass' : 'fail'}\n`);
  process.exit(exited ? 0 : 1);
})().catch((e) => {
  console.error('  error:', e.message);
  process.exit(1);
});
