const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chat', {
  join: (name, invite) => ipcRenderer.invoke('join', name, invite),
  copy: text => ipcRenderer.invoke('clipboard:write', text),
  renameRoom: name => ipcRenderer.invoke('room:rename', name),
  createInvite: roomName => ipcRenderer.invoke('invite:create', roomName),
  checkInvite: code => ipcRenderer.invoke('invite:check', code),
  leave: () => ipcRenderer.invoke('leave'),
  send: text => ipcRenderer.invoke('send', text),
  version: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: changes => ipcRenderer.invoke('settings:set', changes),
  on: (channel, fn) => {
    if (['message', 'history', 'peers', 'system', 'update-ready', 'room'].includes(channel)) {
      ipcRenderer.on(channel, (e, data) => fn(data))
    }
  }
})
