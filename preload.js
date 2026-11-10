const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chat', {
  join: (name, room) => ipcRenderer.invoke('join', name, room),
  leave: () => ipcRenderer.invoke('leave'),
  send: text => ipcRenderer.invoke('send', text),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: changes => ipcRenderer.invoke('settings:set', changes),
  on: (channel, fn) => {
    if (['message', 'history', 'peers', 'system'].includes(channel)) {
      ipcRenderer.on(channel, (e, data) => fn(data))
    }
  }
})
