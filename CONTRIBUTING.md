# Contributing

Issues and pull requests are welcome. The guiding principle of this project is a
**zero-dependency shell with predictable behaviour**, so please read the rules below first.

## Development environment

- Linux x86_64 with KVM (`/dev/kvm` must be accessible)
- Node.js >= 20
- `sudo apt install wmctrl qemu-utils` (window placement and disk conversion)
- `npm install && npm start`

## Before you commit

```bash
npm test          # Node unit tests + engine tests (no network, no VM needed)
```

After UI changes, also run a smoke screenshot to catch layout breakage:

```bash
electron . --smoke test/shot.png
```

## Code conventions

- **The shell takes no third-party runtime dependencies.** The ZIP / AXML / ARSC / PNG
  readers under `src/core/` are hand-written; prefer Node built-ins over pulling in a
  package for a small feature.
- The renderer is plain HTML/CSS/JS with no framework.
- All Android interaction goes through `src/core/adb.js`; never assemble adb commands
  elsewhere.
- The main and renderer processes talk only through the whitelisted channels exposed by
  `preload.js`, with `contextIsolation` enabled.
- **Comments and UI text are in English**; identifiers are English too.

## Testing conventions

- Without a real APK the parser tests skip; point the environment variable at any APK to
  cover them:

```bash
APKSTART_TEST_APK=/path/to/any.apk npm test
```

- Tests must not touch the internet. Tests that need network behaviour start a local
  `http` server (see `test/engine-test.js`).

## Commit messages

Follow Conventional Commits, for example:

```
feat(engine): allow importing a qcow2 disk from a custom path
fix(axml): correct the attribute string pool base offset
docs: explain enabling KVM
```

## Legal boundaries

- This project ships no Android system images, QEMU binaries or Google components; the
  user downloads everything locally on demand.
- Do not commit commercial APKs, cracking tools or anything that infringes third-party
  copyright.
