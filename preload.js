const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chat', {
  join: (name, invite) => ipcRenderer.invoke('join', name, invite),
  copy: text => ipcRenderer.invoke('clipboard:write', text),
  renameRoom: name => ipcRenderer.invoke('room:rename', name),
  createInvite: roomName => ipcRenderer.invoke('invite:create', roomName),
  checkInvite: code => ipcRenderer.invoke('invite:check', code),
  leave: () => ipcRenderer.invoke('leave'),
  send: (text, extra) => ipcRenderer.invoke('send', text, extra),
  sendDm: (toName, text, files, extra) => ipcRenderer.invoke('dm', toName, text, files, extra),
  editMessage: (target, text) => ipcRenderer.invoke('msg:edit', target, text),
  deleteMessage: target => ipcRenderer.invoke('msg:delete', target),
  addFile: (bytes, name, mime, relPath) => ipcRenderer.invoke('file:add', bytes, name, mime, relPath),
  getFile: ref => ipcRenderer.invoke('file:get', ref),
  setPicture: (kind, pic, info) => ipcRenderer.invoke('picture:set', kind, pic, info),
  saveFiles: (refs, folder) => ipcRenderer.invoke('file:save', refs, folder),
  react: (target, emoji, on) => ipcRenderer.invoke('react', target, emoji, on),
  setChannel: (target, name, deleted) => ipcRenderer.invoke('channel:set', target, name, deleted),
  createChannel: name => ipcRenderer.invoke('channel:create', name),
  version: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: changes => ipcRenderer.invoke('settings:set', changes),
  on: (channel, fn) => {
    if (['message', 'history', 'peers', 'system', 'update-ready', 'room', 'file-progress'].includes(channel)) {
      ipcRenderer.on(channel, (e, data) => fn(data))
    }
  }
})
