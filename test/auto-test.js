'use strict';
/**
 * Regression tests for zero-config adaptation and container slimming (pure Node, no emulator)
 * Run: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.XDG_DATA_HOME = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js auto parameters]');

  await test('GPU backend selection by emulator version (host first, software fallback)', () => {
    // New versions (37.x/36.4.9+): host is most responsive, failing over to software/swangle
    assert(doctor.gpuCandidates('37.3.8.0')[0] === 'host', '37.x should prefer host');
    assert(doctor.gpuCandidates('36.4.9.0')[0] === 'host');
    assert(doctor.gpuCandidates('37.3.8.0').includes('software'), 'new versions need a software fallback');
    // On 37.x swiftshader_indirect fails GL init and must never be a candidate
    assert(!doctor.gpuCandidates('37.3.8.0').includes('swiftshader_indirect'));
    // Older versions still use swiftshader_indirect
    assert(doctor.gpuCandidates('35.1.4.0')[0] === 'host');
    assert(doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
  });

  await test('small-memory machines scale down (no hardcoded 4 GB / 4 cores)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `memory should be 2048, got ${p.memoryMB}`);
    assert(p.cores === 2, `cores should be 2, got ${p.cores}`);
    assert(p.accel === 'off', 'no acceleration should fall back to software emulation');
    assert(p.bootTimeoutMs > 240000, 'software emulation needs a longer boot timeout');
    assert(p.gpu === 'host', `render should prefer host (planVariants steps down), got ${p.gpu}`);
    // With accel off the last resort must be software rendering (TCG has no GPU)
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'the last resort must use software rendering');
    // The data partition defaults to 4/6/8 GB by free space (no hardcoded 16G) and is overridable
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `data partition should be 4-8 GB, got ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'the configured data partition size must apply');
  });

  await test('large machines do not eat unlimited memory', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `even a large host is capped: ${p.memoryMB}MB / ${p.cores} cores`);
    assert(p.accel === 'auto');
  });

  await test('retry matrix: best to most conservative, with software and cold-boot fallbacks', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `expected 3-4 attempts, got ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'missing the software fallback');
    // The last stage only skips the snapshot and minimises memory — never -wipe-data:
    // a full disk fails every stage, and a wipe would erase installed apps.
    assert(v[v.length - 1].snapshot === false, 'the last stage must skip the snapshot');
    assert(v[v.length - 1].wipe === false, 'no automatic retry may wipe user data');
    assert(v[v.length - 1].memoryMB <= 2048, 'the last stage should minimise memory');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'retry plans should not repeat');
  });

  await test('moving the image between volumes is not an image change', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'the same image must have the same identity');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'the snapshot must survive a volume move (no wasted cold boot)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'a real image change must be detected');
  });

  await test('snapshot fingerprint ignores GPU/accel/memory retries', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('log diagnosis recognises GPU/accel/path/lock problems', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('log diagnosis: 0xC0000005 exit is a render backend crash', () => {
    // issue #20/#25: exit 3221225477 right after Userspace boot properties
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Crash logs also mention render init: the crash must win over GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'the crash must win over ordinary render lines');
  });

  await test('free port probing returns an even port pair', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `bad port: ${p}`);
  });

  await test('settings show the same auto parameters as a real run', () => {
    const common = { accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044 };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host', `expected host (failover), got ${p.gpu}`);
    assert(p.accelOk === true && text.includes('hardware acceleration'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('port 5562'), text);

    // Old engines keep old backends; manual advanced values still apply
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js container slimming]');

  await test('inventory: non-x86_64 QEMU, old images, old AVDs, locks, old snapshots', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'non-x86_64 QEMU should be listed');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'x86_64 QEMU must not be deleted');
    assert(paths.some((p) => p.includes('android-30')), 'the old API 30 image should be listed');
    assert(paths.some((p) => p.endsWith('.lock')), 'lock files should be listed');
    assert(paths.some((p) => p.includes('snapshots')), 'old snapshots should be listed');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), 'inactive AVDs should be listed');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), 'the active AVD config must not be deleted');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dry run must delete nothing');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'a real cleanup frees space');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), 'inactive AVDs are removed');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), 'the active AVD is kept');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU is kept');
  });

  console.log('\n[adb.js install/launch error messages]');

  await test('Android 14 rejects for old targetSdk come with guidance', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('retries'), s);
  });

  await test('ARM translation crashes produce an actionable message', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('ARM translation') && s.includes('compatible image'), s);
  });

  console.log('\n[sharer does not re-transfer files]');

  await test('a file is not pulled back on every round', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Real state file, directories pointing into a temp dir
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // round 1: new host file is pushed
    const firstPull = calls.pull;
    await sh.sync();          // round 2
    await sh.sync();          // round 3
    await sh.sync();          // round 4
    assert(calls.push === 1, `exactly one push expected, got ${calls.push}`);
    assert(firstPull === 0, `a just-pushed file must not be pulled back, got ${firstPull}`);
    assert(calls.pull === firstPull, `no repeated pulls later, total ${calls.pull}`);
  });

  await test('huge files are never pulled back to the host', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'files above 512 MB must not be pulled back');
  });

  console.log('\n[adb/sharer file sharing]');

  await test('ls -l parsing handles Android group and date formats', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('remote listing comes from find+stat in one call', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `expected 2 files, got ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js streaming large packages]');

  await test('ZipFile and ZipArchive agree on one archive (deflate and pipeTo)', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'entry names should match');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'stored entry content should match');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'deflate entry content should match');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'streamed pipeTo output should be complete');
    } finally {
      file.close();
    }
  });

  await test('Zip64: counts and offsets come from the Zip64 EOCD', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // local header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // central directory entry: three fields set to 0xffffffff, real values in the Zip64 extra (id=0x0001)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EOCD + locator + classic EOCD (all saturated)
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive should recognise the Zip64 entry');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'ZipArchive content should be right');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'ZipArchive uncompressed size comes from the extra field');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile should recognise the Zip64 entry');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'ZipFile content should be right');
      assert(file.entries.get('hello.txt').localOffset === 0, 'ZipFile local offset comes from the extra field');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js zero-config AVD]');

  await test('AVD uses a small data partition, quickboot and a modern GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'the data partition must not be 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'no forced cold boot any more');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'snapshots come from the -snapshot flag, never a stale default_boot');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'the snapshot fingerprint should be written');
  });

  await test('launch flags carry auto memory/cores/snapshot and no deprecated GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Without a snapshot (fresh AVD / just voided) -snapshot must never be passed:
    // qemu waits for a memory state that does not exist and never boots.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // Without a snapshot only loading is disabled: -no-snapshot also disables saving,
      // so no snapshot would ever be produced.
      assert(/-no-snapshot-load/.test(fresh), '-no-snapshot-load is used when there is no snapshot');
      assert(!/ -no-snapshot( |$)/.test(fresh), '-no-snapshot must not be used (it disables saving)');
    }
    // Quickboot only with a real snapshot — it must look complete:
    // an interrupted save leaves a tiny snapshot.pb shell that counts as none,
    // otherwise the emulator tries to load it, fails and cold boots anyway.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // A shell (12-byte pb, no ram.img) counts as no snapshot
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'an incomplete snapshot is not a usable snapshot');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'a shell snapshot falls back to a cold boot');

    // Complete snapshot: pb with content plus ram.img data (hasSnapshot clears the shell)
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), 'a snapshot is used as quickboot');
    assert(!/-no-snapshot-load/.test(withSnap), 'a complete snapshot must not be skipped');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'wipe requires -wipe-data');
    // On a reset the old snapshot is not loaded but a new one MAY be saved.
    // Network repair relies on it: reset → online boot → snapshot → resume.
    // -no-snapshot used to disable saving and no snapshot was ever written.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'a wipe must not load the old snapshot');
    assert(!/ -no-snapshot( |$)/.test(cold), 'a wipe still allows saving a new snapshot');
  });

  // Rotating changes the physical panel and restarts; wm size/density alone is not enough.
  //   - wm size: the panel stays portrait -> rotated corner strip, offset taps;
  //   - wm density: framebuffer unchanged -> the picture does not fill.
  await test('landscape comes from the physical panel (lcdFor), never runtime wm size', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `portrait should be 720x1280, got ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `landscape should be 1280x720, got ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation must not set wm size overrides');
    assert(/wm density 190/.test(body), 'density stays only as a fallback path');
  });

  await test('game mode uses high priority and no global mouse hook', () => {
    // Linux: PowerShell-агента и WH_MOUSE_LL нет вовсе, приоритет ставит сам emulator
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(!/WH_MOUSE_LL|agent\.setHook/.test(aw), 'в Linux-окне не должно быть глобального хука мыши');
    const emu = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    assert(/const perf = this\.settings\?\.engine\?\.priorityMode === 'performance'/.test(emu), 'приоритет выставляется при запуске эмулятора');
  });

  await test('foreground apps must not use below priority', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // balanced/performance use normal in the foreground: below starves qemu,
    // dropping video frames and delaying clicks.
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      'beginApp maps game to game and everything else to normal');
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      'balanced must not fall to below');
    // setPriority runs on every beginApp, not only the first
    assert(begin.split('setPriority(level)').length >= 2 || /if \(first\)[\s\S]{0,200}cancelSnapshotSave[\s\S]{0,300}setPriority\(level\)/.test(begin),
      'setPriority runs on every beginApp');
  });

  await test('frugal mode lowers the memory cap', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'save mode caps memoryMB at 2048 (about 1 GB RAM and 1 GB snapshot)');
    assert(/!overrides\.memoryMB/.test(doc), 'a manual memory value wins over save mode');
  });

  await test('a failed download deletes leftovers (else endless re-downloads)', () => {
    const dl = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'download.js'), 'utf8');
    assert(/function discardPartial/.test(dl), 'discardPartial is required');
    assert(/chunks\.json/.test(dl), 'discardPartial also removes the chunk sidecar');
    // The failure paths of download / downloadParallel / downloadMulti all call it
    const calls = (dl.match(/discardPartial\(/g) || []).length;
    assert(calls >= 6, `too few cleanup points (only ${calls}); some paths still leave partial files`);
    // Outer safety net: an openStream reject (refused / DNS / timeout) is cleaned too
    assert(/catch \(e\) \{[\s\S]{0,200}discardPartial\(dest\)[\s\S]{0,80}throw e;[\s\S]{0,40}\}[\s\S]{0,10}\}/.test(dl),
      'download catches openStream rejects at the outer level');
  });

  await test('leftover cleanup finds ApkStart directories anywhere but never the running one', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-left-'));
    try {
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'ApkStart.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('ApkStart-v0.3.9-win64-portable');
      const old2 = mk('ApkStart-win64-portable.prev-2026-01-01T00-00-00-000Z');
      const curDir = mk('ApkStart-v0.5.0-win64-portable');
      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));
      assert(found.includes(np(old1)), 'a plain old version directory was not found');
      assert(found.includes(np(old2)), 'a .prev backup leftover was not found');
      assert(!found.includes(np(curDir)), 'the running version was treated as old (dangerous)');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('auto deploy has a failure cooldown', () => {
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(/deployFailedAt/.test(mainJs), 'the last failure time is recorded');
    assert(/COOLDOWN_MS|cooldown/.test(mainJs), 'a cooldown window exists');
    assert(/force/.test(mainJs.slice(mainJs.indexOf('async function autoDeploy'))),
      'a manual setup bypasses the cooldown');
  });

  await test('ram.bin from new emulators counts as a complete snapshot', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin counts as a complete snapshot');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), 'a snapshot uses quickboot');
    assert(!/-no-snapshot-load/.test(args), 'a complete snapshot is not skipped');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('userdata seed: 4K blocks, ENCRYPT, consistent accounting', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'the superblock magic must be 0xEF53');
    // dm-default-key (Android 13 /data metadata encryption) has a 4096 logical block size;
    // a smaller fs block makes mount() return EINVAL.
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size must be 2 (4096 bytes)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size must equal the block size');
    // Without ext_attr setxattr returns EOPNOTSUPP, SELinux labels fail and
    // netd / media / tombstoned exit 1, leaving the boot animation forever.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'ext_attr is required');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'free blocks must lie in (0, total)');
    assert(freeInodes === inodes - 10, 'free inodes exclude the reserved 1-10 (e2fsck checks it)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'ENCRYPT is on by default (required for FBE)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'encrypt:false clears the bit');
  });

  console.log('\n[display / shortcuts / zero setup]');
  await test('window mode really opens a window', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'window mode must not pass -no-window');
    // Never pass -no-skin: it overrides -skin and falls back to the config.ini panel size,
    // which shows as 'landscape selected, still portrait'.
    assert(!/\s-no-skin(\s|$)/.test(win), 'window mode must not pass -no-skin');
    assert(/-skin \d+x\d+/.test(win), 'window mode must pass -skin');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    // Linux: -no-window не передаём никогда — окно эмулятора и есть окно приложения
    assert(!/-no-window/.test(headless), 'на Linux окно эмулятора обязательно');
  });

  await test('audio is on by default; -no-audio only when disabled', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Override the settings getter: audio on means no -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), '-no-audio must not be passed with audio=true');
    // Only a disabled setting passes -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), '-no-audio is passed with audio=false');
  });

  await test('old configs migrate: headless and hide-after-launch are dropped', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless migrates to false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch is false');
    assert(s.autoStart === true && s.autoDeploy === true, 'autostart and auto deploy are on by default');
    assert(s.createStartMenuShortcut === true, 'the menu shortcut is on by default');
  });

  await test('display fit: window and fullscreen share the portrait resolution', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // Fullscreen keeps the Android resolution (the aspect is locked by the LCD) and maximises
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', 'bogus landscape', area).h > d.sizeFor('window', 'bogus landscape', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Fullscreen: full height, width from the portrait ratio, centred
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('adb display commands use wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-иконки: hicolor и .desktop ссылаются на существующий файл', async () => {
    const { installIcon, desktopEntry } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const entry = desktopEntry({
      name: 'Тест', exec: '/usr/bin/true', args: ['--launch', 'com.test.app'], icon: 'apkstart-com.test.app',
      startupWMClass: 'apkstart-com.test.app',
    });
    assert(/^\[Desktop Entry\]/m.test(entry) && /^Type=Application$/m.test(entry), 'нет обязательных ключей Desktop Entry');
    assert(/^Exec="\/usr\/bin\/true" "--launch" "com\.test\.app"$/m.test(entry), `Exec собран неверно: ${entry}`);
    assert(/^MimeType=/m.test(entry) === false, 'у ярлыка приложения не должно быть MimeType');
  });

  await test('xzFile feeds stdin and produces a runtime-unpackable image', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // fast preset for a small sample
    process.env.XZ_TIMEOUT_MS = '15000';  // kill a real hang within 15 s
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile did not return within 25 s (stdin never ended?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'the compressed output must not be empty');
    let back;
    if (/\.xz$/i.test(out)) {
      // Do not rely on the @napi-rs/lzma native binding: Node 20 jobs can fail to load it
      // because of a known optional-dependency bug (Node 22 is fine).
      // Python lzma reads it back and the XZ magic is checked;
      // runtime compatibility is covered by the end-to-end package test.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'must be a valid XZ container');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'XZ produced but python is missing for verification');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'the decompressed bytes must match the source');
  });

  console.log('\n[container.js app-level container]');

  const container = require('../src/core/container');

  await test('system/framework packages are never trimmed', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} should be a user app`);
      else assert(sys, `${p} should be a system package`);
    }
    assert(container.isSystemPackage(''), 'an empty name counts as system (no invalid commands)');
  });

  await test('launching stops other user apps only, never system ones', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `expected 2 other user apps stopped, got ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'system packages are never disabled by default');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'no background clearing at launch');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'never force-stop the framework');
  });

  await test('package whitelist prevents command injection', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `only valid package names are stopped, got ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'no injection fragments allowed');
  });

  await test('deep trim disables background packages, fully reversible', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'deep trim should have something to disable');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} must never be disabled`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} must be reversible`);
    }
  });

  await test('container parking: clear background and idle Android', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'parking clears cached background processes');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'parking puts Android into idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'closing the last window parks the container');
  });

  await test('doctor lightweight container: caps vCPUs, manual values win', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // floor(cores/4) clamped to 2-3 gave two vCPUs on eight cores and video stalled.
    // Balanced now uses half the cores (max 4); frugal uses 2.
    assert(lite && lite.cores === 4, `balanced on 16 cores should give 4, got ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `frugal should use 2 cores, got ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'an explicit off returns null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, 'a 2-core host keeps 2 cores');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(manual.cores === 6, 'a manual core count wins over lightweight mode');
    assert(/lightweight container/.test(doctor.describeProfile(auto)), 'the summary marks the lightweight container');
  });

  await test('no global mouse hook and no resident agent on Linux', () => {
    const root = path.join(__dirname, '..');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'side-button hooking is off by default');
    assert(!/\\.ps1/.test(agentJs), 'the agent ships no PowerShell script on Linux');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'the main process never installs a global hook');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'the app window never installs a global hook');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'file sync is not resident unconditionally');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'the settings page exposes the lightweight container option');
  });

  await test('WinAgent.setHook(false) does not start the agent', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'turning it off returns hooked=false');
    assert(a.ready === null, 'no agent process is started for that');
  });

  console.log('\n[mouse button mapping]');

  await test('defaults and migration: right-click back, smooth wheel, no side buttons', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'right-click back is on by default');
    assert(d.wheel === 'smooth', 'smooth wheel by default');
    assert(d.side === false, 'side buttons off by default');
    assert(d.enabled === true, 'at least right-click needs the hook');
    // Old settings.json without the new keys yields the same result
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'no hook when everything is off');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'native wheel needs no hook');
  });

  await test('hookOptions normalises the config and zeroes sub-switches', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false intercepts nothing');
    assert(pointer.hookOptions(true).side === true, 'legacy boolean form (side buttons)');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('wheel direction: down means finger up, up means finger down, in bounds', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'wheel down scrolls content up (finger up)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'wheel up scrolls content down (finger down)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'zero delta produces no command');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x must stay in bounds');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y must stay in bounds');
      assert(s.duration >= 100 && s.duration <= 240, 'swipe duration is capped');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'fast scrolling does not stretch the gesture forever');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'horizontal wheel produces a horizontal swipe');
  });

  await test('input command whitelist blocks injection', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /Invalid/.test(e.message); }
    assert(blocked, 'invalid commands are rejected before adb runs');
    assert(c._input === null, 'a rejected command creates no session');
  });

  await test('back goes through the persistent channel, adb only as fallback', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'the normal path spawns no adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'a failed channel falls back instead of losing the click');
  });

  await test('WheelRouter merges continuous scrolling into one swipe', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 notches should merge into 1 command, got ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'a valid input swipe is produced');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'the merged swipe keeps the downward direction');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'nothing is injected after dispose');
  });

  await test('окно приложения: поиск окна эмулятора и управление им (Linux)', () => {
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/xdotool/.test(aw), 'поиск и управление окном должны идти через xdotool');
    assert(/wmctrl/.test(aw), 'полноэкранный режим должен идти через wmctrl');
    assert(/set_window.*--name/s.test(aw), 'заголовок окна выставляется через xdotool set_window');
    assert(/--class/.test(aw), 'WM_CLASS нужен для группировки окон и иконки в доке');
    assert(/preflight/.test(aw), 'нужна проверка наличия инструментов');
    assert(!/WH_MOUSE_LL|powershell|require\('\.\/agent'\)/.test(aw), 'без Win32-хвостов');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'настройки клавиш мыши должны остаться в UI');
  });

  await test('обновление: выбирается только Linux-артефакт', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-linux');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'apkstart');
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(u.flavor === 'portable', 'на Linux нет установщика — только AppImage/каталог');
    // через _applyLinux проверяем генерацию sh-скрипта без запуска
    const script = u.apply({ mode: 'appimage', payload: '/tmp/new.AppImage', version: '9.9.9' }, { spawn: false, waitPid: 1 });
    assert(/^#!\/bin\/sh/m.test(script) && /kill -0 1/.test(script), 'скрипт должен ждать выхода процесса по pid');
    assert(/cp -f/.test(script) && /chmod \+x/.test(script), 'обновление подменяет файл и ставит права');
  });

  await test('обновление не берёт рантайм-пакет и win-архивы как программу', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset-linux');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'apkstart');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'ApkStart-v0.5.0-Setup.exe', url: 'https://x/s.exe', urls: ['https://x/s.exe'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(!info.asset, 'без AppImage/linux.zip автоматическое обновление не предлагается');
    assert(info.canAutoApply === false, 'canAutoApply должен быть false');

    u.sources = { latest: async () => mk([
      { name: 'ApkStart-0.5.0.AppImage', url: 'https://x/a.AppImage', urls: ['https://x/a.AppImage'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(info.asset && /AppImage$/.test(info.asset.name), `должен выбраться AppImage, а не ${info.asset && info.asset.name}`);
    assert(info.canAutoApply === true, 'с AppImage обновление автоматическое');
  });

  await test('sources: mirror prefixes are candidates, custom wins', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, 'the origin comes first before ranking');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), 'automatic mirrors are candidates');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `the custom prefix is the only one, got ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, 'no automatic mirrors means direct only');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, 'a missing trailing slash is added');

    // Mirrors proxy GitHub only: a prefixed Gitee URL just 403s and is not a candidate
    const giteeUrl = 'https://gitee.com/daily-miku/apkstart/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'Gitee assets get no GitHub mirror prefix');
  });

  await test('sources: ranking sorts by speed and keeps all failures last', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // Inject the speed cache so the test needs no network
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `the fastest should be first, got ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'failed URLs sort last but stay (one more chance)');
    s.reset();
    assert(s._rankCache.size === 0, 'reset clears the speed cache');
  });

  await test('sources: Gitee source archives are never installers', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'ApkStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `only ApkStart* assets should remain, got ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Gitee assets without size still form a part group', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Gitee release assets carry name + url only, no size
        assets: [
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `expected 1 asset, got ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'ApkStart-v0.3.3-win64-portable.zip', `the asset name should be the whole package, got ${a.name}`);
    assert(a.parts && a.parts.length === 2, 'both parts are kept');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', 'part URLs keep their order and content');
    assert(a.size === 0, 'unknown size means 0 (progress by bytes received)');
  });

  await test('частичные (part) ассеты отбрасываются, если платформа не подходит', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'apkstart'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'ApkStart-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset === null, 'win-архив не должен предлагаться на Linux');
  });

  await test('sources: only same-version assets merge', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'ApkStart-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `the higher version should win, got ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', 'an older same-name asset never overrides the new one');
  });

  await test('window agent: scope joins dirs with semicolons and drops empties', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // No real agent process: only the protocol payload is checked
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `expected a single scope message, got ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `empty entries must be dropped, got ${sent[0].dirs}`);
    assert(r.ok === true, 'a successful scope returns ok');
    // An empty list must not throw: it suppresses nothing and the caller decides
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'an empty scope is still delivered');
  });

  await test('sources: both URLs are kept for the same package name', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Gitee assets have no size; do not reuse the GitHub one
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `same-name assets merge into 1, got ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `both source URLs are kept, got ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], 'sizes are tracked per URL; unknown stays unknown');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `candidates include both sources, got ${JSON.stringify(cands)}`);
  });

  await test('parallel download follows the fastest source, not the largest', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // first source, already ranked by speed
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // List order is rank()'s speed order: the first is the fastest
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `expected ${small.length} bytes from the fastest source, got ${got.length}`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('split packages reassemble in order and abort on size mismatch', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, 'the joined size equals the sum of parts');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), 'part 1 content is out of order');
      assert(got.slice(partA.length).every((b) => b === 0x42), 'part 2 content is out of order');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('parallel download: chunks from different sources match exactly', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // Wait for the listening callback; attaching late misses the event and hangs
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'assembled bytes must equal the source file');
      assert(r.sources === 2 && r.parallel >= 2, `both sources should be used, got ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'sizes must match');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('parallel download resumes only missing chunks', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // count data requests only (0-0 probes excluded)
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // Two URLs are required: one URL goes to the single-source path
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // First two chunks done, last one missing (3 connections x 1MB)
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'recognised as a resume');
      assert(ranged === 1, `expected 1 chunk refetched, got ${ranged}`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'the resumed file must equal the source');
      assert(!fs.existsSync(`${out}.chunks.json`), 'the sidecar file is removed on completion');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('downloader times out a silent connection instead of hanging', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // Headers arrive, then silence: TCP up but throttled
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // Send 1 KB, then nothing
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'the download must complete');
      assert(cost < 15000, `must not hang on a stalled connection, took ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('downloader switches away from a crawling source', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Slow source: 4 KB every 100 ms (~40 KB/s)
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'content must be correct after switching');
      // 2 MB at 40 KB/s takes ~50 s; switching must happen within seconds
      assert(cost < 15000, `should switch on low throughput, took ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('parallel download falls back to single source', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Use a just-freed port as the bad source: connection refused instead of timeout
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // The second URL points at a dead port and must be ignored
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'a single source still completes');
      assert(!r.multi || r.sources === 1, 'a single usable source is not marked multi');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('sources: release results cache for 10 minutes, force refetches', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `no refetch within the cache window, got ${calls}`);
    await s.latest({ force: true });
    assert(calls === 2, 'force bypasses the cache');
    s.reset();
    await s.latest();
    assert(calls === 3, 'reset refetches');
  });

  await test('sources: a 403 rate limit trips the breaker', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 (rate limited)' },
      ];
    };
    // First round: Gitee answers 403 and is tripped
    await s.latest({ force: true });
    assert(giteeCalls === 1, 'the first round actually requests');
    const reason = s.blockedReason('gitee');
    assert(!!reason, '403 trips the breaker');
    assert(s.blockedReason('github') === null, 'healthy sources stay unblocked');
    // While tripped, requests are skipped without touching the network
    assert(/skipped/i.test(reason), `the skip reason should be readable, got: ${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'reset clears the breaker');
  });

  await test('sources: all unreachable falls back to the last result as stale', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'the first call is normal');
    s._relTtl = 0;   // expire the cache
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'timeout' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'the old result returns marked stale');
  });

  await test('system image root: a fresh install lands in the runtime dir', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) Fresh install: neither dir has system-images, so use the runtime dir
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `a fresh install uses the runtime dir, got ${p.paths().sysImgRoot}`);

      // 2) Already in the runtime dir (unpacked package), prefer it
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'an existing runtime dir wins');

      // 3) Only the user data dir has it (legacy layout), use it
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `the legacy layout falls back to the user data dir, got ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[resource policy / disk / log cap]');

  await test('one resource preset drives vCPU, priority and resolution', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'smooth mode does not cap cores');
    assert(s.engine.priorityMode === 'game', 'smooth mode uses low-latency priority');
    assert(s.engine.renderSize === '720x1280', `resolution should be 720p, got ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'frugal is 540p with the lightweight container');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'balanced leaves resolution to auto');
  });

  await test('data partition size is configurable', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `should be 12 GB, got ${p.dataMB} MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `plenty of disk means 6 GB, got ${auto.dataMB}`);
  });

  await test('the snapshot fingerprint ignores the data size', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'changing capacity keeps the fingerprint');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'changing the engine version changes it');
  });

  await test('logs rotate past the cap and keep one backup', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'rotation happens');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'it becomes .1.log');
  });

  await test('a log without a .log suffix is never deleted by rotation', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'identical bak and source names skip rotation');
    assert(fs.existsSync(f), 'the log file is not deleted');
  });

  await test('failure records persist across restarts', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / hardware acceleration', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'the exit code is persisted');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'the diagnosis is persisted');
    assert(back.attempts.length === 1, 'attempts are persisted');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'a successful launch clears the failure');
  });

  await test('.xapk split packages: stream parts, parse base, clean up on failure', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Success: two parts (base + config), meta from the parsable one
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `expected 2 parts, got ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'parts are written to disk');
      assert(b.meta.package === 'com.example.test', `package ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Failure: no APK part, a clear error, no temp dir left behind
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /No APK splits found/i.test(err.message), `should report missing parts, got ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'apkstart-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), 'the temp dir is cleaned up on failure');
  });

  await test('materializeImages unpacks .img.gz, skips unpacked, fails cleanly', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40 MB of zeros gzips to tens of KB but expands past 32 MB: checks the skip rule
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `expected 1 image unpacked, got ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'the unpacked size is correct');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'uncompressed components are placed too');
      assert(!fs.existsSync(`${img}.part`), 'no .part file after success');

      const again = await prov.materializeImages();
      assert(again === 0, `unpacked images are skipped, unpacked ${again}`);

      // Corrupt image: throws MATERIALIZE_FAILED and removes .part
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `a corrupt image must fail, got ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'no .part file after failure');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('changing the source clears the provisioner URL cache', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Simulate a cache after resolving package and engine URLs
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'the package URL cache is cleared');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'the engine/image URL cache is cleared');
  });

  await test('each launch is diagnosed from its own log lines', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // round 1: 0xC0000005
      { t: 3, line: '--- round 2 ---' },
      { t: 4, line: 'Address already in use' },          // round 2: port busy
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'round 1 is a crash');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', 'round 2 is a busy port');
    // An empty round falls back to the log tail instead of UNKNOWN
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `an empty round uses the whole log, got ${fallback.length} lines`);
  });

  await test('component args never repeat the package name', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Full components (what apps.json stores) are used as is
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'a full component is returned unchanged');
    // Legacy data: bare class names get the package prefixed
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'an empty activity returns empty (implicit intent)');
    // resolve-activity output ends with blank/priority lines: still find the component
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'blank lines are skipped for the last component line');
    assert(parseResolvedActivity('com.other', out) === '', 'another package name is rejected');
  });

  console.log(results.join('\n'));
  console.log(`\nresult: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
