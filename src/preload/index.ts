import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CorkboardApi } from '@shared/api'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CorkboardApi = {
  config: {
    get: () => invoke('config:get'),
    pickRoot: () => invoke('config:pickRoot'),
  },
  boards: {
    tree: () => invoke('boards:tree'),
    load: path => invoke('boards:load', path),
    create: (parent, title, key) => invoke('boards:create', parent, title, key),
    updateMeta: (path, patch) => invoke('boards:updateMeta', path, patch),
    remove: path => invoke('boards:remove', path),
    index: () => invoke('boards:index'),
  },
  cards: {
    create: (boardPath, fields) => invoke('cards:create', boardPath, fields),
    update: (boardPath, id, patch) => invoke('cards:update', boardPath, id, patch),
    filePath: (boardPath, id) => invoke('cards:filePath', boardPath, id),
  },
  map: {
    save: (boardPath, map) => invoke('map:save', boardPath, map),
  },
  git: {
    cardCommits: boardPath => invoke('git:cardCommits', boardPath),
    commitFiles: (boardPath, sha) => invoke('git:commitFiles', boardPath, sha),
    commitBoardNow: () => invoke('git:commitBoardNow'),
  },
  pty: {
    create: opts => invoke('pty:create', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: id => ipcRenderer.send('pty:kill', id),
    list: () => invoke('pty:list'),
  },
  tackle: {
    start: req => invoke('tackle:start', req),
    resume: (boardPath, ref) => invoke('tackle:resume', boardPath, ref),
  },
  shell: {
    openExternal: url => ipcRenderer.send('shell:openExternal', url),
    openPath: path => ipcRenderer.send('shell:openPath', path),
  },
  on: {
    delta: cb => subscribe('board:delta', cb),
    treeChanged: cb => subscribe('boards:treeChanged', cb),
    boardCommitted: cb => subscribe('git:boardCommitted', cb),
    ptyCreated: cb => subscribe('pty:created', cb),
    ptyData: cb => subscribe('pty:data', cb),
    ptyExit: cb => subscribe('pty:exit', cb),
  },
}

contextBridge.exposeInMainWorld('corkboard', api)
