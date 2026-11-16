# ApkStart v0.3.8

> One line: a **welcome card on start** (reminds you everything is ready when the app
> autostarts), fixed **update checks failing for some users**, new **cleanup of old version
> leftovers**, and a visual refresh of the whole UI.

## 1. New: welcome card on start

When the app starts (or autostarts with the session) a light welcome card appears:

- brand gradient header plus a time-aware greeting;
- three figures at a glance: **installed apps / Android runtime state / device port**;
- the two most useful hints right now (how to install an app when none is installed; how
  the window controls work when there are apps);
- a new version is announced here instead of a separate toast;
- a **"do not show again on start"** checkbox and a shortcut to Settings.

Rules: always on autostart; at most once a day when opened manually; never after the
checkbox is ticked.

## 2. Fix: some users could not check for updates

**Cause**: version info depended on both providers' APIs. The anonymous GitHub API allows
60 requests per IP per hour, Gitee's anonymous API is stricter and returned
`403 Rate Limit Exceeded` after a few calls. Behind a company, campus or carrier NAT both
sources can be rate-limited, and the UI only showed "update check failed".

**Fix**:

- **API-free fallback**: follow the `releases/latest` 302 redirect to read the tag (served
  from the CDN, no API quota) and build the download URL from the release convention;
- both GitHub and Gitee `/releases/download/<tag>/<file>` URLs can be assembled (Gitee
  redirects to the attachment, which downloads fine);
- on failure the UI is no longer blank but offers an **"open the download page"** button,
  and `app:updateOpen` now allows `gitee.com`.

## 3. New: cleanup of old version leftovers

Settings -> System integration -> **"Clean up old version leftovers"**:

- scans **old program directories** (sibling `ApkStart-vX.Y.Z-*` folders that really
  contain the binary, never the running version);
- scans **dead uninstall entries** whose program or uninstaller no longer exists;
- scans **leftover update packages** in the update cache and the temp dir;
- lists everything with the reclaimable space first and deletes only after confirmation,
  reporting items that were busy.

Only provably safe things are removed: never user data, never the running version.

## 4. No more startup popups

- the "new version found" system notification is gone, folded into the welcome card;
- the previous scattered startup toasts collapsed into that single card;
- console-window suppression is unchanged.

## 5. Visual refresh

- new palette: emerald brand colour on a soft neutral base with a faint brand glow;
- frosted-glass title bar and a vector brand mark that still reads as a play key at small sizes;
- app cards with larger radii, hover lift, brand outline and icon shadow;
- primary buttons with a gradient and inner highlight, quieter secondary buttons;
- modals, section headings, scrollbars and the status bar redone consistently;
- the welcome card uses the same design language.

## 6. Verified

- `npm test`: **113 checks passed** (8 + 25 + 80).
- Smoke screenshots: main window and welcome card render correctly.
- The cleanup found 6 old version directories (~1.3 GB) on the dev machine and correctly
  excluded the running version.

## 7. Upgrading

- Portable: unpack over the old copy; the data directory is untouched.
- Installed build: install over the old version.
