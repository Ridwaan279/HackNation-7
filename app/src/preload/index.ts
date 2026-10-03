import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ApprenticeApi } from './api'

const api: ApprenticeApi = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, cb) => {
    const listener = (_e: IpcRendererEvent, payload: any) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
}

contextBridge.exposeInMainWorld('apprentice', api)
