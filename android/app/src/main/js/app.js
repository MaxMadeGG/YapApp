// Bare Kit worklet entry for the Android app.
// Bridges the WebView UI (via the Java host and BareKit.IPC) to core.js.
// Protocol, one JSON object per line:
//   host -> here:  { id, method, args }
//   here -> host:  { id, result } | { id, error } | { event, data }
// Besides the UI's events we emit 'status' { name, room, peers } so the Java
// service can show the connection notification and message notifications.
const fs = require('bare-fs')
const b4a = require('b4a')
const { createCore } = require('./core.js')

const IPC = BareKit.IPC
const dataDir = Bare.argv[Bare.argv.length - 1] // app's private files dir, passed by the service

const send = obj => IPC.write(b4a.from(JSON.stringify(obj) + '\n'))

const status = { name: null, room: null, peers: 0 }
const sendStatus = () => send({ event: 'status', data: status })

const core = createCore({
  fs,
  dataDir,
  emit: (event, data) => {
    send({ event, data })
    if (event === 'peers') { status.peers = data.length; sendStatus() }
    if (event === 'room') { status.room = data.room; sendStatus() }
  }
})

const methods = {
  join: async (name, invite) => {
    const res = await core.join(name, invite)
    if (res.ok) { status.name = String(name).slice(0, 40); status.room = res.room; sendStatus() }
    return res
  },
  leave: async () => {
    await core.leave()
    Object.assign(status, { name: null, room: null, peers: 0 })
    sendStatus()
  },
  send: (text, extra) => core.send(text, extra),
  sendDm: (toName, text, files, extra) => core.sendDm(toName, text, files, extra),
  editMessage: (target, text) => core.editMessage(target, text),
  renameMe: (from, to) => core.renameMe(from, to),
  deleteMessage: target => core.deleteMessage(target),
  // Files picked by the Java side are copied into <dataDir>/import first (no big strings over IPC).
  addFileFromPath: (p, name, mime, relPath) => {
    if (!String(p).startsWith(dataDir + '/import/')) throw new Error('bad path')
    const data = fs.readFileSync(p)
    try { fs.unlinkSync(p) } catch {}
    return core.addFile(data, name, mime, relPath)
  },
  addFileB64: (b64, name, mime, relPath) => core.addFile(b64, name, mime, relPath), // small things (pictures)
  setPicture: (kind, pic, info) => core.setPicture(kind, pic, info),
  getFile: async ref => {
    const b = await core.getFile(ref)
    return b ? b4a.toString(b, 'base64') : null
  },
  // Decrypt to <dataDir>/export/<hash> so Java can copy it into Downloads.
  exportFile: async ref => {
    const b = await core.getFile(ref)
    if (!b) return null
    const dir = dataDir + '/export'
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    const p = dir + '/' + ref.h
    fs.writeFileSync(p, b)
    return p
  },
  react: (target, emoji, on) => core.react(target, emoji, on),
  setChannel: (target, name, deleted) => core.setChannel(target, name, deleted),
  createChannel: name => core.createChannel(name),
  renameRoom: name => core.renameRoom(name),
  createInvite: name => core.createInvite(name),
  checkInvite: code => core.checkInvite(code),
  getSettings: () => core.getSettings(),
  setSettings: changes => core.setSettings(changes),
  getStatus: () => status,
  debug: () => core.debugInfo()
}

let buf = b4a.alloc(0)
IPC.on('data', async chunk => {
  buf = buf.length ? b4a.concat([buf, chunk]) : chunk
  let i
  while ((i = b4a.indexOf(buf, 10)) >= 0) {
    const line = b4a.toString(buf.subarray(0, i))
    buf = buf.subarray(i + 1)
    let req
    try { req = JSON.parse(line) } catch { continue }
    const fn = methods[req.method]
    try {
      if (!fn) throw new Error('unknown method ' + req.method)
      const result = await fn(...(req.args || []))
      send({ id: req.id, result: result === undefined ? null : result })
    } catch (err) {
      send({ id: req.id, error: String(err && err.message || err) })
    }
  }
})

Bare.on('uncaughtException', err => { send({ event: 'system', data: 'Error: ' + (err && err.message) }) })
Bare.on('unhandledRejection', err => { send({ event: 'system', data: 'Error: ' + (err && err.message) }) })
