'use strict';
/**
 * Container-style layering: read-only base image + slim runtime + reclaimable scratch layer
 *
 * The analogy (same as Docker):
 *   system-images/  = read-only base layer shared by every app and session, never copied
 *   avd/*.avd/      = writable thin layer (qcow2 delta + quickboot snapshot), only changes
 *   _tmp/ snapshots = reclaimable scratch layer
 *
 * This module only inventories and reclaims by explicit list; dry-run by default, user files untouched.
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/**
 * Inventory the runtime and list entries that can be reclaimed safely.
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, { keepAvd = 'apkstart.avd', aggressive = false, keepSnapshots = false } = {}) {
  const groups = [];
  const candidates = [];
  if (!exists(root)) return { total: 0, groups, candidates };

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file') => candidates.push({ path: p, size, reason, kind });

  groupOf('emulator engine', path.join(root, 'emulator'));
  groupOf('system image (read-only base layer)', path.join(root, 'system-images'));
  groupOf('AVD writable layer / snapshot', path.join(root, 'avd'));
  groupOf('platform-tools', path.join(root, 'platform-tools'));

  // 1) QEMU needs only the x86_64 target; the other seven architectures are pure waste
  const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (exists(qemuDir)) {
    for (const f of walk(qemuDir)) {
      if (/qemu-system-(aarch64|armel|i386)/i.test(path.basename(f.path))) {
        add(f.path, f.size, 'non-x86_64 QEMU target, unused at runtime');
      }
    }
  }

  // 2) licence texts / redundant directories inside the image package
  for (const f of walk(path.join(root, 'system-images'))) {
    if (/^(NOTICE\.txt|source\.properties)$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) {
      add(f.path, f.size, 'large documentation file inside the image package');
    }
  }

  // 3) Keep one system image: once the API 34 Play image is in place, API 30 images are obsolete
  const play34 = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img');
  if (exists(play34)) {
    const legacy = path.join(root, 'system-images', 'android-30');
    if (exists(legacy)) add(legacy, dirSize(legacy), 'old API 30 image (stale ARM translation layer)', 'dir');
  }
  const stray = path.join(root, 'x86_64');
  if (exists(stray)) add(stray, dirSize(stray), 'duplicate image directory from a misplaced unpack', 'dir');

  // 4) Inactive AVDs: only 'apkstart' is used; test leftovers (apkstart-arm, -houdini) can go
  const avdHome = path.join(root, 'avd');
  if (exists(avdHome)) {
    for (const e of fs.readdirSync(avdHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.avd') || e.name === keepAvd) continue;
      add(path.join(avdHome, e.name), dirSize(path.join(avdHome, e.name)),
        'inactive AVD (old userdata image of 8-16 GB)', 'dir');
    }
    // 5) Lock files: leftovers cause 'AVD is already running'
    for (const f of walk(avdHome)) {
      if (/\.lock$/i.test(f.path)) add(f.path, f.size, 'lock file left by an unclean exit');
    }
    // 6) Quickboot snapshot: ram.img ≈ the VM memory; must be dropped when corrupt or reconfigured
    const activeAvd = path.join(avdHome, keepAvd);
    if (exists(activeAvd) && !keepSnapshots) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        // Both the normal snapshot and renamed ones left after a failed delete are reclaimable
        if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
        const p = path.join(activeAvd, e.name);
        add(p, dirSize(p), 'old quickboot snapshot (rebuilt automatically after a config change)', 'dir');
      }
    }
  }

  // 7) Download cache / leftover QEMU ISOs
  for (const d of ['_tmp', 'images']) {
    const p = path.join(root, d);
    if (exists(p)) {
      const size = dirSize(p);
      if (size > 0) add(p, size, d === '_tmp' ? 'temporary download files' : 'old QEMU/ISO leftovers', 'dir');
    }
  }

  // 8) Aggressive trimming: release builds only.
  // Qt6WebEngineCoreAndroidEmu.dll is a load-time dependency of qemu-system-x86_64 —
  // removing it stops the emulator; qsn/netsim may be called by snapshots and networking, so keep them.
  if (aggressive) {
    const extras = [
      ['emulator/crashreport', 'crash reporter (not needed in normal runs)'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * Reclaim. Requires an explicit apply:true; the caller (UI/build script) shows the list first.
 * Safety: every target must be inside root, and root itself can never be deleted.
 */
function prune(root, { apply = false, keepAvd, aggressive = false, keepSnapshots = false, onRemove = () => {} } = {}) {
  const report = analyze(root, { keepAvd, aggressive, keepSnapshots });
  const rootAbs = path.resolve(root);
  const removed = [];
  let saved = 0;
  for (const c of report.candidates) {
    const p = path.resolve(c.path);
    if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;
    if (!exists(p)) continue;
    if (apply) {
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* busy file — skip, clean next time */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** Short summary for the settings page */
function summary(root) {
  const a = analyze(root);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // Beyond the runtime directory, users care how much disk this takes overall:
  // AVD (app data + snapshots), APK cache, icons and logs all count.
  const store = require('./store');
  const extra = [
    { key: 'avd', label: 'Android data (apps + snapshots)', path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: 'APK cache', path: store.APK_DIR },
    { key: 'icons', label: 'icon cache', path: store.ICON_DIR },
    { key: 'logs', label: 'logs', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: 'runtime (engine + system image)', size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
