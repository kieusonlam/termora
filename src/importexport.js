// Import / export: file .termora (JSON, có thể mã hoá AES-256-GCM bằng passphrase),
// file bookmark session (.mxtsessions / .ini) và OpenSSH config (~/.ssh/config).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { utils } = require('ssh2');

const FORMAT = 'termora-export';

function encryptPayload(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    format: FORMAT,
    version: 1,
    encrypted: true,
    kdf: { name: 'scrypt', N: 1 << 15, r: 8, p: 1, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptPayload(file, passphrase) {
  const { N, r, p, salt } = file.kdf;
  const key = crypto.scryptSync(passphrase, Buffer.from(salt, 'base64'), 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Sai passphrase hoặc file bị hỏng'), { code: 'BADPASS' });
  }
}

function buildExport(raw, passphrase) {
  const body = { exportedAt: new Date().toISOString(), ...raw };
  if (passphrase) return encryptPayload(body, passphrase);
  return { format: FORMAT, version: 1, encrypted: false, ...body };
}

function parseTermora(text, passphrase) {
  const file = JSON.parse(text);
  if (file.format !== FORMAT) throw new Error('Không phải file export của Termora');
  if (file.encrypted) {
    if (!passphrase) throw Object.assign(new Error('File được mã hoá, cần passphrase'), { code: 'NEEDPASS' });
    return decryptPayload(file, passphrase);
  }
  return file;
}

// File bookmark: mỗi section [Bookmarks], [Bookmarks_N] có SubRep=<thư mục>, và dòng
//   <tên>=#<icon>#<loại>%<host>%<port>%<user>%...   (loại 0 = SSH)
function parseBookmarks(text) {
  const sessions = [];
  let group = '';
  let inBookmarks = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      inBookmarks = /^Bookmarks(_\d+)?$/i.test(sec[1]);
      group = '';
      continue;
    }
    if (!inBookmarks) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === 'SubRep') { group = val.replace(/\\/g, '/'); continue; }
    if (key === 'ImgNum') continue;
    const m = val.match(/^#\d+#(\d+)%(.*)$/);
    if (!m || m[1] !== '0') continue; // chỉ lấy session SSH
    const f = m[2].split('%');
    const host = (f[0] || '').trim();
    if (!host) continue;
    sessions.push({
      name: key,
      group,
      host,
      port: Number(f[1]) || 22,
      username: (f[2] || '').trim(),
      authType: 'password',
      followFolder: true,
    });
  }
  return { sessions, keys: [] };
}

function keyInfo(privateKey, passphrase) {
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) throw parsed;
  const k = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!k.isPrivateKey()) throw new Error('Đây không phải private key');
  const pubBlob = k.getPublicSSH();
  return {
    type: k.type,
    publicKey: `${k.type} ${pubBlob.toString('base64')}${k.comment ? ' ' + k.comment : ''}`,
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, ''),
  };
}

function expandHome(p) {
  return p.replace(/^~(?=[\\/]|$)/, os.homedir());
}

// ~/.ssh/config: lấy các block Host không chứa ký tự đại diện.
function parseSshConfig(text) {
  const sessions = [];
  const keys = [];
  const keyByPath = {};
  let cur = null;
  const flush = () => {
    if (!cur) return;
    for (const alias of cur.aliases) {
      if (/[*?!]/.test(alias)) continue;
      const s = {
        name: alias,
        group: 'ssh config',
        host: cur.HostName || alias,
        port: Number(cur.Port) || 22,
        username: cur.User || '',
        authType: 'password',
        followFolder: true,
      };
      if (cur.IdentityFile) {
        const p = expandHome(cur.IdentityFile.replace(/^"|"$/g, ''));
        if (!(p in keyByPath)) {
          keyByPath[p] = null;
          try {
            const priv = fs.readFileSync(p, 'utf8');
            const info = keyInfo(priv);
            const id = 'cfg' + keys.length;
            keys.push({ id, name: path.basename(p), privateKey: priv, passphrase: '', ...info });
            keyByPath[p] = id;
          } catch {}
        }
        if (keyByPath[p]) { s.authType = 'key'; s.keyId = keyByPath[p]; }
      }
      sessions.push(s);
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'host') {
      flush();
      cur = { aliases: m[2].split(/\s+/) };
    } else if (k === 'match') {
      flush();
      cur = null;
    } else if (cur) {
      const map = { hostname: 'HostName', port: 'Port', user: 'User', identityfile: 'IdentityFile' };
      if (map[k] && !cur[map[k]]) cur[map[k]] = m[2].trim();
    }
  }
  flush();
  return { sessions, keys };
}

function detectAndParse(filePath, text, passphrase) {
  const ext = path.extname(filePath).toLowerCase();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) return { kind: 'termora', data: parseTermora(text, passphrase) };
  if (ext === '.mxtsessions' || ext === '.ini' || /^\[Bookmarks/m.test(text)) return { kind: 'bookmarks', data: parseBookmarks(text) };
  return { kind: 'sshconfig', data: parseSshConfig(text) };
}

module.exports = { buildExport, detectAndParse, keyInfo, parseBookmarks, parseSshConfig };
