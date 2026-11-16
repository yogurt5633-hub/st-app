const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('tavernka', {
  state: () => ipcRenderer.invoke('state'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  install: () => ipcRenderer.invoke('install'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  connect: url => ipcRenderer.invoke('connect', url),
  tab: name => ipcRenderer.invoke('tab', name),
  reload: () => ipcRenderer.invoke('reload'),
  setTheme: (theme, accent) => ipcRenderer.invoke('theme', theme, accent),
  dismissWhatsNew: () => ipcRenderer.invoke('dismiss-whats-new'),
  onState: callback => ipcRenderer.on('state', (_event, state) => callback(state)),
});

