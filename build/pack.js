'use strict';
/**
 * Portable build: produces dist/ApkStart-linux-x64-portable/
 *   apkstart (the renamed electron binary) + resources/app (this app's source)
 * No installer: unpack and run. electron-builder packaging reuses the same layout.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Allow overriding the output dir (build elsewhere then swap when a running instance holds it)
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', 'ApkStart-linux-x64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('packing the portable build ->', OUT);
// Never wipe an existing target tree: some environments block bulk deletes and a
// failed build would lose the last working version. Rename it aside and rebuild;
// if it is busy, switch to a versioned output dir.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('previous build kept ->', backup);
  } catch (_) {
    // File managers and indexers can hold directory handles for a long time and the
    // rename fails with EBUSY; fall back to a versioned directory instead.
    OUT = path.join(ROOT, 'dist', `ApkStart-v${require(path.join(ROOT, 'package.json')).version}-linux-x64-portable`);
    console.log('old dir is busy, writing to ->', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Electron runtime
console.log('copying the Electron runtime...');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Locale trimming: Electron ships 55 locales (41 MB); keep en-US only.
const KEEP_LOCALES = new Set(['en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* no locales dir is fine */ }

// 1.2 Files nobody opens: changelogs, debug symbols, unused paks (0.1-9 MB each)
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Removable runtime libraries (Linux: none of the Windows-only stubs apply).
//     Never drop libvk_swiftshader.so / libvulkan.so.1: Chromium needs them for
//     software rendering when no GPU driver is usable.
let pruneSaved = 0;
for (const rel of []) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* absent anyway */ }
}

// 2. The app itself
console.log('copying the app...');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 3. Optional dirs
// Only docs ship from engine/; the large runtime pieces (emulator, system-images,
// platform-tools, avd) are downloaded from the official source on first launch.
// tools/ holds developer self-checks and is not shipped.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

// 4. Rename the main binary
fs.renameSync(path.join(OUT, 'electron'), path.join(OUT, 'apkstart'));

// 5. Version info
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'VERSION.txt'), `ApkStart v${pkg.version}\nbuilt: ${new Date().toISOString()}\n`);

// 6. Size report, printed every build so the package cannot silently grow
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `done: ${totalMB.toFixed(0)} MB (locales saved ${(localeSaved / 1048576).toFixed(0)} MB, `
  + `redundant libraries saved ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('zip: node build/zip.js dist/ApkStart-linux-x64-portable <out.zip>');
console.log(`run ${path.join(OUT, 'apkstart')} to start.`);
