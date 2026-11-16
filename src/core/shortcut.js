'use strict';
/**
 * Рабочий стол: ярлыки .desktop + PNG-иконки (Linux)
 *
 * На Linux ярлык — это текстовый файл .desktop (freedesktop.org Desktop Entry),
 * and the icon is a plain PNG in the application directory. ICO/MS shell entries are gone:
 * убирая их, мы избавляемся от Electron shell.writeShortcutLink и от всей
 * Windows-only цепочки DIB/ICO, которая на Linux просто не выполнится.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256];

/** Имя файла без запрещённых в путях символов (совместимо с файловыми системами Linux) */
function safeFileName(name) {
  return String(name)
    .replace(/[/\u0000:*?"<>|\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Android App';
}

/** Ссылочная строка Exec: экранируем строку по спецификации Desktop Entry */
function execQuote(arg) {
  const s = String(arg == null ? '' : arg);
  // в поле Exec служебные символы экранируются обратным слешем, а % — как %%
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')
    .replace(/`/g, '\\`').replace(/%/g, '%%')}"`;
}

function desktopEscape(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/**
 * Собрать содержимое .desktop файла.
 * @param {object} opt { name, exec, args, icon, comment, categories, terminal, startupWMClass, mimeType }
 */
function desktopEntry(opt) {
  const exec = [execQuote(opt.exec)]
    .concat((opt.args || []).filter((a) => a !== '').map(execQuote))
    .join(' ');
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.5',
    `Name=${desktopEscape(opt.name || 'Android App')}`,
    `Comment=${desktopEscape(opt.comment || '')}`,
    `Exec=${exec}`,
    opt.icon ? `Icon=${opt.icon}` : null,
    opt.terminal ? 'Terminal=true' : 'Terminal=false',
    `Categories=${opt.categories || 'Utility;'}`,
    opt.startupWMClass ? `StartupWMClass=${opt.startupWMClass}` : null,
    opt.mimeType ? `MimeType=${opt.mimeType}` : null,
    'StartupNotify=true',
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

/**
 * Записать .desktop и сделать его исполняемым.
 * GNOME/Nautilus требуют бит +x и доверие пользователя (gio set metadata::trusted),
 * поэтому после записи пробуем пометить файл доверенным, но не падаем, если не вышло.
 */
function writeDesktopFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, filePath);
  try {
    const { execFileSync } = require('child_process');
    execFileSync('gio', ['set', filePath, 'metadata::trusted', 'true'], {
      stdio: 'ignore', timeout: 3000,
    });
  } catch (_) { /* нет gio / другой DE — не критично */ }
  return filePath;
}

/** Обновить кэш меню приложений, если инструмент установлен */
function updateDesktopDatabase() {
  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/local/share/applications',
  ];
  const { execFile } = require('child_process');
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    execFile('update-desktop-database', [d], { timeout: 8000 }, () => {});
  }
}

/** Пути стандартных каталогов пользователя (XDG) */
function xdgDirs() {
  const home = os.homedir();
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const data = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  let desktop = path.join(home, 'Desktop');
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (out && out !== home) desktop = out;
  } catch (_) {
    try {
      const userDirs = fs.readFileSync(path.join(config, 'user-dirs.dirs'), 'utf8');
      const m = /^XDG_DESKTOP_DIR="(.+)"$/m.exec(userDirs);
      if (m) desktop = m[1].replace(/^\$HOME/, home);
    } catch (_) { /* остаёмся на ~/Desktop */ }
  }
  return {
    home,
    config,
    data,
    desktop,
    applications: path.join(data, 'applications'),
    icons: path.join(data, 'icons', 'hicolor'),
    cache: process.env.XDG_CACHE_HOME || path.join(home, '.cache'),
  };
}

/**
 * Иконка приложения: PNG уже получен из APK (nativeImage.toPNG или декодер WebP).
 * Раскладываем в hicolor/<size>x<size>/apps/<id>.png, чтобы DE нашёл нужный размер.
 */
function installIcon(pngBuffer, iconId, sizes = ICON_SIZES) {
  if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) return null;
  const { nativeImage } = require('electron');
  const base = nativeImage.createFromBuffer(pngBuffer);
  if (!base || base.isEmpty()) return null;
  const dirs = xdgDirs();
  const target = path.join(dirs.icons, `${Math.min(256, Math.max(...sizes))}x${Math.min(256, Math.max(...sizes))}`, 'apps');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `${iconId}.png`);
  const width = base.getSize().width || 0;
  const big = sizes.filter((s) => s <= Math.max(width, 256));
  for (const s of big.length ? big : [256]) {
    const sub = path.join(dirs.icons, `${s}x${s}`, 'apps');
    fs.mkdirSync(sub, { recursive: true });
    const img = width >= s ? base.resize({ width: s, height: s, quality: 'best' }) : base.resize({ width: s, height: s });
    fs.writeFileSync(path.join(sub, `${iconId}.png`), img.toPNG());
  }
  // копия рядом с .desktop помогает тем DE, которые ищут иконки рядом
  fs.writeFileSync(file, base.toPNG());
  return file;
}

function removeShortcut(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ICON_SIZES,
  safeFileName,
  execQuote,
  desktopEscape,
  desktopEntry,
  writeDesktopFile,
  updateDesktopDatabase,
  installIcon,
  removeShortcut,
  xdgDirs,
};
