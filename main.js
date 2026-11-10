const { app, BrowserWindow, ipcMain } = require('electron')
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
let me = null          // { name, room }
let history = []       // [{ id, name, text, ts }]
let seen = new Set()
let historyFile = null
const peers = new Map() // conn -> name

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

function onConnection (conn) {
  peers.set(conn, null)
  sendPeers()
  // Introduce ourselves and tell the peer which messages we already have;
  // it replies with every message we're missing (see 'ids' in handle()).
  write(conn, { type: 'hello', name: me.name })
  write(conn, { type: 'ids', ids: history.map(m => m.id) })

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
      try { msg = JSON.parse(line) } catch { continue }
      handle(conn, msg)
    }
  })
  const gone = () => {
    if (!peers.has(conn)) return
    const name = peers.get(conn)
    peers.delete(conn)
    sendPeers()
    if (name) toUI('system', `${name} left`)
  }
  conn.on('close', gone)
  conn.on('error', gone)
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

async function join (name, room) {
  await leave()
  me = { name: String(name).slice(0, 40), room: String(room) }
  const topic = crypto.createHash('sha256').update('yapapp-room:' + me.room).digest()
  historyFile = path.join(app.getPath('userData'), `history-${topic.toString('hex').slice(0, 16)}.json`)
  loadHistory()
  toUI('history', history)

  swarm = new Hyperswarm()
  swarm.on('connection', onConnection)
  swarm.join(topic, { server: true, client: true })
  return true
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

ipcMain.handle('join', (e, name, room) => join(name, room))
ipcMain.handle('leave', () => leave())
ipcMain.handle('send', (e, text) => send(text))

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
    const [n, r] = process.env.YAPAPP_AUTOJOIN.split('|')
    join(n, r)
  }
})

app.on('window-all-closed', async () => {
  await leave()
  app.quit()
})
