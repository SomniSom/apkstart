'use strict';
/**
 * Runtime self-check (no UI needed)
 *
 *   npm run selftest                 # check the existing runtime only
 *   npm run selftest -- --apk a.apk  # also run install -> launch -> screenshot -> shared dir
 *
 * Purpose: after Android is installed, one command proves that "double-click installs,
 * a standalone window opens, data flows both ways" really works on this machine, and
 * pinpoints the failing step when it does not.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
// Empty = use the product path (start the built-in runtime, dynamic serial); set to use an external device
const SERIAL = argOf('--serial') || '';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\nApkStart runtime self-check');
  console.log(`device: ${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[components]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb available', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('adb is not installed; run the one-click setup first');
    return `v${env.adb.version}`;
  });
  await step('Android emulator ready', async () => {
    if (!env.emulator.ok) throw new Error('the runtime engine is not installed; run the one-click setup first');
    return `v${env.emulator.version}`;
  });
  await step('system image complete', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || 'the system image is missing');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)}GB`;
  });
  record('hardware acceleration', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : 'falling back to software emulation (works, but slow)');

  console.log('\n[device]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('runtime ready', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`external device is offline: ${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || 'the runtime is unavailable');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\nthe device is not ready, skipping the rest.');
  } else {
    await step('Android version', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('cannot read the system version');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('screen resolution', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size returned nothing');
      return `${s.width}×${s.height}`;
    });
    await step('freeform standalone window', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('cannot enable freeform (multi-window may be unsupported)');
      return 'enabled';
    });

    console.log('\n[shared folder]');
    await step('two-way sync', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `apkstart selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('apkstart selftest')) throw new Error('host -> device did not sync');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('device -> host did not sync');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return 'both directions work';
    });

    if (APK) {
      console.log('\n[app flow]');
      let meta = null;
      await step('parse the APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('install on the device', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path did not find the package');
          return 'pm path verified';
        });
        await step('standalone window launch', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('the app is not in the foreground');
          return meta.package;
        });
        await step('screenshot', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('the screenshot looks wrong');
          return file;
        });
      }
    } else {
      console.log('\n[app flow] no --apk given, skipped');
    }
  }

  // Stop a runtime this script started: otherwise the emulator's stdio pipes
  // keep the Node event loop alive and the command appears to hang
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`result: ${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, `
    + `${results.filter((r) => r.ok === null).length} skipped`);
  if (failed.length) {
    console.log('failures:');
    failed.forEach((f) => console.log(`  · ${f.name}：${f.detail}`));
    process.exit(1);
  }
  console.log('all checks passed\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nself-check aborted:', e.message);
  process.exit(1);
});
