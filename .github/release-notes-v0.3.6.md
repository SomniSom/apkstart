# ApkStart v0.3.6

> One line: **fixed "black screen after tapping Agree and continue"**. The real cause was
> the Android VM's Wi-Fi taking a long time to associate so the app rendered its home page
> without a network and showed a black block — nothing to do with the GPU or the renderer.

## 1. Black screen after "Agree" — cause and fix

### The previous release got it wrong

v0.3.5 blamed the GPU backend (swangle / software). That was **wrong**; switching backends
of course did not help.

### What adb actually showed

- `cmd wifi status`: `Wifi is not connected`; `ip -o addr show wlan0`: **no address at all**;
- so **the VM had no network at that moment**;
- the privacy dialog is a local page, so it rendered fine; tapping "Agree and continue"
  pulls home-page data, and without data the page renders as a black block — exactly what
  the user sees;
- `sys.boot_completed` only means the system is up; **Wi-Fi association + DHCP often need
  another tens of seconds to two minutes**. The app started before the network, every
  request failed and the page stayed black.

Evidence: immediately after boot the VM reports no address; a minute or two later
`wlan0 inet 10.0.2.16/24` and `Wifi is connected to "AndroidWifi"` appear, and the home
page renders normally.

### What this release does

1. **Wait for the network before launching**: `installer.launch` waits up to 150 s before
   `am start`, logging `waiting for the Android VM network... Ns`, so the app can no
   longer start before the network.
2. **Post-boot network check**: after a successful boot the VM's address is checked and,
   when missing, the reason is written to the log instead of leaving the user guessing.
3. **Settings -> Repair network** (new button): resets the Android user data, reboots and
   waits for the network (up to 4 minutes), then saves the working state as a quickboot
   snapshot.
   - **The app list is kept**; apps are reinstalled on launch, no manual APK reinstall;
   - in-app accounts and watch history are lost and must be re-created;
   - only the current AVD is affected; the system image and the local APK cache stay.

> If the app is black now: just open it (this release waits for the network first), and if
> it is still black use Settings -> Repair network.

## 2. The previous "cache cleanup" fix stays

The `includeSnapshots` + "reset Android data" logic from v0.3.5 is unchanged.

## 3. Known limitations

- The Android 14 (`google_apis_playstore`) image has an upstream issue: cold-booting on
  **existing user data** often leaves Wi-Fi at `NO-CARRIER` with no address, while the
  first boot after a data reset connects normally. "Repair network" therefore resets the
  data and saves a snapshot right away to keep the working state.
- The Play Store image does not allow `adb root`, so the broken Wi-Fi profile cannot be
  deleted on its own.

## 4. Verified

- After the fix, tapping "Agree and continue" reaches the app's main activity and the home
  page shows the catalogue and recommendations (confirmed by screenshot, not black).
- The same VM after the network is ready: `wlan0 inet 10.0.2.16/24`,
  `Wifi is connected to "AndroidWifi"`.
- `npm test`: **113 checks passed** (8 + 25 + 80).

## 5. Upgrading

- Portable: unpack over the old copy; the data directory (`~/.local/share/apkstart` by
  default) is untouched.
- Installed build: install over the old version.
