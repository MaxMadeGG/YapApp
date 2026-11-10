# YapApp

Serverless group chat. Electron window + Hyperswarm (DHT discovery + NAT hole punching).
Rooms are private and invite-only: create a room, share its invite code, and everyone with the code finds each
other over the internet - no server, no port forwarding.

## Install
Newest build (rebuilt automatically on every push to main):
- **Windows:** [YapApp-Setup.exe](https://github.com/MaxMadeGG/YapApp/releases/download/latest/YapApp-Setup.exe) - run the installer. SmartScreen may warn because it isn't code-signed: "More info" > "Run anyway".
- **Linux:** [YapApp.AppImage](https://github.com/MaxMadeGG/YapApp/releases/download/latest/YapApp.AppImage) (`chmod +x` it, then run) or [YapApp.deb](https://github.com/MaxMadeGG/YapApp/releases/download/latest/YapApp.deb) (`sudo apt install ./YapApp.deb`).

Installed apps update themselves: on start (and every 4 hours) YapApp checks the `latest` release,
downloads a newer build in the background and offers "Restart to update" (or installs on quit).
Needs the repo to be public. Rolling builds are versioned `major.minor.<CI run number>`.

**Android:** build the APK yourself for now (see below) and install it on the phone
(allow "Install unknown apps" for your file manager or browser). Phones and PCs join the same rooms.

Older fixed versions are on the [Releases](https://github.com/MaxMadeGG/YapApp/releases) page.

## Run from source
Double-click `start.bat` (first run installs dependencies), or `npm install && npm start`. Needs Node.js.

## Build installers
- Locally on Windows: `npm run dist:win` -> `release/`.
- GitHub Actions (`.github/workflows/release.yml`) builds Windows + Linux on every push to `main`
  (README-only changes skipped) and replaces the files on the rolling `latest` release.
- For a permanent versioned release: bump `version` in package.json, commit, then
  `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Android app (`android/`)
Native Android app: a WebView shows the same `index.html` (copied in by `npm run sync`, plus `bridge.js`),
and the chat core runs in a [Bare Kit](https://github.com/holepunchto/bare-kit) worklet
(`app/src/main/js/app.js` -> shared `core.js` + Hyperswarm). Java host: `MainActivity.java`.

Build (needs Android Studio's SDK + JDK 17; no NDK needed):
```
cd android
npm install
npm run prepare          # fetch Bare Kit (~420 MB zip once), sync UI/core, link addons, bundle
gradlew assembleDebug    # -> app/build/outputs/apk/debug/app-debug.apk
```
Test the worklet on the desktop with Bare: `npm run test:bare -- <invite> <dataDir>`.
Bare Kit is pinned to v2.5.5 with bare-pack/bare-link ^1 (addons need `--needs libbare-kit.so`).
Only `arm64-v8a` is packaged (see `abiFilters` in `app/build.gradle`).

## How it works
- `core.js` (shared by desktop and Android; crypto is HKDF/HMAC-SHA256 via sodium so both runtimes match)
  - a room is a random 128-bit secret; the invite code is `yap1-<secret b64url>-<room name b64url>`.
  HKDF(secret) gives the Hyperswarm topic and a separate auth key. Full mesh between peers.
  Each connection must first send `auth` = HMAC(authKey, role || Noise handshake hash); anything else, a wrong
  MAC, or no MAC within 15 s disconnects the peer before any message is exchanged.
  Wire protocol: newline-delimited JSON: `hello {name}`, `history {msgs}`, `msg {msg}`.
  On connect each peer sends `ids` (every message id it has); the other side replies with all
  messages it's missing in `history` batches of 200, so people who were offline get the full
  backlog when anyone with it is online. Receivers merge by message id.
- Full history saved per room in `%APPDATA%\YapApp\history-<hash>.json` (no cap).
- `preload.js` - IPC bridge; `index.html` - UI.
- Room name: click the pencil (or double-click the name) to rename. Renames sync as `meta {name, ts, by}`,
  newest wins, sent on every connect so offline peers catch up; stored in `room-<hash>.json`. The secret
  doesn't change, so old invite codes keep working; "Invite people" shows a code with the current name.
- Remembered login (name, invite, lastUsed) in `%APPDATA%\YapApp\settings.json`: the app auto-joins on start
  until it has not been used for 30 days (`SESSION_DAYS` in index.html). "Leave room" logs out.
- Test hook: env `YAPAPP_AUTOJOIN="name|room"` joins without the UI.

## Security
- Only people with the invite code can find the room or connect to it; the code is effectively a password
  (128-bit random, can't be guessed). Share it privately.
- Peers prove they hold the room secret on every connection, bound to that encrypted session (no replay).
- Connections are end-to-end encrypted by Hyperswarm (Noise). Message text is rendered as plain text only.
- Not covered: anyone who has the code can join and pick any display name; there's no way to kick someone
  except making a new room. History and the invite are stored unencrypted in `%APPDATA%\YapApp\`.
