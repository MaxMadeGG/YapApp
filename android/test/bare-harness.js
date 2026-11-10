// Runs the Android worklet (app/src/main/js/app.js) under Bare on the desktop,
// with a fake BareKit.IPC. Usage: bare test/bare-harness.js <invite> <dataDir>
const b4a = require('b4a')
const invite = Bare.argv[Bare.argv.length - 2]
const handlers = []
let pending = new Map(), nextId = 1, out = b4a.alloc(0)
const log = (...a) => console.log('[harness]', ...a)
globalThis.BareKit = {
  IPC: {
    on (ev, fn) { if (ev === 'data') handlers.push(fn) },
    write (chunk) {
      out = b4a.concat([out, chunk]); let i
      while ((i = b4a.indexOf(out, 10)) >= 0) {
        const msg = JSON.parse(b4a.toString(out.subarray(0, i))); out = out.subarray(i + 1)
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
        else log('event', msg.event, JSON.stringify(msg.data).slice(0, 120))
      }
    }
  }
}
const call = (method, ...args) => new Promise(resolve => {
  const id = nextId++; pending.set(id, resolve)
  handlers.forEach(h => h(b4a.from(JSON.stringify({ id, method, args }) + '\n')))
})
require('../app/src/main/js/app.js')
;(async () => {
  log('createInvite ->', (await call('createInvite', 'Phone room')).result.slice(0, 12) + '…')
  log('checkInvite  ->', (await call('checkInvite', invite)).result)
  await call('setSettings', { name: 'Phone', invite })
  log('getSettings  ->', JSON.stringify((await call('getSettings')).result))
  log('join         ->', JSON.stringify((await call('join', 'Phone', invite)).result).slice(0, 80))
  setTimeout(async () => { log('send         ->', (await call('send', 'hello from Bare 📱')).result.text) }, 15000)
  setTimeout(async () => { await call('leave'); log('done'); Bare.exit(0) }, 30000)
})()
