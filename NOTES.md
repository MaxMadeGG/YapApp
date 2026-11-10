# YapApp - handover notes (as of 2026-11-10)

Serverless P2P group chat. Desktop (Electron, Windows/Linux) + Android (Bare Kit). Same rooms on all.
README.md has install/build details; this file is "where things stand".

## Layout
- `core.js` - ALL chat logic, shared by desktop and Android: invites, HKDF/HMAC-SHA256 auth (sodium), history
  sync by id, gossip forwarding, room rename (LWW meta), settings. Change behaviour here, not in hosts.
- `main.js` / `preload.js` / `index.html` - Electron host + the one UI (also used on Android).
- `android/` - Java host (`MainActivity` WebView, `YapService` foreground service owning the Bare worklet,
  `Updater` self-update), `app/src/main/js/app.js` worklet bridge, `scripts/` (sync, fetch-barekit).
- `.github/workflows/release.yml` - every push to main: Windows + Linux + Android builds -> rolling `latest` release.

## State
- Version 0.3.2 (CI makes rolling builds `0.3.<run number>`).
- Verified: desktop self-update (local feed), Android on Redmi Note 9 / Android 12: chat with PC, background
  service + notifications, self-update 0.3.2 -> 0.3.99 (local feed), invite auth (good/wrong/no-auth bots).
- NOT verified: any GitHub Actions run (repo private -> can't see it from here). Check the Actions tab first.

## Open / to do
1. User must add repo secret `ANDROID_KEYSTORE_B64` (base64 of `~/.android/debug.keystore`), else CI skips the APK.
2. Repo must be public for self-updates (desktop + Android) and for friends to download releases.
3. User's PC was still running an old 0.2.0 YapApp (no gossip) - install a new build.
4. MIUI: user should enable Autostart + Battery saver "No restrictions" for YapApp.
5. Ideas not started: auto-start after phone reboot, Enter = newline on phones, kick/ban (needs room admin
   design), encrypted local history.
- Decided: keep invite-code login + 30-day expiry as is (no email verification - would need a server).

## Gotchas
- Bare Kit pinned v2.5.5 + bare-pack/bare-link ^1 (`--needs libbare-kit.so`); worklet global is `BareKit.IPC`.
- npm 11 here blocks install scripts: Electron binary needs `node node_modules/electron/install.js` (start.bat does it).
- Electron localStorage isn't flushed on quit - persistent state goes in `settings.json` via core.
- Android: start the service in onResume (Android 12 BackgroundServiceStartNotAllowed in onCreate).
- MIUI blocks `adb shell input keyevent`; background the app with `am start -c android.intent.category.HOME`.
  `adb install` needs Developer options -> "Install via USB".
- Testing tricks: UI via `--remote-debugging-port=9333` + CDP; Android WebView via
  `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`; worklet on desktop: `npm run test:bare`.
- Phone + PC behind the same home NAT are both "firewalled"; fresh peers may not reach the phone directly -
  gossip covers it as long as the phone is connected to anyone.
