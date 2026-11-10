const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { StringDecoder } = require('string_decoder')
const Hyperswarm = require('hyperswarm')

const SYNC_BATCH = 200       // messages per 'history' packet
const MAX_LINE = 16_000_000  // max bytes of one protocol line
const MAX_TEXT = 4000

let win = null
let swarm = null
let me = null          // { name, room, authKey }
let history = []       // [{ id, name, text, ts }]
let seen = new Set()
let historyFile = null
const peers = new Map() // authenticated conn -> name (null until 'hello')
const AUTH_TIMEOUT = 15000

// ---- Rooms & invites -------------------------------------------------------
// A room is a random 128-bit secret. The invite code carries the secret plus the
// room's display name: yap1-<secret base64url>-<name base64url>.
// From the secret we derive (HKDF) the swarm topic and a separate auth key, so
// the room can't be found or joined without the invite.
function makeInvite (roomName) {
  const name = String(roomName).trim().slice(0, 40) || 'Room'
  const secret = crypto.randomBytes(16)
  return `yap1-${secret.toString('base64url')}-${Buffer.from(name).toString('base64url')}`
}

function parseInvite (code) {
  const m = /^yap1-([A-Za-z0-9_-]{22})-([A-Za-z0-9_-]{1,80})$/.exec(String(code).trim())
  if (!m) return null
  const secret = Buffer.from(m[1], 'base64url')
  const name = Buffer.from(m[2], 'base64url').toString('utf8').slice(0, 40)
  if (secret.length !== 16 || !name) return null
  const derive = info => Buffer.from(crypto.hkdfSync('sha256', secret, 'yapapp', info, 32))
  return { name, topic: derive('topic'), authKey: derive('auth') }
}

// Proof that we hold the room secret, bound to this exact encrypted connection
// (Noise handshake hash) and our role, so it can't be replayed or reflected.
function authMac (conn, initiator) {
  return crypto.createHmac('sha256', me.authKey)
    .update(initiator ? 'yapapp-auth-I' : 'yapapp-auth-R')
    .update(conn.handshakeHash)
    .digest()
}

function toUI (channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

function sendPeers () {
  toUI('peers', [...peers.values()].map(n => n || '(connecting…)'))
}

function loadHistory () {
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')) } catch { history = [] }
  seen = new Set(history.map(m => m.id))
}

let saveTimer = null
function saveHistory () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(historyFile, JSON.stringify(history)) } catch {}
  }, 300)
}

function validMsg (m) {
  return m && typeof m.id === 'string' && typeof m.name === 'string' &&
    typeof m.text === 'string' && typeof m.ts === 'number' && m.text.length <= MAX_TEXT
}

// Add messages we haven't seen; returns true if anything new arrived.
function addMessages (msgs) {
  let added = false
  for (const m of msgs) {
    if (!validMsg(m) || seen.has(m.id)) continue
    seen.add(m.id)
    history.push({ id: m.id, name: m.name.slice(0, 40), text: m.text, ts: m.ts })
    added = true
  }
  if (added) {
    history.sort((a, b) => a.ts - b.ts)
    saveHistory()
  }
  return added
}

function write (conn, obj) {
  try { conn.write(JSON.stringify(obj) + '\n') } catch {}
}

async function onConnection (conn) {
  // Until the peer proves it has the room secret we accept nothing but 'auth'
  // and send nothing but our own proof. Failing or stalling = disconnect.
  let authed = false
  const timer = setTimeout(() => { if (!authed) conn.destroy() }, AUTH_TIMEOUT)
  const onAuth = msg => {
    let ok = false
    try {
      const theirs = Buffer.from(String(msg.mac), 'hex')
      const expected = authMac(conn, !conn.isInitiator)
      ok = theirs.length === expected.length && crypto.timingSafeEqual(theirs, expected)
    } catch {}
    if (!ok) { conn.destroy(); return }
    authed = true
    clearTimeout(timer)
    peers.set(conn, null)
    sendPeers()
    // Introduce ourselves and tell the peer which messages we already have;
    // it replies with every message we're missing (see 'ids' in handle()).
    write(conn, { type: 'hello', name: me.name })
    write(conn, { type: 'ids', ids: history.map(m => m.id) })
  }

  const decoder = new StringDecoder('utf8') // keeps emoji intact across chunks
  let buf = ''
  conn.on('data', chunk => {
    buf += decoder.write(chunk)
    if (buf.length > MAX_LINE) { buf = ''; return }
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(line) } catch { conn.destroy(); return }
      if (authed) handle(conn, msg)
      else if (msg && msg.type === 'auth') onAuth(msg)
      else { conn.destroy(); return }
    }
  })
  const gone = () => {
    clearTimeout(timer)
    if (!peers.has(conn)) return
    const name = peers.get(conn)
    peers.delete(conn)
    sendPeers()
    if (name) toUI('system', `${name} left`)
  }
  conn.on('close', gone)
  conn.on('error', gone)

  if ((await conn.opened) === false || !me) return conn.destroy()
  write(conn, { type: 'auth', mac: authMac(conn, conn.isInitiator).toString('hex') })
}

function handle (conn, msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'hello' && typeof msg.name === 'string') {
    const name = msg.name.slice(0, 40)
    peers.set(conn, name)
    sendPeers()
    toUI('system', `${name} joined`)
  } else if (msg.type === 'ids' && Array.isArray(msg.ids)) {
    // Send the peer everything it doesn't have, in batches.
    const theirs = new Set(msg.ids)
    const missing = history.filter(m => !theirs.has(m.id))
    for (let i = 0; i < missing.length; i += SYNC_BATCH) {
      write(conn, { type: 'history', msgs: missing.slice(i, i + SYNC_BATCH) })
    }
  } else if (msg.type === 'history' && Array.isArray(msg.msgs)) {
    if (addMessages(msg.msgs)) toUI('history', history)
  } else if (msg.type === 'msg') {
    if (addMessages([msg.msg])) toUI('message', msg.msg)
  }
}

async function join (name, invite) {
  const room = parseInvite(invite)
  if (!room) return { ok: false, error: 'That invite code is not valid.' }
  await leave()
  me = { name: String(name).slice(0, 40), room: room.name, authKey: room.authKey }
  const topic = room.topic
  historyFile = path.join(app.getPath('userData'), `history-${topic.toString('hex').slice(0, 16)}.json`)
  loadHistory()
  toUI('history', history)

  swarm = new Hyperswarm()
  swarm.on('connection', onConnection)
  swarm.join(topic, { server: true, client: true })
  return { ok: true, room: room.name }
}

async function leave () {
  // Flush any pending history save before closing / switching rooms.
  if (saveTimer && historyFile) {
    clearTimeout(saveTimer)
    saveTimer = null
    try { fs.writeFileSync(historyFile, JSON.stringify(history)) } catch {}
  }
  peers.clear()
  if (swarm) {
    const s = swarm
    swarm = null
    try { await s.destroy() } catch {}
  }
}

function send (text) {
  text = String(text).slice(0, MAX_TEXT)
  if (!me || !text.trim()) return null
  const m = { id: crypto.randomUUID(), name: me.name, text, ts: Date.now() }
  addMessages([m])
  for (const conn of peers.keys()) write(conn, { type: 'msg', msg: m })
  return m
}

// Remembered login (name, room, lastUsed) lives in a JSON file; Chromium's
// localStorage is not reliably flushed to disk when the app quits.
const SETTINGS_KEYS = ['name', 'invite', 'lastUsed']
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
function readSettings () {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {} } catch { return {} }
}
ipcMain.handle('settings:get', () => readSettings())
ipcMain.handle('settings:set', (e, changes) => {
  const s = readSettings()
  for (const k of SETTINGS_KEYS) {
    if (!(k in changes)) continue
    if (changes[k] === null) delete s[k]
    else s[k] = String(changes[k]).slice(0, 300)
  }
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s)) } catch {}
})

ipcMain.handle('join', (e, name, invite) => join(name, invite))
ipcMain.handle('clipboard:write', (e, text) => clipboard.writeText(String(text)))
ipcMain.handle('invite:create', (e, roomName) => makeInvite(roomName))
ipcMain.handle('invite:check', (e, code) => {
  const r = parseInvite(code)
  return r ? r.name : null
})
ipcMain.handle('leave', () => leave())
ipcMain.handle('send', (e, text) => send(text))
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
  // Test hook: YAPAPP_AUTOJOIN="name|room" joins without the UI.
  if (process.env.YAPAPP_AUTOJOIN) {
    const [n, invite] = process.env.YAPAPP_AUTOJOIN.split('|')
    join(n, invite)
  }
  setupAutoUpdate()
})

app.on('window-all-closed', async () => {
  await leave()
  app.quit()
})
