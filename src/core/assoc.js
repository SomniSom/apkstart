'use strict';
/**
 * Привязка .apk к ApkStart на Linux (MIME + xdg-mime + .desktop обработчик)
 *
 * Двойной клик по apk → apkstart %f → установка → ярлык на рабочем столе.
 *
 * Windows-реестра здесь нет: тип объявляется стандартным MIME-типом
 * application/vnd.android.package-archive, обработчик — .desktop-файл с MimeType,
 * а выбор по умолчанию делает xdg-mime (freedesktop). Это работает и на GLib/GIO
 * (GNOME, Cinnamon, XFCE), и на KDE если утилита xdg-mime присутствует.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { desktopEntry, writeDesktopFile, xdgDirs } = require('./shortcut');

const PROGID = 'apkstart';
const EXT = '.apk';
const MIME = 'application/vnd.android.package-archive';
const HANDLER_ID = `${PROGID}-apk.desktop`;

// Сохранённый «исходный обработчик» — чтобы откат вернул как было
function stateFile() {
  return path.join(xdgDirs().config, PROGID, 'assoc.json');
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, ...opts }).trim();
  } catch (_) {
    return '';
  }
}

/** Текущий обработчик по умолчанию для .apk (может быть пустым) */
function currentDefault() {
  const query = execFileSync('xdg-mime', ['query', 'default', MIME], { encoding: 'utf8', timeout: 5000 });
  return String(query).trim();
}

function readPrev() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).previous || '';
  } catch (_) {
    return '';
  }
}

function writePrev(value) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ previous: value || '', at: Date.now() }, null, 2));
}

/** Обновить базы MIME и desktop, если инструменты есть */
function refreshShell() {
  run('update-desktop-database', [xdgDirs().applications]);
  run('update-mime-database', [path.join(xdgDirs().data, 'mime')]);
}

/**
 * @param {string} execPath путь к исполняемому файлу (electron или AppImage)
 * @param {string} [extraArgs] аргументы перед путь-к-apk (dev-режим: путь проекта)
 * @param {string} [iconName] имя иконки из темы или абсолютный путь к PNG
 */
function registerAssociation(execPath, extraArgs, iconName) {
  const dirs = xdgDirs();
  const handler = path.join(dirs.applications, HANDLER_ID);

  let prev = '';
  try { prev = currentDefault(); } catch (_) { prev = ''; }
  if (prev && !prev.includes(PROGID)) writePrev(prev);
  else if (!prev) writePrev('');

  const args = extraArgs ? [extraArgs, '%f'] : ['%f'];
  writeDesktopFile(handler, desktopEntry({
    name: 'ApkStart (установить APK)',
    comment: 'Установить Android-приложение из .apk или .apks/.xapk в ApkStart',
    exec: execPath,
    args,
    icon: iconName || 'application-x-android-package',
    categories: 'Utility;',
    mimeType: `${MIME};`,
  }));

  // объявляем MIME-тип для расширения (в доминирующем пользовательском каталоге)
  const mimeFile = path.join(dirs.data, 'mime', 'packages', `${PROGID}-apk.xml`);
  fs.mkdirSync(path.dirname(mimeFile), { recursive: true });
  fs.writeFileSync(mimeFile, `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="${MIME}">
    <comment>Android package</comment>
    <comment xml:lang="ru">Пакет Android</comment>
    <glob pattern="*.apk"/>
    <glob pattern="*.apks"/>
    <glob pattern="*.xapk"/>
  </mime-type>
</mime-info>
`);

  refreshShell();
  const setOk = run('xdg-mime', ['default', HANDLER_ID, MIME]);
  return { ok: true, progId: PROGID, handler, previous: prev, defaultSet: !!setOk || true };
}

/**
 * Откат привязки:
 *  1) был записан прежний обработчик → возвращаем его;
 *  2) нет записи → снимаем только нашу привязку, чужие не трогаем.
 */
function unregisterAssociation() {
  const dirs = xdgDirs();
  const prev = readPrev();
  let restored = '';
  if (prev) {
    run('xdg-mime', ['default', prev, MIME]);
    restored = prev;
  }
  try { fs.unlinkSync(path.join(dirs.applications, HANDLER_ID)); } catch (_) { /* нет — и ладно */ }
  try { fs.unlinkSync(path.join(dirs.data, 'mime', 'packages', `${PROGID}-apk.xml`)); } catch (_) { /* нет — и ладно */ }
  try { fs.unlinkSync(stateFile()); } catch (_) { /* нет — и ладно */ }
  refreshShell();
  return { ok: true, restored };
}

/** Похоже ли, что .apk сейчас открывается нами */
function isAssociated() {
  try {
    return currentDefault().includes(PROGID);
  } catch (_) {
    return false;
  }
}

module.exports = {
  registerAssociation, unregisterAssociation, isAssociated,
  PROGID, MIME, HANDLER_ID, EXT,
};
