const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chat', {
  join: (name, room) => ipcRenderer.invoke('join', name, room),
  leave: () => ipcRenderer.invoke('leave'),
  send: text => ipcRenderer.invoke('send', text),
  version: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: changes => ipcRenderer.invoke('settings:set', changes),
  on: (channel, fn) => {
    if (['message', 'history', 'peers', 'system', 'update-ready'].includes(channel)) {
      ipcRenderer.on(channel, (e, data) => fn(data))
    }
  }
})
