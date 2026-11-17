const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('tavernka', {
  state: () => ipcRenderer.invoke('state'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  install: () => ipcRenderer.invoke('install'),
  installTavern: () => ipcRenderer.invoke('install-tavern'),
  updateTavern: () => ipcRenderer.invoke('update-tavern'),
  updateKorrektor: () => ipcRenderer.invoke('update-korrektor'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installAppUpdate: () => ipcRenderer.invoke('install-app-update'),
  start: () => ipcRenderer.invoke('start'),
  restart: () => ipcRenderer.invoke('restart'),
  stop: () => ipcRenderer.invoke('stop'),
  connect: url => ipcRenderer.invoke('connect', url),
  tab: name => ipcRenderer.invoke('tab', name),
  openKorrektor: hash => ipcRenderer.invoke('open-korrektor', hash),
  openSite: index => ipcRenderer.invoke('open-site', index),
  setSites: sites => ipcRenderer.invoke('set-sites', sites),
  setFlag: (key, value) => ipcRenderer.invoke('set-flag', key, value),
  dashboard: () => ipcRenderer.invoke('dashboard'),
  reload: () => ipcRenderer.invoke('reload'),
  setTheme: (theme, accent) => ipcRenderer.invoke('theme', theme, accent),
  dismissWhatsNew: () => ipcRenderer.invoke('dismiss-whats-new'),
  onState: callback => ipcRenderer.on('state', (_event, state) => callback(state)),
});


