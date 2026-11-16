'use strict';
/**
 * Device adaptation / automatic diagnostics (zero-config foundation)
 *
 * Goal: no parameters to tune, whatever the machine.
 *  - chooseProfile()  derives launch parameters from RAM, CPU, disk, acceleration and emulator version;
 *  - planVariants()   produces the step-down retry plan (GPU → acceleration → memory → cold boot);
 *  - diagnose()       turns the emulator stderr into actionable hints;
 *  - shortPath()      deals with non-ASCII/space paths (QEMU in the emulator is very picky).
 *
 * Pure functions plus read-only probes: no settings writes, no Android launch, easy to unit-test.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Host profile (sub-millisecond, read-only) */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** Free space (MB) on the filesystem holding the directory; 0 when unknown */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Since emulator 36.4.9 swiftshader_indirect is deprecated in favour of -gpu software.
 * On 37.x swiftshader_indirect fails GL init or exits outright (highly device-dependent).
 * Candidates must be chosen by version, and every candidate needs a fallback.
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  return modern
    // The order is the auto-mode priority:
    // 1) host        — real GPU rendering, cheapest on CPU and most responsive;
    // 2) swangle     — ANGLE on top of SwiftShader. Much friendlier to Android WebView
    //                  compositing than bare software (video apps that go black after the
    //                  consent screen fail exactly this way), hence second place;
    // 3) software    — pure SwiftShader fallback: compatible but WebView compositing often blacks out; last resort;
    // 4) swiftshader — legacy alias fallback.
    // safeGpu (the TCG fallback with acceleration off) still uses software: slow but most compatible.
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
}

/** Короткий путь в стиле Windows 8.3 (кириллица в пути ломала emulator). На Linux не нужен. */
/**
 * Screen spec. landscape=true returns a real landscape panel (1280x720).
 *
 * Why the panel must change instead of wm size at runtime: the emulator LCD is a physical panel;
 * Qt sizes the window from it and pins the picture to the top-left. Changing wm size only changes Android's
 * logical resolution while the panel stays portrait — the result is a 90° rotated strip in the corner,
 * huge black borders and misaligned taps. Only swapping hw.lcd.width/height and restarting
 * gives an upright, filling landscape panel.
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 names disabled — keep the original path */ }
  return p;
}

/**
 * Derive zero-config launch parameters.
 * Explicit engine.memoryMB / cores / gpuMode in the settings act as a cap/override,
 * but nothing hardcodes 4 GB / 4 cores and breaks small machines any more.
 */
/**
 * Lightweight container quota: only limit what hurts host responsiveness most — vCPU count.
 *
 * The old logic gave 4 cores on a 16-core box, and those four vCPU threads kept four physical cores busy,
 * leaving the desktop, the pointer and the browser fighting for the rest — 'everything lags when it opens'.
 * Two vCPUs are plenty for one Android app; giving more only slows the host.
 *
 * Memory and resolution are deliberately left alone: the cap is 2-3 GB anyway, and shrinking the
 * resolution changes the quickboot fingerprint and forces a cold boot on every mode switch.
 *
 * Pure function; returns null for null settings (existing callers and tests keep their behaviour).
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // The old rule was floor(cores/4) clamped to 2-3 — two vCPUs on 8 cores, and software video
    // decoding turned into a slideshow. Now it is half the physical cores, capped at 4:
    // 4 on 8 cores, 2 on 4 cores — the desktop keeps spare cores and video is fine.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3 GB is enough for Android 14 and mainstream apps; more only inflates RAM use and the quickboot snapshot
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // Frugal mode: video/reading workloads do not need 3 GB, so cap at 2 GB.
  // That keeps qemu about 1 GB leaner and the snapshot 1 GB smaller (less disk churn).
  // Only applied when the user did not set memory manually; a manual value always wins.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // Lowered when physical RAM is short; Android 14 needs 2 GB, below that only slow TCG is left
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, 8192);

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) cores = clamp(Number(overrides.cores) || cores, 1, 8);
  // Lightweight mode trims only when the user did not set cores; a manual value always wins
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data size: apps, game assets and their update packages live here; 4 GB fills up too easily
  // (in-app updates then report 'not enough disk space'). Default 6/8 GB depending on free space;
  // it can be set in the settings (growing resizes in place on next boot, data kept).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  const autoDataMB = disk && disk < 12288 ? 4096 : 6144;
  const dataMB = wantGB > 0 ? clamp(Math.round(wantGB * 1024), 2048, 65536) : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Render resolution: auto picks by accel state (software drops to 540x960 to stay smooth)
  // Landscape first: it is decided by the physical panel size, so it must go into the AVD and restart,
  // therefore the direction comes from settings.display.landscape and renderSize is applied on top.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // If an explicit size contradicts the orientation, correct it (landscape: long edge is the width)
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // Pure software emulation does start without acceleration, but an Android 14 cold boot can take 5-10 minutes
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Turn the advanced user settings into overrides.
 * 0 / auto / unset all mean 'no override' and keep auto derivation;
 * only an explicit value with auto-memory off takes effect.
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * Single entry point for display/diagnostics: computes the same parameters without booting Android.
 * The settings page used to call chooseProfile() without version and accel state, which on 37.x
 * showed the deprecated swiftshader_indirect / software mode that did not match reality.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044 } = {}) {
  return chooseProfile({
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Retry matrix: from best to most conservative, at most 4 attempts.
 * Change the GPU backend → turn acceleration off (TCG) → lower memory and force a cold boot.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'hardware acceleration' : 'software emulation'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Software emulation, acceleration off (slow, but most compatible)',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Conservative cold boot (minimum memory + snapshot cleared)',
    // This must NEVER wipe: it used to be wipe:true, and every attempt failed when the disk was full,
    // so the retries cleared the snapshot and the data together with every installed app —
    // exactly how 'the disk got full and all my apps vanished' happened.
    // ensureDataPartition decides when userdata must be rebuilt (only on a corrupt image),
    // not the -wipe-data launch flag.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Deduplicate identical gpu/accel/wipe combos — but the last stage must be kept:
  // it is the only 'no snapshot' option and on small-memory hosts can match the previous one exactly.
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Find a free port pair (emulator console and its adb registration port differ by one) */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * adb server port: fixed, no probing.
 * It used to search upward from 5044, but the adb server is a long-lived process that holds the port,
 * so every ApkStart start spawned another server (six of them in one session),
 * and the ever-changing port broke adoption of the previous emulator.
 * 5044 is reserved for ApkStart (the user's own adb listens on 5037).
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * Config fingerprint: a snapshot is voided only when image / data partition / engine version change.
 * GPU, acceleration and memory are deliberately excluded — auto retries flip them constantly,
 * including them would make every retry pass -wipe-data and erase the user's apps.
 */
/**
 * Quickboot snapshot fingerprint: only these changes invalidate an old snapshot (black screen / no boot).
 *
 * dataMB is deliberately NOT included: an old snapshot still works after the partition grows (qemu
 * remounts with the new size); including it would turn a simple resize into snapshot discard + cold
 * boot + data loss — seen once in the field, and every app on the device was gone.
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * System image identity: only the part after `system-images/` is kept.
 *
 * It does not matter which disk holds the image; the same image in another directory must not count as a new one —
 * otherwise moving the runtime to another volume (which the settings page recommends) would
 * make the AVD sysdir mismatch → image considered changed → -wipe-data → all apps lost.
 * It really happens, so both places (AVD config and snapshot fingerprint) must use the identity, not the path.
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // emulator/qemu exits with 0xC0000005 (3221225477) — usually a GPU driver or Vulkan backend
    // crashing right as the guest boots. Unrelated to CPU, memory or the image
    // (switching to -gpu software usually gets past it).
    // Must come before GPU_INIT: crash logs also mention render init, so checking the crash first is more accurate.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Render backend crashed (0xC0000005 access violation)',
    hint: 'Retried with a more conservative render backend and remembered it. '
      + 'If it keeps happening, update the GPU driver; or lower the quality in Settings → Performance and turn off remote desktop / GPU passthrough.'
  },
  {
    code: 'GPU_INIT',
    // Match failure context only: normal logs mention Vulkan/EGL/ANGLE too, so do not flag them as fatal
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'GPU render backend failed to initialize',
    hint: 'Retried with software rendering. If it still fails, update the GPU driver or turn off remote desktop / GPU passthrough.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'This runtime does not accept that GPU mode',
    hint: 'Retried with a GPU mode that fits the runtime version (swiftshader_indirect on old, software on new).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|acceleration.*(unavailable|not available)|\/dev\/kvm.*(denied|no such)/i,
    title: 'Hardware acceleration unavailable',
    hint: 'Fell back to software emulation (the first boot is much slower). For smooth use, enable KVM: check /dev/kvm and add yourself to the kvm group.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|not enough RAM/i,
    title: 'Memory allocation failed',
    hint: 'Lowered the memory and core count given to Android. Close memory-hungry programs and retry.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Emulator port is busy',
    hint: 'Switched to a free port. If it keeps happening, quit other emulators or reboot.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'A lock file was left from the previous run',
    hint: 'Cleared the AVD lock files and started again.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'System image missing or corrupt / incompatible with old user data',
    hint: 'Booted again with clean user data. If it still fails, delete the image in Runtime and download it again.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|libgtk|libGL.*not found|cannot open shared object/i,
    title: 'Runtime component missing or a shared library is absent',
    hint: 'Reinstall the runtime: the emulator needs the system libraries listed in README (Requirements).',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|no space left/i,
    title: 'Not enough disk space to boot Android',
    hint: 'Move the runtime directory (Settings → System integration → Runtime data directory) to a larger volume, '
      + 'or turn off "keep quickboot snapshot" / shrink the data partition. Android data is never cleared automatically.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|cannot find the path|invalid path/i,
    title: 'Install path contains non-ASCII characters',
    hint: 'Retried with a short path. If it still fails, move ApkStart to an ASCII-only directory.',
  },
  {
    // A forced exit leaves hardware-qemu.ini.lock / multiinstance.lock in the AVD directory,
    // the emulator then refuses to start with a message easily mistaken for a CPU issue. Must precede CPU rules.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'The previous run did not exit cleanly and left a lock file',
    hint: 'ApkStart clears stale locks and retries; if it keeps happening, check whether another emulator uses the same runtime.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'The CPU lacks an instruction set the runtime needs',
    hint: 'On some older CPUs this is only a warning and Android still boots; if it never boots, try an older compatible engine or a host with VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Quickboot snapshot is corrupt',
    hint: 'Dropped the old snapshot and cold-booted; a new snapshot is written on the next clean exit.',
  },
];

/** Turn the log into {code,title,hint} for the UI and the retry logic */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'The runtime did not finish booting',
    hint: 'Retried with several parameter sets. Export the diagnostic report and attach it to an issue.',
  };
}

/** One human-readable line for the settings page so advanced users see what was chosen */
function describeProfile(p) {
  return `Auto: ${(p.memoryMB / 1024).toFixed(1)}GB RAM · ${p.cores} cores · ${p.gpu} render · `
    + `${p.accelOk ? 'hardware acceleration' : 'software emulation'} · ${p.snapshot ? 'snapshot on demand' : 'cold boot'}`
    + `${p.lite ? ' · lightweight container' : ''} · port ${p.port}`;
}

/** Export a diagnostic report (plain text, easy to paste into an issue) */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'ApkStart diagnostic report',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '== Host ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Auto configuration ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Diagnosis ==',
    `${d.code}：${d.title}`,
    d.hint,
    '',
    '== Extra ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Runtime log (last 300 lines) ==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * Legacy helper kept for the Windows flavour: is the VC++ runtime installed?
 * On Linux this is always true (the runtime ships its own libraries);
 * the Windows code path is kept only so the shared callers do not have to branch.
 *
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // Check the DLLs first: msvcp140 / vcruntime140 are what Qt6 and qemu really need.
  // File checks avoid reg.exe (blocked by some security tools and slow for a 60 s poll),
  // and never report a false 'missing' when a cleanup tool removed the registry key.
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* fall back to the registry */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* key absent = not installed */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
