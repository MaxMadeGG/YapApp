// Electron host: window, IPC to the UI, clipboard and self-update.
// All chat logic lives in core.js (shared with the Android app).
const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const { createCore } = require('./core.js')

// Test hook: YAPAPP_DATA=<dir> keeps settings + history out of the real profile.
if (process.env.YAPAPP_DATA) app.setPath('userData', process.env.YAPAPP_DATA)

let win = null

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
ipcMain.handle('dm', (e, toName, text) => getCore().sendDm(toName, text))
ipcMain.handle('react', (e, target, emoji, on) => getCore().react(target, emoji, on))
ipcMain.handle('channel:set', (e, target, name, deleted) => getCore().setChannel(target, name, deleted))
ipcMain.handle('channel:create', (e, name) => getCore().createChannel(name))
ipcMain.handle('room:rename', (e, name) => getCore().renameRoom(name))
ipcMain.handle('invite:create', (e, roomName) => getCore().createInvite(roomName))
ipcMain.handle('invite:check', (e, code) => getCore().checkInvite(code))
ipcMain.handle('clipboard:write', (e, text) => clipboard.writeText(String(text)))
ipcMain.handle('app:version', () => app.getVersion())

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
