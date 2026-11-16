'use strict';
/**
 * ApkStart main process
 * Responsibilities: window / tray / single instance / CLI dispatch (.apk, shortcuts) / IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');

// Brand logo (build/render-logo.js); falls back to the procedural icon
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* fall back to the procedural icon */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}
const assoc = require('./core/assoc');
const display = require('./core/display');
const pointer = require('./core/pointer');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater } = require('./core/updater');
const leftovers = require('./core/leftovers');

// Occluded windows give capturePage stale frames; disabling occlusion helps screenshots
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * When the disk is nearly full, move Chromium's caches (Cache / GPUCache / Local Storage …)
 * to the volume holding the Android data directory.
 * They default to the data directory; with a few hundred MB left even start-up can fail,
 * while the Android data may already live elsewhere.
 * Must be set before app ready; later changes are ignored.
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* keep the default when it does not fit */ }
}
relocateUserDataIfCrowded();

// Legacy Windows note: the emulator window was embedded via SetParent. Chromium used
// DirectComposition layers (Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP) composited by DWM at window level,
// which covered the child window: 'black screen while Android runs'.
// The shell is a 38px titlebar and a boot cover, so software composition is fine;
// without acceleration Chromium draws into the HWND and child ordering works.
// Set APKSTART_HWACCEL=1 to compare.
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * Lightweight file log: a packaged build has no console, so app.log can be shared.
 * Only key steps and exceptions; thousands of normal lines never overflow it.
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* a failed log write must not break the main flow */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * Bundled runtime takes over automatically:
 * A release ships runtime/ next to the launcher (emulator + platform-tools + system image).
 * On first start (no settings.json) runtime.dir points at it,
 * so nothing has to be downloaded. It can still be changed in Settings.
 */
function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // Portable builds keep the runtime next to the launcher; electron-builder unpacks
    // resources beside it, so several candidate paths are checked.
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // A bundled runtime needs an emulator plus any complete image, not a fixed API:
    // hardcoding API 34 would misjudge a smaller AOSP image as missing.
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // The image is stored compressed (system.img.xz / .gz) and unpacked on first start.
            // Requiring system.img here would report a bundled image as missing.
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // It used to take over only without settings.json; a user who installed the online
    // build first kept seeing the wizard. Now it takes over whenever no emulator is present.
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // After a portable build is moved or upgraded, settings still holds the old path:
    // only the runtime next to this launcher counts, otherwise old components are used
    // (an old emulator without the checker failed detection and fell back to TCG).
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // A directory the user picked outside the launcher tree
    // is always respected: it may save space or share one runtime between builds.
    // It used to be overwritten with the bundled runtime, so
    // a changed runtime directory was ignored (issue #23).
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // A usable runtime is respected: the AVD lives there and must not be moved silently
    if (currentOk) {
      // but auto parameters are enabled: old hardcoded memory/cores/GPU values are dropped
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // Compatibility mode only with a Google Play image; AOSP has native x86_64 libs
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* ignore */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
  } catch (_) { /* a failed takeover does not block start-up */ }
}
bootstrapBundledRuntime();

// Automated screenshots skip association probing
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// 'Which windows are ours' is assigned in whenReady (see agentScope); module scope
// is needed because runLaunch and the prewarm timer are defined earlier.
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

// ---------------- argument parsing ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron adds its own flags and the app path; only com.foo.bar look like packages
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium decodes WebP, nativeImage does not; a hidden window converts icons to PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** Start at login: on by default */
function applyAutoStart() {
  if (!app.isPackaged) return; // nothing to write in development
  const on = !!store.getSettings().autoStart;
  try {
    // An explicit name keeps the autostart entry from reading "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // Remove the entry old versions left behind (no name) to avoid double starts
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* ignored when policy forbids it */ }
}

// ---------------- display mode: fullscreen fit / resizable portrait window ----------------

function displaySettings() { return store.getSettings().display || {}; }

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** Wheel injection needs the Android resolution; cached, cleared on rotate/restart */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* runtime not up yet */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** After a mouse-mapping change, resync the hook with the current focus */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  // Linux: глобальный перехват мыши не поддерживается (X11/Wayland не дают LL-хуков
  // так, как WH_MOUSE_LL); правая кнопка → «назад» делается средствами эмулятора.
}

/**
 * Rotating means resizing the physical panel and restarting the emulator.
 *
 * It is the only way to get an upright, filling landscape panel (three wrong paths tried):
 *   - wm size: logical resolution only, the panel stays portrait -> a rotated corner strip;
 *   - wm density: framebuffer unchanged -> the picture does not fill, a blank band on the right;
 *   - adb emu rotate: the picture turns but the system stays portrait.
 * Only a landscape hw.lcd.width/height with a restart makes Qt open a landscape window that fills.
 */
async function restartForOrientation(landscape) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Switching to landscape: restarting the runtime…' : 'Switching back to portrait: restarting the runtime…');
  try {
    await runtime.stop({ graceful: false }).catch(() => {});
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) return false;
    await runtime.waitForNetwork({ onLog: () => {}, timeoutMs: 25000 }).catch(() => null);
    if (pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    await appWin.adopt({ label: appWin.state.label, fullscreen: landscape }).catch(() => null);
    return true;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    return false;
  }
}

/** Open (or reuse) the one clean window per app */
function openAppWindow(pkg, tip) {
  const rec = store.getApp(pkg);
  const land = !!displaySettings().landscape;
  const p0 = portraitSize();
  appWin.open({
    pkg,
    label: (rec && rec.label) || pkg,
    iconPath: rec && (rec.iconPath || rec.icoPath),
    // Landscape opens a landscape window; portrait windows letterbox a landscape picture
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    fullscreen: displaySettings().mode === 'fullscreen',
  });
  // Initialise with the saved orientation (the panel is chosen by doctor.lcdFor)
  appWin.setState({
    tip: tip || 'Starting the Android runtime…',
    ready: false,
    landscape: !!displaySettings().landscape,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    // Linux: окно эмулятора — чужое окно, управляем им через wmctrl/xdotool
    if (full) appWin.setFullscreen(true).catch(() => {});
    else appWin.setFullscreen(false).catch(() => {});
    // Fullscreen equals landscape: change the panel and restart, or the picture only grows
    if (!!displaySettings().landscape !== full) {
      restartForOrientation(full).catch(() => {});
    }
  }
  return next.display.mode;
}

/** First run installs adb / emulator / system image in one go */
let deploying = false;
async function autoDeploy({ force = false } = {}) {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  // Failure cooldown: every start used to re-download the 1.5 GB runtime while
  // checkEnv() reported missing components — 'it keeps downloading'.
  // A timestamp blocks automatic retries for 30 minutes; a manual "set up"
  // passes force=true and clears the cooldown.
  const COOLDOWN_MS = 30 * 60 * 1000;
  const lastFail = Number(store.getSettings().runtime.deployFailedAt || 0);
  if (!force && lastFail && Date.now() - lastFail < COOLDOWN_MS) {
    appLog(`autoDeploy cooling down (last failure ${new Date(lastFail).toISOString()}), skipping`);
    return { ok: false, error: 'cooldown', cooldown: true, until: lastFail + COOLDOWN_MS };
  }
  deploying = true;
  const progress = (p) => send('provision:progress', { ...p, component: p.component || 'all' });
  let succeeded = false;
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // Prefer this project's GitHub runtime bundle: one file with the emulator and image,
    // so downloads and updates come from one place.
    // Without the bundle, components are installed one by one from the official source.
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Downloading the runtime from GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) {
          succeeded = true;
          return { ok: true, source: 'github' };
        }
        progress({ message: 'Runtime bundle incomplete, completing from the official source…' });
      } catch (e) {
        progress({ message: `GitHub runtime unavailable (${e.message}), using the official source…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Preparing adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Preparing the Android runtime…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Preparing the Android system image…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    succeeded = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    return { ok: succeeded };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Only a real failure starts the cooldown; success clears the old record.
    try {
      store.saveSettings({ runtime: { deployFailedAt: succeeded ? 0 : Date.now() } });
    } catch (_) { /* a failed settings write does not change the outcome */ }
    deploying = false;
  }
}

function launcherInfo() {
  // Linux: AppImage/распакованная сборка тоже запускают `electron <appRoot>`,
  // а if (app.isPackaged) брал бы просто exe без пути к приложению — ярлык
  // тогда открывает пустой Electron. Поэтому путь к приложению передаём всегда.
  if (process.platform === 'linux') {
    return { target: process.execPath, args: `${APP_ROOT}`, cwd: APP_ROOT };
  }
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** Copy a directory tree (best effort, source kept; used when the shared dir moves) */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* one file failing does not stop the rest */ }
  }
}

/** Enable a Windows optional feature with elevation (legacy Windows path) */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)})`;
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({ ok: code === 0, restart: true, code }));
    proc.on('error', () => resolve({ ok: false, error: 'Cannot start PowerShell' }));
  });
}

// ---------------- main window ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // Smoke tests print renderer errors to stdout: a blank UI or dead buttons
  // usually mean an exception in app.js that normal runs hide.
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // External links open in the system browser; the app window never navigates away
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkStart is still running', 'Click the tray icon to reopen; right-click to quit.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- tray ----------------

function buildTray() {
  const icon = loadBrandIcon(16);
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    const menu = Menu.buildFromTemplate([
      { label: 'Open ApkStart', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'No apps installed yet', enabled: false }]),
      { type: 'separator' },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Back to portrait window' : 'Fullscreen (fit the screen)',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Rebuild desktop/menu shortcuts', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Sync the shared folder', click: () => sharer.sync() },
      { label: 'Settings', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `New version ${updateInfo.tag}` : 'Check for updates',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'New version available',
              message: `ApkStart ${info.tag} is out; you have v${app.getVersion()}. Update now?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Update now', 'Later'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('Up to date', `ApkStart v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('ApkStart — Android app runner');
  // A single click on the tray opens the main window.
  // Binding double-click only made a single click look broken.
  // The menu is on right-click, so a plain click can call showWindow safely.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- core actions ----------------

let installBusy = null;   // installing file: repeated clicks arrive as second-instance, no concurrency
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // The same package is installing (repeated clicks or drops) — warn once
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'This APK is already installing, please wait…' });
      return { ok: false, error: 'Already installing' };
    }
    send('toast', { type: 'info', message: 'Another install is running; wait for it to finish.' });
    return { ok: false, error: 'An install is already running' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // Refresh the desktop database so a new icon appears immediately
    try { require('./core/shortcut').updateDesktopDatabase(); } catch (_) { /* ignore */ }
    notify('Installed', `${result.app.label} is installed${result.app.shortcutPath ? ', desktop shortcut created' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // One notification per error every 8 s so retries do not spam
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // A visible window already shows the message; no desktop notification needed
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Install failed', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * Download and install a new version; the update script takes over replace-and-restart.
 * The UI and the tray menu share this path.
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'An update is in progress' };
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'Already up to date' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'This release has no auto-installable package; the releases page was opened', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Preparing the download…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Replacing the program and restarting…' });
    updater.apply(job);
    // Give the UI a moment to show the notice, then quit normally
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

async function runLaunch(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  appLog(`launch start ${pkg}`);
  try {
    // Linux: отдельного «окна с анимацией» нет — показываем статус в главном окне,
    // эмулятор поднимется своим окном, и мы сразу переименуем его под приложение.
    openAppWindow(pkg, 'Запускаю Android…');
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();

    const r = await installer.launch(pkg, {
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
      onMark: mark,
      beforeStart: async (rt) => {
        mark('engine ready');
        appWin.setState({ tip: 'Opening the app…' });
        // Immersive mode, animations off, lock screen dismissed — done once
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
      },
    });
    mark('app started');

    // 2) Приложение поднялось — приводим окно эмулятора к виду «окно приложения»:
    // заголовок, класс, размер по ориентации, фокус.
    const adopted = await appWin.adopt({
      label: appWin.state.label,
      portrait: portraitSize(),
      fullscreen: displaySettings().mode === 'fullscreen',
    }).catch(() => ({ ok: false }));
    mark(`window adopted=${!!adopted.ok}`);
    if (!adopted.ok) appLog(`window adopt failed: ${adopted.error || 'unknown'}`);
    // Окно эмулятора может появиться с задержкой — добиваем ещё раз позже.
    if (!adopted.ok) {
      setTimeout(() => { if (appWin.isOpen) appWin.adopt({ label: appWin.state.label }).catch(() => {}); }, 3000);
    }
    // Container session: the environment is ready; only per-app trimming and polling start,
    // Android is not booted again. Mouse-button mappings follow the window focus
    // and are removed on blur.
    deviceSize.value = null;
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} window=${!!adopted.ok}`);
    return { ok: true, embedded: !!adopted.ok };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    showWindow();
    send('toast', { type: 'error', message: `Launch failed: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * Background tasks switch with the presence of an app window.
 * File sync walks the shared folder over adb find/stat every 8 s and notifications poll;
 * both used to run from start-up even with no Android app open.
 * Now they start with a real app and stop when the last window closes.
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/** Notification bridge: polls only with an app window open */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.focus().catch(() => {});
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // How we started (login / manual) decides whether the welcome card shows
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // Pick a folder (move runtime/images/apps to another volume)
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a data directory',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* ignored while the runtime is down */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an APK to install',
      filters: [{ name: 'Android apps', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('The app does not exist');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // The portrait base changed: affects later windows only, running apps untouched
      appWin.portrait = portraitSize();
    }
    // Turning the menu shortcut on fills it in immediately
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
// Mouse mappings changed: resync the hook with the current focus
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
// Update source, mirror prefix or bundle URL changed: the old speed ranking is void
// and URLs cached in provisioner._cache need clearing or a restart
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /**
   * Move the shared directory: copy existing files over (best effort, originals kept)
   * and save. Sharer reads store.getSettings().sharedDir on every sync, so no restart is needed.
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'The directory cannot be empty' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- display mode / shortcuts / one-click setup ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      appWin.setFullscreen(full).catch(() => {});
      // Fullscreen means the tablet landscape layout (see toggleDisplayMode)
      appWin.setLandscape(full).catch(() => {});
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  // A manual 'set up' retries immediately, bypassing the failure cooldown
  ipcMain.handle('runtime:autoDeploy', (_e, opts = {}) => autoDeploy({ force: !!opts.force }));
  // Turning deep trim off re-enables packages disabled with pm disable-user
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Mappings changed: only resync, do not uninstall unconditionally
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // Legacy UI entry: now it just resyncs from the settings
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- diagnostics / slimming ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // A running engine reports its real parameters; when down they are derived from
    // the real engine version and acceleration, not a deprecated default.
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * Automatic self-check for common 'will not install / will not start' causes,
   * with actionable fixes shown in the UI and the settings panel.
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // Assigned inside try and returned outside, so they are declared in the outer scope
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'VC++ runtime missing (x64)',
          hint: 'The runtime needs the VC++ 2015-2022 redistributable (0xc0000135 otherwise).', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        issues.push({
          code: 'accel', severity: 'warn', title: 'Hardware acceleration is off',
          hint: (accel.note || 'Software emulation is used (slow). Enable KVM for the best performance.'), fix: 'virtualization',
        });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Low disk space for the runtime',
          hint: `The volume holding "${runtime.provisioner.paths().root}" has ${free} MB free; the image may fill it.`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'Runtime path contains non-ASCII characters',
          hint: 'Some runtime components dislike non-ASCII paths and may fail to start. Use an ASCII path.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'adb tools missing', hint: 'Cannot reach the Android runtime.', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'Runtime engine not installed', hint: 'Deploy the runtime engine first (~440 MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'System image not ready', hint: 'Download the Android system image first (~1.5 GB).', fix: 'deploy' });
      }
      // Stale locks make the next start fail with 'AVD is already running'
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Stale lock files found', hint: 'The next start may fail with "AVD is already running".', fix: 'lock' });
      }
    } catch (_) { /* a failed self-check blocks nothing */ }
    return { issues, accel, free };
  });

  // The VC++ 2015-2022 x64 runtime is needed by the emulator on Windows.
  // Without it the emulator fails with 0xc0000135 / MSVCP140 missing.
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // Elevate to install it (system component); /quiet and /norestart keep it silent
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // Shared confirm dialog (the renderer always goes through here)
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'Confirm',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Cancel', opts.okLabel || 'OK'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  // /data capacity: apps, games and their update packages live here.
  // 'not enough space' in games is usually this; growing is in place without data loss.
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const info = runtime.emulator.dataInfo();
    return { ...info, freeDiskMB: doctor.freeDiskMB(runtime.provisioner.paths().root) };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const want = Math.max(0, Math.min(64, Number(gb) || 0));
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // The image is busy while qemu runs: stop the container first (apps exit)
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Data partition resized', `About ${want} GB available${stopped ? ' (runtime restarted)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // Explicit confirmation with a list; only ApkStart's own runtime directory is touched
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', `Clean ${preview.candidates.length} item(s)`],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm cleaning the runtime cache',
      message: `This frees about ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'The runtime stops first; old images, the current AVD snapshot, locks and inactive AVDs are removed. Apps themselves stay, '
        : 'only old images, snapshots, locks and inactive AVDs are removed; apps stay.')
        + 'This cannot be undone; export a diagnostic report first.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // Full reset of Android data: /data, installed apps and the quickboot snapshot,
  // returning the AVD to a freshly installed state. Deletes gigabytes; the UI confirms twice.
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Repair the VM network: reset /data (the app list stays; apps reinstall on open).
  // Typical case: every online page is black because wlan0 is down without a default route.
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Network check only, no data touched (shown in Settings)
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- leftovers from older versions ----------------

  /** Scan only: what was found goes to the UI and the user decides */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- runtime provisioning ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** Install the AEHD driver with elevation (Windows only) */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'The AEHD driver package is not ready');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Elevation cancelled (the driver needs admin rights)' : `Driver install failed (exit ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Enable virtualisation automatically; no manual system settings.
   * Prefer the built-in WHPX hypervisor platform; without it,
   * fall back to Google's AEHD driver. Both need elevation.
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'Hardware acceleration is already available' };

      const hv = await runtime.provisioner.hypervisor();
      if (hv.dll) {
        // WinHvPlatform.dll present: enable the hypervisor platform (may need a reboot)
        const r = await enableWindowsFeature('VirtualMachinePlatform');
        const r2 = await enableWindowsFeature('HypervisorPlatform').catch(() => ({ ok: false }));
        const ok = r.ok || r2.ok;
        const after = await runtime.provisioner.emulatorAccel();
        return {
          ok,
          restartNeeded: r.restart || r2.restart,
          accel: after,
          note: ok
            ? (r.restart ? 'Hypervisor platform enabled; reboot for the best performance' : 'Hypervisor platform enabled, acceleration is active')
            : (r.error || r2.error || 'Could not enable system virtualisation'),
        };
      }

      // No WHPX component: use Google's AEHD driver instead
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'Preparing the AEHD driver failed' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Elevation cancelled (the driver needs admin rights)' : `Driver install failed (exit ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'AEHD acceleration enabled' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an Android-x86 / Bliss OS image',
      filters: [{ name: 'System images', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a virtual disk with Android installed',
      filters: [{ name: 'Virtual disks', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // Automated environments skip the association probe
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      // Prefer the bundled multi-size icon; otherwise render it from the logo
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** Clear stale AVD locks that make the next start fail with 'AVD is already running' */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Uninstall ApkStart itself:
   * 1) drop the .apk association first (no dangling handler)
   * 2) packaged install: run the uninstaller, then quit
   * 3) portable build: no uninstaller, so tell the user which directories to delete
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* a failed unlink does not stop the uninstall */ }
      const exeDir = path.dirname(process.execPath);
      const uninstaller = path.join(exeDir, 'uninstaller.exe');
      if (!fs.existsSync(uninstaller)) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const { spawn } = require('child_process');
      // Stop the resident emulator first: qemu locks the runtime binaries
      // and the uninstaller would leave a half directory. Only during a real uninstall.
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // Quit first, then a detached process launches the uninstaller after 2 s:
      // a running binary locks its files and the uninstaller deletes incompletely.
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- app window (rotate / minimize / maximize / close) ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  ipcMain.handle('shell:minimize', (e) => winOf(e)?.minimize());
  ipcMain.handle('shell:maximize', (e) => {
    const w = winOf(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    appWin.scheduleFit();
  });
  // Closing must go through appWin.close(): it detaches the window and stops the app.
  // Calling win.close() directly skipped that — the window vanished while the app ran on,
  // which users described as 'closing does not close the app'.
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  ipcMain.handle('shell:rotate', () => appWin.rotate(restartForOrientation));
  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- Android system settings ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Unknown setting ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.focus().catch(() => {}); return true; }
    return false;
  });

  // ---------------- online update ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // A manual check skips the cache and asks both sources
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // GitHub and Gitee release pages both open on demand: a failed check still
    // lets the user download manually.
    const raw = String(url || '');
    const ok = /^https:\/\/(github\.com|gitee\.com)\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// ---------------- lifecycle ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    runtime = new Runtime(APP_ROOT);
    // Log one line at start so app.log shows the version and data directory
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);
    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: require('./core/shortcut').xdgDirs().desktop,
      // меню приложений: по нему GNOME/KDE ищут запуск по имени
      applicationsDir: require('./core/shortcut').xdgDirs().applications,
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // The updater reads the source preference and mirror prefix from the settings
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // Wheel coalescer: scrolling in one time window becomes a single input swipe
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // Linux: окно приложения — это окно самого эмулятора, которым управляют
    // xdotool/wmctrl (см. core/appwin.js). PowerShell-агент и SetParent здесь не нужны.
    appWin = new AppWindow({
      runtime,
      agent: null,
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
    });
    appWin.onCloseApp((pkg) => {
      // Closing the window stops the app; the last window parks the container
      // while Android stays resident for a fast next open.
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
    });

    // Подавление консольных окон и SetParent — только Windows; на Linux ничего не нужно.
    armAgent = async () => ({ ok: false });

    runtime.emulator.onBeforeSpawn = async () => {};

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // Free disk below 3 GB means Android cannot boot (image/snapshot writes fail).
    // Better to say where to fix it than to show 'will not open'.
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Low disk space', `Only ${(freeMB / 1024).toFixed(1)} GB free. Move the Android data/runtime directory in Settings → System integration.`);
          send('toast', { type: 'error', message: `Only ${(freeMB / 1024).toFixed(1)} GB free; Android may not start (Settings → System integration)` });
        }, 3000).unref?.();
      }
    }

    // Older versions left icons or shortcuts missing: fill them in at start
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        try { require('./core/shortcut').updateDesktopDatabase(); } catch (_) { /* ignore */ }
        notify('Shortcuts restored', fixed.join(', '));
      }
    }).catch(() => {});

    // F11 toggles fullscreen; the global shortcut only lives with ApkStart
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);

    // Prewarm: keep the Android environment resident.
    // It boots in the background at start-up (hidden), so opening an app is one am start.
    // Prewarm only with installed apps and a usable runtime.
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1.2 s is enough for the first frame; waiting 4 s meant the user already clicked
      // and the click raced the prewarm for the AVD lock.
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* a failed prewarm does not block later opens */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // First-run deployment waits 20 s: the cold start already saturates disk and CPU,
    // and downloading on top only makes the desktop lag. ensure() prepares on demand.
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'The runtime was prepared automatically' });
      }).catch(() => {});
    }, 20000).unref?.();

    // Check for a new version 8 s after start (packaged builds). Only notify,
    // never download: updating is a user action.
    if (app.isPackaged) {
      setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // Start-up notices live in the welcome card instead of desktop notifications,
            // avoiding a popup on every login.
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // File sync and notification polling run only with an app window open
    // (see onContainerActive).

    // Smoke test: screenshot then quit, for automated UI checks
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // The runtime panel lives in Settings: --setup equals --settings
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // An occluded window returns stale frames: force a repaint and take the later shot
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // Shoot the performance and resources section
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // Shoot the downloads and update sources section
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // Shoot the about section
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] screenshot failed', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // Closing the window hides to the tray (the close event is intercepted);
    // reaching here means a real quit, which must be allowed or the lock stays held.
    if (quitting) app.exit(0);
  });

  let quitReady = false;
  app.on('before-quit', (e) => {
    quitting = true;
    // Before quitting the emulator window must be released. That is asynchronous,
    // so the first before-quit is intercepted and a second quit finishes.
    // Without it the window re-attaches to the desktop,
    // leaving a stray Android Emulator window after ApkStart exits.
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        runtime?.dispose();
        // The hidden icon decoder counts as a window; closing it lets window-all-closed fire
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    runtime?.dispose();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
