'use strict';
/**
 * Emulator engine: drives the official Android Emulator as the ApkStart runtime.
 *
 * Unlike the old version, one parameter set is not assumed to work everywhere.
 *  1. doctor.chooseProfile() derives parameters from RAM/CPU/disk/acceleration/engine version;
 *  2. a failed start steps down through planVariants() (GPU backend → software → minimal cold boot);
 *  3. free port selection, AVD lock cleanup, short paths for odd directories, snapshot invalidation on image change;
 *  4. quickboot snapshot plus a small data partition for a shared read-only base and instant resume.
 *
 * The probe callback comes from Runtime and decides whether Android is really ready.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const userdata = require('./userdata');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Translate emulator/qemu exit codes into plain words.
 * 0xC0000005 (3221225477) is the most common crash: an access violation, mostly caused by the
 * GPU driver or Vulkan backend crashing as the guest boots; software rendering works around it.
 */
function describeExitCode(code) {
  // A signal termination gives code null (common with taskkill / adb emu kill),
  // which is not success but not an error either — return nothing and let callers show it.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'exited normally';
    case 1: return 'bad launch parameters or environment';
    case 3221225477: return '0xC0000005 access violation, render backend crashed';
    case 3221225725: return '0xC00000FD stack overflow';
    case 3221225781: return '0xC0000135 missing DLL (runtime libraries removed)';
    case 3221225506: return '0xC0000022 access denied (driver or permissions)';
    case 3221225595: return '0xC000007B wrong image architecture or corrupt DLL';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    // The snapshot ram.bin ≈ the VM memory (2-4 GB).
    // Fast machines need not spend gigabytes on it; it is saved only when boots are slow.
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Persist the last failed start.
   * It used to live in memory only, so a report after a restart showed
   * attempts: [] and bootLog: [] — nothing to go on, which is exactly why
   * issues #20/#25 had reports without a cause.
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* a failed write does not break the main flow */ }
  }

  /** Read the last failure record (diagnostics / pre-boot hint) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** Emulator binary and system image directory (runtime dir first, then engine/) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Pick the image: the universal API 34 Play image when present, no manual switch */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Invalidate the quickboot snapshot.
   * A snapshot holds both memory and disk state; loading an old one after an install
   * makes the freshly installed app vanish after a restart.
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Clear locks left by an unclean exit.
   * hardware-qemu.ini.lock is a DIRECTORY, not a file; rmSync(force) alone will not remove it,
   * so the emulator keeps failing with "Running multiple emulators with the same AVD"
   * (true after a forced kill); it must be removed recursively.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* busy — skip and clean next time */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Is there a COMPLETE quickboot snapshot in the AVD directory?
   * 'Directory not empty' is not enough: an interrupted save leaves a 12-byte snapshot.pb shell,
   * the emulator tries to load it, fails ("does not have the requested snapshot") and cold boots,
   * wasting seconds. Sizes are checked and empty shells plus legacy default_boot (3 GB) removed.
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // New emulators (37.x) write ram.bin, old ones ram.img.
    // Accepting only ram.img is severe: a fresh 3 GB snapshot is treated as a shell and deleted,
    // so every start passes -no-snapshot-load and cold boots — half the reason 'opening is slow'.
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // nothing there — do not delete
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Remove snapshot directories left by old versions or failed renames (ram.img up to 3 GB) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Kill orphan emulators holding the AVD lock.
   * The emulator binary is only a launcher; qemu runs detached,
   * so killing our own proc handle often leaves an orphan holding multiinstance.lock
   * and the next start fails with "Running multiple emulators with the same AVD".
   * Two sources are used: the pid in the AVD lock and qemu/emulator processes naming our AVD.
   */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Fast path (every cold boot hits it):
    //  - no .lock → no live emulator can hold this AVD, return immediately;
    //  - a lock but nobody listening → leftovers from a forced kill, just clear it.
    // wmic used to run every time (1-3 s, CPU hungry) and slowed every cold boot.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) the pid the emulator wrote into the lock file (most reliable)
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) fallback: find live qemu by process name and port (tasklist/netstat is an order faster)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+(?:LISTENING|LISTEN|LISTENING.*)\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* no process list — rely on the pid from the lock file */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`cleaning up ${pids.size} leftover emulator process(es)`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** Is any console port in 5554-5620 listening (a refused connect is cheap) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Prepare the AVD: write config.ini from the current auto profile on every start.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Screen: with acceleration 720x1280@320 is sharp;
    // pure software drops to 540x960 for frame rate (56% of the area, barely visible).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM compatible)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // Compare image identity, not the absolute path: the same image elsewhere is not a change,
      // otherwise changing the runtime directory would wipe every installed app.
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // Old userdata is incompatible with the new image (APEX boot loop) and must be rebuilt
        this.wipePending = true;
      }
    }

    // A changed fingerprint means the old snapshot fails to load or shows black; invalidate it.
    // Only the SNAPSHOT is voided, never -wipe-data: userdata holds apps and saves.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* first run */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // The delete may be blocked (snapshot directories reach several GB).
      // A failed delete renames it so the emulator skips it; cleanup never blocks the boot.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // Only an image change (tag / sysdir) needs -wipe-data: old userdata against a new image
    // loops in boot. Capacity, resolution or backend changes are not an image change.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch must be the ABI itself (x86_64 must not be truncated to x86)
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // The old hardcoded 16G created huge files on small disks and slowed the first boot
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // Snapshots are driven by -snapshot apkstart only, with a unique name, never a wrong load
      // (legacy default_boot holds API 30 memory and always loops in boot).
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // Orientation/accelerometer sensors must stay off: otherwise Android rotates itself
      // (a 90-degree picture, vertical text, black bars). Layout switching uses only
      // wm density (smallestWidth); sensors must not take part.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfg);

    // /data must really work first, otherwise everything else waits for nothing
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Make userdata a REALLY usable ext4 — the foundation against 'open an app, wait 30 s'.
   *
   * Why we build it ourselves (three field-tested reasons):
   *  1. the image ships a 1 MB all-zero userdata.img and real formatting comes from avdmanager
   *     mke2fs. ApkStart writes config.ini and starts the emulator, skipping that → /data stays zero →
   *     the kernel reports "Invalid ext4 superblock on /dev/block/vdc" → recovery loop →
   *     adbd never comes up and the probe times out at 240 s: 'open, wait minutes'.
   *  2. the bundled e2fsck/resize2fs is e2fsprogs 1.42.12, which does NOT know the encrypt
   *     feature and exits 8; growing the filesystem must happen before the bit is set.
   *  3. the filesystem must be >= the partition: 64 MB fills up during APEX/dexopt,
   *     every setxattr then returns ENOSPC, SELinux labels fail and netd/media/tombstoned
   *     exit 1, leaving the boot animation forever and adb offline.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* does not exist */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // The file must be big enough AND the filesystem must really be that large.
      // File size alone hides a real failure: qemu-img stretched the file but resize2fs failed,
      // leaving 6 GB on disk and 64 MB in Android — 'not enough space for games'.
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // Capacity grew (or the fs lagged): grow in place, no rebuild, apps kept
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata grown: file ${size} → ${wantBytes}, filesystem ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`growing userdata failed (keeping the current partition): ${e.message}`);
        // The old partition still works, but the caller must know the growth failed
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // First run / an all-zero placeholder / a corrupt image: build a fresh one
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Start without the encrypt bit so older e2fsck/resize2fs will run
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`userdata rebuilt: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (4K blocks, FBE ready)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Best effort: restore the encrypt bit so FBE can initialise (partition stays small)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`rebuilding userdata failed: ${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** qemu-img: stretch the raw image file to the target size (sparse, instant)
   *  Argument order matters: `qemu-img <command> -f raw <file> <size>`.
   *  Putting -f before the command makes it a global flag and fails with unrecognized option. */
  _qemuImg(op, ...rest) {
    // На Linux qemu-img берём системный (/usr/bin/qemu-img, пакет qemu-utils):
    // в Linux-сборке эмулятора его в каталоге нет.
    const exe = process.platform === 'linux'
      ? (require('./provision').systemQemuImg())
      : path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** resize2fs (bundled on Windows, system e2fsprogs on Linux) */
  _resize2fs(img) {
    const bin = process.platform === 'linux' ? '/usr/sbin' : path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = process.platform === 'linux'
      ? ['/usr/sbin/resize2fs', '/sbin/resize2fs'].find((c) => fs.existsSync(c)) || 'resize2fs'
      : path.join(bin, 'resize2fs.exe');
    if (process.platform !== 'linux' && !fs.existsSync(exe)) throw new Error('resize2fs missing');
    const r = spawnSync(exe, [img], {
      cwd: fs.existsSync(bin) ? bin : undefined, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** The emulator uses these variables to find the SDK / AVD; odd paths become short paths */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // The AVD directory must match provisioner.paths().avdHome: a read-only bundled runtime
    // has no writable root/avd, so the AVD lives in the user data directory.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
    };
  }

  buildArgs({
    headless = process.platform !== 'linux', accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Audio: on by default so app sounds and video play.
      // -no-audio is passed only when the user turned sound off.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Crash reporting is disabled: a stored crash report makes the emulator show a
      // consent dialog that blocks the main thread (log: Showing crashdialog to get consent).
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // Network: the emulator uses QEMU user-mode NAT (-netdev user); Android gets
    // 10.0.2.x addresses and leaves through the host's physical NIC.
    // This mode creates NO virtual adapter or switch
    // (that needs -netdev tap or bridging, which is never enabled here).
    // Android is just a device behind the host NAT; the host network stack is untouched,
    // no drivers, no extra adapter.
    // Declare full speed explicitly: some -gpu / -net combinations inherit
    // conservative defaults and video apps load their first screen late.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // DNS: Android defaults to 10.0.2.3 (forwarded to the host DNS). Hosts on VPN / corporate networks
    // can make one lookup take hundreds of ms, so pages spin before loading. A public resolver
    // comes first and the system falls back on failure. It can be turned off in Settings.
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless && process.platform !== 'linux') {
      args.push('-no-window');
    } else if (process.platform === 'linux') {
      // На Linux окно эмулятора — это и есть окно приложения: заголовок,
      // размер и фокус ему ставит appwin.js через xdotool/wmctrl.
      // -no-window тут был бы фатальным: Android не выводит VSYNC в headless
      // и на экране будет пусто.
      // Never pass -gpu-wrap: the Android Emulator (37.x) rejects it with
      // 'unknown option: -gpu-wrap' and exits with code 1. The window is created anyway,
      // which is all we need (appwin.js sets title/size through xdotool/wmctrl).
    } else {
      // Never pass -no-skin: it overrides -skin and falls back to the config.ini panel size —
      // 'landscape selected but still portrait',
      // and 'the picture sits in a corner strip'. -skin must decide the panel.
      // The device frame is never drawn (ShowDeviceFrame=no plus the style flags below).
      // Never use -qt-hide-window: the emulator would not create the Qt window at all,
      // which is the window we adopt as the app window —
      // the probe would never find it and the user would see a black window.
      // Hiding is handled by the window agent on Windows only.
    }
    // -snapshot is passed only when the snapshot exists: on a fresh AVD
    // qemu waits for a memory state that is not there, the process lives but never boots —
    // the caller only sees a boot timeout, retries with other parameters and hits the AVD lock
    // "Running multiple emulators with the same AVD"。
    // Snapshot flags decide whether the next boot is 8 s or 90 s. The second fatal point:
    // the old code passed -no-snapshot when none existed, which also disables SAVING on exit,
    // so no snapshot was ever produced and every open was a full boot.
    // The right flag is -no-snapshot-load: no load this time,
    // but the state is still saved as apkstart on exit and restored next time.
    // A snapshot costs a ~2-3 GB ram.bin (can be turned off; start time only)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // A data reset must not load the old snapshot but MUST allow saving a new one:
      // the network repair relies on reset → online first boot → snapshot → resume,
      // and -no-snapshot would disable saving altogether.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // Network self-healing needs a cold boot: the snapshot may have been taken offline.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    return args;
  }

  /** Spawn one process (no boot wait; the probe loop in start() does that) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: keep the emulator independent of the ApkStart process group.
      // Electron closes its job object on exit and takes children with it —
      // 'close ApkStart, reopen, another 20 s cold boot'. Detached, it survives
      // and is adopted next time (Runtime.adoptExisting) for instant opens.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `（${meaning}）` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `（${meaning}）` : ''}\n`);
      this.proc = null;
      onLog(`Runtime exited (code=${code}${meaning ? `, ${meaning}` : ''})`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu runs detached; lower its priority once it is really up.
    // Otherwise 2-4 vCPU threads compete with the desktop at Normal priority
    // and the whole machine feels sluggish while ApkStart runs.
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Write the emulator log with size rotation */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Current /data image facts (for Settings, without booting Android) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* not created yet */ }
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      configuredGB: Number(this.settings?.engine?.dataPartitionGB || 0),
    };
  }

  /**
   * Grow /data to the given size now (the emulator must be stopped, the image is busy).
   * Uses the in-place path of ensureDataPartition: qemu-img resize + resize2fs,
   * no rebuild, apps and saves kept.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    return this.ensureDataPartition(dir, dataMB);
  }

  /**
   * Adjust the priority of qemu/emulator processes (only ones naming our AVD).
   * level: idle (container parked) | below (an app is in front) | normal (performance).
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Force-kill the current attempt (including the qemu process tree) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // The proc handle is usually gone (the emulator exits after spawning qemu detached),
    // so a name-based sweep is needed or the AVD lock fails the next round.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Rebuild the adb server on our dedicated port.
   *
   * The main culprit behind 'opening an app takes two minutes'; kill-server alone returned too early:
   * the emulator connects to the adb daemon on ANDROID_ADB_SERVER_PORT at start,
   * and never registers the device — adb devices shows no emulator-5554
   * or stays offline forever ("Unable to connect to adb daemon on port: 5044").
   * The probe never sees sys.boot_completed, times out after 3 minutes and retries,
   * every retry is a full cold boot and the snapshot is never saved — an endless loop.
   *
   * So kill first (clearing the old device), then start and wait until the port really listens.
   */
  /** Restart the server once when adb is stuck (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* use the one from PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // adb start-server returns quickly while the port is not listening yet,
    // so wait until it connects (at most ~3 s, usually tens of ms).
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Handle the case where the spawn exits immediately.
   * Bad flags or a missing library exit within a second; a live process returns at once,
   * no fixed 2.5 s wait — on a snapshot resume that is half a boot.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Make the next start a forced cold boot (no quickboot snapshot).
   *
   * The snapshot also holds the NIC state: one taken offline restores offline every time.
   * A cold boot during network repair skips that broken snapshot.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Make the next start pass -wipe-data (only for network repair after failed attempts).
   * Deleting the userdata image is not the same as -wipe-data; the latter is required.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Check whether the VM really has a network.
   *
   * The Wi-Fi config lives in /data; when it breaks (typically two AndroidWifi entries
   * in `cmd wifi list-networks` with colliding network ids),
   * wlan0 stays NO-CARRIER without an IP, and online pages in apps show a black
   * rectangle — nothing to do with GPU or rendering.
   *
   * @param {string} [adbPath] explicit adb binary (Runtime resolves a better one)
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    let adb = adbPath || '';
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() only reads the version file, which is often empty;
      // the bundled platform-tools under the runtime root is more reliable.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Android's multiple routing tables make `ip route` look empty (default route is per-interface),
    // and the shell uid is not in the app's network group so `ping` often lies with
    // "Network is unreachable". Only an IPv4 address counts here,
    // cross-checked with `cmd wifi status`, never ping.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // Wi-Fi association and DHCP often finish tens of seconds after sys.boot_completed.
      // With waitMs given, keep waiting instead of declaring 'no network'.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected };
  }

  /**
   * Start with automatic retries.
   * @param {Function} probe async callback returning 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      return { ok: true, reused: true, serial: this.serial, port: this.port };
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('The runtime engine is not installed — deploy it in Runtime first');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('The system image is not ready — download it in Runtime first');
    }

    const s = this.settings;
    // Check the disk before booting: the AVD (data partition + snapshot, several GB)
    // decides whether a boot is possible; the runtime directory only gets logs.
    // Taking the minimum of both used to flag 'data moved to another volume, system disk at 400 MB'
    // as low disk space — making the move pointless.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Not enough disk space: the volume holding the Android data directory (${avdHome}) has ${(avdFreeMB / 1024).toFixed(1)} GB free, `
        + `and the runtime needs at least ${(needMB / 1024).toFixed(1)} GB. In Settings → System integration → Android data directory `
        + 'point it at a larger volume or free some space. Apps and saves are never deleted automatically.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `The runtime directory (${loc.root}) is on a volume with only ${(diskMB / 1024).toFixed(1)} GB free, `
        + 'not even enough for logs and temporary files. Free space or move the runtime data directory.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Make every adb call and the emulator in this process use one server port
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // These four are independent and run in parallel; they used to be sequential
    // and cost 3-5 s right after the user clicks.
    // The old adb server may still hold device records that push the new emulator to offline,
    // so it is still cleared — just not awaited alone.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // The same entry as Settings and the report, so what is shown is what runs
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    const variants = doctor.planVariants(profile).slice(0, maxAttempts);

    // Remember a GPU backend that crashed on start and try it last next time.
    // On an AMD Radeon 780M `-gpu host` passes the emulator's own hardware check
    // but the process exits 1 some ten seconds later (log: "AEHD is operational"),
    // wasting 20 s before falling back to swangle. The key includes the emulator version,
    // so a runtime upgrade gives it another chance.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`The ${badGpu} render backend crashed last time; trying ${variants[1].gpu} first`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

    // Keep one screen spec for the whole start; changing it per retry would wipe snapshots.
    // The resolution comes from doctor's profile ("picture quality" in Settings).
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Clear orphans before a cold boot: a leftover qemu holding the AVD lock makes
    // every attempt fail with "Running multiple emulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // A busy port fails too, so it is probed again on every retry
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // Reset the exit code each round so the previous crash does not skew the diagnosis
      this.lastExitCode = null;
      // Logs are split per round: the in-memory log accumulates, and a crash line from round 1
      // would make a round 2 port conflict look like the same crash.
      const logStart = this._log.length;
      onLog(`Starting the runtime (attempt ${i + 1}/${variants.length}: ${plan.label})…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe also clears old snapshots: after a reset the old one cannot load
        // (Failed to load snapshot, then a cold boot), so clear before rebuilding.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Hook: main uses it to start console suppression BEFORE the emulator spawns.
      // A console window appears tens of ms after spawn; a later sweep would flash it,
      // so it must be enabled first.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot applies to this spawn only, so later boots do not degrade
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Bad flags or a missing library exit immediately
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // A full disk is not fixed by other parameters; retries only fail again
        // and the last variant wipes data. Stop here and report it.
        if (d.code === 'DISK_FULL') {
          onLog('Not enough disk space, retries stopped (apps and saves untouched).');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Acceleration/image conclusions may be stale cache; drop them for the next start
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}; retrying with other parameters…`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // A snapshot resume boots within seconds; a fixed 3 s poll adds 1.5 s on average
      // before noticing. Polling starts at 200 ms and widens to 1.2 s: quick early,
      // cheap during a long boot.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // An adb shell means the kernel is booting; ordinary Vulkan/EGL lines are not failures
        if (state === 'booting') sawBooting = true;
        // No adb after 45 s plus a clear fatal error → switch early instead of waiting 4 min
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // One progress line per 15 s; modulo checks printed duplicates with adaptive polling
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Booting… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // It really booted: clear the previous failure so diagnostics do not dredge it up
        this._clearFailure();
        // Always save a quickboot snapshot: the emulator ends with ApkStart (Electron kills
        // its children), and the next open is 25 s or 7 s depending on the snapshot.
        // The installer invalidates the snapshot after an install so the app does not vanish.
        this.snapshotWorthSaving = true;
        onLog(`Runtime ready (${Math.round(bootMs / 1000)}s, ${plan.label})`);
        // A boot is not a working setup: the network is checked too. Without one, online
        // pages stay black and users blame the app. Check once and say it plainly.
        let network = null;
        try { network = await this.checkNetwork(); } catch (_) { /* a failed check is not a failed start */ }
        if (network && !network.ok) {
          onLog('WARNING: the Android VM has no network; online apps will show a black page.'
            + ' Use Settings → Repair network to reset Android data (apps reinstall on open).');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}: ${d.hint}` : 'Boot timed out (slow first boot or no hardware acceleration)';
      onLog(`${lastError}; retrying with other parameters…`);
      this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `The runtime failed to start after several attempts (${d.title}).\n${d.hint}\n\n`
      + `Tried: ${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('; ')}\n`
      + `Diagnostic report: ${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Save a quickboot snapshot so the next boot restores memory state.
   *
   * Timing matters: saving 6 s after boot competed with the user opening an app
   * (1-3 GB written) and felt slower. Now it saves when idle, triggered by Runtime
   * when the last window closes, and again before shutdown if that did not happen.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // The save command may return OK mid-write, so the files are checked again;
    // only a real snapshot.pb counts (otherwise the next load fails and wastes seconds).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Schedule an idle snapshot save.
   * Scheduled once; if an app is still in front it waits for real idleness.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // Skip when free space is below memory + 1 GB: writing would fill the disk
        // and break the next boot. A snapshot only affects start time.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`snapshot skipped: ${(freeMB / 1024).toFixed(1)}GB free < ${(needMB / 1024).toFixed(1)}GB needed`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Graceful stop: save the snapshot, shut down via console, then kill the tree */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // An adopted instance has no proc handle but really runs; do not return true blindly
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    if (adbPath && this.snapshotWorthSaving !== false) {
      // Save once more before shutdown when the idle path did not run
      // (the user installed an app and quit), so the next boot resumes.
      // Writing 3 GB takes 3-25 s, so the timeout is generous.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // Let it finish its write-then-exit flow. A fixed 6 s kill
    // truncated the snapshot, leaving a shell with ram.img but no snapshot.pb.
    //
    // Do not wait on this.proc: the emulator is only a launcher that exits after spawning qemu,
    // so its exit would immediately trigger the kill path. The console port decides.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    return true;
  }

  /**
   * Remember a GPU backend that crashes on start and try it last next time.
   * Auto mode only: an explicit choice by the user is respected.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // Software rendering is the last resort; nothing slower to fall back to
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** Is anything still running on our console port (5554) — is the shutdown clean */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /** Trigger a snapshot save through adb (false on failure; the caller decides) */
  _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Take only the log lines produced by THIS attempt.
   * The in-memory log spans rounds (the report needs all of them), but a diagnosis
   * must use one round only, or round 1's `emulator exit 3221225477` mislabels round 2.
   * With no lines this round (the process never started) the overall tail is used.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Read the last n lines of emulator.log (when the in-memory buffer is empty).
   * After an ApkStart restart the in-memory log is empty,
   * so reports showed only UNKNOWN while the cause sat in the log file.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // Reading from the start may truncate the first line — drop it
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
