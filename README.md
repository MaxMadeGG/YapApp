# YapApp

Serverless group chat. Electron window + Hyperswarm (DHT discovery + NAT hole punching).
Everyone who joins the same room name finds each other over the internet - no server, no port forwarding.

## Install
Download from the [Releases](https://github.com/MaxMadeGG/YapApp/releases) page:
- **Windows:** `YapApp-Setup-x.y.z.exe` - run the installer. SmartScreen may warn because it isn't code-signed: "More info" > "Run anyway".
- **Linux:** `YapApp-x.y.z.AppImage` (`chmod +x` it, then run) or `YapApp-x.y.z.deb` (`sudo apt install ./YapApp-x.y.z.deb`).

## Run from source
Double-click `start.bat` (first run installs dependencies), or `npm install && npm start`. Needs Node.js.

## Build installers
- Locally on Windows: `npm run dist:win` -> `release/`.
- Linux installers need Linux, so GitHub Actions builds them: bump `version` in package.json, commit, then
  `git tag v0.1.1 && git push origin v0.1.1`. The workflow builds Windows + Linux installers and attaches them to a Release.

## How it works
- `main.js` - joins the Hyperswarm topic `sha256("yapapp-room:" + room)`, full mesh between peers.
  Wire protocol: newline-delimited JSON: `hello {name}`, `history {msgs}`, `msg {msg}`.
  On connect each peer sends `ids` (every message id it has); the other side replies with all
  messages it's missing in `history` batches of 200, so people who were offline get the full
  backlog when anyone with it is online. Receivers merge by message id.
- Full history saved per room in `%APPDATA%\YapApp\history-<hash>.json` (no cap).
- `preload.js` - IPC bridge; `index.html` - UI.
- Test hook: env `YAPAPP_AUTOJOIN="name|room"` joins without the UI.

## Security
Intentionally minimal: anyone who knows the room name can join and claim any name.
Connections are encrypted by Hyperswarm (Noise), and message text is rendered as plain text only.
