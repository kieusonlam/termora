const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r.ok) return r.data;
  // Lỗi reject qua contextBridge chỉ còn message (mất code, filePath), nên trả về dạng { __err };
  // ui.js ném lại thành Error đầy đủ.
  return { __err: { message: r.error, code: r.code, filePath: r.filePath } };
}

const on = (channel) => (cb) => {
  const l = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, l);
  return () => ipcRenderer.removeListener(channel, l);
};

contextBridge.exposeInMainWorld('bridge', {
  sessions: {
    list: () => call('sessions:list'),
    save: (s) => call('sessions:save', s),
    remove: (id) => call('sessions:delete', id),
    duplicate: (id) => call('sessions:duplicate', id),
    renameGroup: (a, b) => call('sessions:renameGroup', a, b),
  },
  settings: {
    get: () => call('settings:get'),
    set: (p) => call('settings:set', p),
  },
  sync: {
    status: () => call('sync:status'),
    pickDir: () => call('sync:pickDir'),
    setup: (dir, pass) => call('sync:setup', dir, pass),
    now: () => call('sync:now'),
    stop: () => call('sync:stop'),
  },
  update: {
    status: () => call('update:status'),
    check: () => call('update:check'),
    install: () => call('update:install'),
  },
  keys: {
    list: () => call('keys:list'),
    generate: (o) => call('keys:generate', o),
    importFile: (o) => call('keys:importFile', o),
    importText: (o) => call('keys:importText', o),
    rename: (id, n) => call('keys:rename', id, n),
    remove: (id) => call('keys:delete', id),
    exportPrivate: (id) => call('keys:exportPrivate', id),
  },
  ssh: {
    connect: (tabId, o) => call('ssh:connect', tabId, o),
    write: (tabId, d) => ipcRenderer.send('ssh:write', tabId, d),
    resize: (tabId, c, r) => ipcRenderer.send('ssh:resize', tabId, c, r),
    close: (tabId) => call('ssh:close', tabId),
    cwd: (tabId) => call('ssh:cwd', tabId),
    installKey: (tabId, keyId) => call('ssh:installKey', tabId, keyId),
    monitor: (tabId, on) => call('ssh:monitor', tabId, on),
  },
  sftp: {
    home: (t) => call('sftp:home', t),
    list: (t, p) => call('sftp:list', t, p),
    mkdir: (t, p) => call('sftp:mkdir', t, p),
    newFile: (t, p) => call('sftp:newFile', t, p),
    rename: (t, a, b) => call('sftp:rename', t, a, b),
    chmod: (t, p, m) => call('sftp:chmod', t, p, m),
    remove: (t, ps) => call('sftp:remove', t, ps),
    upload: (t, ls, dir) => call('sftp:upload', t, ls, dir),
    uploadDialog: (t, dir, folders) => call('sftp:uploadDialog', t, dir, folders),
    download: (t, ps) => call('sftp:download', t, ps),
    edit: (t, p) => call('sftp:edit', t, p),
    readText: (t, p) => call('sftp:readText', t, p),
  },
  io: {
    exportTo: (o) => call('io:export', o),
    pickImport: (preset) => call('io:pickImport', preset),
    importFile: (f, pass) => call('io:import', f, pass),
  },
  util: {
    clipboardRead: () => call('util:clipboardRead'),
    clipboardWrite: (t) => call('util:clipboardWrite', t),
    openExternal: (u) => call('util:openExternal', u),
    showItem: (p) => call('util:showItem', p),
    openPath: (p) => call('util:openPath', p),
    version: () => call('util:version'),
    pathForFile: (f) => webUtils.getPathForFile(f),
  },
  reply: (reqId, answer) => ipcRenderer.send('ask:reply', reqId, answer),
  on: {
    data: on('ssh:data'),
    status: on('ssh:status'),
    sftpStatus: on('sftp:status'),
    monitor: on('ssh:monitor'),
    transfer: on('transfer'),
    toast: on('toast'),
    ask: on('ask'),
    sync: on('sync'),
    update: on('update'),
  },
});
