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
const MAX_FILE = 50 * 1024 * 1024 // per attached file
const MAX_FILES = 50              // per message
const CHUNK = 256 * 1024          // file transfer piece size
const WANT_TIMEOUT = 60000        // give up fetching a file after this long without progress
const SETTINGS_KEYS = ['name', 'invite', 'lastUsed', 'rooms', 'pfp', 'profile'] // rooms = JSON list of remembered invites

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
//  - kind 'key': a device's public key for direct messages { pk }.
//  - kind 'dm': a direct message, encrypted (crypto_box) separately for every device of
//    the two people { toName, from: sender pk, boxes: { pk: { n: nonce, c: ciphertext } } }.
//    Everyone stores and forwards it, only those two can read it.
//  - kind 'edit': new text for one of the author's own messages { target } (newest wins).
//  - kind 'del': the author deleted their message { target }. Everyone wipes the target's text and
//    files (it becomes a tombstone { deleted: true }), so it's really gone, not just hidden.
//    DMs do the same inside the encrypted payload ({ edit } / { del }).
//  - ch: the channel a message belongs to (missing = 'general').
//  - files: attachments [{ h: blob hash, k: blob key, n: name, s: size, m: mime, p?: path in a folder }].
//    Blobs are encrypted with their own random key (secretbox) and fetched from peers by hash;
//    the key only travels inside the message (and inside the encrypted payload for DMs).
//    The text of react/chan entries is a readable fallback for older apps.
const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 64
const isHex = (v, n) => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v)
const MAX_BOXES = 16
// Profile details people can fill in (all optional, shared with everyone in the room).
const INFO_FIELDS = { title: 80, pronouns: 30, email: 120, phone: 40, location: 80, about: 600 }
function cleanInfo (x) {
  if (x === undefined || x === null) return {}
  if (typeof x !== 'object' || Array.isArray(x)) return null
  const out = {}
  for (const [k, max] of Object.entries(INFO_FIELDS)) {
    if (x[k] === undefined) continue
    if (typeof x[k] !== 'string') return null
    const v = x[k].trim().slice(0, max)
    if (v) out[k] = v
  }
  return out
}
function cleanFiles (f) {
  if (!Array.isArray(f) || !f.length || f.length > MAX_FILES) return null
  const out = []
  for (const x of f) {
    if (!x || !isHex(x.h, 64) || !isHex(x.k, 64) || typeof x.n !== 'string' || !x.n || x.n.length > 200 ||
      typeof x.s !== 'number' || !(x.s >= 0 && x.s <= MAX_FILE) || typeof x.m !== 'string' || x.m.length > 100) return null
    if (x.p !== undefined && (typeof x.p !== 'string' || x.p.length > 500)) return null
    const e = { h: x.h, k: x.k, n: x.n, s: x.s, m: x.m }
    if (x.p) e.p = x.p
    out.push(e)
  }
  return out
}
function validBoxes (b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false
  const keys = Object.keys(b)
  if (!keys.length || keys.length > MAX_BOXES) return false
  return keys.every(k => isHex(k, 64) && b[k] && isHex(b[k].n, 48) &&
    typeof b[k].c === 'string' && b[k].c.length <= 64000)
}
function validMsg (m) {
  if (!(m && isId(m.id) && typeof m.name === 'string' && typeof m.text === 'string' &&
    typeof m.ts === 'number' && Number.isFinite(m.ts) && m.text.length <= MAX_TEXT)) return false
  if (m.parent !== undefined && !isId(m.parent)) return false
  if (m.ch !== undefined && !isId(m.ch)) return false
  if (m.files !== undefined && !cleanFiles(m.files)) return false
  if (m.kind === 'react') {
    return isId(m.target) && typeof m.emoji === 'string' && m.emoji.length > 0 && m.emoji.length <= 16 &&
      typeof m.on === 'boolean'
  }
  if (m.kind === 'chan') {
    return isId(m.target) && typeof m.chName === 'string' && !!cleanChannel(m.chName) && typeof m.deleted === 'boolean'
  }
  if (m.kind === 'key') return isHex(m.pk, 64)
  if (m.kind === 'edit' || m.kind === 'del') return isId(m.target)
  // Profile picture of the author / picture of the room: { pic: file ref or null }, newest wins.
  if (m.kind === 'profile' || m.kind === 'roompic') {
    return (m.pic === null || !!cleanFiles([m.pic])) && (m.info === undefined || !!cleanInfo(m.info))
  }
  if (m.kind === 'dm') {
    return isHex(m.from, 64) && typeof m.toName === 'string' && m.toName.length > 0 && m.toName.length <= 40 &&
      validBoxes(m.boxes)
  }
  return m.kind === undefined
}

// ---- The core ----------------------------------------------------------------
function createCore ({ fs, dataDir, emit }) {
  const file = name => dataDir.replace(/[\\/]+$/, '') + '/' + name
  const readJSON = name => { try { return JSON.parse(b4a.toString(fs.readFileSync(file(name)))) } catch { return null } }
  const writeJSON = (name, data) => { try { fs.writeFileSync(file(name), JSON.stringify(data)) } catch {} }

  let swarm = null
  let identity = null    // this device's DM keypair { pk, sk } (Buffers), from identity.json
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
      if (m.deleted === true && !m.kind) { e.text = ''; e.deleted = true } // tombstone from a peer
      if (m.parent) e.parent = m.parent
      if (m.ch) e.ch = m.ch
      if (m.files && !e.deleted) e.files = cleanFiles(m.files)
      if (m.kind === 'edit' || m.kind === 'del') Object.assign(e, { kind: m.kind, target: m.target })
      if (m.kind === 'react') Object.assign(e, { kind: 'react', target: m.target, emoji: m.emoji, on: m.on })
      if (m.kind === 'chan') Object.assign(e, { kind: 'chan', target: m.target, chName: cleanChannel(m.chName), deleted: m.deleted })
      if (m.kind === 'key') Object.assign(e, { kind: 'key', pk: m.pk })
      if (m.kind === 'profile' || m.kind === 'roompic') Object.assign(e, { kind: m.kind, pic: m.pic ? cleanFiles([m.pic])[0] : null })
      if (m.kind === 'profile' && m.info) e.info = cleanInfo(m.info)
      if (m.kind === 'dm') Object.assign(e, { kind: 'dm', toName: m.toName.slice(0, 40), from: m.from, boxes: m.boxes })
      history.push(e)
      added = true
    }
    if (added) applyDeletes()
    if (added) {
      history.sort((a, b) => a.ts - b.ts)
      saveHistory()
    }
    return added
  }

  // Wipe messages their authors deleted (and the edits of them). Only the author's own 'del' counts.
  function applyDeletes () {
    const dels = new Map()
    for (const h of history) if (h.kind === 'del') dels.set(h.target + '\n' + h.name, true)
    if (!dels.size) return
    const byId = new Map(history.map(h => [h.id, h]))
    for (const h of history) {
      const isTarget = !h.kind && !h.deleted && dels.has(h.id + '\n' + h.name)
      const isEditOf = h.kind === 'edit' && h.text && dels.has(h.target + '\n' + h.name)
      if (isTarget) {
        for (const f of h.files || []) { if (!stillUsed(f.h, h.id, byId)) { try { fs.unlinkSync(blobPath(f.h)) } catch {} } }
        h.text = ''
        delete h.files
        h.deleted = true
      } else if (isEditOf) {
        h.text = ''
      }
    }
  }
  function stillUsed (hash, exceptId) {
    return history.some(h => h.id !== exceptId && !h.deleted && (h.files || []).some(f => f.h === hash))
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
      for (const [h, p] of pending) if (!p.from) write(conn, { type: 'want', h })
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
      for (const [h, p] of pending) if (p.from === conn) askForBlob(h)
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
      if (addMessages(msg.msgs)) emitHistory()
    } else if (msg.type === 'msg') {
      if (addMessages([msg.msg])) {
        const v = view(history.find(h => h.id === msg.msg.id))
        if (v) emit('message', v)
        forward(conn, { type: 'msg', msg: msg.msg })
      }
    } else if (msg.type === 'want') {
      serveBlob(conn, msg.h)
    } else if (msg.type === 'blob') {
      onBlobChunk(conn, msg)
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
      emitHistory()
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
    emitHistory()
    announceKey()

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
    for (const h of [...pending.keys()]) finishFetch(h, false)
    if (swarm) {
      const s = swarm
      swarm = null
      try { await s.destroy() } catch {}
    }
  }

  // ---- Direct messages: per-device keypair, every DM boxed for each device of both people.
  function getIdentity () {
    if (identity) return identity
    const saved = readJSON('identity.json')
    if (saved && isHex(saved.pk, 64) && isHex(saved.sk, 64)) {
      identity = { pk: b4a.from(saved.pk, 'hex'), sk: b4a.from(saved.sk, 'hex') }
    } else {
      identity = { pk: b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES), sk: b4a.alloc(sodium.crypto_box_SECRETKEYBYTES) }
      sodium.crypto_box_keypair(identity.pk, identity.sk)
      writeJSON('identity.json', { pk: b4a.toString(identity.pk, 'hex'), sk: b4a.toString(identity.sk, 'hex') })
    }
    return identity
  }
  const myPk = () => b4a.toString(getIdentity().pk, 'hex')

  function keysOf (name) {
    const out = new Set()
    for (const m of history) if (m.kind === 'key' && m.name === name) out.add(m.pk)
    return out
  }

  // What the UI gets: DMs decrypted (or dropped if they aren't ours), everything else as is.
  function view (m) {
    if (!m || m.kind !== 'dm') return m
    const box = m.boxes[myPk()]
    if (!box) return null
    try {
      const c = b4a.from(box.c, 'base64')
      if (c.length < sodium.crypto_box_MACBYTES) return null
      const out = b4a.alloc(c.length - sodium.crypto_box_MACBYTES)
      if (!sodium.crypto_box_open_easy(out, c, b4a.from(box.n, 'hex'), b4a.from(m.from, 'hex'), getIdentity().sk)) return null
      const peer = m.name === me.name ? m.toName : m.name
      let text = b4a.toString(out)
      let files, edit, del
      if (text.startsWith('{"yap":1')) {
        try {
          const o = JSON.parse(text)
          text = String(o.t || '')
          files = o.f ? cleanFiles(o.f) : undefined
          if (isId(o.edit)) edit = o.edit
          if (isId(o.del)) del = o.del
        } catch {}
      }
      const v = { id: m.id, name: m.name, ts: m.ts, kind: 'dm', peer, text }
      if (files) v.files = files
      if (edit) v.edit = edit
      if (del) v.del = del
      return v
    } catch { return null }
  }
  const views = list => list.map(view).filter(Boolean)
  const emitHistory = () => emit('history', views(history))

  // extra = { edit: id } or { del: id } to change one of your earlier DMs.
  function sendDm (toName, text, files, extra) {
    text = String(text || '').slice(0, MAX_TEXT)
    toName = String(toName).slice(0, 40)
    files = files ? cleanFiles(files) : null
    const edit = extra && isId(extra.edit) ? extra.edit : null
    const del = extra && isId(extra.del) ? extra.del : null
    if (!me || (!text.trim() && !files && !del) || !toName) return null
    const theirs = keysOf(toName)
    if (!theirs.size) return { error: toName + ' needs to update YapApp before you can send them direct messages.' }
    const pks = new Set([...theirs, ...keysOf(me.name), myPk()])
    if (pks.size > MAX_BOXES) return { error: 'Too many devices to send to.' }
    const payload = { yap: 1, t: text }
    if (files) payload.f = files
    if (edit) payload.edit = edit
    if (del) payload.del = del
    const msg = b4a.from(files || edit || del ? JSON.stringify(payload) : text)
    const boxes = {}
    for (const pk of pks) {
      const n = randomBytes(sodium.crypto_box_NONCEBYTES)
      const c = b4a.alloc(msg.length + sodium.crypto_box_MACBYTES)
      sodium.crypto_box_easy(c, msg, n, b4a.from(pk, 'hex'), getIdentity().sk)
      boxes[pk] = { n: b4a.toString(n, 'hex'), c: b4a.toString(c, 'base64') }
    }
    const m = publish({ id: newId(), name: me.name, text: '', ts: Date.now(), kind: 'dm', toName, from: myPk(), boxes })
    return view(m)
  }

  // ---- Files: encrypted blobs in <dataDir>/blobs/<sha256>, fetched from peers on demand.
  const blobPath = h => file('blobs') + '/' + h
  const hasBlob = h => { try { fs.statSync(blobPath(h)); return true } catch { return false } }
  const pending = new Map() // hash -> { chunks, got, total, from, waiters, timer }

  function addFile (bytes, name, mime, relPath) {
    const data = typeof bytes === 'string' ? b4a.from(bytes, 'base64') : b4a.from(bytes)
    if (data.length > MAX_FILE) return { error: `"${name}" is too big (max ${MAX_FILE / 1024 / 1024} MB).` }
    const key = randomBytes(sodium.crypto_secretbox_KEYBYTES)
    const nonce = randomBytes(sodium.crypto_secretbox_NONCEBYTES)
    const ct = b4a.alloc(data.length + sodium.crypto_secretbox_MACBYTES)
    sodium.crypto_secretbox_easy(ct, data, nonce, key)
    const blob = b4a.concat([nonce, ct])
    const h = b4a.toString(sha256(blob), 'hex')
    try { fs.mkdirSync(file('blobs'), { recursive: true }) } catch {}
    fs.writeFileSync(blobPath(h), blob)
    const ref = { h, k: b4a.toString(key, 'hex'), n: String(name || 'file').slice(0, 200), s: data.length,
      m: String(mime || 'application/octet-stream').slice(0, 100) }
    if (relPath) ref.p = String(relPath).slice(0, 500)
    return ref
  }

  // Decrypted bytes of an attachment, downloading the blob first if needed (null if unavailable).
  async function getFile (ref) {
    if (!ref || !isHex(ref.h, 64) || !isHex(ref.k, 64)) return null
    if (!hasBlob(ref.h) && !(await fetchBlob(ref.h))) return null
    try {
      const blob = fs.readFileSync(blobPath(ref.h))
      const nb = sodium.crypto_secretbox_NONCEBYTES
      const ct = blob.subarray(nb)
      const out = b4a.alloc(ct.length - sodium.crypto_secretbox_MACBYTES)
      if (!sodium.crypto_secretbox_open_easy(out, ct, blob.subarray(0, nb), b4a.from(ref.k, 'hex'))) return null
      return out
    } catch { return null }
  }

  function fetchBlob (h) {
    if (hasBlob(h)) return Promise.resolve(true)
    let p = pending.get(h)
    if (!p) {
      p = { chunks: [], got: 0, total: -1, from: null, waiters: [], timer: null }
      pending.set(h, p)
      askForBlob(h)
    }
    return new Promise(resolve => p.waiters.push(resolve))
  }
  function finishFetch (h, ok) {
    const p = pending.get(h)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(h)
    for (const w of p.waiters) w(ok)
  }
  function armTimeout (h) {
    const p = pending.get(h)
    clearTimeout(p.timer)
    p.timer = setTimeout(() => finishFetch(h, false), WANT_TIMEOUT)
  }
  function askForBlob (h, only) {
    const p = pending.get(h)
    p.chunks = []; p.got = 0; p.total = -1; p.from = null
    armTimeout(h)
    for (const conn of only ? [only] : peers.keys()) write(conn, { type: 'want', h })
  }
  function serveBlob (conn, h) {
    if (!isHex(h, 64) || !hasBlob(h)) return
    let blob
    try { blob = fs.readFileSync(blobPath(h)) } catch { return }
    const n = Math.max(1, Math.ceil(blob.length / CHUNK))
    for (let i = 0; i < n; i++) {
      write(conn, { type: 'blob', h, i, n, d: b4a.toString(blob.subarray(i * CHUNK, (i + 1) * CHUNK), 'base64') })
    }
  }
  function onBlobChunk (conn, msg) {
    const p = pending.get(msg.h)
    if (!p || typeof msg.d !== 'string' || !Number.isInteger(msg.i) || !Number.isInteger(msg.n)) return
    if (p.from && p.from !== conn) return // first peer to answer serves the whole file
    const maxN = Math.ceil((MAX_FILE + 64) / CHUNK) + 1
    if (msg.n < 1 || msg.n > maxN || msg.i < 0 || msg.i >= msg.n || (p.total !== -1 && p.total !== msg.n)) return
    p.from = conn
    p.total = msg.n
    if (!p.chunks[msg.i]) { p.chunks[msg.i] = b4a.from(msg.d, 'base64'); p.got++ }
    armTimeout(msg.h)
    emit('file-progress', { h: msg.h, got: p.got, total: p.total })
    if (p.got < p.total) return
    const blob = b4a.concat(p.chunks)
    if (b4a.toString(sha256(blob), 'hex') !== msg.h) { askForBlob(msg.h); return } // corrupt: ask everyone again
    try { fs.mkdirSync(file('blobs'), { recursive: true }) } catch {}
    try { fs.writeFileSync(blobPath(msg.h), blob) } catch { finishFetch(msg.h, false); return }
    finishFetch(msg.h, true)
  }

  // Announce this device's key in the room once (as a history entry, so it syncs to everyone).
  function announceKey () {
    const pk = myPk()
    if (history.some(m => m.kind === 'key' && m.name === me.name && m.pk === pk)) return
    publish({ id: newId(), name: me.name, text: '', ts: Date.now(), kind: 'key', pk })
  }

  function publish (m) {
    addMessages([m])
    for (const conn of peers.keys()) write(conn, { type: 'msg', msg: m })
    return m
  }
  const newId = () => b4a.toString(randomBytes(16), 'hex')

  // extra.parent = reply in that message's thread.
  function send (text, extra) {
    text = String(text || '').slice(0, MAX_TEXT)
    const files = extra && extra.files ? cleanFiles(extra.files) : null
    if (!me || (!text.trim() && !files)) return null
    const m = { id: newId(), name: me.name, text, ts: Date.now() }
    if (files) m.files = files
    if (extra && isId(extra.parent)) m.parent = extra.parent
    if (extra && isId(extra.ch) && extra.ch !== 'general') m.ch = extra.ch
    return publish(m)
  }

  // Edit / delete one of your own channel messages (others ignore it if it isn't yours).
  function editMessage (target, text) {
    text = String(text || '').slice(0, MAX_TEXT)
    if (!me || !isId(target) || !text.trim()) return null
    return publish({ id: newId(), name: me.name, ts: Date.now(), kind: 'edit', target, text })
  }
  function deleteMessage (target) {
    if (!me || !isId(target)) return null
    const m = publish({ id: newId(), name: me.name, ts: Date.now(), kind: 'del', target, text: '' })
    saveHistory()
    return m
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

  // Pictures: pic = a file ref from addFile (an image) or null to remove.
  // info (profile only) = { title, pronouns, email, phone, location, about } - the whole profile each time.
  function setPicture (kind, pic, info) {
    if (!me || (kind !== 'profile' && kind !== 'roompic')) return null
    const ref = pic ? (cleanFiles([pic]) || [])[0] : null
    if (pic && !ref) return null
    const m = { id: newId(), name: me.name, text: '', ts: Date.now(), kind, pic: ref }
    if (kind === 'profile') { const i = cleanInfo(info); if (!i) return null; m.info = i }
    return publish(m)
  }

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
      else s[k] = String(changes[k]).slice(0, k === 'rooms' ? 40000 : k === 'profile' ? 4000 : 1000)
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

  return { join, leave, send, sendDm, editMessage, deleteMessage, addFile, getFile, setPicture, react, setChannel, createChannel, renameRoom, createInvite: makeInvite, checkInvite, getSettings, setSettings, debugInfo }
}

module.exports = { createCore, parseInvite, makeInvite, hmacSha256, hkdf32 }
