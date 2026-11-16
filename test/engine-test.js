'use strict';
/**
 * Engine and bootstrap tests (no real QEMU / adb / Android)
 * Covers: downloader (with resume), ZIP unpacking, env checks, QEMU args, monitor
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// Isolated data dir so real user config is never touched
const TMP = path.join(os.tmpdir(), `apkstart-test-${Date.now()}`);
// XDG: store.js берёт данные из $XDG_DATA_HOME/apkstart
process.env.XDG_DATA_HOME = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  console.log('\n[download.js]');
  const { download, downloadParallel, head, sha256File } = require('../src/core/download');

  // Local HTTP server fakes the download source (with Range resume)
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': payload.length - start,
        });
        return res.end(payload.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': payload.length });
      return res.end(payload);
    }
    // Full start-end Range support (for parallel chunk tests)
    if (req.url === '/ranged.bin') {
      server.rangeHits = (server.rangeHits || 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        return res.end(payload);
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
      });
      return res.end(payload.subarray(start, end + 1));
    }
    // Explicitly no Range support
    if (req.url === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'none' });
      return res.end(payload);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/big.bin' });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('full download follows redirects', async () => {
    const dest = path.join(TMP, 'dl1.bin');
    await download(`http://127.0.0.1:${port}/redirect`, dest);
    assert(fs.statSync(dest).size === payload.length, 'size mismatch');
  });

  await test('resume from a partial file', async () => {
    const dest = path.join(TMP, 'dl2.bin');
    fs.writeFileSync(dest, payload.subarray(0, 100000));
    let lastPercent = 0;
    await download(`http://127.0.0.1:${port}/big.bin`, dest, {
      onProgress: (p) => { lastPercent = p.percent; },
    });
    assert(fs.statSync(dest).size === payload.length, `size after resume ${fs.statSync(dest).size}`);
    assert(fs.readFileSync(dest).equals(payload), 'resumed content differs');
    assert(lastPercent > 50, 'no progress reported');
  });

  await test('HEAD probe and SHA256', async () => {
    const h = await head(`http://127.0.0.1:${port}/big.bin`);
    assert(h.size === payload.length, 'HEAD size mismatch');
    const sum = await sha256File(path.join(TMP, 'dl1.bin'));
    assert(/^[0-9a-f]{64}$/.test(sum), 'malformed sha256');
  });

  await test('a SHA256 mismatch removes the file', async () => {
    const dest = path.join(TMP, 'dl3.bin');
    let threw = false;
    try {
      await download(`http://127.0.0.1:${port}/big.bin`, dest, { expectSha256: 'deadbeef'.repeat(8) });
    } catch (_) { threw = true; }
    assert(threw, 'should throw');
    assert(!fs.existsSync(dest), 'a failed check deletes the file');
  });

  await test('parallel chunk download reassembles correctly', async () => {
    const dest = path.join(TMP, 'dl4.bin');
    server.rangeHits = 0;
    let maxPercent = 0;
    const r = await downloadParallel(`http://127.0.0.1:${port}/ranged.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
      onProgress: (p) => { maxPercent = Math.max(maxPercent, p.percent); },
    });
    assert(fs.readFileSync(dest).equals(payload), 'reassembled content differs');
    assert(r.parallel > 1, `parallel not used: ${r.parallel}`);
    assert(server.rangeHits >= r.parallel, `too few range requests: ${server.rangeHits}`);
    assert(maxPercent > 0, 'no progress reported');
  });

  await test('no Range support falls back to a single stream', async () => {
    const dest = path.join(TMP, 'dl5.bin');
    const r = await downloadParallel(`http://127.0.0.1:${port}/norange.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
    });
    assert(fs.readFileSync(dest).equals(payload), 'content differs after fallback');
    assert(!r.parallel, 'should not go parallel');
  });

  server.close();

  console.log('\n[provision.js]');
  const { Provisioner } = require('../src/core/provision');
  const store = require('../src/core/store');

  await test('the runtime dir lives under the data dir', async () => {
    const p = new Provisioner('C:/fake/app');
    assert(p.paths().root.startsWith(store.DATA_DIR), `unexpected path: ${p.paths().root}`);
    assert(p.paths().qemuExe.endsWith('qemu-system-x86_64'), 'unexpected qemu path');
    assert(p.paths().adbExe.endsWith('adb') && !p.paths().adbExe.endsWith('.exe'), 'unexpected adb path');
  });

  await test('empty env: adb not ready, components complete', async () => {
    const p = new Provisioner(path.join(TMP, 'nonexistent'));
    const env = await p.checkEnv();
    assert(env.adb.ok === false, 'adb should not be ready');
    // QEMU may already be installed system-wide and should then be found
    if (env.qemu.ok) assert(env.qemu.version, 'a ready qemu must report its version');
    assert(env.ready === false, 'should not be ready');
    assert(typeof env.hypervisor.kvm === 'boolean', 'hypervisor info missing');
  });

  await test('the built-in ZIP reader works', async () => {
    const { ZipArchive } = require('../src/core/zip');
    // Build a minimal stored zip
    const name = Buffer.from('platform-tools/adb.exe');
    const data = Buffer.from('fake-adb-binary');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 14);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt32LE(data.length, 20);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zipPath = path.join(TMP, 'pt.zip');
    fs.writeFileSync(zipPath, Buffer.concat([loc, name, data, cen, name, eocd]));

    const out = path.join(TMP, 'unzip');
    const p = new Provisioner(TMP);
    await p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', 'unpacked content mismatch');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'zip read failed');
  });

  await test('relative SDK index URLs become absolute', async () => {
    const { absUrl, baseOf, SOURCES } = require('../src/core/provision');
    // repository2-3.xml (emulator) is relative to the repo root
    assert(absUrl('emulator-windows_x64-16847572.zip') === `${baseOf(SOURCES.sdkIndex)}emulator-windows_x64-16847572.zip`,
      'the emulator relative path is not resolved');
    // The sys-img index is relative to sys-img/android/, not the repo root
    const sysBase = baseOf(SOURCES.sysImgIndexes[0]);
    assert(sysBase.endsWith('/sys-img/android/'), `unexpected sys-img base: ${sysBase}`);
    assert(absUrl('x86_64-30_r11.zip', sysBase) === 'https://dl.google.com/android/repository/sys-img/android/x86_64-30_r11.zip',
      'sys-img relative path resolved wrongly');
    // Absolute URLs come back unchanged
    assert(absUrl('https://example.com/a.zip') === 'https://example.com/a.zip', 'an absolute URL was rewritten');
  });

  await test('resolved emulator and image URLs are absolute', async () => {
    const p = new Provisioner(TMP);
    const emuUrl = await p.resolveEmulatorUrl();
    const imgUrl = await p.resolveSysimgUrl();
    for (const u of [emuUrl, imgUrl]) {
      assert(/^https?:\/\//i.test(u), `not an absolute URL: ${u}`);
      assert(/\.zip$/i.test(u), `not a zip: ${u}`);
    }
    assert(/linux_x64/i.test(emuUrl), `wrong emulator platform: ${emuUrl}`);
  });

  await test('AVD config keeps the 64-bit ABI (x86_64)', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(TMP);
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2 });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg), `hw.cpu.arch should be x86_64, got: ${cfg.match(/^hw\.cpu\.arch=.*$/m)}`);
    assert(/^abi\.type=x86_64$/m.test(cfg), 'abi.type should be x86_64');
    assert(/^image\.sysdir\.1=\S*system-images\//m.test(cfg), 'image.sysdir.1 is missing');
  });

  await test('install failure messages explain NO_MATCHING_ABIS', async () => {
    const { friendlyInstallError } = require('../src/core/adb');
    const out = friendlyInstallError(
      'Performing Streamed Install\nadb.exe: failed to install x.apk: '
      + 'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    );
    assert(out.includes('ARM native libs'), `the ARM native library issue should be explained: ${out}`);
    assert(out.includes('INSTALL_FAILED_NO_MATCHING_ABIS'), 'the original error code is kept');
    const other = friendlyInstallError('Failure [INSTALL_FAILED_INVALID_APK: x]');
    assert(other.toLowerCase().includes('corrupt') || other.toLowerCase().includes('incomplete'), `unknown errors must stay readable: ${other}`);
  });

  await test('image check tells valid ISO9660 from corrupt and partial', async () => {
    const p = new Provisioner(TMP);
    const mk = (file, size, writeMagic) => {
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, size);
      if (writeMagic) {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 0x8000);
        fs.writeSync(fd, Buffer.from('CD001', 'latin1'), 0, 5, 0x8001);
      }
      fs.closeSync(fd);
      return file;
    };

    const good = mk(path.join(TMP, 'good.iso'), 450 * 1024 * 1024, true);
    const a = p.inspectIso(good);
    assert(a.ok && a.iso9660, `a valid ISO was rejected: ${a.reason}`);

    const broken = mk(path.join(TMP, 'broken.iso'), 450 * 1024 * 1024, false);
    const b = p.inspectIso(broken);
    assert(!b.ok && /ISO9660/.test(b.reason), `a corrupt image was accepted: ${JSON.stringify(b)}`);

    const partial = mk(path.join(TMP, 'partial.iso'), 2 * 1024 * 1024, true);
    const c = p.inspectIso(partial);
    assert(!c.ok && /incomplete/i.test(c.reason), `a partial image was accepted: ${JSON.stringify(c)}`);

    for (const f of [good, broken, partial]) fs.rmSync(f, { force: true });
  });

  await test('remote stat listing keeps real mtimes', async () => {
    const { parseStatList } = require('../src/core/adb');
    const rows = parseStatList('1794309868|1234|./a.txt\n1794309900|99|./sub/b.png');
    assert(rows && rows.length === 2, `unexpected row count: ${JSON.stringify(rows)}`);
    assert(rows[0].rel === 'a.txt' && rows[0].size === 1234, 'wrong fields in the first row');
    assert(rows[1].rel === 'sub/b.png', 'wrong relative path for the subdir');
    assert(rows[1].mtime === 1794309900000, 'mtime was not converted to milliseconds');
    assert(parseStatList('ls: /nope: No such file') === null, 'non-stat output returns null for fallback');
    assert(Array.isArray(parseStatList('')) && parseStatList('').length === 0, 'an empty dir returns an empty array');
  });

  console.log('\n[engine.js]');
  const { Runtime } = require('../src/core/engine');

  await test('QEMU args: install mode mounts the ISO and boots from cdrom', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { kvm: true };
    store.saveSettings({
      runtime: { isoPath: '/tmp/img/android.iso', diskPath: '/tmp/img/disk.qcow2' },
      engine: { memoryMB: 4096, cores: 4 },
    });
    const args = rt.buildArgs({ install: true }).join(' ');
    assert(args.includes('-cdrom /tmp/img/android.iso'), '-cdrom is missing');
    assert(/order=d/.test(args), 'should boot from cdrom');
    assert(/accel=kvm/.test(args), 'should use KVM');
    assert(/-cpu host/.test(args), 'KVM uses the host CPU');
    assert(/hostfwd=tcp:127\.0\.0\.1:5555-:5555/.test(args), 'adb port forward is missing');
    assert(args.includes('-monitor tcp:127.0.0.1:5556'), 'monitor is missing');
    assert(/-m 4096/.test(args), 'wrong memory argument');
  });

  await test('QEMU args: normal boot from disk', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { kvm: false };
    const args = rt.buildArgs({ install: false }).join(' ');
    assert(!args.includes('-cdrom'), 'no ISO is mounted');
    assert(/order=c/.test(args), 'should boot from disk');
    assert(/accel=tcg/.test(args), 'no KVM falls back to TCG');
    assert(/-cpu max/.test(args), 'TCG uses the max CPU model');
    assert(args.includes('if=virtio,format=qcow2'), 'wrong disk argument');
  });

  await test('headless mode hides the VM window', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { kvm: false };
    const args = rt.buildArgs({ headless: true }).join(' ');
    assert(args.includes('-display none'), 'no display expected');
  });

  await test('QEMU monitor: handshake then command', async () => {
    // Fake monitor: greet with "(qemu) " and answer ok
    const srv = net.createServer((sock) => {
      sock.write('QEMU 8.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
      sock.on('data', (d) => {
        srv.lastCmd = d.toString().trim();
        sock.write('ok\r\n(qemu) ');
      });
    });
    await new Promise((r) => srv.listen(5556, '127.0.0.1', r));

    const rt = new Runtime(TMP);
    await rt.monitorCmd('system_powerdown');
    assert(srv.lastCmd === 'system_powerdown', `received: ${srv.lastCmd}`);
    await new Promise((r) => srv.close(r));
  });

  await test('ensure returns needsSetup without a system', async () => {
    store.saveSettings({ runtime: { installed: false }, engine: { mode: 'builtin' } });
    const rt = new Runtime(TMP);
    // A fake adb makes isOnline fail fast
    const r = await rt.ensure({ onLog: () => {} });
    assert(r.ok === false, 'should not be ready');
    assert(['provision', 'install'].includes(r.needsSetup), `needsSetup=${r.needsSetup}`);
  });

  await test('prewarm and click start the runtime once (idempotent)', async () => {
    const rt = new Runtime(TMP);
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.emulator.setPriority = async () => 0;
    let calls = 0;
    rt._ensureInner = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, engine: 'emulator' };
    };
    // Prewarm (4 s after launch) and a user click (ensure) overlap
    const [a, b] = await Promise.all([rt.prewarm({}), rt.ensure({})]);
    assert(calls === 1, `the engine booted ${calls} times; only one emulator should start`);
    assert(a && a.ok && b && b.ok, 'both paths get a ready result');
  });

  await test('readiness waits for boot_completed and the package manager', async () => {
    const rt = new Runtime(TMP);
    const calls = [];
    const fake = {
      isOnline: async () => true,
      connect: async () => true,
      shell: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('sys.boot_completed')) return '1';
        if (cmd.includes('pm path android')) return 'package:/system/framework/framework-res.apk';
        return '';
      },
    };
    const r = await rt.waitAndroidReady(fake, 5000, () => {});
    assert(r.ok, 'should be ready');
    assert(calls.some((c) => c.includes('sys.boot_completed')), 'boot_completed was not checked');
    assert(calls.some((c) => c.includes('pm path android')), 'the package manager was not checked');
  });

  await test('an unbooted system reports the stage (kernel)', async () => {
    const rt = new Runtime(TMP);
    const fake = { isOnline: async () => true, connect: async () => true, shell: async () => '0' };
    const r = await rt.waitAndroidReady(fake, 1200, () => {});
    assert(!r.ok && r.stage === 'kernel', `should stop at the kernel stage: ${JSON.stringify(r)}`);
  });

  console.log('\n[provision.js compat image / full build]');

  await test('playImageInfo validates the API 34 image', async () => {
    const dir = path.join(TMP, 'apkstart', 'runtime', 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    const prov = new Provisioner(path.join(__dirname, '..'));
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(64));
    assert(!prov.playImageInfo().ok, 'a tiny image is not ready');
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(301 * 1024 * 1024));
    const info = prov.playImageInfo();
    assert(info.ok && info.api === '34' && info.tag === 'google_apis_playstore', `the API 34 image should be ready: ${JSON.stringify(info)}`);
  });

  await test('branding assets referenced by the UI exist', async () => {
    const root = path.join(__dirname, '..');
    assert(fs.existsSync(path.join(root, 'build', 'fetch-runtime.js')), 'the runtime packaging script is missing');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    // Every local asset the About section references must be on disk
    const refs = [...html.matchAll(/src="(assets\/[^"]+)"/g)].map((m) => m[1]);
    assert(refs.length > 0, 'the About section references no assets');
    for (const rel of refs) {
      assert(fs.existsSync(path.join(root, 'src', 'ui', rel)), `missing asset: ${rel}`);
    }
    assert(html.includes('https://github.com/RoutineMiku/apkstart'), 'upstream credit is missing');
  });

  console.log(results.join('\n'));
  console.log(`\nresult: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
