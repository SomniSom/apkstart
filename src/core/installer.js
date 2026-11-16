'use strict';
/**
 * Install / launch / uninstall orchestration layer
 * Chains parse APK → install into the runtime → persist metadata → create .desktop entries.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const {
  installIcon, writeDesktopFile, desktopEntry, removeShortcut, safeFileName, xdgDirs,
} = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The APK ships ARM native libs only (true of most apps) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Split packages (.apks / .xapk): extract the split APKs into an ASCII-only temp directory.
 * Uses the file-based ZIP reader and streams to disk: bundles reach 2 GB+ and do not fit in RAM.
 * Returns { meta, files, cleanup }; meta comes from the base APK carrying AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('No APK splits found in this bundle (not a .apks/.xapk?)');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // A single split can be hundreds of MB: stream it, never through a Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* no manifest in this split */ }
    }
    if (!meta) throw new Error('Failed to parse the bundle base APK');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  /** Имя файла .desktop для приложения (без пробелов, стабильно между установками) */
  desktopFileName(app) { return `${app.package}.desktop`; }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, this.desktopFileName(app));
  }

  /**
   * Ярлык на рабочем столе + запись в меню приложений.
   * В меню (~/.local/share/applications) приложение находится через поиск GNOME/KDE,
   * поэтому в отличие от Windows «Старт» здесь ставим тот же файл, но с именем пакета:
   * так две программы с одинаковым названием не затирают друг друга.
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.applicationsDir && store.getSettings().createStartMenuShortcut !== false) {
      out.push(path.join(this.ctx.applicationsDir, this.desktopFileName(app)));
    }
    return [...new Set(out)];
  }

  /** Имя иконки для .desktop: раскладываем PNG из APK в hicolor, иначе берём путь к PNG */
  prepareIconImage(app) {
    const src = app.iconPath && fs.existsSync(app.iconPath) ? app.iconPath : null;
    if (!src) return null;
    try {
      return installIcon(fs.readFileSync(src), `apkstart-${app.package}`) || src;
    } catch (_) {
      return src;
    }
  }

  /** Download the compatible image on the first ARM app; a shared read-only layer fetched once */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'First ARM app: downloading the compatible image (~1.5 GB, once)…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Compatible image download failed — check the network and retry');
    return true;
  }

  /** Switching the image restarts the runtime; installed apps are restored from local APK backups */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Switching to the compatible image and restarting the runtime…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Wait until the old device leaves the adb list so ensure() does not reuse it
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime unavailable after switching the compatible image');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Restoring ${app.label}…` });
      } catch (_) { /* a single failed restore does not block */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Parsing the APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Recognised ${meta.label} (${meta.package})`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    try {
      // Zero-config: ARM-only apps automatically get the image with the ARM translation layer
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Preparing the Android runtime…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Runtime unavailable');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Install, persist metadata and create shortcuts; one automatic repair retry on failure */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // After install the old quickboot snapshot is stale and would hide the new app after a restart
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Updating the app…' : 'Installing the app…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // An ABI mismatch here means an AOSP image: switch to the compatible one and retry
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Switched to the compatible image, reinstalling…' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Иконка на диск: PNG кладём как есть, WebP декодирует рендерер
    // (nativeImage WebP не умеет). На Linux обходится без ICO — достаточно PNG
    // в hicolor, но если и его получить не удалось, ставим брендовый placeholder.
    let iconPath = null;
    let iconMime = 'image/png';
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
        iconMime = /^\xFF\xD8/.test(meta.iconPng.toString('latin1', 0, 2)) ? 'image/jpeg' : 'image/png';
      } catch (_) { /* ignore */ }
      if (iconMime !== 'image/png') {
        try {
          if (typeof this.ctx.decodeIcon === 'function') {
            const png = await this.ctx.decodeIcon(meta.iconPng);
            if (Buffer.isBuffer(png) && png.length) {
              iconPath = store.iconPath(meta.package);
              fs.writeFileSync(iconPath, png);
              iconMime = 'image/png';
            } else {
              iconFallback = 'decode-output-invalid';
            }
          } else {
            iconFallback = 'no-decoder';
          }
        } catch (_) { iconFallback = 'webp-decode-failed'; }
      }
    }

    // Keep a copy of the APK for reinstall/recovery
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // Trust the system's resolution: the 'main activity' parsed from the APK is often not
    // the real LAUNCHER entry, and starting it skips app init and crashes.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* keep the parsed result */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      iconMime,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Creating the desktop shortcut…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Shortcut creation failed: ${e.message}` });
      }
    }

    // Compatibility hints: ARM-only apps need the translation layer on an x86 runtime
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`This app needs Android ${meta.minSdk}+, newer than the current runtime; it may not run.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('The app icon could not be parsed (unusual adaptive icon); the shortcut uses a placeholder.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('The WebP app icon failed to decode; the shortcut uses a placeholder.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // Installing voided the old snapshot; schedule a new one so the installed state is saved
    // while idle — otherwise the next start is a 20-second cold boot.
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} installed`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const icon = this.prepareIconImage(app);
    const paths = this.shortcutPaths(app);

    const content = (name) => desktopEntry({
      name,
      comment: `${app.label} — запускается через ApkStart`,
      exec: target,
      args: [...(baseArgs ? [baseArgs] : []), '--launch', app.package],
      icon: icon || undefined,
      categories: 'Utility;',
      // отдельная WM_CLASS на приложение: DE группирует окна и подхватывает иконку
      startupWMClass: `apkstart-${app.package}`,
    });

    let first = null;
    let menuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        writeDesktopFile(p, content(app.label));
        if (!first) first = p;
        if (i === 1) menuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // Если оба каталога не пишутся (read-only home, странный sandbox) —
    // последняя попытка кладём файл прямо на рабочий стол.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, this.desktopFileName(app));
      try {
        writeDesktopFile(fallback, content(app.label));
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'не удалось создать .desktop');
    if (menuPath) store.upsertApp({ package: app.package, startMenuPath: menuPath });
    return first;
  }

  /** Дописать отсутствующие ярлыки и иконки (старые установки, удалённые файлы) */
  async ensureShortcuts() {
    const made = [];
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.iconPath || !fs.existsSync(app.iconPath)) && fs.existsSync(store.iconPath(app.package))) {
        app.iconPath = store.iconPath(app.package);
        dirty = true;
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath, iconPath: app.iconPath });
        made.push(app.label);
      } catch (_) { /* один сбой не блокирует запуск */ }
    }
    return made;
  }

  /** Fill in missing shortcuts and icons from updates made before Linux support */
  async ensureShortcuts() {
    const made = [];
    // Do not recreate entries when the user disabled auto-create and the app has none,
    // otherwise the switch would be ignored on every start.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* icon rebuild failure does not block the entry */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // Rebuild even if the .desktop exists so the real icon is picked up
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* one failure does not block start-up */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {} } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime unavailable');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // Set the resolution before launching so a config change does not recreate the activity
    if (beforeStart) await beforeStart(rt).catch((e) => onLog(`Display fit skipped: ${e.message}`));
    // Clear wm size / density overrides and auto-rotate left in /data by older versions.
    // They persist, so without cleanup every launch shows a 90° rotated picture with black bars
    // and taps miss ('rotated / not filling / cannot tap Accept').
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // Check the network on a cold boot and say so plainly; otherwise the user just sees a black screen
    // and never guesses the VM has no network (a page without data is a black rectangle).
    // Key fix: Wi-Fi association often lags sys.boot_completed by tens of seconds; apps fetch
    // their home feed immediately, and with no network it renders black — the real cause of
    // 'black screen after Accept'. So wait for the network (up to 90 s) before launching.
    // Look at the network first: wait only, never restart.
    // This used to call ensureNetwork(), which on a slow network stopped the VM and cold-booted,
    // making the adb device vanish mid-install ('the app will not open').
    // The launch path must never do that; if waiting fails, launch anyway.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      const net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`VM network ready (${net.ip || ''})`);
      } else {
        onLog('VM network not ready yet — launching anyway (online pages may load later)');
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // The app may be missing from this runtime (image rebuilt / data cleared / first run); launching
    // would report "Invalid packageName". Install from the local backup first so opening always works,
    // which is the expected 'click the installed app and it opens' experience.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      const pkgs = await rt.client.shell(`pm list packages ${pkg}`, { timeout: 8000 }).catch(() => '');
      if (!new RegExp(`package:${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(pkgs)) {
        onLog('The app is not installed yet — installing it now…');
        await rt.client.install(app.apkPath).catch((e) => onLog(`Auto-install failed: ${e.message}`));
      }
    }
    // Watch for 25 s and require 5 s of continuous life to call it a successful launch.
    // 'not up yet' and 'was up and died' must be distinguished; treating an empty pidof as
    // failure force-stopped large apps during their ten-second first load,
    // three rounds before they opened — 'click and wait a minute'.
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // Check before sleeping: in a warm container the process shows up within a second,
        // sleeping first would delay the fastest path by a second.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // appeared and vanished — it really crashed
        } else {
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // failure only if the process never appeared
    };
    try {
      // Make sure runtime permissions are granted first: -g is lost when data is cleared,
      // and a missing grant leaves the app behind a system dialog — 'click does nothing'.
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // A permission dialog in front makes the app look broken; grant, then dismiss
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Only a clear crash log escalates (may need the compatible image); otherwise it is just slow
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // Lock the orientation right after the activity appears: the launch itself triggers
        // a config change (activity recreation) that can reset user-rotation to 0 —
        // after that the landscape panel shows a 90° rotated picture ('won't turn upright').
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`The app exited after launch (attempt ${attempt}), retrying…`);
      }
      if (!ok) {
        // Fallback: a crash leaves half-initialised data and every later start fails.
        // Clearing app data once before relaunch works best (no manual cache clear needed).
        onLog('The app keeps exiting — clearing its data and retrying…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear also drops runtime permissions, so they must be granted again or the dialog blocks
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('The app exits immediately after launch; retries and a data reset did not help');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // The crash comes from the ARM translation layer: switch image, reinstall and launch again
        onLog('ARM translation layer crash detected — switching to the compatible image…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* keep the original package */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
