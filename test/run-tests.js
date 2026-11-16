'use strict';
/**
 * Pure Node unit tests (no Electron, adb or network needed)
 * Run: npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('parses a stored zip the way this project builds it', () => {
  // Verify parsing with a minimal in-memory zip (stored mode)
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello apkstart');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // central directory size
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // central directory offset

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), 'hello.txt should be found');
  assert(zip.read('hello.txt').toString() === 'hello apkstart', 'content should match');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('the PNG encoder emits a valid signature and IHDR', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'PNG signature');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, 'sane length');
});
test('the app icon renders at any size', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `width should be ${s}, got ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// Test fixture: the APKSTART_TEST_APK env var wins,
// otherwise common local APK paths are tried (read-only)
function findFixture() {
  const candidates = [
    process.env.APKSTART_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  (fixture: ${fixture})`);
  test('quickCheck detects the PK header', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('parses package, version and launch activity', () => {
    assert(/^[\w.]+$/.test(meta.package), `bad package name: ${meta.package}`);
    assert(meta.versionName, 'versionName is missing');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `bad launch activity: ${meta.launchActivity}`);
  });
  test('parses a usable icon', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, 'icon is empty or too small');
    assert(meta.label, 'label is empty');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('the AXML root is manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('resources.arsc parses', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, 'at least one package is expected');
    }
  });
} else {
  console.log('  (skipped: no APK fixture, set APKSTART_TEST_APK)');
}

// The synthetic APK builder lives in test/lib/make-apk.js so the parser stays covered
// without a real fixture; run-tests and auto-test share it.
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[synthetic APK: axml + apk end to end]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('attrValue namespace semantics: null means any, default android only', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: 'Test' },
      ],
    };
    // Attributes without a namespace (package) need null; parseApk relies on this
    assert(attrValue(node, 'package', null) === 'com.a.b', 'package needs ns=null');
    assert(attrValue(node, 'package') === null, 'android namespace only by default');
    assert(attrValue(node, 'label') === 'Test', 'android attributes use the default namespace');
    assert(attrValue(node, 'label', null) === 'Test', 'ns=null still finds android attributes');
  });
}
{
  const tmp = path.join(os.tmpdir(), `apkstart-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('package: the manifest attribute carries no namespace', () => {
      assert(meta.package === 'com.example.test', `got ${meta.package}`);
    });
    test('label, version and SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('launch activity comes from the intent-filter', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('ABI dirs and icon resources', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, 'the icon should be a PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, 'file size is filled in');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

console.log(`\nresult: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
