'use strict';
/**
 * App-level container (pure computation layer)
 *
 * ApkStart runs a full-system QEMU VM, so it cannot load only the system services an app
 * needs: the Linux kernel, zygote and system_server must all be up.
 * What users feel as 'heavy' comes not from those services but from:
 *   1. booting all of Android for every app (40-142 s, CPU and disk saturated);
 *   2. previously opened apps staying in the background with memory, network and wake locks;
 *   3. qemu competing with the desktop at Normal priority when nothing is in front;
 *   4. file sync and notification polling running with no app open.
 *
 * Everything that can really be cut is expressed as composable, testable commands:
 *   - the environment boots once; 'opening an app' = am start + window (Runtime.beginApp);
 *   - opening an app stops other user apps, keeping only the current environment;
 *   - closing the last app idles Android, clears background processes and lowers qemu priority;
 *   - system packages are left alone by default (stopping GMS breaks push/login apps),
 *     and only an explicit 'deep trim' disables a short list of pointless background packages.
 *
 * No adb / Electron here: everything is pure and easy to regression-test.
 */

/** Never trimmed: touching them blacks out the UI or crashes apps */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Deep trim only: background updates/wallpapers/printing; stopping them never blocks an app */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play Store (background update scans)
  'com.google.android.setupwizard',         // first-run wizard
  'com.android.printspooler',               // print service
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // screen saver
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** Clearly system/framework packages: skipped by session trim to avoid friendly fire */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Only valid Android package names may reach a shell command (guards against injection) */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Trim commands to run when opening an app.
 * @param {object} o
 * @param {string} o.pkg            package being opened
 * @param {string[]} o.installed    user apps installed here (from store)
 * @param {boolean} o.deep          deep trim (disable system background packages), default false
 * @param {boolean} o.killBackground also clear cached background processes, default false
 *   (clearing at launch can hit the app coming to the front; endApp parks instead)
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Clear cached background processes (not foreground, not persistent services)
  // so 'keep only the current app' really returns memory, not just force-stops names.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // On metered networks disable background data so stores/sync cannot keep waking up
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * After the last app closes, let the container idle without eating resources.
 * No shutdown, no AVD destruction: the next open is instant, but CPU/RAM go back to the desktop.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Undo a deep trim (called when the user turns it off, so it is reversible) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Session state machine: what the container should be after a launch/close.
 * Pure, so multi-window switching and closing the last window are easy to verify.
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** One-line summary for logs/diagnostics */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Container idle (Android resident at low priority, 0 app processes)';
  return `Container active: ${n} app window(s)${plan && plan.stopped && plan.stopped.length
    ? `, stopped ${plan.stopped.length} background app(s)` : ''}`;
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
};
