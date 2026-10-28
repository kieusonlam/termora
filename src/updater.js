// Cập nhật tự động từ GitHub Releases.
// - Bản cài (NSIS): electron-updater đọc latest.yml của release, tải ngầm, cài khi khởi động lại.
// - Bản portable: electron-updater không hỗ trợ. Tự hỏi GitHub API bản mới nhất, tải exe portable
//   về thư mục tạm; khi người dùng bấm, một script nhỏ chờ app thoát, chép đè lên file exe đang
//   dùng (giữ nguyên tên để shortcut vẫn chạy) rồi mở lại. TermoraData cạnh exe không bị đụng tới.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, net } = require('electron');

const REPO = 'kieusonlam/termora';
const AUTO_EVERY = 6 * 3600 * 1000;

// Chép đè exe portable. Exe cũ còn bị khoá đến khi launcher portable thoát hẳn, nên thử lại.
// Dùng cmd thay vì powershell: powershell 5.1 chạy kiểu detached (không console) thoát ngay mà
// không làm gì. Đường dẫn đi qua biến môi trường nên tên thư mục có dấu tiếng Việt vẫn đúng.
const APPLY_CMD = [
  '@echo off',
  'for /l %%i in (1,1,240) do (',
  '  copy /y /b "%TERMORA_SRC%" "%TERMORA_DST%" >nul 2>&1 && goto done',
  '  ping -n 2 127.0.0.1 >nul',
  ')',
  'start "" "%TERMORA_SRC%"',
  'exit /b 1',
  ':done',
  'del /f /q "%TERMORA_SRC%" >nul 2>&1',
  'start "" "%TERMORA_DST%"',
  '',
].join('\r\n');

function cmpVer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function sha256(file) {
  return new Promise((ok, bad) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', bad).on('end', () => ok(h.digest('hex')));
  });
}

class Updater {
  constructor({ send }) {
    this.send = send;
    this.portableFile = process.env.PORTABLE_EXECUTABLE_FILE || '';
    this.current = process.env.TERMORA_FAKE_VERSION || app.getVersion();
    // TERMORA_UPDATE_FEED: chạy thử luồng bản cài với một server generic (chỉ dùng khi test).
    this.feed = process.env.TERMORA_UPDATE_FEED || '';
    this.mode = this.portableFile ? 'portable' : app.isPackaged || this.feed ? 'installer' : 'dev';
    this.state = { status: 'idle', mode: this.mode, current: this.current };
    this.timer = null;
    if (this.mode === 'installer') this.initInstaller();
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.send('update', this.state);
    return this.state;
  }

  initInstaller() {
    const { autoUpdater } = require('electron-updater');
    this.au = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    if (this.feed) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: this.feed });
    }
    autoUpdater.on('update-available', (i) => this.set({ status: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('update-not-available', (i) => this.set({ status: 'none', version: i.version }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.floor(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => this.set({ status: 'ready', version: i.version, percent: 100 }));
    autoUpdater.on('error', (e) => this.fail(e));
  }

  fail(e) {
    if (this.state.status === 'ready') return this.state;
    const msg = /latest\.yml|404/.test(e.message) ? 'Bản mới nhất trên GitHub chưa hỗ trợ cập nhật tự động' : e.message;
    return this.set({ status: 'error', error: msg });
  }

  startAuto(enabled) {
    clearInterval(this.timer);
    this.timer = null;
    if (!enabled || this.mode === 'dev') return;
    setTimeout(() => this.check(), 8000);
    this.timer = setInterval(() => this.check(), AUTO_EVERY);
  }

  async check() {
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: '' });
    try {
      if (this.mode === 'installer') {
        const r = await this.au.checkForUpdates();
        r?.downloadPromise?.catch(() => {}); // lỗi tải đã báo qua sự kiện 'error'
      }
      else await this.checkGithub();
    } catch (e) {
      this.fail(e);
    }
    return this.state;
  }

  async checkGithub() {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Termora' },
    });
    if (!r.ok) throw new Error('GitHub trả về HTTP ' + r.status);
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (cmpVer(version, this.current) <= 0) return this.set({ status: 'none', version });
    const asset = (rel.assets || []).find((a) => /portable.*\.exe$/i.test(a.name));
    if (this.mode !== 'portable' || !asset) return this.set({ status: 'available', version, url: rel.html_url });
    await this.downloadPortable(asset, version);
  }

  async downloadPortable(asset, version) {
    const dir = path.join(app.getPath('temp'), 'termora-update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, asset.name);
    const tmp = file + '.part';
    const digest = String(asset.digest || '');
    // Đã tải ở lần chạy trước mà chưa cài: dùng lại nếu còn nguyên.
    if (fs.existsSync(file) && fs.statSync(file).size === asset.size && (!digest.startsWith('sha256:') || (await sha256(file)) === digest.slice(7))) {
      this.downloaded = file;
      return this.set({ status: 'ready', version, percent: 100 });
    }
    this.set({ status: 'downloading', version, percent: 0 });
    const res = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Termora' } });
    if (!res.ok) throw new Error('Tải bản mới lỗi HTTP ' + res.status);
    const total = asset.size || Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    let got = 0, pct = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise((ok) => out.once('drain', ok));
        const p = total ? Math.floor((got / total) * 100) : 0;
        if (p !== pct) { pct = p; this.set({ percent: p }); }
      }
    } finally {
      await new Promise((ok) => out.end(ok));
    }
    if (total && got !== total) throw new Error('File tải về không đủ dung lượng');
    if (digest.startsWith('sha256:') && digest.slice(7) !== hash.digest('hex')) {
      fs.rmSync(tmp, { force: true });
      throw new Error('File tải về sai checksum');
    }
    fs.renameSync(tmp, file);
    this.downloaded = file;
    this.set({ status: 'ready', version, percent: 100 });
  }

  // Thoát app và cài bản đã tải.
  install() {
    if (this.state.status !== 'ready') return false;
    if (this.mode === 'installer') {
      setImmediate(() => this.au.quitAndInstall(true, true));
      return true;
    }
    const script = path.join(path.dirname(this.downloaded), 'apply.cmd');
    fs.writeFileSync(script, APPLY_CMD, 'ascii');
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, TERMORA_SRC: this.downloaded, TERMORA_DST: this.portableFile },
    }).unref();
    setImmediate(() => app.quit());
    return true;
  }
}

module.exports = { Updater, cmpVer };
