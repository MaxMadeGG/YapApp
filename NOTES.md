# YapApp - handover notes (as of 2026-11-11 evening)

Serverless P2P group chat, Slack-like. Desktop (Electron, Windows/Linux) + Android (Bare Kit). Same rooms on all.
README.md has install/build details; this file is "where things stand".

## Where things stand (read this first)
- Live rolling build 0.3.25 (win/linux/apk at releases/tag/latest); all features below pushed and CI green.
- Features: rooms (= workspaces, invite-only) with channels, threads, reactions, encrypted DMs, files/photos/
  folders, emoji panel (+ Favorites tab from the user's Slack, custom :sadshit:), profile + room pictures,
  profiles with details, edit/delete messages, unread marks, self-update on all platforms.
- CLEAN SLATE 2026-11-11: user asked to delete all test rooms/data. Deleted: PC %APPDATA%/YapApp (dev-run data;
  YapApp is NOT installed on this PC) and all scratch test profiles. Phone: `pm clear` is blocked by MIUI and the
  release build isn't run-as-able -> user was told to clear YapApp's data on the phone themselves
  (Settings > Apps > YapApp > Clear data). Next time: create real rooms from scratch.
- Testing recipe: two/three isolated desktop instances with YAPAPP_DATA=<scratch dir> + --remote-debugging-port
  and a small CDP script (Runtime.evaluate). Instances on the same PC sometimes take 30 s-3 min to find each
  other (DHT); not a bug. Test windows are visible on the user's screen.
- Not verified by a human tap yet: Android file picker (📎) and picking a picture on the phone.
- Linux builds are produced by CI but were never run on a real Linux machine.

## Layout
- `core.js` - ALL chat logic, shared by desktop and Android: invites, HKDF/HMAC-SHA256 auth (sodium), history
  sync by id, gossip forwarding, room rename (LWW meta), settings. Change behaviour here, not in hosts.
- `main.js` / `preload.js` / `index.html` - Electron host + the one UI (also used on Android).
- `android/` - Java host (`MainActivity` WebView, `YapService` foreground service owning the Bare worklet,
  `Updater` self-update), `app/src/main/js/app.js` worklet bridge, `scripts/` (sync, fetch-barekit).
- `.github/workflows/release.yml` - every push to main: Windows + Linux + Android builds -> rolling `latest` release.

## History of verification
- Base version 0.3.2 in package.json (CI makes rolling builds `0.3.<run number>`).
- Verified: desktop self-update (local feed), Android on Redmi Note 9 / Android 12: chat with PC, background
  service + notifications, self-update 0.3.2 -> 0.3.99 (local feed), invite auth (good/wrong/no-auth bots).
- Repo is PUBLIC (2026-11-11); Actions runs 1-10 all green, rolling `latest` has win/linux 0.3.10 -> desktop
  self-update live. Check runs with `curl https://api.github.com/repos/MaxMadeGG/YapApp/actions/runs`.
- Android auto-rejoin after reboot (BootReceiver -> YapService ACTION_AUTOJOIN: foreground "Reconnecting…",
  getSettings, join if login fresh) verified on the Redmi after a real reboot (2026-11-11).

## Open / to do (renumber freely)
1. DONE 2026-11-11: secret `ANDROID_KEYSTORE_B64` added; run #12 published YapApp.apk 0.3.12 + android-latest.json
   (same cert 36b60d12... as local builds). NOTE: pushes touching only *.md (or empty commits) don't trigger CI.
4. MIUI: Autostart must be ON or the boot receiver is blocked ("not permitted to auto start" in logcat).
   MIUI RESETS Autostart to off on every app update/reinstall -> so MY_PACKAGE_REPLACED rejoin never fires on
   MIUI, and the user must re-enable Autostart after each update (or `adb shell appops set
   com.maxmadegg.yapapp 10008 allow`). Battery saver "No restrictions" is set on the user's phone.
   Since 2026-11-11 the app shows a yellow bar when Autostart is off (MainActivity.autostartBlocked() reads MIUI
   op 10008 via AppOpsManager.checkOpNoThrow reflection; works on the Redmi) with a button that opens
   com.miui.securitycenter AutoStartManagementActivity. NOTE: MIUI flips it to off a few seconds AFTER install.
5. Done 2026-11-11: auto-start after reboot, Enter = newline on phones (Send button sends).
   Ideas not started: kick/ban (needs room admin
   design), encrypted local history.
- Decided: keep invite-code login + 30-day expiry as is (no email verification - would need a server).

## UI (2026-11-11 redesign, layout inspired by Slack, own colours)
- Sidebar: Rooms list (settings key `rooms` = JSON [{invite,name}], keyed by invite secret part since renames
  change the name part) + Online list; header with room name (click = rename), online faces, invite button;
  day dividers, avatars, 5-min message grouping; phones get a slide-out drawer (<=700px).
- Only ONE room is connected at a time (core limitation) - switching rooms = leave + join; notifications only
  for the active room. Leave room = drop from list; log-out icon = forget login, keep list.
- Reactions + threads (2026-11-11): both are ordinary history entries so they sync/gossip by id with no new
  packet types. Reply = message with `parent`; reaction = `kind:'react'` {target, emoji, on}, newest per
  person+emoji wins; its `text` ("reacted 👍") is the fallback old clients display. UI keeps byId/reacts/replies
  maps; replies only show in the thread panel (#thread; full-screen on phones). Android doesn't notify reactions.
  Verified with two isolated desktop instances (sync both ways, toggle off, saved to disk) + phone-size layout.
- Channels (2026-11-11): a ROOM is the workspace (one invite = all its channels); left rail = room icons.
  Channel state = history entries kind:'chan' {target: channel id, chName, deleted}, newest per channel wins;
  messages carry `ch` (missing = 'general', so pre-channel history is #general; #general can't be deleted).
  Anyone in the room can add/rename/delete channels. Unread marks per channel (in memory). Messages of deleted
  channels stay in history but are hidden. Verified with two isolated instances (create/rename/delete/unread sync).
- DMs (2026-11-11): each device has a crypto_box keypair in identity.json (dataDir, NOT settings) and publishes
  it as a kind:'key' history entry on join. A DM (kind:'dm') is boxed separately for every key of the recipient's
  name AND the sender's name (so PC + phone both read it); everyone stores/forwards the ciphertext, core.view()
  decrypts for the UI and drops DMs that aren't ours. Sidebar "Direct messages" = people with keys + online peers.
  No threads in DMs (replies would be unencrypted); reactions OK. Verified with 3 instances: 3rd party stores
  the DM entries but no plaintext. LIMIT: identity = display name, so someone joining with the same name gets
  that person's FUTURE DMs (fine for invite-only friend rooms; would need key verification otherwise).
- Files (2026-11-11): message.files = [{h,k,n,s,m,p?}]. Each file = secretbox-encrypted blob (random key) stored
  at <dataDir>/blobs/<sha256>; peers fetch on demand with 'want' {h} -> 'blob' {h,i,n,d} 256 KB chunks, first
  responder wins, hash verified, 60 s idle timeout, re-asks on new/closed peers. Key travels in the message (inside
  the encrypted payload for DMs). 50 MB/file. Desktop: paperclip/folder buttons, Ctrl+V paste, drag & drop (folders
  via webkitGetAsEntry); save via dialogs in main.js (paths sanitised). Android: Java ACTION_OPEN_DOCUMENT picker
  copies into files/import (no bytes through the WebView), saves via MediaStore into Downloads/YapApp[/folder].
  Images <=15 MB auto-preview; viewer overlay. Verified: 2 desktop instances (paste, file bytes, folder paths, DM
  image) + on the phone add/get/save (picker itself needs a human tap - not verified).
- Emojis + pictures (2026-11-11): emoji panel (~1230 emojis in EMOJI_SETS, recent tab in localStorage; emojis the
  device font can't draw are hidden via a canvas check - Win10 lacks ~54). Quick reaction bar has "+" -> panel.
  Pictures = history entries kind:'profile' (author's avatar) / kind:'roompic' {pic: file ref|null}, newest wins;
  images are square-cropped to 192px JPEG (~5 KB) client-side, then shared as normal blobs. Own picture is also in
  settings 'pfp' and re-published when joining a room that doesn't have it. Room pics are cached in the rooms list
  (settings) for the rail. Click your name (sidebar top / "you" row) or the room tile for the menu.
- Custom emojis: CUSTOM_EMOJI in index.html (name -> inline SVG data URL; :sadshit: drawn by hand 2026-11-11).
  Messages keep the :name: text; richText() swaps known names for <img class=cemoji>; works in reactions, quick
  bar, and the panel's "Custom" tab. Add more by adding entries (no protocol change).
- Edit/delete (2026-11-11): kind:'edit' {target,text} / kind:'del' {target} entries (DMs: {edit}/{del} inside the
  encrypted payload). Only the author's own change counts (matched by name). core.applyDeletes() turns deleted
  messages into tombstones {deleted:true} everywhere, blanks edits of them and removes their blobs. UI keeps
  edits/dels maps; deleted msgs vanish unless they have thread replies ("This message was deleted.").
- Profiles (2026-11-11): kind:'profile' now = {pic, info:{title,pronouns,email,phone,location,about}} - the WHOLE
  profile each time, newest wins. Saved in settings 'profile' {pic,info,ts} (old 'pfp' still read); on joining a
  room syncMyProfile() publishes it if the room has an older one, or adopts a newer one from your other device.
  FIXED: profile was re-published on every start (history arrived before myName was set). Click a picture/name
  -> profile card; your own card -> Edit profile dialog.
- Ideas next: unread badges for other ROOMS (needs multi-room core), more emojis, edit/delete messages,
  remember last channel per room.

## Gotchas
- Build size (2026-11-11): AppImage ~101 MB, exe ~115 MB - almost all of it is Electron/Chromium itself.
  package.json build: electronLanguages (5 locales), compression maximum, per-platform `files` that exclude
  other systems' native prebuilds. QUIRK: a platform `files` list with ONLY "!" patterns packs EVERYTHING
  (got a 513 MB installer) - always repeat the explicit file list there. Going much smaller would need a
  Tauri-style host (system webview) - big rewrite, not started.
- TEST WITH `YAPAPP_DATA=<dir>` (main.js) - otherwise the dev app uses the user's REAL settings/history
  (%APPDATA%/YapApp; setting APPDATA does NOT redirect Electron).
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
