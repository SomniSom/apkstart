'use strict';
/**
 * Assemble the built-in runtime for the full build:
 *   node build/fetch-runtime.js <output-dir>
 * Produces <output-dir>/runtime/:
 *   emulator/ + platform-tools/ + system-images/android-34/google_apis_playstore/x86_64/
 * Everything is downloaded and verified through the Provisioner's official channel,
 * so it is byte-identical to what the online build fetches.
 */
const path = require('path');
const fs = require('fs');

const outRoot = path.resolve(process.argv[2] || '');
if (!outRoot) {
  console.error('usage: node build/fetch-runtime.js <output-runtime-dir>');
  process.exit(1);
}
fs.mkdirSync(outRoot, { recursive: true });

// The Provisioner reads its root from settings.runtime.dir; point XDG dirs at a
// scratch directory so the real user config is never touched.
process.env.XDG_CONFIG_HOME = path.join(outRoot, '_appdata', 'config');
process.env.XDG_DATA_HOME = path.join(outRoot, '_appdata', 'data');
const store = require('../src/core/store');
store.saveSettings({ runtime: { dir: outRoot } });

const { Provisioner } = require('../src/core/provision');
const prov = new Provisioner(path.resolve(__dirname, '..'));

const log = (p) => console.log(`[${p.stage}] ${p.message} ${p.percent != null ? p.percent + '%' : ''}`);

(async () => {
  await prov.installAdb(log);
  await prov.installEmulator(log);
  await prov.installPlayImage(log);

  const ok =
    fs.existsSync(path.join(outRoot, 'emulator', 'emulator')) &&
    fs.existsSync(path.join(outRoot, 'platform-tools', 'adb')) &&
    fs.existsSync(path.join(outRoot, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'));
  if (!ok) throw new Error('runtime assembly failed its own self-check');

  // Container-style pruning: keep only the x86_64 QEMU and what a headless run needs.
  // Foreign-arch QEMU binaries (~400 MB), QtWebEngine and netsim are useless here.
  const layers = require('../src/core/layers');
  const pruned = layers.prune(outRoot, { apply: true, aggressive: true });
  const before = layers.analyze(outRoot).total + pruned.saved;
  console.log(`slim: ${(pruned.saved / 1048576).toFixed(0)} MB removed, `
    + `${(before / 1073741824).toFixed(2)} GB -> ${(pruned.after / 1073741824).toFixed(2)} GB`);

  fs.rmSync(path.join(outRoot, '_appdata'), { recursive: true, force: true });
  fs.rmSync(path.join(outRoot, '_tmp'), { recursive: true, force: true });
  console.log('runtime-ready:', outRoot);
})().catch((e) => {
  console.error('fetch-runtime failed:', e.message);
  process.exit(1);
});
