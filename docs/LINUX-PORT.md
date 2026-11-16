# Портирование на Linux: что именно заменено

[Русский](#русский) · [English](#english)

## Русский

Исходный проект рассчитан на Windows. Ниже — карта замен: что было, чем стало, где лежит.

| Функция | Windows (исходник) | Linux (форк) | Файл |
|---|---|---|---|
| Связь `.apk` с программой | `HKCU\Software\Classes`, `reg.exe` | MIME `application/vnd.android.package-archive`, `xdg-mime default`, XML в `~/.local/share/mime/packages` | `src/core/assoc.js` |
| Ярлык приложения | `.lnk` через `shell.writeShortcutLink`, многоразмерный ICO | `.desktop` (Desktop Entry 1.5) + PNG в `~/.local/share/icons/hicolor/<N>x<N>/apps` | `src/core/shortcut.js` |
| «Одна программа — одно окно» | `SetParent`: Qt-окно эмулятора вклеивалось в своё окно, отключалась аппаратная композиция Chromium | окно эмулятора **и есть** окно приложения: `xdotool set_window --name/--class`, `windowsize`, `windowactivate`, `wmctrl -b add,fullscreen` | `src/core/appwin.js` |
| Скрытие консолей, PowerShell-агент | `agent.ps1`, `WM_MOUSE_LL`, сокет | не нужно: у Linux-сборки нет консольных окон, глобального хука мыши нет | — |
| Ускорение | `WHPX` / `AEHD`, `-accel-check` | `/dev/kvm` + проверка группы `kvm`; без KVM — явная ошибка вместо тихого TCG | `src/core/provision.js: _linuxHypervisor` |
| Скачивание рантайма | `platform-tools-latest-windows.zip`, `emulator-windows_x64-*.zip`, AEHD | `platform-tools-latest-linux.zip`, `emulator-linux_x64-*.zip` (из официального SDK-индекса) | `src/core/provision.js` |
| `qemu-img` / `resize2fs` | из комплекта эмулятора (`.exe`, cygwin) | системные `qemu-img` (`qemu-utils`) и `resize2fs` (`e2fsprogs`) | `src/core/emulator.js`, `src/core/provision.js: systemQemuImg` |
| Каталог данных | `%APPDATA%\apkstart` | `$XDG_DATA_HOME/apkstart` = `~/.local/share/apkstart` | `src/core/store.js` |
| Рабочий стол / меню | `Desktop`, `Старт\Программы` | `xdg-user-dir DESKTOP`, `~/.local/share/applications` | `src/core/shortcut.js: xdgDirs` |
| Режим эмулятора | окно + вклейка (`-no-window` по умолчанию выключено через агент) | окно по умолчанию (`headless = false`); `-no-window` на Linux не передаётся никогда | `src/core/emulator.js: buildArgs` |
| Сборка | NSIS `.exe` | `electron-builder --linux AppImage` | `package.json`, `electron-builder.yml` |

### Что осталось без изменений

Разбор APK (`zip`, `axml`, `arsc`, `apk`, `png`), клиент adb (`adb.js`), жизненный цикл рантайма и снапшоты (`engine.js`, `emulator.js`), синхронизация общей папки (`sharer.js`), конвейер установки (`installer.js`), интерфейс (`src/ui`). Это ~70% кода — платформенная часть была изолирована.

### Осознанные ограничения Linux-версии

1. **Нет вклейки окна.** Wayland не даёт клиенту присоседить чужое окно без протокола `xdg-foreign`, который поддерживают не все композиторы. X11-хак через `XReparentWindow` работает, но ломает ввод фокуса на части DM. Выбрано решение «окно эмулятора = окно приложения»: оно устойчиво и совпадает по ощущениям (Alt+Tab, док, заголовок, иконка).
2. **Нет глобального хука мыши.** Правая кнопка → «Назад» и плавный скролл делаются через эмулятор/`adb input`; перехвата уровня ОС нет.
3. **Только x86_64 с KVM.** ARM-хосты — вне области: там путь через Waydroid.
4. **Смена ориентации требует перезапуска** эмулятора с другим `-skin` (как и в Windows-версии).

### Проверка на текущей машине

- ОС: Ubuntu 26.10, ядро 7.3, x86_64; `/dev/kvm` доступен — ускорение есть.
- `npm install` проходит, Electron 33 скачивается как Linux-сборка.
- `npm test`: unit 8/8; движок 25/25 после правки ожиданий под Linux (пути без `.exe`, образ `linux_x64`).
- `electron .` стартует, интерфейс открывается, ошибок в главном процессе нет.
- Обнаружено при проверке окружения: не установлен `wmctrl` (нужен для полноэкранного режима) и `qemu-utils` (нужен `qemu-img`). Отсутствие инструментов показывается отдельной проверкой `npm run check:deps`.

---

## English

The upstream project targets Windows. Below is the replacement map: what it was, what it is, where it lives.

| Feature | Windows (upstream) | Linux (fork) | File |
|---|---|---|---|
| `.apk` association | `HKCU\Software\Classes`, `reg.exe` | `application/vnd.android.package-archive` MIME, `xdg-mime default`, XML in `~/.local/share/mime/packages` | `src/core/assoc.js` |
| App shortcut | `.lnk` via `shell.writeShortcutLink`, multi-size ICO | `.desktop` (Desktop Entry 1.5) + PNG in `~/.local/share/icons/hicolor/<N>x<N>/apps` | `src/core/shortcut.js` |
| "One app — one window" | `SetParent`: the emulator's Qt window was embedded into ours; Chromium composition disabled | the emulator window **is** the app window: `xdotool set_window --name/--class`, `windowsize`, `windowactivate`, `wmctrl -b add,fullscreen` | `src/core/appwin.js` |
| Console hiding, PowerShell agent | `agent.ps1`, `WM_MOUSE_LL`, socket | not needed: the Linux emulator build spawns no console windows; there is no global mouse hook | — |
| Acceleration | `WHPX` / `AEHD`, `-accel-check` | `/dev/kvm` plus a `kvm` group check; without KVM it fails loudly instead of silently using TCG | `src/core/provision.js: _linuxHypervisor` |
| Runtime download | `platform-tools-latest-windows.zip`, `emulator-windows_x64-*.zip`, AEHD | `platform-tools-latest-linux.zip`, `emulator-linux_x64-*.zip` (resolved from the official SDK index) | `src/core/provision.js` |
| `qemu-img` / `resize2fs` | bundled with the emulator (`.exe`, cygwin) | system `qemu-img` (`qemu-utils`) and `resize2fs` (`e2fsprogs`) | `src/core/emulator.js`, `src/core/provision.js: systemQemuImg` |
| Data directory | `%APPDATA%\apkstart` | `$XDG_DATA_HOME/apkstart` = `~/.local/share/apkstart` | `src/core/store.js` |
| Desktop / menu | `Desktop`, `Start Menu\Programs` | `xdg-user-dir DESKTOP`, `~/.local/share/applications` | `src/core/shortcut.js: xdgDirs` |
| Emulator mode | windowed + embedding (headless disabled by the agent) | windowed by default (`headless = false`); `-no-window` is never passed on Linux | `src/core/emulator.js: buildArgs` |
| Packaging | NSIS `.exe` | `electron-builder --linux AppImage` | `package.json`, `electron-builder.yml` |

### Unchanged

APK parsing (`zip`, `axml`, `arsc`, `apk`, `png`), the adb client (`adb.js`), runtime lifecycle and snapshots (`engine.js`, `emulator.js`), shared-folder sync (`sharer.js`), the install pipeline (`installer.js`) and the UI (`src/ui`). That is roughly 70% of the code — platform specifics were isolated.

### Deliberate Linux limitations

1. **No window adoption.** Wayland does not let a client adopt another client's window without `xdg-foreign`, which not every compositor implements. The X11 `XReparentWindow` hack works but breaks input focus on some desktops. We chose "emulator window = app window": stable and close in feel (Alt+Tab, dock, title, icon).
2. **No global mouse hook.** Right-click → "Back" and smooth scrolling go through the emulator/`adb input`; there is no OS-level interception.
3. **x86_64 with KVM only.** ARM hosts are out of scope — use Waydroid there.
4. **Orientation changes restart** the emulator with a different `-skin` (same as on Windows).

### Verification on the current machine

- OS: Ubuntu 26.10, kernel 7.3, x86_64; `/dev/kvm` is accessible — acceleration available.
- `npm install` succeeds; Electron 33 downloads as a Linux build.
- `npm test`: units 8/8; engine 25/25 after adjusting expectations for Linux (paths without `.exe`, `linux_x64` image).
- `electron .` starts, the UI opens, the main process logs no errors.
- Found during environment checks: `wmctrl` (fullscreen) and `qemu-utils` (`qemu-img`) are not installed. Missing tools are reported by `npm run check:deps`.
