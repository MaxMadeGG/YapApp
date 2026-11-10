# P2P Chat

Serverless group chat. Electron window + Hyperswarm (DHT discovery + NAT hole punching).
Everyone who joins the same room name finds each other over the internet - no server, no port forwarding.

## Run
Double-click `start.bat` (first run installs dependencies).
Needs Node.js installed.

## How it works
- `main.js` - joins the Hyperswarm topic `sha256("p2p-chat-room:" + room)`, full mesh between peers.
  Wire protocol: newline-delimited JSON: `hello {name}`, `history {msgs}`, `msg {msg}`.
  On connect each peer sends its last 200 messages; receivers merge by message id, so
  people who were offline catch up when anyone with the history is online.
- History saved per room in `%APPDATA%\p2p-chat\history-<hash>.json` (last 500 msgs).
- `preload.js` - IPC bridge; `index.html` - UI.
- Test hook: env `P2PCHAT_AUTOJOIN="name|room"` joins without the UI.

## Security
Intentionally minimal: anyone who knows the room name can join and claim any name.
Connections are encrypted by Hyperswarm (Noise), and message text is rendered as plain text only.
