'use strict';
/**
 * Runtime provisioning
 *
 * ApkStart needs no third-party emulator: adb, the emulator and the system image are downloaded, verified and managed here.
 * All runtime files live under ~/.local/share/apkstart/runtime so any install location stays read-only.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial } = require('./download');
const { ZipArchive, ZipFile } = require('./zip');
const { Sources } = require('./sources');
const { cmpVer } = require('./version');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Official SDK index: emulator and system image URLs are resolved dynamically, no hardcoded versions
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // Fallback: known versions used when the index is unreachable
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-linux_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // ARM compatible image (Google Play build with the native bridge)
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2 (x86_64): only when the user supplies an ISO
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // The runtime bundle is fetched from this project's GitHub Release.
  // Downloading the emulator and image separately from dl.google.com often stalled
  // at tens of KB/s or 404'd; with one bundle from GitHub, the download and update
  // source is the same place, so a problem is fixed once.
  ghReleaseApi: 'https://api.github.com/repos/RoutineMiku/apkstart/releases',
  ghReleasePage: 'https://github.com/RoutineMiku/apkstart/releases',
  // The same content on Gitee: api.github.com often answers in tens of seconds, Gitee in ms.
  // Both are asked and the higher version with a runtime bundle wins.
  giteeReleaseApi: 'https://gitee.com/api/v5/repos/daily-miku/apkstart/releases',
  giteeReleasePage: 'https://gitee.com/daily-miku/apkstart/releases',
};

/**
 * SDK index <url> values are relative paths with different bases:
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * so the base is always the index file's own directory. Using the bare name threw Invalid URL.
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * Keep a single universal base image.
 * The old AOSP API 30 default plus an optional API 34 Play image caused:
 *   - ARM-only apps always failed and needed a manual image switch;
 *   - two images of 0.6-3 GB each, tens of GB in the runtime directory;
 *   - switching images required wipe-data and lost every app.
 * Now there is one Android 14 Google Play x86_64 image running x86 apps, ARM apps and GMS,
 * stored once as a shared read-only layer and downloaded on demand.
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

/** Системный qemu-img (пакет qemu-utils); нужен для создания ext4-раздела /data */
function systemQemuImg() {
  const { execFileSync } = require('child_process');
  const candidates = ['/usr/bin/qemu-img', '/usr/local/bin/qemu-img', '/usr/sbin/qemu-img'];
  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;
  try {
    const which = execFileSync('sh', ['-c', 'command -v qemu-img'], { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch (_) { /* ignore */ }
  throw new Error('qemu-img не найден: установите qemu-utils (sudo apt install qemu-utils)');
}

/** Системные e2fsprogs: resize2fs / e2fsck / mke2fs (Linux) */
function systemE2fs(name) {
  const candidates = [`/usr/sbin/${name}`, `/sbin/${name}`, `/usr/bin/${name}`];
  return candidates.find((c) => fs.existsSync(c)) || name;
}

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * Completeness check after a download; a failed check DELETES the partial file.
 *
 * It used to throw without deleting, leaving a half zip in tmp; the next run
 * resumed it with Range, and when the server or source changed the bytes
 * never matched — failing again and again: 'it keeps re-downloading'.
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(`${label} download incomplete (${(size / 1048576).toFixed(1)} MB); cleaned up, retry`);
}

/**
 * On-disk cache of environment probes.
 *
 * `emulator -version` and `-accel-check` each spawn an emulator process
 * costing 1-3 s, while the result is constant as long as the engine is unchanged.
 * It used to cache for 30 s in memory, paying it on every start right when
 * the user clicks. Here the key is the engine file plus the acceleration device
 * and is stored on disk, invalidated when software or hardware changes.
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // An 'unavailable' verdict is trusted for 10 minutes only: the user may just have enabled it

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** Unified entry for both sources and mirrors (the speed cache is shared) */
  get sources() {
    return this._sources;
  }

  /** Cache key changes when the engine file or acceleration device changes */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* first run */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* a failed cache write does not break anything */ }
  }

  /** Called after a failed boot so the next start re-probes instead of reusing a wrong verdict */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- paths ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // The AVD (userdata, apps, quickboot snapshot) must live somewhere writable and persistent.
    // A portable build unpacks to a temp dir; storing the AVD there loses apps on every exit.
    // Unless the runtime directory is in the user data directory the AVD is pinned there.
    // The settings may point the Android data directory elsewhere — that is what eats disk
    // (6-24 GB partition plus a 2-3 GB snapshot); moving the runtime alone does not help.
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // Where the system image goes: the RUNTIME directory wins.
    // It used to prefer the user data directory, so moving the runtime to another volume
    // still unpacked the 3.3 GB system.img back into the user data directory,
    // eating the system disk anyway,
    // with the same image stored twice (1.2 GB + 3.3 GB measured).
    // Now: use system-images inside the runtime directory when present,
    // otherwise fall back to the user data directory (older layouts).
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // Three cases:
    //  1) the runtime directory already holds the image → use it;
    //  2) an older layout keeps it in the user data directory → use that;
    //  3) a fresh install → the runtime directory, because the user data directory may be
    //     a redirected temp directory (as in CI, where a wrong write fails verification).
    const sysRoot = fs.existsSync(rootImg) ? rootImg : (fs.existsSync(dataImg) ? dataImg : rootImg);
    return {
      root,
      qemuDir: path.join(root, 'qemu'),
      // На Linux QEMU отдельно не нужен: emulator идёт со своим qemu-system-x86_64,
      // а qemu-img берём системный из PATH (пакет qemu-utils).
      qemuDir: path.join(root, 'qemu'),
      qemuExe: '/usr/bin/qemu-system-x86_64',
      qemuImg: '/usr/bin/qemu-img',
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb'),
      // Official emulator runtime: the root also serves as ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(root, 'aehd'),
      imagesDir: path.join(root, 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(root, '_tmp'),
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      fs.mkdirSync(d, { recursive: true });
    }
    return p;
  }

  /**
   * Disk guard: check free space before downloading or unpacking a big component.
   * Otherwise the system disk fills mid-download or unpacking fails and leaves a partial file.
   * A 1 GB buffer: snapshots and the data partition keep growing after the unpack.
   * @param {string} component component name (selects the space estimate)
   * @param {string} targetDir write directory (locates the volume)
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Runtime bundle: a 1.5 GB archive plus a ~3.3 GB image present at the same time
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // extra 1 GB (snapshot / data partition / unpack scratch)
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `Not enough disk space: this component needs about ${need + buf} MB but "${dir}" is on a volume with ${free} MB.\n`
        + 'Move the runtime data directory to a larger volume (Settings → System integration → Browse), '
        + 'or free some space / uninstall unused apps and retry.',
      );
    }
    return free;
  }

  // ---------------- environment checks ----------------

  /**
   * Ускорение на Linux — это только KVM: /dev/kvm должен существовать и быть
   * доступен пользователю (обычно через группу kvm). WHPX/AEHD здесь нет.
   */
  async _linuxHypervisor() {
    const devKvm = '/dev/kvm';
    let present = false;
    let readable = false;
    try {
      const st = fs.statSync(devKvm);
      present = st.isCharacterDevice();
      fs.accessSync(devKvm, fs.constants.R_OK | fs.constants.W_OK);
      readable = true;
    } catch (_) { /* нет устройства или нет прав */ }
    let inGroup = false;
    try {
      const { execFileSync } = require('child_process');
      inGroup = /(^|,|\s)kvm(,|\s|$)/.test(String(execFileSync('id', ['-nG'], { encoding: 'utf8' })).trim());
    } catch (_) { /* ignore */ }
    return {
      kvm: present && readable,
      present,
      readable,
      inGroup,
      note: !present
        ? 'Нет /dev/kvm: либо нет аппаратной виртуализации в BIOS, либо не загружен модуль kvm '
          + '(sudo modprobe kvm_intel / kvm_amd). Без KVM эмулятор запускать не будем.'
        : (!readable
          ? `Нет прав на /dev/kvm: добавьте пользователя в группу kvm (sudo usermod -aG kvm $USER) и перелогиньтесь`
            + (inGroup ? ' (группа уже есть, нужен новый вход в сессию)' : '')
          : 'KVM доступен: аппаратное ускорение включено'),
    };
  }

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = await this._linuxHypervisor(); return this._hypervisor; }
    // Millisecond checks only; the authoritative answer comes from emulator -accel-check,
    // so no helper process is spawned during status polling.
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      kvm: false,           // overwritten with the real value by emulatorAccel()
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'Hypervisor platform present (availability checked by the engine)'
        : 'No hypervisor platform found: enable virtualisation in the firmware',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // 30 s cache; status polling must not spawn processes repeatedly
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      '/usr/bin/qemu-system-x86_64',
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** Validate the ISO9660 primary volume descriptor ("CD001" at 0x8001) to reject error pages */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: 'not downloaded' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // An imported raw disk image has no ISO boot area; accept it by size
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `the file is only ${(size / 1048576).toFixed(1)}MB, the download is incomplete`
        : 'not a valid ISO9660 image (an error page or a corrupt file)';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // The bundled runtime ships one API 34 Google Play image, both primary and compatible;
    // the compatImage switch no longer decides, so a present image is never 'not deployed'
    const compatReady = this.playImageInfo().ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : 'not installed' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? this.playImageInfo().size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api}（${(sysimg.size / 1073741824).toFixed(2)} GB）`
          : (compatReady ? `Android ${PLAY_SYSIMG.api}(ARM compatible image)` : (sysimg.note || 'not downloaded')),
      },
      playImage: this.playImageInfo(),
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : 'not downloaded',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : 'not created yet',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: 'Downloading Android platform-tools (~8 MB)…', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, 'adb package');

    onProgress({ stage: 'extract', message: 'Extracting adb…', percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb does not run after extraction — check the permissions on the file');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} ready`, percent: 100 });
    return v;
  }

  /**
   * Extract with the built-in ZIP parser (no system unzip needed)
   * GB-sized entries stream, small ones are read whole, staying under the Buffer cap.
   */
  // ---------------- runtime bundle from GitHub ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * Resolve the runtime bundle download URL.
   * Asset convention: ApkStart-runtime-<tag>.zip (built by .github/workflows/release.yml,
   * containing build/runtime: emulator/ + platform-tools/ + system-images/).
   * Both GitHub and Gitee are scanned and the highest version wins; otherwise the caller
   * falls back to per-component Google downloads.
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const pref = String(store.getSettings().runtime.sourcePreference || 'auto');
    const apis = [];
    if (pref !== 'gitee') apis.push({ api: SOURCES.ghReleaseApi, page: SOURCES.ghReleasePage, name: 'GitHub' });
    if (pref !== 'github') apis.push({ api: SOURCES.giteeReleaseApi, page: SOURCES.giteeReleasePage, name: 'Gitee' });

    // Ask both concurrently; one failing does not affect the other
    const lists = await Promise.all(apis.map(async (a) => {
      const j = await this._fetchJson(`${a.api}?per_page=15`).catch(() => null);
      return { ...a, list: Array.isArray(j) ? j : null };
    }));

    const cands = [];
    for (const item of lists) {
      if (!item.list) continue;
      for (const rel of item.list) {
        if (!rel || rel.draft) continue;
        const hit = (rel.assets || []).find((x) => /^ApkStart-runtime-.*\.zip$/i.test(x.name || ''));
        if (!hit) continue;
        cands.push({
          url: hit.browser_download_url || hit.url,
          name: hit.name,
          size: hit.size || 0,
          tag: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
          page: rel.html_url || item.page,
          from: item.name,
        });
      }
    }
    if (!cands.length) {
      const errs = lists.filter((x) => !x.list).map((x) => `${x.name} unreachable`).join(', ');
      throw new Error(`No runtime bundle on either source${errs ? ` (${errs})` : ''}`);
    }
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    this._cache.pack = cands[0];
    return this._cache.pack;
  }

  /**
   * One-click deploy: download and unpack the runtime bundle from GitHub.
   * The image inside is .xz and is unpacked once by materializeImages() on the first boot.
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // Send progress first: version lookup and speed probing have no byte counts, so silence looks frozen.
    onProgress({ stage: 'download', message: 'Fetching the runtime version…', percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: `Picking the fastest source (${pack.from || 'GitHub'} · ${pack.tag})…`, percent: 1 });
    // Candidates = origin + mirror prefixes. 128 KB is measured from each before choosing:
    // guessing by domain is often wrong — 30 KB/s in the morning, 5 MB/s in the evening.
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    onProgress({ stage: 'download', message: `Downloading the runtime (~1.5 GB, once, ${conn} threads)…`, percent: 2 });
    // Parallel chunks beat a single stream: GitHub throttles per connection
    // (100-200 KB/s) while 8 threads use the whole link; a drop falls back to resume.
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` · about ${Math.ceil(pr.eta / 60)} min left` : '';
        onProgress({
          stage: 'download',
          message: `Downloading the runtime ${mb}${sp}${eta}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    assertComplete(zip, 200 * 1024 * 1024, 'runtime bundle');

    onProgress({ stage: 'extract', message: 'Extracting the runtime (~1 min)…', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `Extracting ${done}/${all}` });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* a failed marker write is harmless */ }

    // The image inside is .xz compressed. Unpack it now,
    // otherwise checkEnv() reports a missing image and downloads another 1.4 GB from Google.
    // A failed unpack must fail the deploy with a reason: the old code swallowed it and
    // progress stuck at 99% then fell back to another 1.4 GB download.
    onProgress({ stage: 'extract', message: 'Unpacking the system image (~1 min, once)…', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: 'Runtime ready', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  /**
   * Candidate URLs: direct first, then mirror prefixes.
   * Sources handles it all, so automatic mirrors and a custom prefix
   * live in one place and share the speed cache with parallel downloads.
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // Big packages use the file reader: a 1.5 GB zip never sits in memory,
    // so small machines unpack reliably; small packages keep the faster memory version.
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        if (name.endsWith('/')) {
          fs.mkdirSync(path.join(destDir, name), { recursive: true });
          continue;
        }
        const target = path.join(destDir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator (official runtime) ----------------

  /** Fetch a piece of XML (size capped, the index is ~400 KB) */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    return new Promise((resolve, reject) => {
      let d = '';
      res.on('data', (c) => { d += c; if (d.length > limit) res.destroy(); });
      res.on('end', () => resolve(d));
      res.on('error', () => resolve(d));
    });
  }

  /** Resolve the latest Linux emulator package from the SDK index (emulator-linux_x64-*.zip) */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const linux = urls.find((u) => /emulator-linux_x64.*\.zip$/i.test(u)) || urls.find((u) => /linux.*\.zip$/i.test(u));
        if (linux) {
          this._cache.emulatorUrl = linux;
          return linux;
        }
      }
    } catch (_) { /* use the fallback */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** Resolve the default AOSP system image from the sys-img index */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* try the next index */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // Probed last session and the engine is unchanged: reuse the cached result
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * Unpack the bundled compressed image into the user directory on first start (once).
   * A portable build ships system.img as .gz (3.1 GB → 580 MB); unpacking is required.
   * Unpack into the user data directory, not the bundle: a portable runtime unpacks
   * to a new temp directory every start and would redo the work each time.
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // The destination must follow paths().sysImgRoot rules, otherwise the image
    // duplicates (measured 1.2 GB + 3.3 GB).
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // non-image files (kernel-ranchu / ramdisk / plain .img) must land there too
    const found = new Map(); // dest -> job (.xz wins when both exist)
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // Supports .img.xz (LZMA2, ~25% smaller than .gz) and legacy .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // Copy non-image files first (the emulator needs kernel-ranchu etc. to boot)
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // unpacked in place
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`Copying an image component failed: ${e.message}`); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // 'Already unpacked' must not rely on 32 MB alone: old builds left
      // partial images that passed the threshold and broke at boot.
      // A real image is always bigger than its archive: smaller means unfinished.
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // Unpack to .part and rename on success: an interrupted unpack
      // never leaves a finished-looking partial system.img that makes
      // the next boot dies on a corrupt image and data must be deleted.
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`First start: unpacking the system image ${path.basename(j.dest)} (~1 min, once)`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // LZMA2 decompression must import the native binding index.js directly.
            // The default entries (main.js / xz.js) require('stream-polyfill.mjs'),
            // which Electron's Node 20 refuses (no require of ESM), while exports forbids
            // '@napi-rs/lzma/index.js', so require.resolve locates the file and it is loaded by path.
            const path0 = require('path');
            const lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // This must not be swallowed: the deploy and boot paths need to know the unpack failed,
        // otherwise another 1.4 GB is downloaded or the boot just fails.
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`image unpack failed: ${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`System image unpack failed (${failures.join('; ')})`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /** Is the system image complete (system.img missing or too small means incomplete) */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // Look in the default API 34 Play location first, then any image.
    // A portable build may ship a smaller AOSP image; hardcoding API 34 would
    // report 'not downloaded' with the image present.
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    for (const dir of candidates) {
      const system = path.join(dir, 'system.img');
      const kernel = path.join(dir, 'kernel-ranchu');
      const size = fileSize(system);
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi };
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? 'image incomplete' : 'system.img missing' };
      }
    }
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: 'not downloaded' };
  }

  /**
   * Hardware acceleration state.
   * On Linux the only accelerator is KVM (/dev/kvm); Windows uses WHPX or AEHD.
   */
  async emulatorAccel() {
    // Status polls every few seconds and -accel-check spawns a process, so results are cached
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: 'emulator not installed' };

    // On-disk cache: no process is spawned on start-up for this.
    // An 'unavailable' verdict is trusted for 10 minutes only.
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const hv = await this.hypervisor();

    // На Linux никаких WHPX/AEHD нет: единственный источник ускорения — KVM.
    // -accel-check у Linux-сборки эмулятора есть, но он же и падает без /dev/kvm,
    // поэтому сначала смотрим файл устройства, а версию движка выясняем отдельно.
    if (process.platform === 'linux') {
      const result = hv.kvm
        ? { ok: true, kind: 'kvm', note: 'KVM включён: аппаратное ускорение активно' }
        : {
          ok: false,
          kind: 'none',
          kvm: false,
          present: hv.present,
          readable: hv.readable,
          note: hv.note,
        };
      this._cache.accel = result;
      this._cache.accelAt = Date.now();
      this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
      return result;
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'WHPX acceleration enabled' : 'AEHD acceleration enabled' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // Slimmed runtime packages may omit the checker, so -accel-check cannot conclude.
      // With the driver installed it counts as usable: the emulator mounts it at start,
      // avoiding a forced -accel off that crashes on some machines.
      result = { ok: true, kind: 'aehd', note: 'AEHD acceleration enabled (checker missing, judged by driver)' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'AEHD acceleration enabled' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'WHPX acceleration enabled' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        kvm: hv.kvm,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'No hardware acceleration: software emulation (slow). Enable KVM on Linux.',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** Download and install the emulator (the zip root is emulator/, extracted into the SDK root) */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: 'Downloading the runtime engine (~440 MB, official source)…', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading the runtime engine ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, 'runtime engine');

    onProgress({ stage: 'extract', message: 'Extracting the runtime engine…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // The SDK root needs platform-tools or the emulator refuses to start
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('The emulator does not run after extraction — check file permissions');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `Runtime engine ${v.version} ready`, percent: 100 });
    return v;
  }

  /** The emulator needs a platform-tools directory under the SDK root or it fails fatally */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb')));
    if (!src) return false;
    for (const f of ['adb', 'fastboot', 'make_f2fs', 'mke2fs.conf', 'lib64']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** Only one universal base image (Android 14 Play x86_64); no normal/compatible pair */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** Is the ARM compatible image (Google Play build) in place */
  playImageInfo() {
    const p = this.paths();
    const dir = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag, PLAY_SYSIMG.abi);
    const size = fileSize(path.join(dir, 'system.img'));
    if (size > MIN_SIZE.sysimg && fs.existsSync(path.join(dir, 'kernel-ranchu'))) {
      return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag };
    }
    return { ok: false, dir, size, note: size ? 'image incomplete' : 'not downloaded' };
  }

  /** Resolve the Google Play image URL (<url> is relative to the index directory) */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* use the fallback */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** Download and install the ARM compatible image (Google Play build, ~1.5 GB) */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: 'Downloading the ARM compatible image (Android 14, ~1.5 GB)…', percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading the compatible image ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, 'compatible image');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: 'Extracting the compatible image (3 GB, ten seconds or so)…', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `Extracting the compatible image ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('The compatible image failed verification after extraction');
    // Legacy API 30 images are no longer used; clean them up to free space
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'ARM compatible image ready; restart the runtime to apply', percent: 100 });
    return info;
  }

  /** Download the AEHD driver (Windows only); installing needs elevation */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: 'Downloading the AEHD driver…', percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('The AEHD driver package did not extract correctly');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'AEHD driver ready; installation needs elevation', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** Find the newest installer name in the official directory (no hardcoded version) */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* fall back to the backup source */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: 'Looking up the latest QEMU version…', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `Downloading QEMU (~200 MB)…`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, 'QEMU package');

    onProgress({ stage: 'install', message: 'Installing QEMU silently…', percent: 96 });
    // The QEMU installer is NSIS: /S is silent, /D sets the directory (last, unquoted)
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('qemu-system-x86_64 was not found after install; install QEMU from your distribution');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} ready`, percent: 100 });
    return v;
  }

  // ---------------- system image ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: 'Downloading Android-x86 9.0-r2 (~900 MB, 8 chunks)…', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading the system image… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`System image unusable: ${info.reason}${info.size && info.size < MIN_SIZE.iso ? '; click again to resume' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `System image ready (${(info.size / 1073741824).toFixed(2)} GB)`, percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** Validate an imported image/ISO */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('The file does not exist or is empty');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || 'The image file is unusable');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- virtual disk ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `Creating a ${sizeGB}GB virtual disk…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`qemu-img failed to create the disk: ${r.stderr || r.stdout}`);
    } else {
      throw new Error('qemu-img not found — install qemu-utils');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: 'Virtual disk created', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- system image reachability ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, systemQemuImg, systemE2fs, SOURCES, MIN_SIZE, absUrl, baseOf };
