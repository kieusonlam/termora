const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Electron 44 dừng ngay (FATAL install_dir_access) nếu thư mục chứa exe có ACE cho một
// AppContainer cụ thể mà thiếu ALL APPLICATION PACKAGES. Bản portable giải nén vào %TEMP%,
// mà máy có app dạng MSIX (vd Claude) thì %TEMP% dính đúng kiểu ACL đó. Bước kiểm tra chạy
// sau code top-level của main.js, nên cấp quyền đọc ở đây là kịp.
if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    require('child_process').execFileSync('icacls', [path.dirname(process.execPath), '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/Q'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  } catch {}
}

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const { utils } = require('ssh2');
const { Store } = require('./store');
const { SshTab } = require('./ssh');
const { buildExport, detectAndParse, keyInfo } = require('./importexport');

let win = null;
let store = null;
const tabs = new Map(); // tabId -> SshTab
const pendingAsks = new Map(); // reqId -> resolve

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function ask(tabId) {
  return (kind, payload) =>
    new Promise((resolve) => {
      const reqId = crypto.randomBytes(6).toString('hex');
      pendingAsks.set(reqId, resolve);
      send('ask', { reqId, tabId, kind, payload });
    });
}

// Bọc handler để lỗi trả về gọn (message + code) thay vì chuỗi "Error invoking remote method…"
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e), code: e.code, filePath: e.filePath };
    }
  });
}

function getTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) throw new Error('Tab không còn kết nối');
  return t;
}

function createWindow() {
  const st = store.getSettings();
  const b = st.bounds || { width: 1400, height: 860 };
  win = new BrowserWindow({
    ...b,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0d1017',
    title: 'Termora',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1017', symbolColor: '#9aa4b2', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (st.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const patch = { maximized: win.isMaximized() };
    if (!win.isMaximized() && !win.isMinimized()) patch.bounds = win.getBounds();
    store.setSettings(patch);
  };
  win.on('close', saveBounds);

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  // Link trong terminal mở bằng trình duyệt ngoài
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Renderer reload (Ctrl+R / devtools) thì các tab cũ không còn ai giữ: đóng kết nối.
  win.webContents.on('did-start-loading', () => {
    for (const t of tabs.values()) t.close();
    tabs.clear();
  });
}

function registerIpc() {
  ipcMain.on('ask:reply', (_e, reqId, answer) => {
    const r = pendingAsks.get(reqId);
    if (r) { pendingAsks.delete(reqId); r(answer); }
  });

  // ---------- Sessions ----------
  handle('sessions:list', () => store.listSessions());
  handle('sessions:save', (s) => store.saveSession(s));
  handle('sessions:delete', (id) => store.deleteSession(id));
  handle('sessions:duplicate', (id) => store.duplicateSession(id));
  handle('sessions:renameGroup', (a, b) => store.renameGroup(a, b));

  // ---------- Settings ----------
  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => store.setSettings(patch));

  // ---------- Keys ----------
  handle('keys:list', () => store.listKeys());
  handle('keys:generate', ({ name, type, bits }) => {
    const opts = { comment: name || `termora@${os.hostname()}` };
    if (type === 'rsa') opts.bits = Number(bits) || 4096;
    if (type === 'ecdsa') opts.bits = 256;
    const pair = utils.generateKeyPairSync(type || 'ed25519', opts);
    const info = keyInfo(pair.private);
    return store.addKey({ name: name || info.type, privateKey: pair.private, passphrase: '', ...info });
  });
  handle('keys:importFile', async ({ passphrase, filePath } = {}) => {
    let p = filePath;
    if (!p) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Chọn private key',
        defaultPath: path.join(os.homedir(), '.ssh'),
        properties: ['openFile', 'showHiddenFiles'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      p = r.filePaths[0];
    }
    const priv = fs.readFileSync(p, 'utf8');
    let info;
    try {
      info = keyInfo(priv, passphrase);
    } catch (e) {
      if (/passphrase|encrypted|decrypt/i.test(e.message)) {
        throw Object.assign(new Error(passphrase ? 'Sai passphrase' : 'Key có passphrase'), { code: 'NEEDPASS', filePath: p });
      }
      throw e;
    }
    return store.addKey({ name: path.basename(p), privateKey: priv, passphrase: passphrase || '', ...info, filePath: p });
  });
  handle('keys:importText', ({ name, text, passphrase }) => {
    const info = keyInfo(text, passphrase);
    return store.addKey({ name: name || info.type, privateKey: text.trim() + '\n', passphrase: passphrase || '', ...info });
  });
  handle('keys:rename', (id, name) => store.renameKey(id, name));
  handle('keys:delete', (id) => store.deleteKey(id));
  handle('keys:exportPrivate', async (id) => {
    const k = store.listKeys().find((x) => x.id === id);
    const sec = store.getKeySecret(id);
    if (!k || !sec) throw new Error('Không tìm thấy key');
    const r = await dialog.showSaveDialog(win, { title: 'Lưu private key', defaultPath: k.name.replace(/[^\w.-]+/g, '_') });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, sec.privateKey, { mode: 0o600 });
    fs.writeFileSync(r.filePath + '.pub', k.publicKey + '\n');
    return r.filePath;
  });

  // ---------- SSH ----------
  handle('ssh:connect', async (tabId, { sessionId, adhoc, password, savePassword, cols, rows }) => {
    const old = tabs.get(tabId);
    if (old) { old.close(); tabs.delete(tabId); }
    let session;
    if (sessionId) {
      const s = store.getSession(sessionId);
      if (!s) throw new Error('Session không tồn tại');
      session = { ...s };
    } else {
      session = { authType: 'password', port: 22, ...adhoc };
    }
    let pw = password;
    if (pw == null && sessionId) pw = store.getSessionSecret(sessionId) || undefined;
    if (session.authType === 'password' && !pw) {
      throw Object.assign(new Error('Cần mật khẩu'), { code: 'NEEDPASS' });
    }
    const t = new SshTab({ tabId, session, send, ask: ask(tabId), store });
    tabs.set(tabId, t);
    try {
      await t.connect({ password: pw, cols, rows });
    } catch (e) {
      t.close();
      tabs.delete(tabId);
      throw e;
    }
    if (sessionId) {
      if (savePassword && password) store.setSessionPassword(sessionId, password);
      store.touchSession(sessionId);
    }
    return { host: session.host, username: session.username };
  });
  ipcMain.on('ssh:write', (_e, tabId, data) => tabs.get(tabId)?.write(data));
  ipcMain.on('ssh:resize', (_e, tabId, cols, rows) => tabs.get(tabId)?.resize(cols, rows));
  handle('ssh:close', (tabId) => {
    const t = tabs.get(tabId);
    if (t) { t.close(); tabs.delete(tabId); }
  });
  handle('ssh:cwd', (tabId) => getTab(tabId).getCwd());
  handle('ssh:installKey', async (tabId, keyId) => {
    const k = store.listKeys().find((x) => x.id === keyId);
    if (!k) throw new Error('Không tìm thấy key');
    await getTab(tabId).installPublicKey(k.publicKey);
  });
  handle('ssh:monitor', (tabId, on) => {
    const t = getTab(tabId);
    on ? t.startMonitor() : t.stopMonitor();
  });

  // ---------- SFTP ----------
  handle('sftp:home', (tabId) => getTab(tabId).home());
  handle('sftp:list', (tabId, dir) => getTab(tabId).list(dir));
  handle('sftp:mkdir', (tabId, p) => getTab(tabId).mkdir(p));
  handle('sftp:newFile', (tabId, p) => getTab(tabId).newFile(p));
  handle('sftp:rename', (tabId, a, b) => getTab(tabId).rename(a, b));
  handle('sftp:chmod', (tabId, p, mode) => getTab(tabId).chmod(p, mode));
  handle('sftp:remove', (tabId, paths) => getTab(tabId).remove(paths));
  handle('sftp:upload', (tabId, localPaths, remoteDir) => getTab(tabId).upload(localPaths, remoteDir));
  handle('sftp:uploadDialog', async (tabId, remoteDir, folders) => {
    const r = await dialog.showOpenDialog(win, {
      title: folders ? 'Chọn thư mục để upload' : 'Chọn file để upload',
      properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return getTab(tabId).upload(r.filePaths, remoteDir);
  });
  handle('sftp:download', async (tabId, remotePaths) => {
    const st = store.getSettings();
    const r = await dialog.showOpenDialog(win, {
      title: 'Lưu vào thư mục',
      defaultPath: st.lastDownloadDir || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    store.setSettings({ lastDownloadDir: r.filePaths[0] });
    return getTab(tabId).download(remotePaths, r.filePaths[0]);
  });
  handle('sftp:edit', (tabId, p) => getTab(tabId).editLocal(p, (f) => shell.openPath(f)));
  handle('sftp:readText', (tabId, p) => getTab(tabId).readText(p));

  // ---------- Import / export ----------
  handle('io:export', async ({ includeSecrets, includeKeys, passphrase }) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Export sessions',
      defaultPath: `termora-${new Date().toISOString().slice(0, 10)}.termora`,
      filters: [{ name: 'Termora export', extensions: ['termora', 'json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const raw = store.exportRaw({ includeSecrets, includeKeys });
    fs.writeFileSync(r.filePath, JSON.stringify(buildExport(raw, passphrase || null), null, 2), 'utf8');
    return { file: r.filePath, sessions: raw.sessions.length, keys: raw.keys.length };
  });
  handle('io:pickImport', async (preset) => {
    const docs = app.getPath('documents');
    const defaults = {
      bookmarks: docs,
      sshconfig: path.join(os.homedir(), '.ssh', 'config'),
    };
    if (preset === 'sshconfig' && fs.existsSync(defaults.sshconfig)) return defaults.sshconfig;
    const r = await dialog.showOpenDialog(win, {
      title: 'Chọn file để import',
      defaultPath: defaults[preset] || docs,
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'Hỗ trợ', extensions: ['termora', 'json', 'mxtsessions', 'ini', '*'] },
        { name: 'Tất cả', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
  handle('io:import', (filePath, passphrase) => {
    const buf = fs.readFileSync(filePath);
    // File .ini thường là ANSI; thử UTF-8 trước, có ký tự hỏng thì đọc latin1
    let text = buf.toString('utf8');
    if (text.includes('�')) text = buf.toString('latin1');
    text = text.replace(/^﻿/, '');
    const { kind, data } = detectAndParse(filePath, text, passphrase);
    const res = store.importRaw(data);
    return { kind, ...res, total: (data.sessions || []).length };
  });

  // ---------- Tiện ích ----------
  handle('util:clipboardRead', () => clipboard.readText());
  handle('util:clipboardWrite', (t) => clipboard.writeText(String(t)));
  handle('util:openExternal', (u) => /^https?:\/\//.test(u) && shell.openExternal(u));
  handle('util:showItem', (p) => shell.showItemInFolder(p));
  handle('util:openPath', (p) => shell.openPath(p));
  handle('util:version', () => app.getVersion());
}

// Bản portable lưu dữ liệu cạnh file .exe; TERMORA_USERDATA để chạy thử với dữ liệu riêng.
if (process.env.TERMORA_USERDATA) app.setPath('userData', process.env.TERMORA_USERDATA);
else if (process.env.PORTABLE_EXECUTABLE_DIR) app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'TermoraData'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    store = new Store();
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => {
    for (const t of tabs.values()) t.close();
    tabs.clear();
    try { fs.rmSync(path.join(os.tmpdir(), 'termora'), { recursive: true, force: true }); } catch {}
    app.quit();
  });
}
