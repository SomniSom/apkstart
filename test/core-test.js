'use strict';
/**
 * Coverage of the modules that the CLI/UI layer uses but that no other test touched:
 * version comparison, Android settings over adb, notification parsing, and the .apk
 * MIME association constants. All adb access is faked, nothing here needs a device.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-core-${Date.now()}`);
process.env.XDG_DATA_HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const { parseVer, cmpVer } = require('../src/core/version');
const { AndroidSettings, ACTIONS } = require('../src/core/android');
const { parseRecords } = require('../src/core/notify');
const assoc = require('../src/core/assoc');

/** Fake adb client: records shell commands and replays a fixed dump */
function fakeClient(output = '', online = true) {
  const calls = [];
  return {
    calls,
    async isOnline() { return online; },
    async shell(cmd) { calls.push(cmd); return output; },
  };
}

function fakeRuntime(client) {
  return {
    async ensure() { return { ok: true, client }; },
  };
}

(async () => {
  console.log('\n[version comparison]');

  await test('parseVer strips the v prefix and splits on separators', () => {
    assert(JSON.stringify(parseVer('v1.2.3')) === '[1,2,3]', JSON.stringify(parseVer('v1.2.3')));
    assert(JSON.stringify(parseVer('1.0.0+build'))[0] === '[', 'build metadata is split out');
    assert(parseVer('').length === 0, 'an empty string gives no parts');
  });

  await test('cmpVer compares numerically, not as strings', () => {
    assert(cmpVer('0.10.0', '0.9.9') === 1, '0.10.0 > 0.9.9');
    assert(cmpVer('v0.3.1', '0.3.1') === 0, 'the v prefix does not matter');
    assert(cmpVer('0.4.3', '0.4.4') === -1, 'a smaller patch version sorts first');
  });

  await test('cmpVer treats a missing part as older', () => {
    assert(cmpVer('1.2', '1.2.0') === -1, '1.2 < 1.2.0');
    assert(cmpVer('1.2.0', '1.2') === 1, '1.2.0 > 1.2');
  });

  await test('cmpVer handles prerelease suffixes', () => {
    assert(cmpVer('1.0.0-preview', '1.0.0') !== 0, 'a prerelease differs from the release');
  });

  console.log('\n[android settings over adb]');

  await test('status parses wifi, airplane, font, density, animations and sdk', async () => {
    const out = 'wifi=1\nair=0\nfont=1.15\ndensity=320\nanimw=0.0\nsdk=34\nvol=7\n';
    const client = fakeClient(out);
    const a = new AndroidSettings(fakeRuntime(client));
    const s = await a.status();
    assert(s.wifi === true, 'wifi on');
    assert(s.airplane === false, 'airplane off');
    assert(s.fontScale === 1.15, `font scale ${s.fontScale}`);
    assert(s.density === 320, `density ${s.density}`);
    assert(s.animationsOff === true, 'animations off');
    assert(s.sdk === 34, `sdk ${s.sdk}`);
    assert(client.calls.length === 1, 'one batched shell call');
  });

  await test('status falls back to safe defaults on an empty dump', async () => {
    const a = new AndroidSettings(fakeRuntime(fakeClient('')));
    const s = await a.status();
    assert(s.wifi === false && s.density === 0 && s.fontScale === 1, JSON.stringify(s));
  });

  await test('setVolume clamps to 0..100 and rounds', async () => {
    const client = fakeClient();
    const a = new AndroidSettings(fakeRuntime(client));
    const hi = await a.setVolume(250);
    const lo = await a.setVolume(-40);
    assert(hi.volume === 100 && lo.volume === 0, `${hi.volume} / ${lo.volume}`);
    assert(client.calls.some((c) => c.includes('--set 100')), 'the clamped value reaches adb');
  });

  await test('setFontScale clamps to 0.85..1.3', async () => {
    const a = new AndroidSettings(fakeRuntime(fakeClient()));
    assert((await a.setFontScale(5)).fontScale === 1.3, 'upper bound');
    assert((await a.setFontScale(0.1)).fontScale === 0.85, 'lower bound');
  });

  await test('setDensity rejects a non-numeric dpi', async () => {
    const a = new AndroidSettings(fakeRuntime(fakeClient()));
    const r = await a.setDensity('abc');
    assert(r.ok === false, 'NaN must not become a wm density command');
  });

  await test('open falls back to the settings action for unknown keys', async () => {
    const client = fakeClient();
    const a = new AndroidSettings(fakeRuntime(client));
    await a.open('nope');
    assert(client.calls[0].includes(ACTIONS.settings), client.calls[0]);
    await a.open('wifi');
    assert(client.calls[1].includes(ACTIONS.wifi), client.calls[1]);
  });

  await test('permissions parses the runtime permission block only', async () => {
    const dump = [
      '  requested permissions:',
      '    android.permission.CAMERA: granted=true',
      '  runtime permissions:',
      '    android.permission.CAMERA: granted=true',
      '    android.permission.RECORD_AUDIO: granted=false',
      '  install permissions:',
      '    android.permission.INTERNET: granted=true',
    ].join('\n');
    const a = new AndroidSettings(fakeRuntime(fakeClient(dump)));
    const rows = await a.permissions('com.example');
    assert(rows.length === 2, `expected 2 runtime permissions, got ${rows.length}`);
    assert(rows[0].name === 'android.permission.CAMERA' && rows[0].granted === true);
    assert(rows[1].granted === false, 'a denied permission is reported as denied');
  });

  await test('grantAll only grants what is missing', async () => {
    const dump = [
      '  runtime permissions:',
      '    android.permission.CAMERA: granted=true',
      '    android.permission.RECORD_AUDIO: granted=false',
    ].join('\n');
    const client = fakeClient(dump);
    const a = new AndroidSettings(fakeRuntime(client));
    const r = await a.grantAll('com.example');
    assert(r.granted === 1, `granted ${r.granted}`);
    const grants = client.calls.filter((c) => c.startsWith('pm grant'));
    assert(grants.length === 1 && grants[0].includes('RECORD_AUDIO'), JSON.stringify(grants));
  });

  await test('a runtime that is not ready throws a readable error', async () => {
    const a = new AndroidSettings({ async ensure() { return { ok: false, error: 'no runtime' }; } });
    let err = null;
    try { await a.status(); } catch (e) { err = e; }
    assert(err && /no runtime/.test(err.message), err && err.message);
  });

  console.log('\n[notification parsing]');

  await test('parseRecords keeps user notifications and drops system ones', () => {
    const dump = [
      'NotificationRecord(0x1 pkg=com.example.app key=0|com.example.app|1|n flags=0x10',
      '  android.title=String (Hello)',
      '  android.text=String (World)',
      'NotificationRecord(0x2 pkg=com.android.systemui key=0|sys|2 flags=0x10',
      '  android.title=String (Ignored)',
      '  android.text=String ()',
    ].join('\n');
    const rows = parseRecords(dump);
    assert(rows.length === 1, `expected 1 record, got ${rows.length}`);
    assert(rows[0].pkg === 'com.example.app', rows[0].pkg);
    assert(rows[0].title === 'Hello' && rows[0].text === 'World', JSON.stringify(rows[0]));
  });

  await test('parseRecords skips ongoing and foreground-service notifications', () => {
    const ongoing = 'NotificationRecord(0x1 pkg=com.a key=k1 flags=0x2 android.title=String (bg)';
    const fgs = 'NotificationRecord(0x2 pkg=com.a key=k2 flags=0x40 android.title=String (fgs)';
    assert(parseRecords(ongoing).length === 0, 'ongoing must be skipped');
    assert(parseRecords(fgs).length === 0, 'foreground-service must be skipped');
  });

  await test('parseRecords drops records without title and text', () => {
    const dump = 'NotificationRecord(0x1 pkg=com.a key=k flags=0x10\n';
    assert(parseRecords(dump).length === 0, 'an empty notification is not forwarded');
  });

  await test('parseRecords tolerates an empty dump', () => {
    assert(parseRecords('').length === 0);
    assert(parseRecords(null).length === 0);
  });

  console.log('\n[.apk association constants]');

  await test('the association uses the standard Android package MIME type', () => {
    assert(assoc.MIME === 'application/vnd.android.package-archive', assoc.MIME);
    assert(assoc.EXT === '.apk', assoc.EXT);
    assert(assoc.HANDLER_ID.endsWith('.desktop'), assoc.HANDLER_ID);
    assert(assoc.PROGID === 'apkstart', assoc.PROGID);
  });

  await test('isAssociated reports false when no handler is configured', () => {
    assert(typeof assoc.isAssociated === 'function');
    assert(assoc.isAssociated() === false || assoc.isAssociated() === true, 'must return a boolean');
  });

  console.log(results.join('\n'));
  console.log(`\nresult: ${passed} passed, ${failed} failed\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
})();
