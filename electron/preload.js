const { contextBridge, ipcRenderer } = require('electron')

/**
 * Exposes a narrow, typed API to the React renderer process.
 * No direct Node/Electron APIs are exposed — everything goes through
 * explicit named handlers registered in main.js.
 *
 * DELIBERATELY NO FILE OR SHELL ACCESS. openPath/readFile/fileExists used to
 * live here and took an unvalidated path, so between them the renderer could
 * read any file and ask the OS to execute any program. See the note in
 * main.js. File work belongs to the backend, which only accepts paths already
 * recorded in the open project.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // File dialogs
  openFiles: (options) => ipcRenderer.invoke('dialog:open-files', options),
  openDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options),

  // App info
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getUserDataPath: () => ipcRenderer.invoke('app:get-user-data-path'),
  getBackendPort: () => ipcRenderer.invoke('backend:get-port'),

  // Event listeners (backend push events via main process relay)
  onJobProgress: (callback) => {
    ipcRenderer.on('job:progress', (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('job:progress')
  },
  onJobComplete: (callback) => {
    ipcRenderer.on('job:complete', (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('job:complete')
  },
  onBackendReady: (callback) => {
    ipcRenderer.on('backend:ready', (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('backend:ready')
  }
})
