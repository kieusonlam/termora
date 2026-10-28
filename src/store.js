// Lưu trữ session / key / known hosts / settings trong userData/data.json.
// Mật khẩu, passphrase, private key được mã hoá bằng safeStorage (DPAPI trên Windows)
// nên file data.json chép sang máy khác cũng không giải mã được.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  fontSize: 14,
  fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
  copyOnSelect: true,
  rightClickPaste: true,
  sftpWidth: 380,
  sftpVisible: true,
  showHidden: false,
  scrollback: 10000,
  cursorBlink: true,
  monitor: true,
};

const SECRET_FIELDS = ['password', 'passphrase', 'privateKey'];

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function encrypt(plain) {
  if (plain == null || plain === '') return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
  }
  return 'plain:' + Buffer.from(String(plain)).toString('base64');
}

function decrypt(stored) {
  if (!stored) return '';
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      return '';
    }
  }
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString();
  return '';
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'data.json');
    this.data = { version: 2, sessions: [], keys: [], knownHosts: {}, deleted: { sessions: {}, keys: {} }, settings: { ...DEFAULT_SETTINGS } };
    this.onSave = null; // sync.js gắn vào để biết khi dữ liệu đổi
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...this.data,
        ...raw,
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        deleted: { sessions: {}, keys: {}, ...(raw.deleted || {}) },
      };
      // v1 → v2: "SFTP theo thư mục terminal" đổi sang mặc định tắt. Session cũ đều bật
      // theo mặc định cũ chứ không phải do người dùng chọn, nên tắt một lần.
      if ((raw.version || 1) < 2) {
        for (const s of this.data.sessions) s.followFolder = false;
        this.data.version = 2;
        this.save();
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // File hỏng: giữ bản sao để không mất dữ liệu.
        try { fs.copyFileSync(this.file, this.file + '.broken-' + Date.now()); } catch {}
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    if (this.onSave) this.onSave();
  }

  // Ghi dấu đã xoá để đồng bộ không kéo lại mục này từ máy khác.
  markDeleted(kind, id) {
    this.data.deleted[kind][id] = Date.now();
  }

  // ---------- Sessions ----------
  publicSession(s) {
    const { password, ...rest } = s;
    return { ...rest, hasPassword: !!password };
  }

  listSessions() {
    return this.data.sessions.map((s) => this.publicSession(s));
  }

  getSession(id) {
    return this.data.sessions.find((s) => s.id === id);
  }

  getSessionSecret(id) {
    const s = this.getSession(id);
    return s ? decrypt(s.password) : '';
  }

  // input.password: undefined = giữ nguyên, '' = xoá, chuỗi = đặt mới
  saveSession(input) {
    let s = input.id && this.getSession(input.id);
    const isNew = !s;
    if (isNew) {
      s = { id: newId(), createdAt: Date.now() };
      this.data.sessions.push(s);
    }
    const fields = ['name', 'group', 'host', 'port', 'username', 'authType', 'keyId', 'color', 'followFolder', 'startDir', 'notes'];
    for (const f of fields) if (input[f] !== undefined) s[f] = input[f];
    s.port = Number(s.port) || 22;
    s.authType = s.authType || 'password';
    if (!s.name) s.name = `${s.username ? s.username + '@' : ''}${s.host}`;
    if (input.password !== undefined) s.password = encrypt(input.password);
    s.updatedAt = Date.now();
    this.save();
    return this.publicSession(s);
  }

  setSessionPassword(id, password) {
    const s = this.getSession(id);
    if (!s) return;
    s.password = encrypt(password);
    s.updatedAt = Date.now();
    this.save();
  }

  touchSession(id) {
    const s = this.getSession(id);
    if (s) { s.lastUsed = Date.now(); this.save(); }
  }

  deleteSession(id) {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    this.markDeleted('sessions', id);
    this.save();
  }

  duplicateSession(id) {
    const s = this.getSession(id);
    if (!s) return null;
    const copy = { ...s, id: newId(), name: s.name + ' (copy)', createdAt: Date.now(), updatedAt: Date.now(), lastUsed: undefined };
    this.data.sessions.push(copy);
    this.save();
    return this.publicSession(copy);
  }

  renameGroup(oldName, newName) {
    for (const s of this.data.sessions) {
      if ((s.group || '') === oldName) s.group = newName;
      else if ((s.group || '').startsWith(oldName + '/')) s.group = newName + s.group.slice(oldName.length);
      else continue;
      s.updatedAt = Date.now();
    }
    this.save();
  }

  // ---------- Keys ----------
  publicKey(k) {
    const { privateKey, passphrase, ...rest } = k;
    return { ...rest, hasPassphrase: !!passphrase };
  }

  listKeys() {
    return this.data.keys.map((k) => this.publicKey(k));
  }

  getKeySecret(id) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) return null;
    return { privateKey: decrypt(k.privateKey), passphrase: decrypt(k.passphrase) };
  }

  addKey({ name, type, publicKey, privateKey, passphrase, fingerprint }) {
    const k = {
      id: newId(),
      name,
      type,
      publicKey,
      fingerprint,
      privateKey: encrypt(privateKey),
      passphrase: encrypt(passphrase || ''),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.data.keys.push(k);
    this.save();
    return this.publicKey(k);
  }

  renameKey(id, name) {
    const k = this.data.keys.find((x) => x.id === id);
    if (k) { k.name = name; k.updatedAt = Date.now(); this.save(); }
  }

  deleteKey(id) {
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    this.markDeleted('keys', id);
    for (const s of this.data.sessions) if (s.keyId === id) { s.keyId = ''; s.updatedAt = Date.now(); }
    this.save();
  }

  // ---------- Known hosts ----------
  getHostKey(hostPort) {
    return this.data.knownHosts[hostPort];
  }

  setHostKey(hostPort, fp) {
    this.data.knownHosts[hostPort] = fp;
    this.save();
  }

  // ---------- Settings ----------
  getSettings() {
    return this.data.settings;
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }

  // ---------- Export / import helpers ----------
  exportRaw({ includeSecrets, includeKeys }) {
    const sessions = this.data.sessions.map((s) => {
      const { password, ...rest } = s;
      return includeSecrets ? { ...rest, password: decrypt(password) } : rest;
    });
    const keys = includeKeys
      ? this.data.keys.map((k) => ({ ...k, privateKey: decrypt(k.privateKey), passphrase: decrypt(k.passphrase) }))
      : [];
    return { sessions, keys, knownHosts: this.data.knownHosts };
  }

  importRaw({ sessions = [], keys = [], knownHosts = {} }) {
    const keyMap = {};
    let addedKeys = 0;
    for (const k of keys) {
      const existing = this.data.keys.find((x) => x.fingerprint && x.fingerprint === k.fingerprint);
      if (existing) { keyMap[k.id] = existing.id; continue; }
      const added = this.addKey(k);
      keyMap[k.id] = added.id;
      addedKeys++;
    }
    let added = 0, skipped = 0;
    for (const s of sessions) {
      const dup = this.data.sessions.find(
        (x) => x.host === s.host && Number(x.port) === Number(s.port || 22) && (x.username || '') === (s.username || '') && x.name === s.name
      );
      if (dup) { skipped++; continue; }
      const { id, hasPassword, ...rest } = s;
      if (rest.keyId) rest.keyId = keyMap[rest.keyId] || '';
      this.saveSession({ ...rest, password: s.password || undefined });
      added++;
    }
    for (const [hp, fp] of Object.entries(knownHosts)) if (!this.data.knownHosts[hp]) this.data.knownHosts[hp] = fp;
    this.save();
    return { added, skipped, addedKeys };
  }

  // ---------- Đồng bộ ----------
  // Bản giải mã của session / key / known hosts / dấu xoá để gộp với file đồng bộ.
  syncView() {
    return {
      sessions: this.data.sessions.map((s) => ({ ...s, password: decrypt(s.password) })),
      keys: this.data.keys.map((k) => ({ ...k, privateKey: decrypt(k.privateKey), passphrase: decrypt(k.passphrase) })),
      knownHosts: { ...this.data.knownHosts },
      deleted: { sessions: { ...this.data.deleted.sessions }, keys: { ...this.data.deleted.keys } },
    };
  }

  applySyncView(v) {
    this.data.sessions = v.sessions.map((s) => ({ ...s, password: encrypt(s.password) }));
    this.data.keys = v.keys.map((k) => ({ ...k, privateKey: encrypt(k.privateKey), passphrase: encrypt(k.passphrase) }));
    this.data.knownHosts = v.knownHosts;
    this.data.deleted = v.deleted;
    this.save();
  }

  getSyncSecret() {
    return decrypt(this.data.syncSecret);
  }

  setSyncSecret(pass) {
    this.data.syncSecret = encrypt(pass);
    this.save();
  }
}

module.exports = { Store, newId };
