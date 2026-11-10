// Bare Kit worklet entry for the Android app.
// Bridges the WebView UI (via the Java host and BareKit.IPC) to core.js.
// Protocol, one JSON object per line:
//   host -> here:  { id, method, args }
//   here -> host:  { id, result } | { id, error } | { event, data }
const fs = require('bare-fs')
const b4a = require('b4a')
const { createCore } = require('./core.js')

const IPC = BareKit.IPC
const dataDir = Bare.argv[Bare.argv.length - 1] // app's private files dir, passed by MainActivity

const send = obj => IPC.write(b4a.from(JSON.stringify(obj) + '\n'))
const core = createCore({ fs, dataDir, emit: (event, data) => send({ event, data }) })

const methods = {
  join: (name, invite) => core.join(name, invite),
  leave: () => core.leave(),
  send: text => core.send(text),
  renameRoom: name => core.renameRoom(name),
  createInvite: name => core.createInvite(name),
  checkInvite: code => core.checkInvite(code),
  getSettings: () => core.getSettings(),
  setSettings: changes => core.setSettings(changes)
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
