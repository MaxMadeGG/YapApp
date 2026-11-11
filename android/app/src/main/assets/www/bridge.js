// Android stand-in for the Electron preload: defines window.chat (the API the
// shared index.html uses) on top of the native YapNative bridge + Bare worklet.
;(function () {
  const pending = new Map()
  const listeners = {}
  let nextId = 1

  function call (method, ...args) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      window.YapNative.post(JSON.stringify({ id, method, args }))
    })
  }

  // Called by MainActivity with one JSON line from the worklet.
  window.__yapRecv = function (line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if ('error' in msg) p.reject(new Error(msg.error))
      else p.resolve(msg.result)
    } else if (msg.event) {
      for (const fn of listeners[msg.event] || []) fn(msg.data)
    }
  }

  window.chat = {
    join: (name, invite) => call('join', name, invite),
    leave: () => call('leave'),
    send: (text, extra) => call('send', text, extra),
    react: (target, emoji, on) => call('react', target, emoji, on),
    renameRoom: name => call('renameRoom', name),
    createInvite: name => call('createInvite', name),
    checkInvite: code => call('checkInvite', code),
    getSettings: () => call('getSettings'),
    setSettings: changes => call('setSettings', changes),
    copy: text => Promise.resolve(window.YapNative.copy(String(text))),
    version: () => Promise.resolve(window.YapNative.version()),
    installUpdate: () => window.YapNative.installUpdate(), // system installer asks to confirm
    on: (channel, fn) => { (listeners[channel] = listeners[channel] || []).push(fn) }
  }
})()
