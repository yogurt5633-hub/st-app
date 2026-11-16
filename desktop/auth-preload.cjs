const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('auth', {
  submit: (username, password) => ipcRenderer.send('auth-response', {username, password}),
  cancel: () => ipcRenderer.send('auth-response', null),
  host: callback => ipcRenderer.on('auth-host', (_event, host) => callback(host)),
});
