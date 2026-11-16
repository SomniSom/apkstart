'use strict';
/**
 * Runtime slimming: delete emulator files that our launch mode never loads.
 *
 * The criteria come from the fixed arguments in emulator.js:
 *   - x86_64 images only (API 30 AOSP)   -> qemu-system-aarch64.exe is unused
 *   - -gpu software (swiftshader)        -> the vulkan / gles_angle backends are unused
 *   - only a 38px title bar is shown     -> the emulator's own UI and WebEngine are unused
 *
 * Networking pieces (netsimd / netsim / nimble_bridge) are always kept: they carry
 * wifi and bluetooth traffic, and without them apps have no network.
 *
 * Usage:
 *   node build/slim-runtime.js build/runtime                 # safe profile (default)
 *   node build/slim-runtime.js build/runtime --aggressive    # also drop QtWebEngine (-169 MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Safe profile: removes only what is provably never loaded (~-190 MB).
 * Boundaries confirmed by single-point rollbacks (important — do not add to this blindly):
 *   - Qt6WebEngineCoreAndroidEmu.dll is a hard (static) dependency of emulator.exe -> keep
 *   - lib64/gles_angle provides vk_swiftshader, which software rendering needs -> keep
 *   - lib64/vulkan can go (only falls back to software rendering) -> frees 103 MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'arm64 QEMU binary (we ship x86_64 images only)'],
  // Never delete emulator/lib64/vulkan wholesale: vulkan-1.dll is the -gpu host loader
  // and host rendering breaks without it (required on AMD 780M). Only the big items:
  ['emulator/lib64/vulkan/layers', 'Vulkan validation layers (unused by host rendering, -20 MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'shader validator (unused at runtime, -7 MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'lavapipe software Vulkan fallback (unused with a GPU driver, -53 MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'lavapipe ICD descriptor (-1 KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (duplicate copy in gles_angle, -23 MB)'],
  ['emulator/lib64/qt/translations', 'emulator UI translations (only a 38px title bar is shown)'],
  // Never delete emulator-check.exe: -accel-check relies on it for KVM/AEHD/WHPX;
  // without it acceleration looks absent and the runtime falls back to TCG.
  ['emulator/qsn.exe', 'QEMU snapshot notifier (no references in emulator.exe, verified with strings, -34 MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'VR panorama environment texture (unused, -3.7 MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR panorama decoration texture (-3.5 MB)'],
  ['emulator/resources/Toren1BD.obj', 'VR panorama 3D model (-3.5 MB)'],
  ['emulator/resources/macroPreviews', 'macro previews (-2.7 MB)'],
  ['emulator/resources/default360.mp4', 'default 360 panorama video (-2.4 MB)'],
];

/** Aggressive profile is empty: WebEngine and gles_angle are both required */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* ignore */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} is not a runtime directory (emulator/emulator.exe is missing)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  skipping ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  removing ${rel} (${(n / 1048576).toFixed(0)} MB) - ${why}`);
  }
  log(`${dryRun ? 'can free' : 'freed'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`slim target: ${root} (${aggressive ? 'aggressive' : 'safe'} profile)`);
  slim(root, { aggressive, dryRun });
}
