# YapApp

Serverless group chat. Electron window + Hyperswarm (DHT discovery + NAT hole punching).
Everyone who joins the same room name finds each other over the internet - no server, no port forwarding.

## Install
Newest build (rebuilt automatically on every push to main):
- **Windows:** [YapApp-Setup.exe](https://github.com/MaxMadeGG/YapApp/releases/download/latest/YapApp-Setup.exe) - run the installer. SmartScreen may warn because it isn't code-signed: "More info" > "Run anyway".
- **Linux:** [YapApp.AppImage](https://github.com/MaxMadeGG/YapApp/releases/download/latest/YapApp.AppImage) (`chmod +x` it, then run) or [YapApp.deb](https://github.com/MaxMadeGG/YapApp/releases/download/latest/YapApp.deb) (`sudo apt install ./YapApp.deb`).

Installed apps update themselves: on start (and every 4 hours) YapApp checks the `latest` release,
downloads a newer build in the background and offers "Restart to update" (or installs on quit).
Needs the repo to be public. Rolling builds are versioned `major.minor.<CI run number>`.

Older fixed versions are on the [Releases](https://github.com/MaxMadeGG/YapApp/releases) page.

## Run from source
Double-click `start.bat` (first run installs dependencies), or `npm install && npm start`. Needs Node.js.

## Build installers
- Locally on Windows: `npm run dist:win` -> `release/`.
- GitHub Actions (`.github/workflows/release.yml`) builds Windows + Linux on every push to `main`
  (README-only changes skipped) and replaces the files on the rolling `latest` release.
- For a permanent versioned release: bump `version` in package.json, commit, then
  `git tag vX.Y.Z && git push origin vX.Y.Z`.

## How it works
- `main.js` - joins the Hyperswarm topic `sha256("yapapp-room:" + room)`, full mesh between peers.
  Wire protocol: newline-delimited JSON: `hello {name}`, `history {msgs}`, `msg {msg}`.
  On connect each peer sends `ids` (every message id it has); the other side replies with all
  messages it's missing in `history` batches of 200, so people who were offline get the full
  backlog when anyone with it is online. Receivers merge by message id.
- Full history saved per room in `%APPDATA%\YapApp\history-<hash>.json` (no cap).
- `preload.js` - IPC bridge; `index.html` - UI.
- Remembered login (name, room, lastUsed) in `%APPDATA%\YapApp\settings.json`: the app auto-joins on start
  until it has not been used for 30 days (`SESSION_DAYS` in index.html). "Leave room" logs out.
- Test hook: env `YAPAPP_AUTOJOIN="name|room"` joins without the UI.

## Security
Intentionally minimal: anyone who knows the room name can join and claim any name.
Connections are encrypted by Hyperswarm (Noise), and message text is rendered as plain text only.
