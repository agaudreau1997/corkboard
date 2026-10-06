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
    setCodeRepo: (boardPath, repo) => invoke('config:setCodeRepo', boardPath, repo),
    pickFolder: title => invoke('config:pickFolder', title),
    pickFile: title => invoke('config:pickFile', title),
    setNotify: notify => invoke('config:setNotify', notify),
    tryNotify: command => invoke('config:tryNotify', command),
  },
  projects: {
    list: () => invoke('projects:list'),
    add: opts => invoke('projects:add', opts),
    update: (id, patch) => invoke('projects:update', id, patch),
    setTheme: (id, theme) => invoke('projects:setTheme', id, theme),
    addGuide: id => invoke('projects:addGuide', id),
    remove: id => invoke('projects:remove', id),
    pickFolder: title => invoke('projects:pickFolder', title),
  },
  boards: {
    load: path => invoke('boards:load', path),
    create: (parent, title, key) => invoke('boards:create', parent, title, key),
    updateMeta: (path, patch) => invoke('boards:updateMeta', path, patch),
    remove: (path, force) => invoke('boards:remove', path, force),
    moveToProject: (path, projectId) => invoke('boards:moveToProject', path, projectId),
    index: () => invoke('boards:index'),
  },
  cards: {
    create: (boardPath, fields) => invoke('cards:create', boardPath, fields),
    update: (boardPath, id, patch) => invoke('cards:update', boardPath, id, patch),
    updateMany: (boardPath, patches) => invoke('cards:updateMany', boardPath, patches),
    move: (fromPath, id, toPath, list, pos) => invoke('cards:move', fromPath, id, toPath, list, pos),
    duplicate: (boardPath, id) => invoke('cards:duplicate', boardPath, id),
    filePath: (boardPath, id) => invoke('cards:filePath', boardPath, id),
  },
  lists: {
    move: (fromPath, listId, toPath) => invoke('lists:move', fromPath, listId, toPath),
  },
  sync: {
    now: projectId => invoke('sync:now', projectId),
  },
  claude: {
    info: () => invoke('claude:info'),
    update: boardPath => invoke('claude:update', boardPath),
    desktopAvailable: () => invoke('claude:desktopAvailable'),
  },
  updates: {
    status: () => invoke('updates:status'),
    check: () => invoke('updates:check'),
    install: () => invoke('updates:install'),
  },
  clipboard: {
    write: text => ipcRenderer.send('clipboard:write', text),
    read: () => invoke('clipboard:read'),
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
    running: id => invoke('pty:running', id),
  },
  tackle: {
    start: req => invoke('tackle:start', req),
    prompt: req => invoke('tackle:prompt', req),
    resume: (boardPath, ref) => invoke('tackle:resume', boardPath, ref),
    openInDesktop: ref => invoke('tackle:openInDesktop', ref),
  },
  shell: {
    openExternal: url => ipcRenderer.send('shell:openExternal', url),
    openPath: path => ipcRenderer.send('shell:openPath', path),
  },
  on: {
    delta: cb => subscribe('board:delta', cb),
    treeChanged: cb => subscribe('boards:treeChanged', cb),
    boardCommitted: cb => subscribe('git:boardCommitted', cb),
    syncStatus: cb => subscribe('sync:status', cb),
    ptyCreated: cb => subscribe('pty:created', cb),
    ptyData: cb => subscribe('pty:data', cb),
    ptyExit: cb => subscribe('pty:exit', cb),
    ptyStatus: cb => subscribe('pty:status', cb),
    updateStatus: cb => subscribe('updates:changed', cb),
  },
}

contextBridge.exposeInMainWorld('corkboard', api)
