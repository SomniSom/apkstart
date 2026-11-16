# Portable adb

Unpack the Android platform-tools here (you should get `adb`), and ApkStart will
prefer this copy:

```
tools/platform-tools/
└─ adb
```

Download: https://developer.android.com/tools/releases/platform-tools

When this directory is empty, ApkStart tries, in order:

1. the adb path set manually in Settings
2. this directory
3. `$XDG_DATA_HOME/apkstart/runtime/platform-tools/adb`
4. adb shipped with the system package manager (`/usr/bin/adb`)
5. the system `PATH`
