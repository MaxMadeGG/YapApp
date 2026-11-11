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
    sendDm: (toName, text, files, extra) => call('sendDm', toName, text, files, extra),
    editMessage: (target, text) => call('editMessage', target, text),
    renameMe: (from, to) => call('renameMe', from, to),
    deleteMessage: target => call('deleteMessage', target),
    // src = { path } from pickFiles() (bytes never go through the WebView).
    addFile: (src, name, mime, relPath) => {
      if (src && src.path) return call('addFileFromPath', src.path, name, mime, relPath)
      let bin = '' // small byte arrays (resized pictures) go as base64
      for (let i = 0; i < src.length; i += 0x8000) bin += String.fromCharCode.apply(null, src.subarray(i, i + 0x8000))
      return call('addFileB64', btoa(bin), name, mime, relPath)
    },
    setPicture: (kind, pic, info) => call('setPicture', kind, pic, info),
    getFile: async ref => {
      const b64 = await call('getFile', ref)
      if (!b64) return null
      const bin = atob(b64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    },
    // Saved into Downloads/YapApp[/folder].
    saveFiles: async (refs, folder) => {
      let saved = 0
      for (const ref of refs) {
        const p = await call('exportFile', ref)
        if (!p) continue
        const rel = folder ? (ref.p || ref.n) : ref.n
        if (window.YapNative.saveToDownloads(p, rel, ref.m)) saved++
      }
      if (!saved) throw new Error('Could not download (is anyone who has it online?)')
      return saved
    },
    // Native picker; resolves to [{ path, name, mime, size }] (copied into the app's files).
    pickFiles: () => new Promise(resolve => {
      window.__yapPicked = list => { window.__yapPicked = null; resolve(list || []) }
      window.YapNative.pickFiles()
    }),
    react: (target, emoji, on) => call('react', target, emoji, on),
    setChannel: (target, name, deleted) => call('setChannel', target, name, deleted),
    createChannel: name => call('createChannel', name),
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
