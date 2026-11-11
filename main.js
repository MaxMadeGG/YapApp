// Electron host: window, IPC to the UI, clipboard and self-update.
// All chat logic lives in core.js (shared with the Android app).
const { app, BrowserWindow, ipcMain, clipboard, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { createCore } = require('./core.js')

// Test hook: YAPAPP_DATA=<dir> keeps settings + history out of the real profile.
if (process.env.YAPAPP_DATA) app.setPath('userData', process.env.YAPAPP_DATA)

let win = null
if (process.platform === 'win32') app.setAppUserModelId('com.maxmadegg.yapapp') // Windows notifications

function toUI (channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

let core = null
function getCore () {
  if (!core) core = createCore({ fs, dataDir: app.getPath('userData'), emit: toUI })
  return core
}

ipcMain.handle('settings:get', () => getCore().getSettings())
ipcMain.handle('settings:set', (e, changes) => getCore().setSettings(changes))
ipcMain.handle('join', (e, name, invite) => getCore().join(name, invite))
ipcMain.handle('leave', () => getCore().leave())
ipcMain.handle('send', (e, text, extra) => getCore().send(text, extra))
ipcMain.handle('dm', (e, toName, text, files, extra) => getCore().sendDm(toName, text, files, extra))
ipcMain.handle('msg:edit', (e, target, text) => getCore().editMessage(target, text))
ipcMain.handle('me:rename', (e, from, to) => getCore().renameMe(from, to))
ipcMain.handle('msg:delete', (e, target) => getCore().deleteMessage(target))
ipcMain.handle('file:add', (e, bytes, name, mime, relPath) => getCore().addFile(bytes, name, mime, relPath))
ipcMain.handle('file:get', (e, ref) => getCore().getFile(ref))
ipcMain.handle('picture:set', (e, kind, pic, info) => getCore().setPicture(kind, pic, info))

// Names and folder paths come from other people: keep them inside the chosen folder.
function safeName (n) {
  const s = String(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '_').trim()
  return s.slice(0, 150) || 'file'
}
function safeRel (p) { return String(p).split(/[\\/]+/).filter(x => x && x !== '.' && x !== '..').map(safeName) }

// Save one file (Save As dialog) or a whole folder (pick where to put it).
ipcMain.handle('file:save', async (e, refs, folder) => {
  const core = getCore()
  if (!Array.isArray(refs) || !refs.length) return 0
  if (!folder) {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeName(refs[0].n)) })
    if (r.canceled || !r.filePath) return 0
    const bytes = await core.getFile(refs[0])
    if (!bytes) throw new Error('Could not download the file (is anyone who has it online?)')
    fs.writeFileSync(r.filePath, bytes)
    return 1
  }
  const r = await dialog.showOpenDialog(win, { title: 'Where should the folder "' + folder + '" go?',
    defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || !r.filePaths[0]) return 0
  let saved = 0
  for (const ref of refs) {
    const bytes = await core.getFile(ref)
    if (!bytes) continue
    const parts = safeRel(ref.p || ref.n)
    const target = path.join(r.filePaths[0], ...parts)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
    saved++
  }
  return saved
})
ipcMain.handle('react', (e, target, emoji, on) => getCore().react(target, emoji, on))
ipcMain.handle('channel:set', (e, target, name, deleted) => getCore().setChannel(target, name, deleted))
ipcMain.handle('channel:create', (e, name) => getCore().createChannel(name))
ipcMain.handle('room:rename', (e, name) => getCore().renameRoom(name))
ipcMain.handle('invite:create', (e, roomName) => getCore().createInvite(roomName))
ipcMain.handle('invite:check', (e, code) => getCore().checkInvite(code))
ipcMain.handle('clipboard:write', (e, text) => clipboard.writeText(String(text)))
ipcMain.handle('app:version', () => app.getVersion())
const isWebLink = u => /^(https?:|mailto:)/i.test(String(u))
ipcMain.handle('open:url', (e, url) => { if (isWebLink(url)) shell.openExternal(String(url)) })
ipcMain.handle('win:focus', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus() })

// Self-update from the rolling "latest" GitHub release (feed URL is in
// package.json build.publish). Only the installed app updates, not `npm start`.
let updater = null
function setupAutoUpdate () {
  if (!app.isPackaged) return
  try { updater = require('electron-updater').autoUpdater } catch { return }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.on('update-downloaded', info => toUI('update-ready', info.version))
  updater.on('error', err => console.log('update check failed:', err && err.message))
  const check = () => updater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, 4 * 3600 * 1000)
}
ipcMain.handle('update:install', () => { if (updater) updater.quitAndInstall() })

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 400,
    title: 'YapApp',
    backgroundColor: '#1e1f24',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('index.html')
  // Links open in the normal browser; the app window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWebLink(url)) shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (isWebLink(url)) shell.openExternal(url) } })
  // Test hook: YAPAPP_AUTOJOIN="name|invite" joins without the UI.
  if (process.env.YAPAPP_AUTOJOIN) {
    const [n, invite] = process.env.YAPAPP_AUTOJOIN.split('|')
    getCore().join(n, invite)
  }
  setupAutoUpdate()
})

app.on('window-all-closed', async () => {
  if (core) await core.leave()
  app.quit()
})
