# ApkStart для Linux

[English](README.md) · [Русский](README.ru.md)

<p align="center"><img src="docs/images/logo.png" alt="ApkStart" width="160" /></p>

**Запуск Android-приложений на Linux: двойной клик по APK — и приложение открывается отдельным окном, как обычная программа.**

> **Это форк.** Оригинал — [RoutineMiku/apkstart](https://github.com/RoutineMiku/apkstart) (лицензия MIT).
> Здесь проект переработан под **только Linux**: слой реестра/NSIS/PowerShell удалён, а управление
> окнами, ярлыки, привязка файлов, загрузка рантайма и упаковка рассчитаны на Linux.
> Windows-ветка в этом форке не поддерживается. Авторство оригинала и лицензия MIT сохранены.

Форк проекта [RoutineMiku/apkstart](https://github.com/RoutineMiku/apkstart) (лицензия MIT), переработанный под Linux. Windows-ветка не поддерживается: весь код, документация и сценарии рассчитаны только на Linux.

## Что делает

- **Двойной клик по `.apk`** — после привязки типа MIME в файловом менеджере (Nautilus, Dolphin, Thunar) файл автоматически разбирается, устанавливается и получает ярлык.
- **Ярлык на рабочем столе и в меню приложений** — `.desktop`-файл с иконкой, извлечённой из APK; запуск из меню по имени приложения.
- **Приложение = отдельное окно** — Android Emulator стартует с окном, ApkStart меняет ему заголовок, `WM_CLASS` и размер под ориентацию через `xdotool`/`wmctrl`. Никакой трансляции экрана: нативный рендер 60 fps.
- **Google-сервисы и ARM-приложения** — используется официальный образ `google_apis_playstore` (Android 14, x86_64) с Play Services и транслятором ARM-библиотек.
- **Общая папка с хостом** — `~/.local/share/apkstart/shared` ↔ `/sdcard/ApkStartShared`, двусторонняя синхронизация через `adb`.
- **Своё окружение** — adb, emulator и образы скачиваются и проверяются самим приложением в `~/.local/share/apkstart/runtime`, сторонние эмуляторы не нужны (но можно подключиться к уже работающему через `adb`).

```
Рабочий стол: ~/.local/share/applications/<пакет>.desktop
        │  двойной клик
        ▼
electron . --launch <пакет>
        │  движок не запущен? → поднимаем эмулятор (KVM)
        ▼
запуск по LAUNCHER-активности, разрешённой системой
        │  наблюдение за живостью, перезапуск при падении
        ▼
окно эмулятора = окно приложения (заголовок, иконка, размер, фокус)
```

## Требования

| Компонент | Зачем | Установка (Debian/Ubuntu) |
|---|---|---|
| Linux x86_64, `/dev/kvm` | аппаратное ускорение — без него не запускаемся | `sudo apt install qemu-kvm && sudo usermod -aG kvm $USER` |
| Node.js ≥ 20 | сборка и запуск из исходников | `sudo apt install nodejs npm` или nvm |
| `xdotool` | управление окном эмулятора (заголовок, фокус, размер) | `sudo apt install xdotool` |
| `wmctrl` | полноэкранный режим и максимизация окна | `sudo apt install wmctrl` |
| `qemu-utils` | `qemu-img` для раздела `/data` | `sudo apt install qemu-utils` |
| `e2fsprogs` | `resize2fs` для расширения `/data` | обычно уже стоит |
| `libfuse2` | только для AppImage | `sudo apt install libfuse2` |

Сессия: X11 или Wayland (через XWayland). На Wayland окном эмулятора управляет XWayland, поэтому `xdotool`/`wmctrl` работают; «вклеить» чужое окно внутрь своего Wayland не разрешает — это ограничение платформы, а не реализации.

Занимаемое место: сам Android-образ ~3.1 ГБ (плюс ~1.5 ГБ при распаковке), данные приложений и снапшоты — от 4 ГБ. Резервируйте минимум 15 ГБ.

## Установка из исходников

```bash
git clone <ваш-форк> apkstart
cd apkstart
npm install
npm start                      # первый запуск: интерфейс + деплой рантайма
npm run assoc:on               # привязать .apk к ApkStart (xdg-mime)
```

При первом запуске приложение само скачивает `platform-tools`, Android Emulator (Linux-сборку) и образ `google_apis_playstore` x86_64, затем первый раз загружает Android. Дальше запуск идёт из сохранённого снапшота.

Проверить окружение без запуска интерфейса:

```bash
npm run check:deps
```

## Сборка пакетов

```bash
npm run build:deb              # dist/release/ApkStart-<версия>-amd64.deb
npm run build:appimage         # dist/release/ApkStart-<версия>.AppImage
npm run build:all              # оба, рантайм готовится один раз
```

**.deb** — рекомендуемый способ для Debian/Ubuntu: регистрирует MIME-тип
`application/vnd.android.package-archive`, ставит ярлык в меню и зависимости (видны `apt`).
**AppImage** — один самодостаточный файл для любого дистрибутива; нужен FUSE (`libfuse2`)
или запуск с `--appimage-extract-and-run`.

## CLI

```text
electron .                     открыть основной интерфейс
electron . <путь/к/app.apk>    установить APK
electron . --launch <пакет>    запустить приложение (так вызывают .desktop-ярлыки)
electron . --silent            запуск без окна (автозапуск)
```

## Устройство проекта

```
src/
├─ main.js              главный процесс: окно, трей, один экземпляр, CLI, IPC
├─ preload.js           безопасный мост
├─ ui/                  интерфейс (чистый HTML/CSS/JS, без фреймворков)
└─ core/
   ├─ zip.js            минимальный ZIP-ридер
   ├─ axml.js           парсер бинарного AndroidManifest
   ├─ arsc.js           парсер resources.arsc (имя и иконка приложения)
   ├─ apk.js            метаданные APK: пакет, версия, Activity, иконка, ABI
   ├─ png.js            кодировщик PNG + отрисовка иконки
   ├─ shortcut.js       .desktop + PNG-иконки (freedesktop, XDG)
   ├─ assoc.js          привязка .apk: MIME + xdg-mime
   ├─ appwin.js         окно приложения: поиск и настройка окна эмулятора
   ├─ adb.js            клиент adb (установка, запуск, синхронизация, …)
   ├─ emulator.js       запуск и обвязка Android Emulator
   ├─ engine.js         управление рантаймом, переиспользование сессии
   ├─ provision.js      загрузка/проверка adb, emulator, образов, KVM
   ├─ doctor.js         профиль машины, подбор параметров, диагностика
   ├─ sharer.js         двусторонняя синхронизация общей папки
   ├─ installer.js      конвейер установки
   └─ store.js          манифест приложений и настройки
```

Документация по внутреннему устройству: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/LINUX-PORT.md](docs/LINUX-PORT.md), [docs/DEV-ENV.md](docs/DEV-ENV.md).

## Тесты

```bash
npm test                # unit + движок + авто-тесты (без сети)
npm run test:boot       # реальная загрузка: QEMU-параметры, раздел, выключение
npm run selftest        # проверка на живом Android: установка → запуск → скриншот → общая папка
```

## Отличия от Windows-версии

| Было на Windows | Стало на Linux |
|---|---|
| Реестр `HKCU` + `reg.exe` для связи `.apk` | MIME `application/vnd.android.package-archive` + `xdg-mime` |
| Ярлыки `.lnk` + ICO | `.desktop` + PNG в `~/.local/share/icons/hicolor` |
| `SetParent` — окно эмулятора внутри своего окна | окно эмулятора и есть окно приложения (`xdotool`/`wmctrl`) |
| PowerShell-агент, скрытие консоли, `WHPX`/`AEHD` | KVM (`/dev/kvm`), консольных окон нет |
| Данные в `%APPDATA%\apkstart` | `~/.local/share/apkstart` (XDG) |

## Ограничения

- Нет «вклейки» окна эмулятора внутрь собственного окна: Wayland не предоставляет такого протокола всем композиторам, а X11-решение хрупкое. Поэтому окно — это окно эмулятора, а интерфейс ApkStart остаётся отдельным окном.
- Правая кнопка мыши → «Назад» и плавный скролл настраиваются средствами эмулятора; глобального перехвата мыши на уровне ОС нет.
- Только x86_64 с KVM: на ARM-машинах (Apple Silicon, Snapdragon X) этот путь не работает — там нужен Waydroid.
- Приложения с агрессивной проверкой сенсоров/базовой станции могут не работать — ограничение самого эмулятора.

## Лицензия

MIT. Распространяемые сборки содержат только код ApkStart и Electron; образы Android, QEMU и компоненты Google загружаются пользователем с официальных источников по их лицензиям.
