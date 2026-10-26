// Một tab = một kết nối SSH: shell + SFTP + kênh exec cho monitor / theo dõi thư mục.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { posix } = path;
const { Client } = require('ssh2');

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

function hostKeyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    return keyBuf.slice(4, 4 + len).toString();
  } catch {
    return 'unknown';
  }
}

// Tên file hợp lệ trên Linux nhưng Windows cấm: < > : " / \ | ? * , ký tự điều khiển,
// dấu chấm / dấu cách ở cuối, tên thiết bị (CON, NUL, COM1…). Thay bằng "_".
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
function winSafeName(name) {
  let n = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  if (WIN_RESERVED.test(n)) n = '_' + n;
  return n || '_';
}

// Tránh hai tên khác nhau trên server cùng thành một tên sau khi đổi (vd "a:b" và "a?b").
function uniqueName(name, used) {
  let n = name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${stem} (${i})${ext}`;
  used.add(n.toLowerCase());
  return n;
}

function modeToString(mode, isDir, isLink) {
  const t = isLink ? 'l' : isDir ? 'd' : '-';
  const r = (m, s) => (mode & m ? s : '-');
  return (
    t +
    r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') +
    r(0o040, 'r') + r(0o020, 'w') + r(0o010, 'x') +
    r(0o004, 'r') + r(0o002, 'w') + r(0o001, 'x')
  );
}

class SshTab {
  constructor({ tabId, session, send, ask, store }) {
    this.tabId = tabId;
    this.session = session;
    this.send = send; // (channel, payload)
    this.ask = ask; // (kind, payload) => Promise
    this.store = store;
    this.conn = null;
    this.shell = null;
    this.sftp = null;
    this.closed = false;
    this.shellPid = null;
    this.monitorTimer = null;
    this.monitorBusy = false;
    this.prevCpu = null;
    this.prevNet = null;
    this.watchers = new Map();
    this.outBuf = [];
    this.flushScheduled = false;
  }

  emit(channel, payload) {
    this.send(channel, { tabId: this.tabId, ...payload });
  }

  // ---------- Kết nối ----------
  connect({ password, cols, rows }) {
    const s = this.session;
    return new Promise((resolve, reject) => {
      const conn = new Client();
      this.conn = conn;
      let settled = false;
      let kbdTried = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };

      const cfg = {
        host: s.host,
        port: Number(s.port) || 22,
        username: s.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        tryKeyboard: true,
        hostVerifier: (key, verify) => {
          const hp = `${s.host}:${cfg.port}`;
          const fp = fingerprint(key);
          const known = this.store.getHostKey(hp);
          if (known === fp) return verify(true);
          this.ask('hostkey', { host: hp, fingerprint: fp, keyType: hostKeyType(key), previous: known || null })
            .then((ok) => {
              if (ok) this.store.setHostKey(hp, fp);
              verify(!!ok);
            })
            .catch(() => verify(false));
        },
      };

      if (s.authType === 'key' && s.keyId) {
        const k = this.store.getKeySecret(s.keyId);
        if (!k || !k.privateKey) return done(Object.assign(new Error('Không tìm thấy SSH key của session này'), { code: 'NOKEY' }));
        cfg.privateKey = k.privateKey;
        if (k.passphrase) cfg.passphrase = k.passphrase;
      } else if (s.authType === 'agent') {
        cfg.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      }
      if (password) cfg.password = password;

      conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        if (!prompts.length) return finish([]);
        if (password && !kbdTried && prompts.length === 1 && !prompts[0].echo) {
          kbdTried = true;
          return finish([password]);
        }
        this.ask('kbd', { name, instructions, prompts })
          .then((answers) => finish(answers || []))
          .catch(() => finish([]));
      });

      conn.on('ready', async () => {
        try {
          await this.openShell(cols, rows);
          done();
          this.emit('ssh:status', { state: 'connected' });
          this.openSftp();
          this.afterConnect();
        } catch (e) {
          done(e);
        }
      });

      conn.on('error', (err) => {
        if (!settled) {
          if (err.level === 'client-authentication') err.code = 'AUTH';
          done(err);
        } else {
          this.emit('ssh:status', { state: 'error', message: err.message });
        }
      });

      conn.on('close', () => {
        this.cleanup();
        if (settled) { if (!this.closed) this.emit('ssh:status', { state: 'closed' }); }
        else done(new Error('Kết nối bị đóng'));
      });

      try {
        conn.connect(cfg);
      } catch (e) {
        done(e);
      }
    });
  }

  openShell(cols, rows) {
    return new Promise((resolve, reject) => {
      this.conn.shell({ term: 'xterm-256color', cols: cols || 120, rows: rows || 30 }, (err, stream) => {
        if (err) return reject(err);
        this.shell = stream;
        const onData = (d) => this.pushOutput(d);
        stream.on('data', onData);
        stream.stderr.on('data', onData);
        stream.on('close', () => {
          this.shell = null;
          if (this.conn) this.conn.end();
        });
        resolve();
      });
    });
  }

  // Gom dữ liệu terminal theo vòng event loop để giảm số IPC message.
  pushOutput(d) {
    this.outBuf.push(d);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      const data = Buffer.concat(this.outBuf);
      this.outBuf = [];
      this.emit('ssh:data', { data });
    });
  }

  openSftp() {
    this.conn.sftp((err, sftp) => {
      if (err) {
        this.emit('sftp:status', { state: 'error', message: err.message });
        return;
      }
      this.sftp = sftp;
      sftp.on('close', () => { this.sftp = null; });
      this.emit('sftp:status', { state: 'ready' });
    });
  }

  async afterConnect() {
    setTimeout(() => this.findShellPid().catch(() => {}), 1200);
    if (this.store.getSettings().monitor) this.startMonitor();
  }

  write(data) {
    if (this.shell) this.shell.write(data);
  }

  resize(cols, rows) {
    if (this.shell) this.shell.setWindow(rows, cols, 0, 0);
  }

  // ---------- exec ----------
  exec(cmd, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error('Chưa kết nối'));
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        let errOut = '';
        const t = setTimeout(() => { try { stream.close(); } catch {} reject(new Error('exec timeout')); }, timeout);
        stream.on('data', (d) => (out += d));
        stream.stderr.on('data', (d) => (errOut += d));
        stream.on('close', (code) => {
          clearTimeout(t);
          resolve({ out, err: errOut, code });
        });
      });
    });
  }

  // ---------- Theo dõi thư mục terminal ----------
  // Shell và kênh exec chung một kết nối TCP nên có cùng SSH_CONNECTION.
  // Tìm tiến trình có SSH_CONNECTION đó và gắn với /dev/pts, lấy pid nhỏ nhất = login shell.
  async findShellPid() {
    const script =
      'C="$SSH_CONNECTION"; for d in /proc/[0-9]*; do ' +
      't=$(readlink "$d/fd/0" 2>/dev/null); case "$t" in /dev/pts/*) ' +
      'if tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -qxF "SSH_CONNECTION=$C"; then echo "${d#/proc/}"; fi;; esac; ' +
      'done | sort -n | head -1';
    const { out } = await this.exec(script);
    const pid = parseInt(out.trim(), 10);
    if (pid) this.shellPid = pid;
    return this.shellPid;
  }

  async getCwd() {
    if (!this.shellPid) await this.findShellPid().catch(() => {});
    if (!this.shellPid) return null;
    const { out } = await this.exec(`readlink /proc/${this.shellPid}/cwd`);
    return out.trim() || null;
  }

  // ---------- Monitor ----------
  startMonitor() {
    this.stopMonitor();
    const tick = () => this.pollMonitor().catch(() => {});
    tick();
    this.monitorTimer = setInterval(tick, 3000);
  }

  stopMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  async pollMonitor() {
    if (this.monitorBusy || !this.conn) return;
    this.monitorBusy = true;
    try {
      const cmd =
        'head -1 /proc/stat; echo @@; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; echo @@; ' +
        'cat /proc/net/dev; echo @@; cat /proc/uptime; echo @@; df -Pk / | tail -1; echo @@; cat /proc/loadavg';
      const { out } = await this.exec(cmd, { timeout: 8000 });
      const parts = out.split('@@\n');
      if (parts.length < 6) return;
      const now = Date.now();
      const stat = {};

      const cpu = parts[0].trim().split(/\s+/).slice(1).map(Number);
      const idle = (cpu[3] || 0) + (cpu[4] || 0);
      const total = cpu.reduce((a, b) => a + (b || 0), 0);
      if (this.prevCpu) {
        const dt = total - this.prevCpu.total;
        stat.cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - (idle - this.prevCpu.idle) / dt) * 100)) : 0;
      }
      this.prevCpu = { idle, total };

      const mem = {};
      for (const line of parts[1].split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) mem[m[1]] = Number(m[2]) * 1024;
      }
      stat.memTotal = mem.MemTotal || 0;
      stat.memUsed = mem.MemTotal && mem.MemAvailable != null ? mem.MemTotal - mem.MemAvailable : 0;

      let rx = 0, tx = 0;
      for (const line of parts[2].split('\n').slice(2)) {
        const m = line.trim().match(/^([^:]+):\s*(.*)$/);
        if (!m || m[1] === 'lo') continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        rx += f[0] || 0;
        tx += f[8] || 0;
      }
      if (this.prevNet) {
        const sec = (now - this.prevNet.t) / 1000;
        stat.rx = Math.max(0, (rx - this.prevNet.rx) / sec);
        stat.tx = Math.max(0, (tx - this.prevNet.tx) / sec);
      }
      this.prevNet = { rx, tx, t: now };

      stat.uptime = Number(parts[3].trim().split(/\s+/)[0]) || 0;
      const df = parts[4].trim().split(/\s+/);
      stat.diskTotal = Number(df[1]) * 1024 || 0;
      stat.diskUsed = Number(df[2]) * 1024 || 0;
      stat.diskPct = parseInt(df[4], 10) || 0;
      stat.load = parts[5].trim().split(/\s+/).slice(0, 3).join(' ');
      this.emit('ssh:monitor', { stat });
    } finally {
      this.monitorBusy = false;
    }
  }

  // ---------- SFTP ----------
  requireSftp() {
    if (!this.sftp) throw new Error('SFTP chưa sẵn sàng');
    return this.sftp;
  }

  sftpCall(method, ...args) {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  async home() {
    if (this.session.startDir) return this.session.startDir;
    return this.sftpCall('realpath', '.');
  }

  async list(dir) {
    const real = await this.sftpCall('realpath', dir || '.');
    const entries = await this.sftpCall('readdir', real);
    const items = await Promise.all(
      entries.map(async (e) => {
        const mode = e.attrs.mode || 0;
        const type = mode & 0o170000;
        const isLink = type === 0o120000;
        let isDir = type === 0o040000;
        let target = null;
        if (isLink) {
          try {
            const st = await this.sftpCall('stat', posix.join(real, e.filename));
            isDir = (st.mode & 0o170000) === 0o040000;
          } catch {}
          try { target = await this.sftpCall('readlink', posix.join(real, e.filename)); } catch {}
        }
        const cols = (e.longname || '').split(/\s+/);
        return {
          name: e.filename,
          path: posix.join(real, e.filename),
          isDir,
          isLink,
          target,
          size: e.attrs.size || 0,
          mtime: (e.attrs.mtime || 0) * 1000,
          mode: mode & 0o7777,
          perms: modeToString(mode, isDir && !isLink, isLink),
          owner: cols[2] || String(e.attrs.uid ?? ''),
          group: cols[3] || String(e.attrs.gid ?? ''),
        };
      })
    );
    return { path: real, items };
  }

  mkdir(p) { return this.sftpCall('mkdir', p); }
  rename(a, b) { return this.sftpCall('rename', a, b); }
  chmod(p, mode) { return this.sftpCall('chmod', p, mode); }

  async newFile(p) {
    const sftp = this.requireSftp();
    await new Promise((resolve, reject) => {
      sftp.open(p, 'wx', (err, h) => {
        if (err) return reject(err);
        sftp.close(h, () => resolve());
      });
    });
  }

  async remove(paths) {
    // rm -rf qua exec nhanh hơn nhiều so với xoá đệ quy từng file qua SFTP
    const { code, err } = await this.exec('rm -rf -- ' + paths.map(shq).join(' '), { timeout: 600000 });
    if (code !== 0) throw new Error(err.trim() || 'Xoá thất bại');
  }

  async readText(p) {
    const st = await this.sftpCall('stat', p);
    if (st.size > 5 * 1024 * 1024) throw new Error('File lớn hơn 5 MB');
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(p, (err, buf) => (err ? reject(err) : resolve(buf.toString('utf8'))));
    });
  }

  // ---------- Truyền file ----------
  transferEmit(job) {
    const now = Date.now();
    if (!job.final && now - (job.lastEmit || 0) < 150) return;
    job.lastEmit = now;
    const { lastEmit, ...pub } = job;
    this.emit('transfer', { job: pub });
  }

  // Duyệt cây local. Junction/symlink thư mục bị bỏ qua để tránh vòng lặp (vd "Application Data").
  async walkLocal(p, remoteBase, list, top = true) {
    const lst = await fs.promises.lstat(p);
    let st = lst;
    if (lst.isSymbolicLink()) {
      st = await fs.promises.stat(p).catch(() => null);
      if (!st || (st.isDirectory() && !top)) { list.skipped.push(p); return list; }
    }
    if (st.isDirectory()) {
      list.push({ dir: true, remote: remoteBase });
      for (const name of await fs.promises.readdir(p)) {
        await this.walkLocal(path.join(p, name), posix.join(remoteBase, name), list, false);
      }
    } else {
      list.push({ local: p, remote: remoteBase, size: st.size });
    }
    return list;
  }

  // Duyệt cây remote. Symlink trỏ tới file thì tải nội dung; symlink thư mục bên trong
  // thì bỏ qua (link kiểu "loop -> .." sẽ làm đệ quy vô hạn).
  async walkRemote(p, localBase, list, top = true) {
    let st = await this.sftpCall(top ? 'stat' : 'lstat', p);
    if ((st.mode & 0o170000) === 0o120000) {
      st = await this.sftpCall('stat', p).catch(() => null);
      if (!st || (st.mode & 0o170000) === 0o040000) { list.skipped.push(p); return list; }
    }
    if ((st.mode & 0o170000) === 0o040000) {
      list.push({ dir: true, local: localBase });
      const used = new Set();
      for (const e of await this.sftpCall('readdir', p)) {
        const safe = uniqueName(winSafeName(e.filename), used);
        if (safe !== e.filename) list.renamed.push(e.filename + ' → ' + safe);
        await this.walkRemote(posix.join(p, e.filename), path.join(localBase, safe), list, false);
      }
    } else if ((st.mode & 0o170000) === 0o100000 || !st.mode) {
      list.push({ remote: p, local: localBase, size: st.size });
    } else {
      list.skipped.push(p); // socket, FIFO, thiết bị: không tải được
    }
    return list;
  }

  newList() {
    const l = [];
    l.skipped = [];
    l.renamed = [];
    return l;
  }

  // Một file lỗi không làm dừng cả lượt: ghi lại lỗi rồi làm tiếp file sau.
  async runJob(kind, label, items, extra = {}) {
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      kind,
      label,
      total: items.reduce((a, b) => a + (b.size || 0), 0),
      done: 0,
      files: items.filter((i) => !i.dir).length,
      filesDone: 0,
      failed: [],
      skipped: items.skipped || [],
      renamed: items.renamed || [],
      state: 'running',
      startedAt: Date.now(),
      ...extra,
    };
    this.transferEmit(job);
    const sftp = this.requireSftp();
    const failedDirs = [];
    for (const it of items) {
      const target = kind === 'upload' ? it.remote : it.local;
      if (failedDirs.some((d) => target.startsWith(d))) continue;
      if (!this.sftp) { job.failed.push({ name: target, error: 'Mất kết nối SFTP' }); break; }
      if (it.dir) {
        try {
          if (kind === 'upload') {
            await this.sftpCall('mkdir', it.remote).catch(async (e) => {
              const st = await this.sftpCall('stat', it.remote).catch(() => null);
              if (!st || (st.mode & 0o170000) !== 0o040000) throw e;
            });
          } else await fs.promises.mkdir(it.local, { recursive: true });
        } catch (e) {
          job.failed.push({ name: target, error: e.message });
          failedDirs.push(target + (kind === 'upload' ? '/' : path.sep));
        }
        continue;
      }
      const base = job.done;
      try {
        await new Promise((resolve, reject) => {
          const opts = {
            concurrency: 64,
            chunkSize: 32768,
            step: (transferred) => {
              job.done = base + transferred;
              this.transferEmit(job);
            },
          };
          if (kind === 'upload') sftp.fastPut(it.local, it.remote, opts, (e) => (e ? reject(e) : resolve()));
          else sftp.fastGet(it.remote, it.local, opts, (e) => (e ? reject(e) : resolve()));
        });
        job.filesDone++;
      } catch (e) {
        job.failed.push({ name: target, error: e.code === 3 || /permission/i.test(e.message) ? 'Không có quyền' : e.message });
      }
      job.done = base + (it.size || 0);
      this.transferEmit(job);
    }
    job.state = job.failed.length ? (job.filesDone ? 'partial' : 'error') : 'done';
    if (job.failed.length) {
      const f = job.failed[0];
      job.error = `${job.failed.length} mục lỗi — ${posix.basename(f.name.replace(/\\/g, '/'))}: ${f.error}`;
    }
    job.final = true;
    this.transferEmit(job);
    return job;
  }

  // Hỏi khi trùng tên ở cấp trên cùng: ghi đè / bỏ qua mục trùng / huỷ.
  async resolveConflicts(kind, names, exists, where) {
    const conflicts = [];
    for (const n of names) if (await exists(n)) conflicts.push(n);
    if (!conflicts.length) return new Set();
    const choice = await this.ask('conflict', { kind, names: conflicts, where });
    if (choice === 'overwrite') return new Set();
    if (choice === 'skip') return new Set(conflicts);
    return null;
  }

  async upload(localPaths, remoteDir) {
    const skip = await this.resolveConflicts('upload', localPaths.map((p) => path.basename(p)),
      (n) => this.sftpCall('lstat', posix.join(remoteDir, n)).then(() => true, () => false), remoteDir);
    if (!skip) return null;
    const items = this.newList();
    const chosen = localPaths.filter((p) => !skip.has(path.basename(p)));
    if (!chosen.length) return null;
    for (const p of chosen) await this.walkLocal(p, posix.join(remoteDir, path.basename(p)), items);
    const label = chosen.length === 1 ? path.basename(chosen[0]) : `${chosen.length} mục`;
    return this.runJob('upload', label, items, { remoteDir });
  }

  async download(remotePaths, localDir) {
    const used = new Set();
    const map = remotePaths.map((p) => ({ p, safe: uniqueName(winSafeName(posix.basename(p)), used) }));
    const skip = await this.resolveConflicts('download', map.map((m) => m.safe),
      (n) => fs.promises.lstat(path.join(localDir, n)).then(() => true, () => false), localDir);
    if (!skip) return null;
    const items = this.newList();
    const chosen = map.filter((m) => !skip.has(m.safe));
    if (!chosen.length) return null;
    for (const m of chosen) {
      if (m.safe !== posix.basename(m.p)) items.renamed.push(posix.basename(m.p) + ' → ' + m.safe);
      await this.walkRemote(m.p, path.join(localDir, m.safe), items);
    }
    const label = chosen.length === 1 ? posix.basename(chosen[0].p) : `${chosen.length} mục`;
    return this.runJob('download', label, items, { localDir });
  }

  // ---------- Sửa file bằng editor của máy ----------
  // Tải về thư mục tạm, mở bằng app mặc định, mỗi lần lưu tự upload ngược lên server.
  async editLocal(remotePath, openPath) {
    const dir = path.join(os.tmpdir(), 'termora', this.tabId, crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8));
    await fs.promises.mkdir(dir, { recursive: true });
    const local = path.join(dir, winSafeName(posix.basename(remotePath)));
    await this.sftpCall('fastGet', remotePath, local);
    const prev = this.watchers.get(local);
    if (prev) fs.unwatchFile(local, prev);
    let lastMtime = (await fs.promises.stat(local)).mtimeMs;
    let uploading = false;
    const listener = async (cur) => {
      if (cur.mtimeMs === lastMtime || uploading) return;
      lastMtime = cur.mtimeMs;
      uploading = true;
      try {
        await this.sftpCall('fastPut', local, remotePath);
        this.emit('toast', { kind: 'ok', message: `Đã lưu lên server: ${remotePath}` });
      } catch (e) {
        this.emit('toast', { kind: 'error', message: `Lưu thất bại: ${e.message}` });
      } finally {
        uploading = false;
      }
    };
    fs.watchFile(local, { interval: 800 }, listener);
    this.watchers.set(local, listener);
    const err = await openPath(local);
    if (err) throw new Error(err);
    return local;
  }

  // ---------- Cài public key ----------
  async installPublicKey(pub) {
    const line = pub.trim();
    const cmd =
      'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ' +
      `(grep -qxF ${shq(line)} ~/.ssh/authorized_keys || echo ${shq(line)} >> ~/.ssh/authorized_keys) && ` +
      'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && echo OK';
    const { out, err } = await this.exec(cmd);
    if (!out.includes('OK')) throw new Error(err.trim() || 'Không cài được key');
  }

  // ---------- Dọn dẹp ----------
  cleanup() {
    this.stopMonitor();
    for (const [file, l] of this.watchers) fs.unwatchFile(file, l);
    this.watchers.clear();
    this.shell = null;
    this.sftp = null;
  }

  close() {
    this.closed = true;
    this.cleanup();
    if (this.conn) {
      try { this.conn.end(); } catch {}
    }
    this.conn = null;
  }
}

module.exports = { SshTab, shq, winSafeName };
