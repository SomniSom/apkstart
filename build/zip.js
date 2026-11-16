'use strict';
/**
 * Portable package compression (zip).
 *
 * Why not the shell's `zip -r`: it uses zlib level 6 deflate, which produced
 * 105,213,775 bytes for the same 225 MB tree where 7-Zip's deflate (`-mx=9`) needs
 * 99,616,541 — a 5.6 MB difference. Gitee caps a single release attachment at 100 MB
 * (104,800,000 bytes uploads fine, 105,213,775 gets split into part1/part2 that users
 * cannot simply unpack). Those 5 MB decide whether the package is usable at all.
 *
 * So 7-Zip is used when available, with `zip -r -9` as the fallback (with a warning).
 *
 * Usage:
 *   node build/zip.js <srcDir> <out.zip> [--limit-mb 100]
 * Exit codes: 0 ok / 1 failure / 2 over the size limit (CI treats it as a failure)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** Find a 7-Zip executable in the usual locations (7z / 7za) */
function find7z() {
  const explicit = process.env.APKSTART_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    '/usr/bin/7z',
    '/usr/bin/7za',
    '/usr/local/bin/7z',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'linux', 'x64', '7za'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // Search PATH (GitHub Actions' ubuntu-latest has p7zip installed)
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z', '7za']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // electron-builder's downloaded 7zip cache (common on dev machines)
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '', '.cache'), 'electron-builder');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* no cache dir */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Zip with 7-Zip: cwd is the source dir so paths stay relative */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`7-Zip compression failed (${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** Fallback: `zip -r -9` (about 5% bigger, used only when 7-Zip is missing) */
function zipWithZipCli(srcDir, outZip) {
  const r = spawnSync('zip', ['-r', '-9', '-q', outZip, '.'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`zip failed: ${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** Self-check: re-read the archive with the app's own zip reader and compare totals */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`entry count mismatch: ${names.length} in the zip, ${expect.files} in the tree`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`uncompressed size mismatch: ${bytes} in the zip, ${expect.bytes} in the tree`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('usage: node build/zip.js <srcDir> <out.zip> [--limit-mb 100]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`zipping ${srcDir} (${stats.files} files, ${(stats.bytes / MIB).toFixed(1)} MB)`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('compressor:', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('! 7-Zip not found, falling back to zip — about 5% bigger, may exceed the attachment limit');
    zipWithZipCli(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`done: ${outZip}`);
  console.log(`  ${entries} entries, ${size} bytes (${(size / MIB).toFixed(2)} MiB), ratio ${(size / stats.bytes * 100).toFixed(1)}%`);

  if (size > limitMiB * MIB) {
    console.error(`x over the ${limitMiB} MiB limit. Slim the package instead of splitting it.`);
    process.exit(2);
  }
  console.log(`  ok, under ${limitMiB} MiB (${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB left)`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
