'use strict';
/**
 * Local persistence: app manifest + settings
 * Данные: $XDG_DATA_HOME/apkstart (~/.local/share/apkstart) на Linux
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** XDG Base Directory: ~/.local/share/apkstart */
function dataDir() {
  const xdg = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim();
  return path.join(xdg || path.join(os.homedir(), '.local', 'share'), 'apkstart');
}
const DATA_DIR = dataDir();
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  engine: {
    mode: 'builtin',         // builtin (own runtime, default) | attach (connect to an existing runtime, advanced)
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = decided by doctor from the host RAM
    cores: 0,                // 0 = auto
    autoMemory: true,        // zero-config: memory/cores/disk/render are derived automatically
    idleShutdownMinutes: 15,
    startVisible: true,
    // Must be windowed: headless SurfaceFlinger produces no VSYNC — the app is alive but the screen is empty.
    // A windowed emulator renders natively at 60 fps with native input; ApkStart just dresses it up as an app window.
    headless: false,
    gpuMode: 'auto',         // auto = pick the backend from the emulator version, fall back step by step
    // The last render backend that crashed on start (`<emulator version>|<gpu>`); in auto mode it is
    // tried last, so we do not wait 20 s before falling back to software rendering. Invalidated on runtime upgrades.
    badGpu: '',
    forceTcg: false,         // kept for advanced troubleshooting; doctor already falls back automatically
    audio: true,             // app sound (notifications/video). Turning it off saves some CPU
    // ---- lightweight container (on by default to save resources; each item can be turned off) ----
    liteMode: true,          // limits the vCPU quota so qemu does not saturate every physical core
    // One-line policy: save (frugal) / balanced / smooth (video and games first).
    // The UI exposes only this option; it is translated into liteMode / priorityMode / renderSize on save,
    // while the individual switches remain for advanced users.
    resourceMode: 'balanced',
    // Data partition size (GB): apps, game caches and their update packages live here.
    // 0 = auto (6/8 GB depending on free space). Growing it resizes in place on the next boot; apps are kept.
    dataPartitionGB: 0,
    // Render resolution: lower is smoother and cheaper; auto picks 720x1280 / 540x960 by acceleration state
    renderSize: 'auto',
    // Network acceleration: point the emulator at public DNS servers. Android's default 10.0.2.3 forwards to
    // the host DNS, which can take hundreds of ms on VPN/corporate networks and stalls video first frames.
    fastDns: true,
    // Snapshots: a quickboot memory snapshot makes the next start take seconds, at the cost of a ~2-3 GB
    // ram.bin on disk. Turn it off on tight disks (affects start time only, never app data).
    keepSnapshot: true,
    // Log cap (KB): rotate and keep one backup so long-term use does not fill the disk
    logLimitKB: 2048,
    // Mouse buttons: the emulator maps the left button to tap natively, no switch needed.
    // Right-click Back and smooth scrolling need a low-level hook; it is installed only while the app window is focused.
    mouseRightBack: true,    // right click = Android Back (stops Qt's default right-click-as-tap)
    mouseWheelMode: 'smooth', // smooth = coalesce into one swipe | native = leave it to Qt | off = ignore
    mouseSideButtons: false, // side buttons back/forward: off by default; enabling adds one more mapping
    deepTrim: false,         // aggressively trim system background packages (Play Store/wizard); system untouched by default
    // balanced = yields to the foreground | performance = qemu Normal | game = qemu High + low-latency input
  priorityMode: 'balanced',
    // Prewarm: boot Android in the background after start-up so the first click is nearly instant.
    // Costs about 1 GB of RAM while idle; can be turned off at any time.
    prewarm: true,
  },
  runtime: {
    dir: '',                 // пусто = ~/.local/share/apkstart/runtime
    qemuUrl: '',             // manually set the QEMU installer URL
    isoUrl: '',              // manually set the system image URL
    isoPath: '',             // system image (ISO) path
    diskPath: '',            // virtual disk where the system is installed
    diskSizeGB: 24,
    headless: false,         // do not show the VM window (debug only)
    installMode: 'guided',   // guided (wizard) | auto (experimental)
    emulatorUrl: '',         // manually set the emulator package URL (empty = latest from the SDK index)
    sysimgUrl: '',           // manually set the system image package URL
    compatImage: false,      // ARM compatibility mode: Google Play image (built-in native bridge, runs ARM-only apps)
    deployFailedAt: 0,       // timestamp of the last failed auto-deploy (0 = none). No auto retry for 30 minutes after a failure
    // The runtime bundle: downloaded from this project's GitHub Release by default (same source as updates),
    // falling back to per-component downloads from dl.google.com. You may point it at your own mirror.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // Optional GitHub mirror prefix: direct GitHub Releases can be very slow,
    // set a prefix such as https://ghfast.top/ to route downloads through it.
    // Empty = direct (with 8 parallel chunks to use the full bandwidth).
    mirrorPrefix: '',
    // Parallel connections for chunked downloads. Default 8; raise to 16 on throttled links.
    downloadConnections: 8,
    // Source selection for updates/downloads. auto = ask GitHub and Gitee and measure
    // every URL with a 128 KB probe, then use the fastest; force one side if your network allows only one host.
    sourcePreference: 'auto',
    // Try public GitHub mirrors (ghfast / gh-proxy) automatically. When off, only direct + custom prefix.
    // They are third-party relays for public release files; no account data is involved.
    autoMirror: true,
    // The Gitee releases API requires an access_token even for public repos (404 without one).
    // Put a read-only token here to use Gitee as an update source; empty = GitHub + mirrors only.
    giteeToken: '',
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // application-menu entry (so the desktop finds the app by name)
  shortcutDir: '',           // empty = desktop
  freeform: false,           // one shared runtime window instead of Android freeform windows
  hideAfterLaunch: false,    // the main process must stay alive, otherwise the runtime dies with it
  notifyOnInstall: true,
  autoStart: true,           // start at login (default; nothing to configure)
  autoDeploy: true,          // fully deploy on first run; no multi-step wizard
  // Welcome card: lastDate remembers the last automatic popup (manual open at most once a day),
  // disabled = the user unticked the automatic popup.
  welcome: { lastDate: '', disabled: false },
  display: {
    mode: 'window',          // window (portrait, freely resizable) | fullscreen (fits the screen)
    portrait: '900x1600',    // portrait resolution in window mode; size is adjustable in the settings
    density: 0,              // 0 = derived from the resolution
    rememberBounds: true,    // remember window position/size per app
    autoFullscreenOnLaunch: false,
    // Landscape = switch the AVD panel to 1280x720 and restart (the only way to get upright and filling).
    // Persisted here, so ApkStart boots in the same orientation next time.
    landscape: false,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Strip a possible UTF-8 BOM: JSON.parse throws on it and the whole config would
    // silently fall back to defaults — users see 'all settings lost' with no clue why.
    // The file is edited by the settings page, sync tools and users, so BOM must be tolerated.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resource policy → concrete switches.
 *   save     : 2 vCPU + low priority + 540x960, for old laptops / always-on use;
 *   balanced : half of the physical cores (2-4) + yields to the foreground + 720x1280;
 *   smooth   : unlimited vCPU + foreground priority + 720x1280, video and games first.
 * 1080p is left alone for now: the quickboot fingerprint depends on it (every change forces a cold boot),
 * and 720p already looks identical in a phone-shaped window while costing a lot less.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    // Old versions ran headless: the app was alive but there was no window — effectively 'won't open'.
    // Migrate to windowed unconditionally and never let an old config turn it off.
    s.engine.headless = false;
    // Old versions killed the whole runtime on exit, so a desktop icon flashed and vanished.
    s.hideAfterLaunch = false;
    // Old versions used Android freeform windows; now the emulator window is the app window,
    // so the app must fill it — otherwise you get a window inside a window.
    s.freeform = false;
    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // When only the policy changed, translate it into the three switches so both stay consistent
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    return path.join(ICON_DIR, `${pkg}.png`);
  },

  apkPath(pkg, version = 'cur') {
    return path.join(APK_DIR, `${pkg}-${version}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
