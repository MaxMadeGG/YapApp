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
- Repo is PUBLIC (2026-11-11); Actions runs 1-10 all green, rolling `latest` has win/linux 0.3.10 -> desktop
  self-update live. Check runs with `curl https://api.github.com/repos/MaxMadeGG/YapApp/actions/runs`.
- Android auto-rejoin after reboot (BootReceiver -> YapService ACTION_AUTOJOIN: foreground "Reconnecting…",
  getSettings, join if login fresh) verified on the Redmi after a real reboot (2026-11-11).

## Open / to do (renumber freely)
1. DONE 2026-11-11: secret `ANDROID_KEYSTORE_B64` added; run #12 published YapApp.apk 0.3.12 + android-latest.json
   (same cert 36b60d12... as local builds). NOTE: pushes touching only *.md (or empty commits) don't trigger CI.
3. User's PC was still running an old 0.2.0 YapApp (no gossip) - install a new build.
4. MIUI: Autostart must be ON or the boot receiver is blocked ("not permitted to auto start" in logcat).
   MIUI RESETS Autostart to off on every app update/reinstall -> so MY_PACKAGE_REPLACED rejoin never fires on
   MIUI, and the user must re-enable Autostart after each update (or `adb shell appops set
   com.maxmadegg.yapapp 10008 allow`). Battery saver "No restrictions" is set on the user's phone.
5. Done 2026-11-11: auto-start after reboot, Enter = newline on phones (Send button sends).
   Ideas not started: kick/ban (needs room admin
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
