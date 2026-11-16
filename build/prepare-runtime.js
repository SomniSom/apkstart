'use strict';
/**
 * Turn engine/ into a shippable runtime tree: build/runtime/
 *
 * The key step is compressing system.img. The AOSP system.img is a 3.1 GB sparse
 * image that is mostly zeros and gzips down to ~580 MB; that single file dominates
 * the download. With the slimmed emulator (~340 MB) + Electron + platform-tools the
 * whole package is about 1.0-1.1 GB, versus 1.4 GB+ without compression.
 * The price is a 1-2 minute one-time unpack into the user data dir on first launch,
 * handled by materializeImages() in src/core/provision.js.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Bundled initial /data template (formatted ext4, xz compressed); see the userdata.img note below.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Large images use XZ (LZMA2): ~25% smaller than gzip -6 (system.img 1.5 GB -> ~1.1 GB).
 *  Default is preset 9e; a dual-core CI can set XZ_PRESET=6 to cut the time to a third (+3% size).
 *
 *  Implementation notes (lessons learned):
 *   - Use python's lzma (single-threaded, stable). @napi-rs/lzma's createCompressStream
 *     hung with zero bytes in some environments (18 minutes, no output), so it is only a
 *     last resort and must be guarded by a timeout.
 *   - CI once hung for three hours because the source was never piped into stdin. The
 *     python side runs shutil.copyfileobj(sys.stdin.buffer, z); without EOF it waits
 *     forever, writes nothing to stdout and never exits.
 *   - A watchdog kills the compressor no matter what and falls back to gzip, so the
 *     packaging chain can never hang forever.
 *   - No python or a failed compression -> gzip -9 (slightly bigger, never hangs);
 *     materializeImages picks the decompressor by extension and accepts both outputs.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Default 2 hours (3 GB / 2 cores / preset 6 measured at ~40 min); on timeout kill and gzip.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Attach listeners first so a child that exits before our await is not missed.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  (xz exceeded ${Math.round(timeoutMs / 60000)} min, killing it and using gzip -9)`);
      try { p.kill(); } catch (_) { /* already exited */ }
    }, timeoutMs);

    let ok = false;
    try {
      // Key: stdin is the compressor input. pipeline ends p.stdin after reading src,
      // so python gets EOF, flushes the XZ tail and exits cleanly.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // Any error (EPIPE / write failure) kills the child immediately instead of waiting for the watchdog.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // A half-written .xz would pollute the output, so remove it before falling back.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  (${py} compression failed, using gzip -9)`);
  } else {
    console.log('  (no python found, using gzip -9 — slightly bigger but reliable)');
  }
  // Fallback: gzip -9 (not xz); materializeImages picks the decompressor by extension
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime is up to date (pass --force to rebuild)');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('the engine/ directory is missing, cannot prepare the runtime');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy emulator / platform-tools as is (without old artefacts)
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`copying ${dir}...`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Slim down: drop files our fixed launch arguments never load (~-400 MB)
  if (!process.argv.includes('--no-slim')) {
    console.log('slimming the runtime...');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. System images: large files become .xz (streamed by materializeImages), the rest is copied
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt is the GMS licence text (~20 MB) and is not needed at runtime
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // userdata.img uses the bundled ext4 seed template: the official one is 1 MB
            // of zeros, e2fsck fails with code=8 when the emulator grows it, the partition
            // stays at 1 MB, the guest sees an invalid magic, /data goes read-only and a
            // fresh install never boots. The template is built once with mke2fs and kept in
            // the repo, so CI needs no extra toolchain.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('userdata.img uses the bundled ext4 seed (build/seed)');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // Compress large images; the raw file is not shipped. Skip when a valid .xz/.gz exists
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // The gzip fallback writes .gz and must be accepted too, otherwise every
              // rebuild recompresses 3 GB. The threshold is >1 MB rather than a ratio:
              // vendor.img.gz is only ~21 MB and userdata.img is almost all zeros, so a
              // fixed large threshold or a ratio would reject valid outputs.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`skipping ${f} (existing ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB)`);
                compressed += 1;
                continue;
              }
              console.log(`compressing ${f} (${(sizeOf(src) / 1073741824).toFixed(2)} GB) -> XZ 9e (slow, once)...`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`done: build/runtime (${(total / 1073741824).toFixed(2)} GB, ${gzCount} large images compressed)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Exported so regression tests can call it directly (without main's full preparation)
module.exports = { xzFile, gzipFile, findPython };
