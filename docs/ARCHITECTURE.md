# Архитектура / Architecture

[Русский](#русский) · [English](#english)

## Русский

### Слои

```
┌──────────────────────────────────────────────────────────────┐
│ UI            src/ui (HTML/CSS/JS)  ←→  preload (contextBridge) │
├──────────────────────────────────────────────────────────────┤
│ Оркестрация   src/main.js (окно, трей, CLI, IPC)               │
│               installer.js (конвейер установки)                │
├──────────────────────────────────────────────────────────────┤
│ Домен         engine.js (жизненный цикл рантайма)              │
│               adb.js (операции с устройством)                  │
│               sharer.js (общая папка)                          │
├──────────────────────────────────────────────────────────────┤
│ Разбор        zip.js → axml.js / arsc.js → apk.js              │
│               png.js / shortcut.js (иконки и .desktop)         │
├──────────────────────────────────────────────────────────────┤
│ Интеграция ОС appwin.js (xdotool / wmctrl), assoc.js (xdg-mime) │
├──────────────────────────────────────────────────────────────┤
│ Движок        Android Emulator (Linux, KVM) │ существующий adb  │
└──────────────────────────────────────────────────────────────┘
```

### Поток 1. Установка по двойному клику

```
Файловый менеджер открывает .apk
  → MIME application/vnd.android.package-archive
  → ~/.local/share/applications/apkstart-apk.desktop (Exec = electron . %f)
  → main.js parseArgs → runInstall
      1. apk.js: разбор офлайн (zip → AXML манифеста → ARSC → имя/иконка)
      2. engine.ensure(): поднять/найти рантайм
      3. adb install -r -g -t (для .apks/.xapk — install-multiple)
      4. иконка → PNG (icons/)
      5. .desktop на рабочем столе и в меню приложений (--launch <пакет>)
      6. store.upsertApp: метаданные приложения
```

### Поток 2. Запуск из ярлыка

```
.desktop → electron . --launch <пакет>
  → runtime.ensure(): эмулятор уже работает? переиспользуем : движок не готов? поднимаем
  → adb shell cmd package resolve-activity --brief → LAUNCHER-активность
  → adb shell am start -n <пакет>/<активность>
  → appwin.adopt(): найти окно эмулятора, выставить заголовок/WM_CLASS/размер/фокус
```

### Поток 3. Окно приложения

Окно эмулятора — это и есть окно приложения. `appwin.js`:

1. `xdotool search --class emulator` → фильтр по заголовку `Android Emulator - <avd>` с таймаутом;
2. `xdotool set_window --name "<название>"` и `--class apkstart-<пакет>` — DE группирует окна и подбирает иконку;
3. `xdotool windowsize` под выбранную ориентацию, `windowactivate --sync` — фокус;
4. `wmctrl -i -r <id> -b add,fullscreen` для полноэкранного режима;
5. опрос раз в 2 с: окно закрыли крестиком → останавливаем приложение.

Смена ориентации требует перезапуска эмулятора с другим `-skin` (изменение `wm size`/`wm density` даёт повёрнутую или не заполненную картинку — проверено).

### Разбор APK без зависимостей

`zip.js` читает центральный каталог ZIP и умеет потоково распаковывать (нужно для многогигабайтных `.apks`). `axml.js` разбирает бинарный XML, `arsc.js` — таблицу ресурсов, чтобы восстановить имя и путь иконки. ICO больше не нужен: иконки хранятся как PNG, что для freedesktop естественно.

---

## English

### Layers

```
┌──────────────────────────────────────────────────────────────┐
│ UI            src/ui (HTML/CSS/JS)  ←→  preload (contextBridge) │
├──────────────────────────────────────────────────────────────┤
│ Orchestration src/main.js (window, tray, CLI, IPC)             │
│               installer.js (install pipeline)                  │
├──────────────────────────────────────────────────────────────┤
│ Domain        engine.js (runtime lifecycle)                    │
│               adb.js (device operations)                       │
│               sharer.js (shared folder)                        │
├──────────────────────────────────────────────────────────────┤
│ Parsing       zip.js → axml.js / arsc.js → apk.js              │
│               png.js / shortcut.js (icons and .desktop)        │
├──────────────────────────────────────────────────────────────┤
│ OS glue       appwin.js (xdotool / wmctrl), assoc.js (xdg-mime)│
├──────────────────────────────────────────────────────────────┤
│ Engine        Android Emulator (Linux, KVM) │ existing adb     │
└──────────────────────────────────────────────────────────────┘
```

### Flow 1 — install on double-click

```
File manager opens .apk
  → MIME application/vnd.android.package-archive
  → ~/.local/share/applications/apkstart-apk.desktop (Exec = electron . %f)
  → main.js parseArgs → runInstall
      1. apk.js: offline parse (zip → manifest AXML → ARSC → label/icon)
      2. engine.ensure(): bring up or find the runtime
      3. adb install -r -g -t (.apks/.xapk → install-multiple)
      4. icon → PNG (icons/)
      5. .desktop on the desktop and in the application menu (--launch <package>)
      6. store.upsertApp: app metadata
```

### Flow 2 — launch from a shortcut

```
.desktop → electron . --launch <package>
  → runtime.ensure(): reuse a running emulator, otherwise start one
  → adb shell cmd package resolve-activity --brief → LAUNCHER activity
  → adb shell am start -n <package>/<activity>
  → appwin.adopt(): find the emulator window, set title/WM_CLASS/size/focus
```

### Flow 3 — the app window

The emulator window *is* the app window. `appwin.js`:

1. `xdotool search --class emulator`, filtered by the title `Android Emulator - <avd>`, with a timeout;
2. `xdotool set_window --name "<label>"` and `--class apkstart-<package>` — the DE groups windows and picks the icon;
3. `xdotool windowsize` for the orientation, `windowactivate --sync` for focus;
4. `wmctrl -i -r <id> -b add,fullscreen` for fullscreen;
5. poll every 2 s: the user closed the window → stop the app.

Orientation changes restart the emulator with a different `-skin`; `wm size`/`wm density` produce a rotated or non-filling image (verified).

### Dependency-free APK parsing

`zip.js` reads the ZIP central directory and streams entries (needed for multi-gigabyte `.apks`). `axml.js` parses binary XML; `arsc.js` reads the resource table to recover the app name and icon path. ICO is gone — icons stay PNG, which is what freedesktop expects.
