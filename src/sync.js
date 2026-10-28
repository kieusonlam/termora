// Đồng bộ session / key qua một thư mục mà Google Drive, OneDrive, Dropbox… đã đồng bộ sẵn.
// Trong thư mục chỉ có file termora-sync.termora, mã hoá AES-256-GCM bằng mật khẩu đồng bộ
// (khoá DPAPI của Windows chỉ mở được trên đúng máy này nên không dùng được ở đây). File cùng
// định dạng với Export nên Import cũng đọc được.
//
// Mỗi lần đồng bộ: đọc file (và các bản xung đột mà dịch vụ cloud tạo ra), gộp vào dữ liệu máy
// này theo updatedAt của từng mục, rồi ghi lại nếu kết quả khác file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE = 'termora-sync.termora';
const FILE_RE = /^termora-sync.*\.termora$/i; // gồm cả "termora-sync-PC2.termora" do OneDrive tạo khi xung đột
const KDF = { name: 'scrypt', N: 1 << 15, r: 8, p: 1 };
const POLL_MS = 20000;
const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;

// ---------- Mã hoá (cùng định dạng với importexport.js) ----------
const keyCache = new Map(); // `${salt}|${pass}` -> key; scrypt tốn ~100ms nên chỉ dẫn xuất một lần mỗi salt

function deriveKey(pass, kdf) {
  const id = kdf.salt + '|' + pass;
  if (!keyCache.has(id)) {
    keyCache.set(id, crypto.scryptSync(pass, Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 }));
  }
  return keyCache.get(id);
}

function seal(body, pass, kdf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, kdf), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return {
    format: 'termora-export',
    version: 1,
    encrypted: true,
    kdf,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function open(file, pass) {
  if (file.format !== 'termora-export' || !file.encrypted) throw new Error('Không phải file đồng bộ của Termora');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, file.kdf), Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Sai mật khẩu đồng bộ'), { code: 'BADPASS' });
  }
}

// ---------- Gộp ----------
const sessionKey = (s) => [s.host, Number(s.port) || 22, s.username || '', s.name].join('\n');
const keyKey = (k) => k.fingerprint || '';

// Gộp một danh sách theo id. Mục mới hơn (updatedAt) thắng; lastUsed lấy lớn nhất; dấu xoá thắng
// nếu xoá sau lần sửa cuối. Mục giống hệt nhưng khác id (hai máy tạo riêng trước khi bật đồng bộ)
// được nhận id của file để từ đó sửa ở đâu cũng theo nhau.
function mergeList(local, remote, delL, delR, sameKey) {
  const deleted = { ...delL };
  for (const [id, t] of Object.entries(delR || {})) deleted[id] = Math.max(deleted[id] || 0, t);
  const list = local.map((x) => ({ ...x }));
  const byId = new Map(list.map((x) => [x.id, x]));
  const remoteIds = new Set(remote.map((r) => r.id));
  const idMap = {};
  for (const r of remote) {
    let l = byId.get(r.id);
    if (!l) {
      const k = sameKey(r);
      l = k && list.find((x) => !remoteIds.has(x.id) && !idMap[x.id] && sameKey(x) === k);
      if (l) { idMap[l.id] = r.id; byId.delete(l.id); l.id = r.id; byId.set(r.id, l); }
    }
    if (!l) { const n = { ...r }; list.push(n); byId.set(n.id, n); continue; }
    const lastUsed = Math.max(l.lastUsed || 0, r.lastUsed || 0) || undefined;
    if ((r.updatedAt || 0) > (l.updatedAt || 0)) {
      for (const f of Object.keys(l)) delete l[f];
      Object.assign(l, r);
    }
    if (lastUsed) l.lastUsed = lastUsed;
  }
  const out = list.filter((x) => !(deleted[x.id] && deleted[x.id] >= (x.updatedAt || 0)));
  const cutoff = Date.now() - TOMBSTONE_TTL;
  for (const [id, t] of Object.entries(deleted)) if (t < cutoff) delete deleted[id];
  return { list: out, deleted, idMap };
}

function merge(local, remote) {
  const keys = mergeList(local.keys, remote.keys || [], local.deleted.keys, remote.deleted?.keys, keyKey);
  // Key đổi id thì sửa keyId của session máy này trước khi gộp session.
  const localSessions = local.sessions.map((s) => (keys.idMap[s.keyId] ? { ...s, keyId: keys.idMap[s.keyId] } : s));
  const sessions = mergeList(localSessions, remote.sessions || [], local.deleted.sessions, remote.deleted?.sessions, sessionKey);
  return {
    sessions: sessions.list,
    keys: keys.list,
    knownHosts: { ...(remote.knownHosts || {}), ...local.knownHosts },
    deleted: { sessions: sessions.deleted, keys: keys.deleted },
  };
}

// So nội dung không phụ thuộc thứ tự mục / thứ tự field.
function canon(v) {
  const norm = (x) => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = norm(x[k]);
      return o;
    }
    return x;
  };
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.stringify(norm({
    sessions: [...(v.sessions || [])].sort(byId),
    keys: [...(v.keys || [])].sort(byId),
    knownHosts: v.knownHosts || {},
    deleted: v.deleted || { sessions: {}, keys: {} },
  }));
}

// ---------- Tiến trình đồng bộ ----------
class Sync {
  constructor({ store, send }) {
    this.store = store;
    this.send = send;
    this.state = { status: 'off' };
    this.running = null;
    this.again = false;
    this.lastLocal = null; // canon dữ liệu máy này ở lần đồng bộ trước
    this.seen = '';        // mtime/size các file trong thư mục ở lần đọc trước
    this.timer = null;
    this.debounce = null;
    store.onSave = () => this.localChanged();
  }

  get dir() {
    return this.store.getSettings().syncDir || '';
  }

  status() {
    return { ...this.state, dir: this.dir };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.send('sync', this.status());
  }

  start() {
    clearInterval(this.timer);
    if (!this.dir) return this.set({ status: 'off', error: '' });
    this.timer = setInterval(() => this.poll(), POLL_MS);
    return this.run();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.store.setSettings({ syncDir: '' });
    this.store.setSyncSecret('');
    this.lastLocal = null;
    this.seen = '';
    this.set({ status: 'off', error: '', lastSync: 0 });
  }

  // Bật đồng bộ vào thư mục dir. File đã có thì mật khẩu phải mở được nó.
  async setup(dir, pass) {
    if (!pass) throw new Error('Cần mật khẩu đồng bộ');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, FILE);
    if (fs.existsSync(f)) open(JSON.parse(fs.readFileSync(f, 'utf8')), pass);
    this.store.setSyncSecret(pass);
    this.store.setSettings({ syncDir: dir });
    this.lastLocal = null;
    this.seen = '';
    return this.start();
  }

  exists(dir) {
    return fs.existsSync(path.join(dir, FILE));
  }

  localChanged() {
    if (!this.dir || this.applying) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      if (canon(this.store.syncView()) !== this.lastLocal) this.run();
    }, 1500);
  }

  files() {
    try {
      return fs.readdirSync(this.dir).filter((n) => FILE_RE.test(n)).sort((a, b) => (a === FILE ? -1 : b === FILE ? 1 : a.localeCompare(b)));
    } catch {
      return [];
    }
  }

  fingerprint(names) {
    return names.map((n) => {
      try { const st = fs.statSync(path.join(this.dir, n)); return `${n}:${st.mtimeMs}:${st.size}`; } catch { return n; }
    }).join('|');
  }

  poll() {
    if (this.dir && this.fingerprint(this.files()) !== this.seen) this.run();
  }

  run() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try { await this.once(); } catch (e) { this.set({ status: 'error', error: e.message, code: e.code }); }
      } while (this.again);
      this.running = null;
      return this.status();
    })();
    return this.running;
  }

  async once() {
    const dir = this.dir;
    if (!dir) return;
    const pass = this.store.getSyncSecret();
    if (!pass) throw Object.assign(new Error('Thiếu mật khẩu đồng bộ, hãy thiết lập lại'), { code: 'BADPASS' });
    if (!fs.existsSync(dir)) throw new Error('Không thấy thư mục đồng bộ: ' + dir);
    this.set({ status: 'syncing', changedLocal: false });

    const names = this.files();
    let main = null, kdf = null;
    let merged = this.store.syncView();
    const before = canon(merged);
    for (const n of names) {
      let file;
      try { file = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) {
        if (n === FILE) throw new Error('Không đọc được ' + FILE + ': ' + e.message);
        continue; // bản xung đột hỏng / đang tải dở: bỏ qua
      }
      const body = open(file, pass);
      if (n === FILE) { main = body; kdf = file.kdf; }
      merged = merge(merged, body);
    }

    const changedLocal = canon(merged) !== before;
    if (changedLocal) {
      this.applying = true;
      try { this.store.applySyncView(merged); } finally { this.applying = false; }
    }
    const now = canon(merged);
    if (!main || canon(main) !== now) {
      kdf = kdf || { ...KDF, salt: crypto.randomBytes(16).toString('base64') };
      const body = { exportedAt: new Date().toISOString(), device: os.hostname(), sync: true, ...merged };
      const target = path.join(dir, FILE);
      const tmp = target + '.tmp';
      const text = JSON.stringify(seal(body, pass, kdf));
      try {
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, target);
      } catch {
        // Một số ổ cloud (file placeholder) không cho đổi tên đè: ghi thẳng.
        try { fs.rmSync(tmp, { force: true }); } catch {}
        fs.writeFileSync(target, text, 'utf8');
      }
    }
    this.lastLocal = now;
    this.seen = this.fingerprint(this.files());
    this.set({
      status: 'ok',
      error: '',
      code: '',
      lastSync: Date.now(),
      changedLocal,
      sessions: merged.sessions.length,
      keys: merged.keys.length,
    });
  }
}

module.exports = { Sync, merge, canon, FILE };
