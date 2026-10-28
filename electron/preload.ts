import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EnhancerApi, JobProgress } from '../shared/types';

function subscribe(channel: string, cb: (p: JobProgress) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, p: JobProgress) => cb(p);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: EnhancerApi = {
  tools: () => ipcRenderer.invoke('tools'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  analyze: (path) => ipcRenderer.invoke('analyze', path),
  enqueue: (path, options, outDir, segments) => ipcRenderer.invoke('job:enqueue', path, options, outDir, segments),
  cancel: (id) => ipcRenderer.invoke('job:cancel', id),
  preview: (req) => ipcRenderer.invoke('preview', req),
  cancelPreview: () => ipcRenderer.invoke('preview:cancel'),
  detectScenes: (req) => ipcRenderer.invoke('scenes', req),
  proxy: (path) => ipcRenderer.invoke('proxy', path),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  mediaUrl: (path) => `media://file/?p=${encodeURIComponent(path)}&t=${Date.now()}`,
  showInFolder: (path) => ipcRenderer.invoke('shell:showItem', path),
  onProgress: (cb) => subscribe('job:progress', cb),
  onPreviewProgress: (cb) => subscribe('preview:progress', cb),
};

contextBridge.exposeInMainWorld('enhancer', api);
