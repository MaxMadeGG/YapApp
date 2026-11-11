// YapApp chat core: rooms, invites, peer auth, history sync, settings.
// Runtime-neutral: runs in Electron's Node (desktop) and in Bare (Android).
// The host passes in a file-system module and a data directory, and gets
// events back through `emit(channel, data)`.
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const sodium = require('sodium-universal')

const SYNC_BATCH = 200        // messages per 'history' packet
const MAX_LINE = 16_000_000   // max bytes of one protocol line
const MAX_TEXT = 4000
const AUTH_TIMEOUT = 15000
const SETTINGS_KEYS = ['name', 'invite', 'lastUsed', 'rooms'] // rooms = JSON list of remembered invites

// ---- Crypto helpers (SHA-256 based, identical on every runtime) -------------
function sha256 (...parts) {
  const out = b4a.alloc(32)
  sodium.crypto_hash_sha256(out, b4a.concat(parts.map(p => typeof p === 'string' ? b4a.from(p) : p)))
  return out
}

function hmacSha256 (key, ...parts) {
  if (key.length > 64) key = sha256(key)
  const k = b4a.alloc(64)
  b4a.copy(key, k)
  const ipad = b4a.alloc(64)
  const opad = b4a.alloc(64)
  for (let i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c }
  return sha256(opad, sha256(ipad, ...parts))
}

// HKDF-SHA256 (RFC 5869) with a 32-byte output.
function hkdf32 (ikm, salt, info) {
  const prk = hmacSha256(b4a.from(salt), ikm)
  return hmacSha256(prk, b4a.from(info), b4a.from([1]))
}

function randomBytes (n) {
  const b = b4a.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

function timingSafeEqual (a, b) {
  return a.length === b.length && sodium.sodium_memcmp(a, b)
}

function toB64url (buf) {
  return b4a.toString(buf, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url (s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return b4a.from(s, 'base64')
}

// ---- Invites -----------------------------------------------------------------
// A room is a random 128-bit secret. The invite code carries the secret plus the
// room's display name: yap1-<secret base64url>-<name base64url>.
// From the secret we derive (HKDF) the swarm topic and a separate auth key, so
// the room can't be found or joined without the invite.
function makeInvite (roomName) {
  const name = String(roomName).trim().slice(0, 40) || 'Room'
  return `yap1-${toB64url(randomBytes(16))}-${toB64url(b4a.from(name))}`
}

function parseInvite (code) {
  const m = /^yap1-([A-Za-z0-9_-]{22})-([A-Za-z0-9_-]{1,80})$/.exec(String(code).trim())
  if (!m) return null
  const secret = fromB64url(m[1])
  const name = b4a.toString(fromB64url(m[2]), 'utf8').slice(0, 40)
  if (secret.length !== 16 || !name) return null
  return { name, secret, topic: hkdf32(secret, 'yapapp', 'topic'), authKey: hkdf32(secret, 'yapapp', 'auth') }
}

function cleanRoomName (n) { return String(n).replace(/\s+/g, ' ').trim().slice(0, 40) }
// Channel names like Slack: lowercase, no spaces.
function cleanChannel (n) { return String(n).trim().toLowerCase().replace(/\s+/g, '-').replace(/^#+/, '').slice(0, 40) }

function validMeta (m) {
  return m && typeof m.name === 'string' && cleanRoomName(m.name) &&
    typeof m.ts === 'number' && Number.isFinite(m.ts) && typeof m.by === 'string'
}

// Every history entry is a "message"; two optional extras ride along so they sync
// by id like everything else:
//  - parent: id of the message this is a thread reply to
//  - kind 'react': a reaction toggle { target, emoji, on } (newest per person+emoji wins).
//  - kind 'chan': a channel's state { target: channel id, chName, deleted } (newest wins).
//  - ch: the channel a message belongs to (missing = 'general').
//    The text of react/chan entries is a readable fallback for older apps.
const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 64
function validMsg (m) {
  if (!(m && isId(m.id) && typeof m.name === 'string' && typeof m.text === 'string' &&
    typeof m.ts === 'number' && Number.isFinite(m.ts) && m.text.length <= MAX_TEXT)) return false
  if (m.parent !== undefined && !isId(m.parent)) return false
  if (m.ch !== undefined && !isId(m.ch)) return false
  if (m.kind === 'react') {
    return isId(m.target) && typeof m.emoji === 'string' && m.emoji.length > 0 && m.emoji.length <= 16 &&
      typeof m.on === 'boolean'
  }
  if (m.kind === 'chan') {
    return isId(m.target) && typeof m.chName === 'string' && !!cleanChannel(m.chName) && typeof m.deleted === 'boolean'
  }
  return m.kind === undefined
}

// ---- The core ----------------------------------------------------------------
function createCore ({ fs, dataDir, emit }) {
  const file = name => dataDir.replace(/[\\/]+$/, '') + '/' + name
  const readJSON = name => { try { return JSON.parse(b4a.toString(fs.readFileSync(file(name)))) } catch { return null } }
  const writeJSON = (name, data) => { try { fs.writeFileSync(file(name), JSON.stringify(data)) } catch {} }

  let swarm = null
  let me = null          // { name, secret, authKey }
  let history = []       // [{ id, name, text, ts }]
  let seen = new Set()
  let historyName = null
  let metaName = null
  let roomMeta = null    // { name, ts, by }
  let saveTimer = null
  const peers = new Map() // authenticated conn -> name (null until 'hello')

  const currentInvite = () => `yap1-${toB64url(me.secret)}-${toB64url(b4a.from(roomMeta.name))}`
  const roomInfo = () => ({ room: roomMeta.name, invite: currentInvite() })
  const sendPeers = () => emit('peers', [...peers.values()].map(n => n || '(connecting…)'))

  function write (conn, obj) {
    try { conn.write(b4a.from(JSON.stringify(obj) + '\n')) } catch {}
  }

  function saveHistory () {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; writeJSON(historyName, history) }, 300)
  }

  // Add messages we haven't seen; returns true if anything new arrived.
  function addMessages (msgs) {
    let added = false
    for (const m of msgs) {
      if (!validMsg(m) || seen.has(m.id)) continue
      seen.add(m.id)
      const e = { id: m.id, name: m.name.slice(0, 40), text: m.text, ts: m.ts }
      if (m.parent) e.parent = m.parent
      if (m.ch) e.ch = m.ch
      if (m.kind === 'react') Object.assign(e, { kind: 'react', target: m.target, emoji: m.emoji, on: m.on })
      if (m.kind === 'chan') Object.assign(e, { kind: 'chan', target: m.target, chName: cleanChannel(m.chName), deleted: m.deleted })
      history.push(e)
      added = true
    }
    if (added) {
      history.sort((a, b) => a.ts - b.ts)
      saveHistory()
    }
    return added
  }

  // Room name: renames are shared as { name, ts, by }, newest wins. The secret
  // never changes, so old invite codes keep working. Returns true if replaced.
  function applyMeta (m) {
    if (!validMeta(m)) return false
    const name = cleanRoomName(m.name)
    const newer = m.ts > roomMeta.ts || (m.ts === roomMeta.ts && name > roomMeta.name)
    if (!newer || m.ts > Date.now() + 24 * 3600 * 1000) return false // ignore far-future clocks
    roomMeta = { name, ts: m.ts, by: m.by.slice(0, 40) }
    writeJSON(metaName, roomMeta)
    emit('room', roomInfo())
    return true
  }

  // Proof that we hold the room secret, bound to this exact encrypted connection
  // (Noise handshake hash) and our role, so it can't be replayed or reflected.
  function authMac (conn, initiator) {
    return hmacSha256(me.authKey, b4a.from(initiator ? 'yapapp-auth-I' : 'yapapp-auth-R'), conn.handshakeHash)
  }

  async function onConnection (conn) {
    // Until the peer proves it has the room secret we accept nothing but 'auth'
    // and send nothing but our own proof. Failing or stalling = disconnect.
    let authed = false
    const timer = setTimeout(() => { if (!authed) conn.destroy() }, AUTH_TIMEOUT)
    const onAuth = msg => {
      let ok = false
      try { ok = timingSafeEqual(b4a.from(String(msg.mac), 'hex'), authMac(conn, !conn.isInitiator)) } catch {}
      if (!ok) { conn.destroy(); return }
      authed = true
      clearTimeout(timer)
      peers.set(conn, null)
      sendPeers()
      // Introduce ourselves and tell the peer which messages we already have;
      // it replies with every message we're missing (see 'ids' in handle()).
      write(conn, { type: 'hello', name: me.name })
      write(conn, { type: 'ids', ids: history.map(m => m.id) })
      write(conn, { type: 'meta', meta: roomMeta })
    }

    // Newline-delimited JSON. Split on the byte so multi-byte UTF-8 (emoji)
    // is never cut in half across chunks.
    let buf = b4a.alloc(0)
    conn.on('data', chunk => {
      buf = buf.length ? b4a.concat([buf, chunk]) : chunk
      if (buf.length > MAX_LINE) { buf = b4a.alloc(0); return }
      let i
      while ((i = b4a.indexOf(buf, 10)) >= 0) {
        const line = b4a.toString(buf.subarray(0, i))
        buf = buf.subarray(i + 1)
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
      if (name) emit('system', `${name} left`)
    }
    conn.on('close', gone)
    conn.on('error', gone)

    if ((await conn.opened) === false || !me) return conn.destroy()
    write(conn, { type: 'auth', mac: b4a.toString(authMac(conn, conn.isInitiator), 'hex') })
  }

  function handle (conn, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'hello' && typeof msg.name === 'string') {
      const name = msg.name.slice(0, 40)
      peers.set(conn, name)
      sendPeers()
      emit('system', `${name} joined`)
    } else if (msg.type === 'ids' && Array.isArray(msg.ids)) {
      // Send the peer everything it doesn't have, in batches.
      const theirs = new Set(msg.ids)
      const missing = history.filter(m => !theirs.has(m.id))
      for (let i = 0; i < missing.length; i += SYNC_BATCH) {
        write(conn, { type: 'history', msgs: missing.slice(i, i + SYNC_BATCH) })
      }
    } else if (msg.type === 'history' && Array.isArray(msg.msgs)) {
      if (addMessages(msg.msgs)) emit('history', history)
    } else if (msg.type === 'msg') {
      if (addMessages([msg.msg])) {
        emit('message', msg.msg)
        forward(conn, { type: 'msg', msg: msg.msg })
      }
    } else if (msg.type === 'meta') {
      if (applyMeta(msg.meta)) {
        emit('system', `${roomMeta.by} renamed the room to "${roomMeta.name}"`)
        forward(conn, { type: 'meta', meta: roomMeta })
      }
    }
  }

  // Gossip: pass new messages/renames on to our other peers, so people who
  // couldn't connect to each other directly still get them. Message ids (and
  // meta timestamps) are deduplicated, so this never loops.
  function forward (from, obj) {
    for (const conn of peers.keys()) if (conn !== from) write(conn, obj)
  }

  async function join (name, invite) {
    const room = parseInvite(invite)
    if (!room) return { ok: false, error: 'That invite code is not valid.' }
    // Already in this room as this name (e.g. the Android UI reattaching to the
    // background service): just resend the current state, don't reconnect.
    if (swarm && me && b4a.equals(me.secret, room.secret) && me.name === String(name).slice(0, 40)) {
      emit('history', history)
      sendPeers()
      return { ok: true, ...roomInfo() }
    }
    await leave()
    me = { name: String(name).slice(0, 40), secret: room.secret, authKey: room.authKey }
    const roomId = b4a.toString(room.topic, 'hex').slice(0, 16)
    historyName = `history-${roomId}.json`
    metaName = `room-${roomId}.json`
    roomMeta = { name: room.name, ts: 0, by: '' } // name from the invite, older than any rename
    const saved = readJSON(metaName)
    if (validMeta(saved)) roomMeta = { name: cleanRoomName(saved.name), ts: saved.ts, by: saved.by }
    history = readJSON(historyName) || []
    seen = new Set(history.map(m => m.id))
    emit('history', history)

    swarm = new Hyperswarm()
    swarm.on('connection', onConnection)
    swarm.join(room.topic, { server: true, client: true })
    return { ok: true, ...roomInfo() }
  }

  async function leave () {
    // Flush any pending history save before closing / switching rooms.
    if (saveTimer && historyName) {
      clearTimeout(saveTimer)
      saveTimer = null
      writeJSON(historyName, history)
    }
    peers.clear()
    if (swarm) {
      const s = swarm
      swarm = null
      try { await s.destroy() } catch {}
    }
  }

  function publish (m) {
    addMessages([m])
    for (const conn of peers.keys()) write(conn, { type: 'msg', msg: m })
    return m
  }
  const newId = () => b4a.toString(randomBytes(16), 'hex')

  // extra.parent = reply in that message's thread.
  function send (text, extra) {
    text = String(text).slice(0, MAX_TEXT)
    if (!me || !text.trim()) return null
    const m = { id: newId(), name: me.name, text, ts: Date.now() }
    if (extra && isId(extra.parent)) m.parent = extra.parent
    if (extra && isId(extra.ch) && extra.ch !== 'general') m.ch = extra.ch
    return publish(m)
  }

  // Create (new id), rename or delete a channel. Everyone in the room can.
  function setChannel (target, chName, deleted) {
    chName = cleanChannel(chName)
    if (!me || !isId(target) || !chName) return null
    deleted = !!deleted && target !== 'general' // #general always stays
    return publish({ id: newId(), name: me.name, ts: Date.now(), kind: 'chan', target, chName, deleted,
      text: deleted ? 'deleted channel #' + chName : 'set up channel #' + chName })
  }
  function createChannel (chName) { return setChannel(newId(), chName, false) }

  function react (target, emoji, on) {
    emoji = String(emoji).slice(0, 16)
    if (!me || !isId(target) || !emoji) return null
    on = !!on
    return publish({ id: newId(), name: me.name, text: (on ? 'reacted ' : 'removed reaction ') + emoji,
      ts: Date.now(), kind: 'react', target, emoji, on })
  }

  function renameRoom (newName) {
    const name = cleanRoomName(newName)
    if (!me || !name) return null
    if (name !== roomMeta.name) {
      applyMeta({ name, ts: Math.max(Date.now(), roomMeta.ts + 1), by: me.name })
      for (const conn of peers.keys()) write(conn, { type: 'meta', meta: roomMeta })
    }
    return roomInfo()
  }

  // Remembered login (name, invite, lastUsed) in settings.json.
  function getSettings () { return readJSON('settings.json') || {} }
  function setSettings (changes) {
    const s = getSettings()
    for (const k of SETTINGS_KEYS) {
      if (!changes || !(k in changes)) continue
      if (changes[k] === null) delete s[k]
      else s[k] = String(changes[k]).slice(0, k === 'rooms' ? 20000 : 300)
    }
    writeJSON('settings.json', s)
  }

  function checkInvite (code) {
    const r = parseInvite(code)
    return r ? r.name : null
  }

  // Diagnostics: what the swarm/DHT thinks about our network situation.
  function debugInfo () {
    if (!swarm) return { joined: false }
    const dht = swarm.dht
    return {
      joined: true,
      firewalled: dht.firewalled,
      host: dht.host,
      port: dht.port,
      randomized: dht.randomized,
      connections: swarm.connections.size,
      connecting: swarm.connecting,
      authedPeers: peers.size
    }
  }

  return { join, leave, send, react, setChannel, createChannel, renameRoom, createInvite: makeInvite, checkInvite, getSettings, setSettings, debugInfo }
}

module.exports = { createCore, parseInvite, makeInvite, hmacSha256, hkdf32 }
