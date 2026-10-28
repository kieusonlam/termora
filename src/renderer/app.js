/* global Terminal, FitAddon, WebLinksAddon, SearchAddon */
const COLORS = ['', '#4fd1a5', '#5aa9ff', '#c792ea', '#ffcb6b', '#ff8a65', '#f07178', '#89ddff'];

const TERM_THEME = {
  background: '#0b0e14',
  foreground: '#d7dde8',
  cursor: '#4fd1a5',
  cursorAccent: '#0b0e14',
  selectionBackground: 'rgba(79, 209, 165, 0.28)',
  black: '#1c222d', red: '#f07178', green: '#a6d189', yellow: '#ffcb6b',
  blue: '#6cb6ff', magenta: '#c792ea', cyan: '#89ddff', white: '#c8d0dc',
  brightBlack: '#5c6773', brightRed: '#ff8f97', brightGreen: '#c3e88d', brightYellow: '#ffe08a',
  brightBlue: '#9ccfff', brightMagenta: '#e0b3ff', brightCyan: '#b2ecff', brightWhite: '#ffffff',
};

const App = {
  sessions: [],
  keys: [],
  settings: {},
  tabs: [],
  active: null,
  selectedSession: null,
  collapsed: new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')),

  async init() {
    hydrateIcons();
    $('#btn-sidebar').innerHTML = icon('sidebar', 16);
    $('#btn-newtab').innerHTML = icon('plus', 16);
    $('#btn-new-session').innerHTML = icon('plus', 16);
    this.settings = await api.settings.get();
    if (this.settings.sidebarWidth) document.documentElement.style.setProperty('--side-w', this.settings.sidebarWidth + 'px');
    if (this.settings.sidebarHidden) document.body.classList.add('no-sidebar');
    await Promise.all([this.loadSessions(), this.loadKeys()]);
    this.bind();
    this.renderTabs();
    this.showWelcome();
  },

  async loadSessions() {
    this.sessions = await api.sessions.list();
    this.renderTree();
    this.renderRecent();
  },

  async loadKeys() {
    this.keys = await api.keys.list();
  },

  async saveSettings(patch) {
    this.settings = await api.settings.set(patch);
  },

  groups() {
    const set = new Set();
    for (const s of this.sessions) if (s.group) {
      const parts = s.group.split('/');
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  },

  // ---------- Sidebar ----------
  renderTree() {
    const tree = $('#session-tree');
    const q = $('#session-search').value.trim().toLowerCase();
    const openIds = new Set(this.tabs.filter((t) => t.state === 'connected').map((t) => t.sessionId));
    const row = (s, depth) => `
      <div class="srow ${this.selectedSession === s.id ? 'sel' : ''}" data-id="${s.id}" draggable="true" style="--depth:${depth}">
        <span class="sdot" style="${s.color ? `background:${s.color}` : ''}"></span>
        <span class="sname">${esc(s.name)}</span>
        <span class="smeta">${esc(s.username ? s.username + '@' : '')}${esc(s.host)}${s.port && s.port !== 22 ? ':' + s.port : ''}</span>
        ${openIds.has(s.id) ? '<span class="slive" title="Đang kết nối"></span>' : ''}
        ${s.authType === 'key' ? `<span class="sauth" title="Đăng nhập bằng SSH key">${icon('key', 12)}</span>` : ''}
      </div>`;

    if (!this.sessions.length) {
      tree.innerHTML = `<div class="tree-empty">
        <p>Chưa có session nào.</p>
        <button class="btn primary sm" data-empty="new">Tạo session</button>
        <button class="btn sm" data-empty="import">Import session</button></div>`;
      return;
    }
    if (q) {
      const hits = this.sessions.filter((s) =>
        [s.name, s.host, s.username, s.group, s.notes].some((v) => (v || '').toLowerCase().includes(q))
      );
      tree.innerHTML = hits.length ? hits.map((s) => row(s, 0)).join('') : '<div class="tree-empty"><p>Không tìm thấy</p></div>';
      if (hits.length && !hits.some((h) => h.id === this.selectedSession)) this.selectedSession = hits[0].id;
      this.paintTreeSel();
      return;
    }
    // Dựng cây theo group "a/b/c"
    const root = { children: new Map(), items: [] };
    for (const s of this.sessions) {
      let node = root;
      let acc = '';
      for (const part of (s.group || '').split('/').filter(Boolean)) {
        acc = acc ? acc + '/' + part : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path: acc, children: new Map(), items: [] });
        node = node.children.get(part);
      }
      node.items.push(s);
    }
    const count = (n) => n.items.length + [...n.children.values()].reduce((a, c) => a + count(c), 0);
    const sortS = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
    const renderNode = (n, depth) => {
      let html = '';
      for (const c of [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const col = this.collapsed.has(c.path);
        html += `<div class="grow ${col ? 'collapsed' : ''}" data-group="${esc(c.path)}" style="--depth:${depth}">
          <span class="chev">${icon('chevron', 12)}</span>${icon(col ? 'folder' : 'folderOpen', 14)}
          <span class="gname">${esc(c.name)}</span><span class="gcount">${count(c)}</span></div>`;
        if (!col) html += renderNode(c, depth + 1);
      }
      html += n.items.sort(sortS).map((s) => row(s, depth)).join('');
      return html;
    };
    tree.innerHTML = renderNode(root, 0) + '<div class="tree-root-drop" data-group=""></div>';
  },

  paintTreeSel() {
    $$('#session-tree .srow').forEach((r) => r.classList.toggle('sel', r.dataset.id === this.selectedSession));
  },

  renderRecent() {
    const box = $('#recent');
    const list = [...this.sessions].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8);
    if (!list.length) {
      box.innerHTML = `<div class="recent-empty muted">Chưa có session. <button class="linkbtn" data-act="new">Tạo session đầu tiên</button> hoặc <button class="linkbtn" data-act="import">import session có sẵn</button>.</div>`;
      return;
    }
    box.innerHTML = list.map((s) => `
      <button class="rcard" data-id="${s.id}">
        <span class="rcard-bar" style="${s.color ? `background:${s.color}` : ''}"></span>
        <span class="rcard-name">${esc(s.name)}</span>
        <span class="rcard-host mono">${esc(s.username ? s.username + '@' : '')}${esc(s.host)}</span>
        <span class="rcard-time muted">${timeAgo(s.lastUsed)}</span>
      </button>`).join('');
  },

  sessionMenu(s, x, y) {
    showMenu(x, y, [
      { label: 'Kết nối', icon: 'play', kbd: 'Enter', onClick: () => this.openSession(s) },
      { label: 'Sửa', icon: 'edit', kbd: 'F2', onClick: () => this.editSession(s) },
      { label: 'Nhân bản', icon: 'copy', onClick: async () => { await api.sessions.duplicate(s.id); this.loadSessions(); } },
      { label: 'Copy lệnh ssh', icon: 'terminal', onClick: () => api.util.clipboardWrite(`ssh ${s.port && s.port !== 22 ? `-p ${s.port} ` : ''}${s.username ? s.username + '@' : ''}${s.host}`).then(() => toast('Đã copy', 'ok')) },
      '-',
      { label: 'Xoá', icon: 'trash', kbd: 'Del', danger: true, onClick: () => this.deleteSession(s) },
    ]);
  },

  async deleteSession(s) {
    if (!(await uiConfirm({ title: 'Xoá session?', message: `Xoá <b>${esc(s.name)}</b> (${esc(s.host)}). Mật khẩu đã lưu cũng bị xoá.`, okLabel: 'Xoá', danger: true }))) return;
    await api.sessions.remove(s.id);
    this.loadSessions();
  },

  // ---------- Session editor ----------
  editSession(s = {}, { group } = {}) {
    const isNew = !s.id;
    const keyOpts = () => this.keys.map((k) => `<option value="${k.id}" ${s.keyId === k.id ? 'selected' : ''}>${esc(k.name)} · ${esc(k.type)}</option>`).join('');
    const body = el(`
      <form class="form session-form" autocomplete="off">
        <div class="grid2">
          <label class="field span2"><span>Host / IP</span><input name="host" value="${esc(s.host || '')}" placeholder="203.0.113.10 hoặc server.example.com" spellcheck="false" autofocus /></label>
          <label class="field"><span>Username</span><input name="username" value="${esc(s.username || '')}" placeholder="root" spellcheck="false" /></label>
          <label class="field"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${esc(s.port || 22)}" /></label>
        </div>
        <div class="field"><span>Xác thực</span>
          <div class="seg" data-name="authType">
            <button type="button" data-v="password">${icon('lock', 14)} Mật khẩu</button>
            <button type="button" data-v="key">${icon('key', 14)} SSH key</button>
            <button type="button" data-v="agent">${icon('shield', 14)} SSH agent</button>
          </div>
        </div>
        <div class="auth-pane" data-pane="password">
          <label class="field"><span>Mật khẩu ${s.hasPassword ? '<em class="saved-tag">đã lưu</em>' : ''}</span>
            <div class="pw-wrap"><input name="password" type="password" placeholder="${s.hasPassword ? 'Để trống = giữ mật khẩu đã lưu' : 'Để trống = hỏi khi kết nối'}" /><button type="button" class="icon-btn pw-eye" title="Hiện mật khẩu">${icon('eye', 15)}</button></div>
          </label>
          ${s.hasPassword ? '<label class="check"><input type="checkbox" name="clearPassword" /><span>Xoá mật khẩu đã lưu</span></label>' : ''}
          <p class="hint">${icon('shield', 12)} Mật khẩu được mã hoá bằng Windows DPAPI, chỉ tài khoản Windows này giải mã được.</p>
        </div>
        <div class="auth-pane" data-pane="key">
          <label class="field"><span>Key</span>
            <div class="row"><select name="keyId"><option value="">— chọn key —</option>${keyOpts()}</select>
            <button type="button" class="btn sm" data-act="import-key">Import…</button>
            <button type="button" class="btn sm" data-act="gen-key">Tạo mới</button></div>
          </label>
        </div>
        <div class="auth-pane" data-pane="agent"><p class="hint">Dùng key trong OpenSSH Agent của Windows (dịch vụ <code>ssh-agent</code>) hoặc <code>SSH_AUTH_SOCK</code>.</p></div>
        <details class="more" ${isNew ? '' : 'open'}>
          <summary>Tuỳ chọn khác</summary>
          <div class="grid2">
            <label class="field"><span>Tên hiển thị</span><input name="name" value="${esc(s.name || '')}" placeholder="Tự đặt theo user@host" /></label>
            <label class="field"><span>Thư mục (nhóm)</span><input name="group" list="group-list" value="${esc(s.group ?? group ?? '')}" placeholder="vd: Khách hàng/Potech" /><datalist id="group-list">${this.groups().map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
            <label class="field span2"><span>Thư mục SFTP khi mở</span><input name="startDir" value="${esc(s.startDir || '')}" placeholder="Mặc định: home của user" spellcheck="false" /></label>
          </div>
          <label class="check"><input type="checkbox" name="followFolder" ${s.followFolder === true ? 'checked' : ''}/><span>SFTP tự đi theo thư mục hiện tại của terminal</span></label>
          <div class="field"><span>Màu</span><div class="swatches">${COLORS.map((c) => `<button type="button" class="sw ${(s.color || '') === c ? 'on' : ''}" data-c="${c}" style="${c ? `background:${c}` : ''}" title="${c || 'Không màu'}"></button>`).join('')}</div></div>
          <label class="field"><span>Ghi chú</span><textarea name="notes" rows="2">${esc(s.notes || '')}</textarea></label>
        </details>
      </form>`);

    let authType = s.authType || 'password';
    let color = s.color || '';
    const setAuth = (v) => {
      authType = v;
      $$('.seg button', body).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      $$('.auth-pane', body).forEach((p) => (p.hidden = p.dataset.pane !== v));
    };
    setAuth(authType);
    $('.seg', body).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setAuth(b.dataset.v); });
    $('.swatches', body).addEventListener('click', (e) => {
      const b = e.target.closest('.sw'); if (!b) return;
      color = b.dataset.c;
      $$('.sw', body).forEach((x) => x.classList.toggle('on', x === b));
    });
    $('.pw-eye', body).addEventListener('click', () => { const i = $('[name=password]', body); i.type = i.type === 'password' ? 'text' : 'password'; });
    const refreshKeys = (selectId) => {
      const sel = $('[name=keyId]', body);
      sel.innerHTML = '<option value="">— chọn key —</option>' + this.keys.map((k) => `<option value="${k.id}">${esc(k.name)} · ${esc(k.type)}</option>`).join('');
      if (selectId) sel.value = selectId;
    };
    $('[data-act=import-key]', body).addEventListener('click', async () => { const k = await this.importKeyFile(); if (k) refreshKeys(k.id); });
    $('[data-act=gen-key]', body).addEventListener('click', async () => { const k = await this.generateKey(); if (k) refreshKeys(k.id); });

    const collect = () => {
      const f = (n) => $(`[name=${n}]`, body);
      let host = f('host').value.trim();
      let username = f('username').value.trim();
      let port = Number(f('port').value) || 22;
      // Cho phép dán "user@host:port" vào ô host
      const m = host.match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
      if (m) { if (m[1] && !username) username = m[1]; host = m[2]; if (m[3]) port = Number(m[3]); }
      if (!host) { toast('Cần nhập host', 'error'); f('host').focus(); return null; }
      if (authType === 'key' && !f('keyId').value) { toast('Chọn SSH key', 'error'); return null; }
      const out = {
        id: s.id, host, username, port, authType,
        keyId: f('keyId').value,
        name: f('name').value.trim(),
        group: f('group').value.trim().replace(/^\/+|\/+$/g, ''),
        startDir: f('startDir').value.trim(),
        followFolder: f('followFolder').checked,
        color,
        notes: f('notes').value,
      };
      const pw = f('password').value;
      if (pw) out.password = pw;
      else if (f('clearPassword') && f('clearPassword').checked) out.password = '';
      return out;
    };
    const save = async (connect) => {
      const data = collect();
      if (!data) return false;
      const saved = await api.sessions.save(data);
      await this.loadSessions();
      this.selectedSession = saved.id;
      this.paintTreeSel();
      if (connect) this.openSession(saved);
    };
    openModal({
      title: isNew ? 'Session mới' : `Sửa session: ${s.name}`,
      icon: 'server',
      width: 540,
      body,
      actions: [
        { label: 'Huỷ' },
        { label: 'Lưu', onClick: () => save(false) },
        { label: 'Lưu & kết nối', kind: 'primary', onClick: () => save(true) },
      ],
    });
  },

  // ---------- Tabs ----------
  openSession(s) {
    const tab = new Tab({ session: s });
    this.addTab(tab);
  },

  quickConnect(str) {
    const m = str.trim().match(/^(?:ssh\s+)?(?:-p\s*(\d+)\s+)?(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
    if (!m) return toast('Định dạng: user@host:port', 'error');
    const adhoc = { host: m[3], username: m[2] || 'root', port: Number(m[4] || m[1]) || 22, authType: 'password', followFolder: false };
    const existing = this.sessions.find((s) => s.host === adhoc.host && (s.username || '') === adhoc.username && Number(s.port) === adhoc.port);
    if (existing) return this.openSession(existing);
    this.addTab(new Tab({ adhoc }));
  },

  addTab(tab) {
    this.tabs.push(tab);
    this.renderTabs();
    this.activate(tab);
    tab.connect();
  },

  activate(tab) {
    this.active = tab;
    $('#welcome').hidden = true;
    for (const t of this.tabs) t.view.classList.toggle('active', t === tab);
    this.renderTabs();
    requestAnimationFrame(() => { tab.fitTerm(); tab.term.focus(); });
  },

  showWelcome() {
    this.active = null;
    for (const t of this.tabs) t.view.classList.remove('active');
    $('#welcome').hidden = false;
    this.renderTabs();
    this.renderRecent();
    setTimeout(() => $('#quick-input').focus(), 30);
  },

  closeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    tab.dispose();
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      const next = this.tabs[i] || this.tabs[i - 1];
      next ? this.activate(next) : this.showWelcome();
    }
    this.renderTabs();
    this.renderTree();
  },

  renderTabs() {
    const strip = $('#tabstrip');
    strip.innerHTML = this.tabs.map((t, i) => `
      <div class="tab ${t === this.active ? 'active' : ''} st-${t.state}" data-i="${i}" title="${esc(t.subtitle)}" draggable="true">
        <span class="tab-dot" style="${t.color ? `--c:${t.color}` : ''}"></span>
        <span class="tab-title">${esc(t.title)}</span>
        <button class="tab-x" title="Đóng (Ctrl+Shift+W)">${icon('x', 12)}</button>
      </div>`).join('');
    $('#btn-newtab').classList.toggle('active', !this.active);
  },

  // ---------- Keys ----------
  async importKeyFile(opts = {}) {
    try {
      const k = await api.keys.importFile(opts);
      if (!k) return null;
      await this.loadKeys();
      toast(`Đã import key ${k.name}`, 'ok');
      return k;
    } catch (e) {
      if (e.code === 'NEEDPASS') {
        const r = await uiPrompt({ title: 'Key có passphrase', label: e.message === 'Sai passphrase' ? 'Sai passphrase, nhập lại' : 'Passphrase của key', type: 'password', okLabel: 'Import' });
        if (!r) return null;
        return this.importKeyFile({ filePath: e.filePath, passphrase: r.value });
      }
      toast('Không đọc được key: ' + e.message, 'error', 6000);
      return null;
    }
  },

  generateKey() {
    return new Promise((resolve) => {
      let result = null;
      const body = el(`<div class="form">
        <label class="field"><span>Tên / comment</span><input name="name" placeholder="vd: laptop-lam" value="termora-${new Date().toISOString().slice(0, 10)}" /></label>
        <div class="field"><span>Loại</span><div class="seg"><button type="button" class="on" data-v="ed25519">Ed25519 (khuyên dùng)</button><button type="button" data-v="rsa">RSA 4096</button><button type="button" data-v="ecdsa">ECDSA</button></div></div>
        <p class="hint">Private key lưu mã hoá trong app. Sau khi tạo, mở một tab đang kết nối rồi bấm "Cài lên server" để thêm public key vào <code>~/.ssh/authorized_keys</code>.</p>
      </div>`);
      let type = 'ed25519';
      $('.seg', body).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; type = b.dataset.v; $$('.seg button', body).forEach((x) => x.classList.toggle('on', x === b)); });
      openModal({
        title: 'Tạo SSH key mới', icon: 'key', body,
        actions: [{ label: 'Huỷ' }, { label: 'Tạo key', kind: 'primary', onClick: async () => {
          try {
            result = await api.keys.generate({ name: $('[name=name]', body).value.trim(), type });
            await this.loadKeys();
            toast('Đã tạo key ' + result.name, 'ok');
          } catch (e) { toast(e.message, 'error'); return false; }
        } }],
        onClose: () => resolve(result),
      });
    });
  },

  keyManager() {
    const body = el('<div class="keys"><div class="key-actions"></div><div class="key-list"></div></div>');
    const actions = $('.key-actions', body);
    actions.innerHTML = `
      <button class="btn primary sm" data-a="gen">${icon('wand', 14)} Tạo key</button>
      <button class="btn sm" data-a="file">${icon('import', 14)} Import file</button>
      <button class="btn sm" data-a="paste">${icon('copy', 14)} Dán private key</button>`;
    const connected = this.active && this.active.state === 'connected' ? this.active : null;
    const render = () => {
      const list = $('.key-list', body);
      if (!this.keys.length) { list.innerHTML = '<div class="tree-empty"><p>Chưa có key. Tạo mới hoặc import file id_ed25519 / id_rsa / .ppk.</p></div>'; return; }
      list.innerHTML = this.keys.map((k) => {
        const used = this.sessions.filter((s) => s.keyId === k.id).length;
        return `<div class="key-item" data-id="${k.id}">
          <div class="key-main"><span class="key-ico">${icon('key', 16)}</span>
            <div><div class="key-name">${esc(k.name)} <span class="pill">${esc(k.type)}</span>${used ? `<span class="pill muted">${used} session</span>` : ''}</div>
            <div class="key-fp mono muted">${esc(k.fingerprint || '')}</div></div></div>
          <div class="key-btns">
            <button class="btn sm" data-a="copy" title="Copy public key">${icon('copy', 14)} Public key</button>
            ${connected ? `<button class="btn sm" data-a="install" title="Thêm vào ~/.ssh/authorized_keys của ${esc(connected.subtitle)}">${icon('upload', 14)} Cài lên server</button>` : ''}
            <button class="icon-btn" data-a="more" title="Thêm">${icon('more', 16)}</button>
          </div></div>`;
      }).join('');
    };
    render();
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const item = b.closest('.key-item');
      const k = item && this.keys.find((x) => x.id === item.dataset.id);
      const a = b.dataset.a;
      if (a === 'gen') { if (await this.generateKey()) render(); }
      else if (a === 'file') { if (await this.importKeyFile()) render(); }
      else if (a === 'paste') { if (await this.pasteKey()) render(); }
      else if (a === 'copy') { await api.util.clipboardWrite(k.publicKey); toast('Đã copy public key', 'ok'); }
      else if (a === 'install') {
        try { await api.ssh.installKey(connected.id, k.id); toast(`Đã cài key lên ${connected.subtitle}`, 'ok'); }
        catch (err) { toast(err.message, 'error'); }
      } else if (a === 'more') {
        const r = b.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, [
          { label: 'Đổi tên', icon: 'edit', onClick: async () => {
            const p = await uiPrompt({ title: 'Đổi tên key', label: 'Tên', value: k.name });
            if (p && p.value.trim()) { await api.keys.rename(k.id, p.value.trim()); await this.loadKeys(); render(); }
          } },
          { label: 'Xuất private key ra file…', icon: 'export', onClick: async () => {
            const f = await api.keys.exportPrivate(k.id).catch((err) => toast(err.message, 'error'));
            if (f) toast('Đã lưu ' + f, 'ok');
          } },
          '-',
          { label: 'Xoá key', icon: 'trash', danger: true, onClick: async () => {
            if (!(await uiConfirm({ title: 'Xoá key?', message: `Xoá <b>${esc(k.name)}</b>. Các session đang dùng key này sẽ phải chọn lại key.`, danger: true, okLabel: 'Xoá' }))) return;
            await api.keys.remove(k.id); await this.loadKeys(); await this.loadSessions(); render();
          } },
        ]);
      }
    });
    openModal({ title: 'SSH keys', icon: 'key', width: 640, body });
  },

  pasteKey() {
    return new Promise((resolve) => {
      let result = null;
      const body = el(`<div class="form">
        <label class="field"><span>Tên</span><input name="name" placeholder="vd: server-key" /></label>
        <label class="field"><span>Private key (OpenSSH / PEM / PuTTY .ppk)</span><textarea name="text" rows="8" class="mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
        <label class="field"><span>Passphrase (nếu có)</span><input name="pass" type="password" /></label></div>`);
      openModal({
        title: 'Dán private key', icon: 'key', width: 560, body,
        actions: [{ label: 'Huỷ' }, { label: 'Lưu key', kind: 'primary', onClick: async () => {
          try {
            result = await api.keys.importText({ name: $('[name=name]', body).value.trim(), text: $('[name=text]', body).value, passphrase: $('[name=pass]', body).value });
            await this.loadKeys();
          } catch (e) { toast('Key không hợp lệ: ' + e.message, 'error', 6000); return false; }
        } }],
        onClose: () => resolve(result),
      });
    });
  },

  // ---------- Import / export ----------
  importDialog() {
    const body = el(`<div class="import-grid">
      <button class="icard" data-k="termora">${icon('import', 22)}<b>File Termora</b><span>.termora export từ máy khác, có thể kèm mật khẩu và key</span></button>
      <button class="icard" data-k="bookmarks">${icon('server', 22)}<b>File .mxtsessions / .ini</b><span>Danh sách bookmark session — lấy host, port, user, thư mục</span></button>
      <button class="icard" data-k="sshconfig">${icon('terminal', 22)}<b>OpenSSH config</b><span>~/.ssh/config, kèm IdentityFile nếu đọc được</span></button>
    </div>
    <p class="hint">Session trùng (cùng tên, host, port, user) sẽ được bỏ qua.</p>`);
    const m = openModal({ title: 'Import sessions', icon: 'import', width: 620, body });
    body.addEventListener('click', async (e) => {
      const c = e.target.closest('[data-k]'); if (!c) return;
      const file = await api.io.pickImport(c.dataset.k);
      if (!file) return;
      m.close();
      this.runImport(file);
    });
  },

  async runImport(file, passphrase) {
    try {
      const r = await api.io.importFile(file, passphrase);
      await Promise.all([this.loadSessions(), this.loadKeys()]);
      const kind = { termora: 'Termora', bookmarks: 'File session', sshconfig: 'SSH config' }[r.kind];
      toast(`${kind}: thêm ${r.added}/${r.total} session${r.skipped ? `, bỏ qua ${r.skipped} trùng` : ''}${r.addedKeys ? `, ${r.addedKeys} key` : ''}`, 'ok', 5000);
    } catch (e) {
      if (e.code === 'NEEDPASS' || e.code === 'BADPASS') {
        const p = await uiPrompt({ title: 'File được mã hoá', label: e.code === 'BADPASS' ? 'Sai passphrase, nhập lại' : 'Passphrase', type: 'password', okLabel: 'Giải mã & import' });
        if (p) return this.runImport(file, p.value);
        return;
      }
      toast('Import lỗi: ' + e.message, 'error', 6000);
    }
  },

  exportDialog() {
    const body = el(`<div class="form">
      <label class="check"><input type="checkbox" name="secrets" checked /><span>Kèm mật khẩu đã lưu</span></label>
      <label class="check"><input type="checkbox" name="keys" checked /><span>Kèm SSH key (private key)</span></label>
      <div class="pass-block">
        <label class="field"><span>Passphrase bảo vệ file</span><input name="p1" type="password" placeholder="Bắt buộc khi kèm mật khẩu / key" /></label>
        <label class="field"><span>Nhập lại passphrase</span><input name="p2" type="password" /></label>
        <p class="hint">${icon('shield', 12)} File được mã hoá AES-256-GCM. Mất passphrase thì không mở lại được.</p>
      </div>
      <p class="hint">${this.sessions.length} session · ${this.keys.length} key</p>
    </div>`);
    const f = (n) => $(`[name=${n}]`, body);
    openModal({
      title: 'Export sessions', icon: 'export', body,
      actions: [{ label: 'Huỷ' }, { label: 'Chọn nơi lưu…', kind: 'primary', onClick: async () => {
        const includeSecrets = f('secrets').checked, includeKeys = f('keys').checked;
        const p1 = f('p1').value, p2 = f('p2').value;
        if ((includeSecrets || includeKeys) && !p1) { toast('Cần passphrase khi export kèm mật khẩu hoặc key', 'error'); f('p1').focus(); return false; }
        if (p1 !== p2) { toast('Hai passphrase không khớp', 'error'); f('p2').focus(); return false; }
        try {
          const r = await api.io.exportTo({ includeSecrets, includeKeys, passphrase: p1 });
          if (!r) return false;
          toast(`Đã export ${r.sessions} session, ${r.keys} key`, 'ok');
          api.util.showItem(r.file);
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
  },

  // ---------- Settings ----------
  settingsDialog() {
    const s = this.settings;
    const body = el(`<div class="form">
      <div class="grid2">
        <label class="field"><span>Cỡ chữ terminal</span><input name="fontSize" type="number" min="9" max="28" value="${s.fontSize}" /></label>
        <label class="field"><span>Số dòng lưu lại (scrollback)</span><input name="scrollback" type="number" min="1000" step="1000" value="${s.scrollback}" /></label>
        <label class="field span2"><span>Font terminal</span><input name="fontFamily" value="${esc(s.fontFamily)}" spellcheck="false" /></label>
      </div>
      <label class="check"><input type="checkbox" name="copyOnSelect" ${s.copyOnSelect ? 'checked' : ''}/><span>Bôi đen là copy</span></label>
      <label class="check"><input type="checkbox" name="rightClickPaste" ${s.rightClickPaste ? 'checked' : ''}/><span>Chuột phải để dán (giống PuTTY)</span></label>
      <label class="check"><input type="checkbox" name="cursorBlink" ${s.cursorBlink ? 'checked' : ''}/><span>Con trỏ nhấp nháy</span></label>
      <label class="check"><input type="checkbox" name="monitor" ${s.monitor ? 'checked' : ''}/><span>Theo dõi CPU / RAM / mạng / ổ đĩa của server ở thanh trạng thái</span></label>
      <p class="hint">Phím tắt: Ctrl+Shift+K tìm session · Ctrl+Shift+B ẩn sidebar · Ctrl+Shift+F tìm trong terminal · Ctrl+= / Ctrl+- cỡ chữ · Ctrl+C copy khi có vùng chọn · Ctrl+V / Shift+Insert dán</p>
    </div>`);
    openModal({
      title: 'Cài đặt', icon: 'settings', width: 520, body,
      actions: [{ label: 'Đóng' }, { label: 'Lưu', kind: 'primary', onClick: async () => {
        const f = (n) => $(`[name=${n}]`, body);
        await this.saveSettings({
          fontSize: Math.max(9, Math.min(28, Number(f('fontSize').value) || 14)),
          scrollback: Math.max(1000, Number(f('scrollback').value) || 10000),
          fontFamily: f('fontFamily').value.trim() || s.fontFamily,
          copyOnSelect: f('copyOnSelect').checked,
          rightClickPaste: f('rightClickPaste').checked,
          cursorBlink: f('cursorBlink').checked,
          monitor: f('monitor').checked,
        });
        for (const t of this.tabs) t.applySettings();
      } }],
    });
  },

  // ---------- Hỏi từ main process ----------
  onAsk({ reqId, tabId, kind, payload }) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (kind === 'hostkey') {
      const changed = !!payload.previous;
      const body = el(`<div class="hostkey">
        ${changed
          ? `<div class="warn-box">${icon('alert', 18)}<div><b>Host key đã thay đổi!</b><br>Có thể server được cài lại — hoặc ai đó đang chặn giữa đường (MITM). Chỉ tiếp tục nếu bạn biết chắc lý do.</div></div>`
          : `<p>Lần đầu kết nối tới <b class="mono">${esc(payload.host)}</b>. Kiểm tra fingerprint dưới đây khớp với server rồi mới tin cậy.</p>`}
        <div class="fp"><span class="muted">${esc(payload.keyType)}</span><code>${esc(payload.fingerprint)}</code></div>
        ${changed ? `<div class="fp old"><span class="muted">Trước đây</span><code>${esc(payload.previous)}</code></div>` : ''}
      </div>`);
      let answered = false;
      openModal({
        title: changed ? 'Cảnh báo bảo mật' : 'Xác nhận server mới',
        icon: changed ? 'alert' : 'shield', tone: changed ? 'danger' : undefined, width: 520, body,
        actions: [
          { label: 'Huỷ', onClick: () => { answered = true; api.reply(reqId, false); } },
          { label: changed ? 'Vẫn kết nối & cập nhật key' : 'Tin cậy & kết nối', kind: changed ? 'danger' : 'primary', onClick: () => { answered = true; api.reply(reqId, true); } },
        ],
        onClose: () => { if (!answered) api.reply(reqId, false); },
      });
    } else if (kind === 'conflict') {
      const n = payload.names.length;
      const list = payload.names.slice(0, 8).map((x) => `<li><code>${esc(x)}</code></li>`).join('') + (n > 8 ? `<li class="muted">… và ${n - 8} mục khác</li>` : '');
      let answered = false;
      const answer = (v) => { answered = true; api.reply(reqId, v); };
      openModal({
        title: `${n} mục đã có sẵn`,
        icon: 'alert',
        width: 500,
        body: `<p class="confirm-msg">Trong <code>${esc(payload.where)}</code> ${payload.kind === 'upload' ? 'trên server' : 'trên máy'} đã có:</p><ul class="det-list">${list}</ul><p class="hint">Với thư mục, "Ghi đè" là gộp vào thư mục cũ và thay các file trùng tên.</p>`,
        actions: [
          { label: 'Huỷ', onClick: () => answer('cancel') },
          { label: 'Bỏ qua mục trùng', onClick: () => answer('skip') },
          { label: 'Ghi đè', kind: 'danger', onClick: () => answer('overwrite') },
        ],
        onClose: () => { if (!answered) api.reply(reqId, 'cancel'); },
      });
    } else if (kind === 'kbd') {
      const body = el(`<div class="form">
        ${payload.instructions ? `<p>${esc(payload.instructions)}</p>` : ''}
        ${payload.prompts.map((p, i) => `<label class="field"><span>${esc(p.prompt)}</span><input data-i="${i}" type="${p.echo ? 'text' : 'password'}" /></label>`).join('')}
      </div>`);
      let answered = false;
      openModal({
        title: payload.name || `Xác thực ${tab ? tab.subtitle : ''}`, icon: 'lock', body,
        actions: [
          { label: 'Huỷ', onClick: () => { answered = true; api.reply(reqId, null); } },
          { label: 'Gửi', kind: 'primary', onClick: () => { answered = true; api.reply(reqId, $$('input', body).map((i) => i.value)); } },
        ],
        onClose: () => { if (!answered) api.reply(reqId, null); },
      });
    }
  },

  // ---------- Transfers ----------
  transferEls: new Map(),
  onTransfer({ job }) {
    const box = $('#transfers');
    let row = this.transferEls.get(job.id);
    if (!row) {
      row = el(`<div class="xfer"><span class="xfer-ico"></span><div class="xfer-main"><div class="xfer-top"><span class="xfer-name"></span><span class="xfer-pct"></span></div><div class="bar"><i></i></div><div class="xfer-sub muted"></div></div></div>`);
      $('.xfer-ico', row).innerHTML = icon(job.kind === 'upload' ? 'upload' : 'download', 16);
      box.appendChild(row);
      this.transferEls.set(job.id, row);
    }
    const pct = job.total ? Math.min(100, (job.done / job.total) * 100) : job.state === 'done' ? 100 : 0;
    const secs = (Date.now() - job.startedAt) / 1000;
    const speed = secs > 0.3 ? job.done / secs : 0;
    $('.xfer-name', row).textContent = (job.kind === 'upload' ? 'Upload ' : 'Tải ') + job.label;
    $('.xfer-pct', row).textContent = { error: 'Lỗi', partial: 'Xong một phần', done: 'Xong' }[job.state] || pct.toFixed(0) + '%';
    $('.bar i', row).style.width = pct + '%';
    const notes = [];
    if (job.renamed && job.renamed.length) notes.push(`đổi tên ${job.renamed.length} file cho hợp lệ trên Windows`);
    if (job.skipped && job.skipped.length) notes.push(`bỏ qua ${job.skipped.length} symlink/file đặc biệt`);
    $('.xfer-sub', row).textContent = job.error && job.state !== 'running'
      ? job.error
      : `${job.filesDone}/${job.files} file · ${fmtBytes(job.done)} / ${fmtBytes(job.total)}${speed && job.state === 'running' ? ' · ' + fmtRate(speed) : ''}${notes.length ? ' · ' + notes.join(', ') : ''}`;
    row.className = 'xfer ' + job.state;
    if (job.state === 'running') return;
    // Kết thúc: thêm nút xem chi tiết / mở thư mục; có lỗi thì giữ lại tới khi người dùng đóng.
    const acts = el('<div class="xfer-acts"></div>');
    if (job.failed.length || job.renamed.length || job.skipped.length) {
      const b = el('<button class="linkbtn">Chi tiết</button>');
      b.addEventListener('click', () => this.transferDetails(job));
      acts.appendChild(b);
    }
    if (job.kind === 'download' && job.filesDone && job.localDir) {
      const b = el('<button class="linkbtn">Mở thư mục</button>');
      b.addEventListener('click', () => api.util.openPath(job.localDir));
      acts.appendChild(b);
    }
    const close = el(`<button class="icon-btn xfer-x" title="Đóng">${icon('x', 13)}</button>`);
    const dismiss = () => { row.classList.add('leaving'); setTimeout(() => { row.remove(); this.transferEls.delete(job.id); }, 250); };
    close.addEventListener('click', dismiss);
    if (acts.children.length) $('.xfer-main', row).appendChild(acts);
    row.appendChild(close);
    if (job.state === 'done') setTimeout(dismiss, acts.children.length ? 8000 : 3500);
  },

  transferDetails(job) {
    const sect = (title, items, fmt) => items.length
      ? `<h4 class="det-h">${title} (${items.length})</h4><ul class="det-list mono">${items.slice(0, 200).map((x) => `<li>${fmt(x)}</li>`).join('')}${items.length > 200 ? `<li class="muted">… và ${items.length - 200} mục khác</li>` : ''}</ul>`
      : '';
    openModal({
      title: `${job.kind === 'upload' ? 'Upload' : 'Tải xuống'}: ${job.label}`,
      icon: job.failed.length ? 'alert' : 'check',
      width: 620,
      body: `<p class="muted">${job.filesDone}/${job.files} file thành công · ${fmtBytes(job.done)}</p>` +
        sect('Lỗi', job.failed, (f) => `${esc(f.name)} <span class="err">— ${esc(f.error)}</span>`) +
        sect('Đổi tên cho hợp lệ trên Windows', job.renamed, (r) => esc(r)) +
        sect('Bỏ qua (symlink thư mục, socket, FIFO…)', job.skipped, (p) => esc(p)),
      actions: [{ label: 'Đóng', kind: 'primary' }],
    });
  },

  // ---------- Bind ----------
  bind() {
    api.on.data(({ tabId, data }) => this.tabById(tabId)?.term.write(data));
    api.on.status((p) => this.tabById(p.tabId)?.onStatus(p));
    api.on.sftpStatus((p) => this.tabById(p.tabId)?.onSftpStatus(p));
    api.on.monitor((p) => this.tabById(p.tabId)?.onMonitor(p.stat));
    api.on.transfer((p) => this.onTransfer(p));
    api.on.toast((p) => toast(p.message, p.kind));
    api.on.ask((p) => this.onAsk(p));

    $('#btn-sidebar').addEventListener('click', () => this.toggleSidebar());
    $('#btn-newtab').addEventListener('click', () => this.showWelcome());
    $('#btn-new-session').addEventListener('click', () => this.editSession());
    $('#btn-keys').addEventListener('click', () => this.keyManager());
    $('#btn-import').addEventListener('click', () => this.importDialog());
    $('#btn-export').addEventListener('click', () => this.exportDialog());
    $('#btn-settings').addEventListener('click', () => this.settingsDialog());
    $('#quick-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#quick-input').value; if (v.trim()) { this.quickConnect(v); $('#quick-input').value = ''; } });
    $('#recent').addEventListener('click', (e) => {
      const c = e.target.closest('[data-id]');
      if (c) return this.openSession(this.sessions.find((s) => s.id === c.dataset.id));
      const a = e.target.closest('[data-act]');
      if (a) a.dataset.act === 'new' ? this.editSession() : this.importDialog();
    });

    // Session tree
    const tree = $('#session-tree');
    const sessionOf = (e) => { const r = e.target.closest('.srow'); return r && this.sessions.find((s) => s.id === r.dataset.id); };
    tree.addEventListener('click', (e) => {
      const g = e.target.closest('.grow');
      if (g) {
        const p = g.dataset.group;
        this.collapsed.has(p) ? this.collapsed.delete(p) : this.collapsed.add(p);
        localStorage.setItem('collapsed', JSON.stringify([...this.collapsed]));
        return this.renderTree();
      }
      const emp = e.target.closest('[data-empty]');
      if (emp) return emp.dataset.empty === 'new' ? this.editSession() : this.importDialog();
      const s = sessionOf(e);
      if (s) { this.selectedSession = s.id; this.paintTreeSel(); }
    });
    tree.addEventListener('dblclick', (e) => { const s = sessionOf(e); if (s) this.openSession(s); });
    tree.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const s = sessionOf(e);
      if (s) { this.selectedSession = s.id; this.paintTreeSel(); return this.sessionMenu(s, e.clientX, e.clientY); }
      const g = e.target.closest('.grow');
      if (g) {
        const path = g.dataset.group;
        return showMenu(e.clientX, e.clientY, [
          { label: 'Session mới trong thư mục này', icon: 'plus', onClick: () => this.editSession({}, { group: path }) },
          { label: 'Đổi tên thư mục', icon: 'edit', onClick: async () => {
            const r = await uiPrompt({ title: 'Đổi tên thư mục', label: 'Đường dẫn thư mục', value: path });
            if (r && r.value.trim() && r.value.trim() !== path) { await api.sessions.renameGroup(path, r.value.trim().replace(/^\/+|\/+$/g, '')); this.loadSessions(); }
          } },
          { label: 'Bỏ thư mục (giữ session)', icon: 'folder', onClick: async () => {
            const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            await api.sessions.renameGroup(path, parent); this.loadSessions();
          } },
        ]);
      }
      showMenu(e.clientX, e.clientY, [
        { label: 'Session mới', icon: 'plus', onClick: () => this.editSession() },
        { label: 'Import…', icon: 'import', onClick: () => this.importDialog() },
      ]);
    });
    tree.addEventListener('keydown', (e) => {
      const visible = $$('.srow', tree);
      const idx = visible.findIndex((r) => r.dataset.id === this.selectedSession);
      const s = this.sessions.find((x) => x.id === this.selectedSession);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = visible[Math.max(0, Math.min(visible.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) { this.selectedSession = n.dataset.id; this.paintTreeSel(); n.scrollIntoView({ block: 'nearest' }); }
      } else if (e.key === 'Enter' && s) this.openSession(s);
      else if (e.key === 'F2' && s) this.editSession(s);
      else if (e.key === 'Delete' && s) this.deleteSession(s);
    });
    // Kéo session vào thư mục
    tree.addEventListener('dragstart', (e) => { const r = e.target.closest('.srow'); if (r) { e.dataTransfer.setData('text/x-session', r.dataset.id); e.dataTransfer.effectAllowed = 'move'; } });
    tree.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/x-session')) return;
      const g = e.target.closest('[data-group]');
      $$('.drop-on', tree).forEach((x) => x.classList.remove('drop-on'));
      if (g) { e.preventDefault(); g.classList.add('drop-on'); }
    });
    tree.addEventListener('dragleave', (e) => { const g = e.target.closest('[data-group]'); g && g.classList.remove('drop-on'); });
    tree.addEventListener('drop', async (e) => {
      const g = e.target.closest('[data-group]');
      const id = e.dataTransfer.getData('text/x-session');
      $$('.drop-on', tree).forEach((x) => x.classList.remove('drop-on'));
      if (!g || !id) return;
      e.preventDefault();
      await api.sessions.save({ id, group: g.dataset.group });
      this.loadSessions();
    });

    const search = $('#session-search');
    search.addEventListener('input', () => this.renderTree());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const s = this.sessions.find((x) => x.id === this.selectedSession); if (s && search.value) { this.openSession(s); search.value = ''; this.renderTree(); } }
      if (e.key === 'Escape') { search.value = ''; this.renderTree(); search.blur(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { tree.focus(); tree.dispatchEvent(new KeyboardEvent('keydown', { key: e.key })); e.preventDefault(); }
    });

    // Tabs
    const strip = $('#tabstrip');
    strip.addEventListener('mousedown', (e) => {
      const t = e.target.closest('.tab'); if (!t) return;
      const tab = this.tabs[Number(t.dataset.i)];
      if (e.button === 1) { e.preventDefault(); return this.closeTab(tab); }
      if (e.target.closest('.tab-x')) return;
      if (e.button === 0) this.activate(tab);
    });
    strip.addEventListener('click', (e) => { if (e.target.closest('.tab-x')) this.closeTab(this.tabs[Number(e.target.closest('.tab').dataset.i)]); });
    strip.addEventListener('contextmenu', (e) => {
      const t = e.target.closest('.tab'); if (!t) return;
      e.preventDefault();
      const tab = this.tabs[Number(t.dataset.i)];
      showMenu(e.clientX, e.clientY, [
        { label: 'Nhân bản tab', icon: 'copy', onClick: () => this.addTab(new Tab({ session: tab.session, adhoc: tab.adhoc, password: tab.password })) },
        { label: 'Kết nối lại', icon: 'refresh', onClick: () => tab.connect() },
        tab.adhoc ? { label: 'Lưu thành session', icon: 'server', onClick: () => this.editSession({ ...tab.adhoc }) } : null,
        '-',
        { label: 'Đóng tab', icon: 'x', onClick: () => this.closeTab(tab) },
        { label: 'Đóng các tab khác', onClick: () => this.tabs.filter((x) => x !== tab).forEach((x) => this.closeTab(x)) },
      ]);
    });
    let dragTab = null;
    strip.addEventListener('dragstart', (e) => { const t = e.target.closest('.tab'); if (t) { dragTab = this.tabs[Number(t.dataset.i)]; e.dataTransfer.effectAllowed = 'move'; } });
    strip.addEventListener('dragover', (e) => { if (dragTab) e.preventDefault(); });
    strip.addEventListener('drop', (e) => {
      const t = e.target.closest('.tab');
      if (!dragTab || !t) return;
      const to = Number(t.dataset.i);
      this.tabs.splice(this.tabs.indexOf(dragTab), 1);
      this.tabs.splice(to, 0, dragTab);
      dragTab = null;
      this.renderTabs();
    });
    strip.addEventListener('dragend', () => (dragTab = null));
    strip.addEventListener('wheel', (e) => { strip.scrollLeft += e.deltaY; });

    // Kéo rộng sidebar
    const res = $('#side-resizer');
    res.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add('resizing');
      const move = (ev) => document.documentElement.style.setProperty('--side-w', Math.max(200, Math.min(480, ev.clientX)) + 'px');
      const up = (ev) => {
        document.body.classList.remove('resizing');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.saveSettings({ sidebarWidth: Math.max(200, Math.min(480, ev.clientX)) });
        this.active && this.active.fitTerm();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    document.addEventListener('keydown', (e) => this.onGlobalKey(e));
    window.addEventListener('resize', () => this.active && this.active.fitTerm());
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  },

  tabById(id) {
    return this.tabs.find((t) => t.id === id);
  },

  toggleSidebar() {
    document.body.classList.toggle('no-sidebar');
    this.saveSettings({ sidebarHidden: document.body.classList.contains('no-sidebar') });
    setTimeout(() => this.active && this.active.fitTerm(), 50);
  },

  onGlobalKey(e) {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape' && closeTopModal()) { e.preventDefault(); return; }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (!this.tabs.length) return;
      const i = this.tabs.indexOf(this.active);
      const n = this.tabs[(i + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length];
      return this.activate(n);
    }
    if (e.ctrlKey && e.shiftKey) {
      if (k === 'k') { e.preventDefault(); document.body.classList.remove('no-sidebar'); $('#session-search').focus(); $('#session-search').select(); }
      else if (k === 'b') { e.preventDefault(); this.toggleSidebar(); }
      else if (k === 't') { e.preventDefault(); this.showWelcome(); }
      else if (k === 'w') { e.preventDefault(); this.active && this.closeTab(this.active); }
      else if (k === 'f') { e.preventDefault(); this.active && this.active.openSearch(); }
    }
    if (e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key) && !e.altKey) {
      const t = this.tabs[Number(e.key) - 1];
      if (t) { e.preventDefault(); this.activate(t); }
    }
  },
};

// ======================= Tab =======================
let tabSeq = 0;

class Tab {
  constructor({ session, adhoc, password }) {
    this.id = 't' + Date.now().toString(36) + (++tabSeq);
    this.session = session || null;
    this.adhoc = adhoc || null;
    this.sessionId = session ? session.id : null;
    const s = session || adhoc;
    this.title = session ? session.name : `${adhoc.username}@${adhoc.host}`;
    this.subtitle = `${s.username ? s.username + '@' : ''}${s.host}${s.port && Number(s.port) !== 22 ? ':' + s.port : ''}`;
    this.color = s.color || '';
    this.follow = s.followFolder === true;
    this.password = password; // chỉ giữ trong RAM để kết nối lại
    this.state = 'idle';
    this.sftpVisible = App.settings.sftpVisible !== false;
    this.buildView();
  }

  buildView() {
    const v = el(`
      <div class="view">
        <div class="view-main">
          <div class="term-area">
            <div class="term"></div>
            <div class="term-search" hidden>
              <input placeholder="Tìm trong terminal…" spellcheck="false" />
              <button class="icon-btn" data-s="prev" title="Trước (Shift+Enter)">${icon('up', 14)}</button>
              <button class="icon-btn" data-s="next" title="Sau (Enter)">${icon('arrowDown', 14)}</button>
              <button class="icon-btn" data-s="close" title="Đóng (Esc)">${icon('x', 14)}</button>
            </div>
            <div class="conn-overlay">
              <div class="conn-card">
                <div class="spinner"></div>
                <div class="conn-text">Đang kết nối…</div>
                <div class="conn-sub mono muted"></div>
                <div class="conn-actions" hidden>
                  <button class="btn primary sm" data-c="retry">${icon('refresh', 14)} Kết nối lại</button>
                  <button class="btn sm" data-c="edit">${icon('edit', 14)} Sửa session</button>
                  <button class="btn sm" data-c="close">Đóng tab</button>
                </div>
              </div>
            </div>
            <div class="closed-bar" hidden>
              <span>${icon('plug', 14)} Mất kết nối</span>
              <button class="btn primary sm" data-c="retry">Kết nối lại <kbd>R</kbd></button>
            </div>
          </div>
          <div class="splitter" title="Kéo để đổi độ rộng"></div>
          <aside class="sftp"></aside>
        </div>
        <footer class="statusbar">
          <span class="sb-host"><span class="sb-dot"></span><span class="mono">${esc(this.subtitle)}</span></span>
          <span class="sb-stats"></span>
          <span class="sb-fill"></span>
          <button class="sb-btn" data-sb="sftp" title="Ẩn/hiện SFTP">${icon('panelRight', 14)} SFTP</button>
        </footer>
      </div>`);
    this.view = v;
    $('#views').appendChild(v);
    this.termEl = $('.term', v);
    this.overlay = $('.conn-overlay', v);
    this.closedBar = $('.closed-bar', v);
    this.sftpEl = $('.sftp', v);
    this.sftp = new SftpPanel(this, this.sftpEl);
    this.applySftpLayout();

    const st = App.settings;
    this.term = new Terminal({
      fontFamily: st.fontFamily,
      fontSize: st.fontSize,
      lineHeight: 1.15,
      cursorBlink: st.cursorBlink,
      cursorStyle: 'bar',
      scrollback: st.scrollback,
      theme: TERM_THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
    });
    this.fit = new FitAddon.FitAddon();
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => { if (e.ctrlKey) api.util.openExternal(uri); }));
    this.term.open(this.termEl);

    this.term.onData((d) => {
      if (this.state === 'connected') {
        api.ssh.write(this.id, d);
        if (this.follow && d.includes('\r')) this.checkCwd();
      } else if (this.state === 'closed' && (d === 'r' || d === 'R' || d === '\r')) {
        this.connect();
      }
    });
    this.term.onResize(({ cols, rows }) => { if (this.state === 'connected') api.ssh.resize(this.id, cols, rows); });
    this.term.onSelectionChange(() => {
      if (App.settings.copyOnSelect && this.term.hasSelection()) api.util.clipboardWrite(this.term.getSelection());
    });
    // OSC 7 (shell tự báo thư mục hiện tại) — dùng nếu server có cấu hình sẵn
    this.term.parser.registerOscHandler(7, (data) => {
      try {
        const p = decodeURIComponent(new URL(data).pathname);
        if (this.follow && p && p !== this.sftp.path) this.sftp.load(p, { quiet: true });
      } catch {}
      return true;
    });
    this.term.attachCustomKeyEventHandler((e) => this.onTermKey(e));
    this.termEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (App.settings.rightClickPaste && !this.term.hasSelection()) return this.paste();
      showMenu(e.clientX, e.clientY, [
        { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', disabled: !this.term.hasSelection(), onClick: () => this.copy() },
        { label: 'Dán', icon: 'download', kbd: 'Ctrl+V', onClick: () => this.paste() },
        { label: 'Chọn tất cả', onClick: () => this.term.selectAll() },
        '-',
        { label: 'Tìm…', icon: 'search', kbd: 'Ctrl+Shift+F', onClick: () => this.openSearch() },
        { label: 'Xoá màn hình', onClick: () => this.term.clear() },
        { label: 'Kết nối lại', icon: 'refresh', onClick: () => this.connect() },
      ]);
    });

    this.ro = new ResizeObserver(() => this.fitTerm());
    this.ro.observe(this.termEl);

    v.addEventListener('click', (e) => {
      const c = e.target.closest('[data-c]');
      if (c) {
        if (c.dataset.c === 'retry') this.connect();
        else if (c.dataset.c === 'close') App.closeTab(this);
        else if (c.dataset.c === 'edit') this.session ? App.editSession(App.sessions.find((s) => s.id === this.sessionId) || this.session) : App.editSession({ ...this.adhoc });
      }
      if (e.target.closest('[data-sb=sftp]')) {
        this.sftpVisible = !this.sftpVisible;
        App.saveSettings({ sftpVisible: this.sftpVisible });
        this.applySftpLayout();
      }
    });

    // Tìm kiếm
    const sb = $('.term-search', v);
    const sInput = $('input', sb);
    const opts = { decorations: { matchOverviewRuler: '#ffcb6b', activeMatchColorOverviewRuler: '#4fd1a5', matchBackground: '#5c4a1a', activeMatchBackground: '#1f6b55' } };
    sInput.addEventListener('input', () => this.search.findNext(sInput.value, { ...opts, incremental: true }));
    sInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.shiftKey ? this.search.findPrevious(sInput.value, opts) : this.search.findNext(sInput.value, opts);
      if (e.key === 'Escape') { e.stopPropagation(); this.closeSearch(); }
    });
    sb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      if (b.dataset.s === 'next') this.search.findNext(sInput.value, opts);
      if (b.dataset.s === 'prev') this.search.findPrevious(sInput.value, opts);
      if (b.dataset.s === 'close') this.closeSearch();
    });

    // Splitter SFTP
    const sp = $('.splitter', v);
    sp.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add('resizing-col');
      const rect = $('.view-main', v).getBoundingClientRect();
      const move = (ev) => { this.sftpEl.style.width = Math.max(260, Math.min(rect.width - 320, rect.right - ev.clientX)) + 'px'; };
      const up = () => {
        document.body.classList.remove('resizing-col');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const w = parseInt(this.sftpEl.style.width, 10);
        App.saveSettings({ sftpWidth: w });
        for (const t of App.tabs) if (t !== this) t.sftpEl.style.width = w + 'px';
        this.fitTerm();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  applySftpLayout() {
    this.sftpEl.style.width = (App.settings.sftpWidth || 380) + 'px';
    this.view.classList.toggle('no-sftp', !this.sftpVisible);
    $('[data-sb=sftp]', this.view).classList.toggle('on', this.sftpVisible);
    setTimeout(() => this.fitTerm(), 30);
  }

  applySettings() {
    const st = App.settings;
    this.term.options.fontSize = st.fontSize;
    this.term.options.fontFamily = st.fontFamily;
    this.term.options.cursorBlink = st.cursorBlink;
    this.term.options.scrollback = st.scrollback;
    if (this.state === 'connected') api.ssh.monitor(this.id, !!st.monitor).catch(() => {});
    if (!st.monitor) $('.sb-stats', this.view).innerHTML = '';
    this.fitTerm();
  }

  fitTerm() {
    if (!this.view.classList.contains('active') || !this.termEl.offsetWidth) return;
    try { this.fit.fit(); } catch {}
  }

  onTermKey(e) {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && ['k', 'b', 't', 'w', 'f'].includes(k)) return false;
    if (e.ctrlKey && e.key === 'Tab') return false;
    if (e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key) && !e.altKey) return false;
    if (e.ctrlKey && !e.shiftKey && k === 'c' && this.term.hasSelection()) { this.copy(); return false; }
    if (e.ctrlKey && e.shiftKey && k === 'c') { this.copy(); return false; }
    if ((e.ctrlKey && k === 'v') || (e.shiftKey && e.key === 'Insert')) { e.preventDefault(); this.paste(); return false; }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { this.zoom(1); return false; }
    if (e.ctrlKey && e.key === '-') { this.zoom(-1); return false; }
    if (e.ctrlKey && e.key === '0') { this.zoom(0); return false; }
    return true;
  }

  zoom(d) {
    const size = d === 0 ? 14 : Math.max(9, Math.min(28, App.settings.fontSize + d));
    App.saveSettings({ fontSize: size });
    App.settings.fontSize = size;
    for (const t of App.tabs) { t.term.options.fontSize = size; t.fitTerm(); }
  }

  copy() {
    const s = this.term.getSelection();
    if (s) api.util.clipboardWrite(s);
    this.term.clearSelection();
  }

  async paste() {
    const text = await api.util.clipboardRead();
    if (!text) return;
    if (text.includes('\n') && text.trim().split('\n').length > 1) {
      const lines = text.trim().split('\n').length;
      const ok = await uiConfirm({ title: `Dán ${lines} dòng?`, message: `<pre class="paste-preview">${esc(text.slice(0, 600))}${text.length > 600 ? '\n…' : ''}</pre>Mỗi dòng có thể chạy như một lệnh.`, okLabel: 'Dán' });
      if (!ok) return this.term.focus();
    }
    this.term.paste(text);
    this.term.focus();
  }

  openSearch() {
    const sb = $('.term-search', this.view);
    sb.hidden = false;
    const i = $('input', sb);
    const sel = this.term.getSelection();
    if (sel && !sel.includes('\n')) i.value = sel;
    i.focus(); i.select();
  }

  closeSearch() {
    $('.term-search', this.view).hidden = true;
    this.search.clearDecorations();
    this.term.focus();
  }

  typeCommand(cmd) {
    if (this.state !== 'connected') return;
    api.ssh.write(this.id, cmd + '\r');
    this.term.focus();
    if (this.follow) this.checkCwd();
  }

  // Sau mỗi lần Enter, hỏi server thư mục hiện tại của shell (nhẹ, chạy ẩn).
  checkCwd(delay = 450) {
    clearTimeout(this.cwdTimer);
    clearTimeout(this.cwdTimer2);
    const run = async () => {
      if (this.state !== 'connected' || !this.sftp.ready || !this.follow) return;
      try {
        const cwd = await api.ssh.cwd(this.id);
        if (cwd && cwd !== this.sftp.path) this.sftp.load(cwd, { quiet: true });
      } catch {}
    };
    this.cwdTimer = setTimeout(run, delay);
    this.cwdTimer2 = setTimeout(run, delay + 1600);
  }

  setState(state, info = {}) {
    this.state = state;
    const ov = this.overlay;
    ov.classList.toggle('show', state === 'connecting' || state === 'failed');
    ov.classList.toggle('failed', state === 'failed');
    $('.conn-text', ov).textContent = state === 'failed' ? (info.message || 'Kết nối thất bại') : `Đang kết nối tới ${this.subtitle}…`;
    $('.conn-sub', ov).textContent = info.sub || '';
    $('.conn-actions', ov).hidden = state !== 'failed';
    $('[data-c=edit]', ov).hidden = !this.session;
    this.closedBar.hidden = state !== 'closed';
    this.view.dataset.state = state;
    App.renderTabs();
    App.renderTree();
  }

  async connect(password) {
    if (this.state === 'connecting') return;
    if (this.state === 'closed' || this.state === 'connected') {
      this.term.write('\r\n\x1b[90m── kết nối lại ──\x1b[0m\r\n');
    }
    this.sftp.ready = false;
    this.sftp.setState('đang mở…');
    this.setState('connecting');
    this.fitTerm();
    const pw = password ?? this.password;
    try {
      await api.ssh.connect(this.id, {
        sessionId: this.sessionId,
        adhoc: this.adhoc,
        password: pw,
        savePassword: this.savePassword,
        cols: this.term.cols,
        rows: this.term.rows,
      });
      if (pw) this.password = pw;
      this.onStatus({ state: 'connected' });
      if (this.sessionId) App.loadSessions();
    } catch (e) {
      if ((e.code === 'NEEDPASS' || e.code === 'AUTH') && (this.adhoc || this.session.authType === 'password')) {
        const wrong = e.code === 'AUTH';
        this.setState('failed', { message: wrong ? 'Sai mật khẩu' : 'Cần mật khẩu' });
        const r = await uiPrompt({
          title: wrong ? 'Sai mật khẩu — thử lại' : `Mật khẩu cho ${this.subtitle}`,
          label: 'Mật khẩu',
          type: 'password',
          okLabel: 'Kết nối',
          checkbox: this.sessionId ? { label: 'Lưu mật khẩu (mã hoá)', checked: true } : null,
        });
        if (!r) return;
        this.savePassword = !!r.checked;
        this.password = undefined;
        this.state = 'failed';
        return this.connect(r.value);
      }
      const msg = {
        AUTH: 'Xác thực thất bại — key không được server chấp nhận',
        NOKEY: e.message,
        ECONNREFUSED: 'Server từ chối kết nối (sai port hoặc sshd chưa chạy)',
        ENOTFOUND: 'Không tìm thấy host',
        ETIMEDOUT: 'Hết thời gian chờ',
      }[e.code] || e.message;
      this.setState('failed', { message: msg, sub: this.subtitle });
    }
  }

  onStatus({ state, message }) {
    if (state === 'connected') {
      if (this.state !== 'connected') {
        this.setState('connected');
        this.fitTerm();
        api.ssh.resize(this.id, this.term.cols, this.term.rows);
        this.term.focus();
      }
    } else if (state === 'closed') {
      if (this.state === 'connected') {
        this.setState('closed');
        this.sftp.ready = false;
        this.sftp.setState('mất kết nối', 'err');
        $('.sb-stats', this.view).innerHTML = '';
      }
    } else if (state === 'error' && message) {
      toast(`${this.title}: ${message}`, 'error');
    }
  }

  onSftpStatus({ state, message }) {
    if (state === 'ready') this.sftp.onReady();
    else this.sftp.setState('lỗi: ' + message, 'err');
  }

  onMonitor(m) {
    const box = $('.sb-stats', this.view);
    const meter = (pct) => `<span class="meter"><i style="width:${Math.max(2, Math.min(100, pct || 0))}%;${pct > 85 ? 'background:var(--red)' : pct > 65 ? 'background:var(--yellow)' : ''}"></i></span>`;
    const memPct = m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
    box.innerHTML = `
      <span class="stat" title="CPU · load ${esc(m.load || '')}">${icon('cpu', 13)} ${m.cpu != null ? m.cpu.toFixed(0) + '%' : '–'} ${meter(m.cpu)}</span>
      <span class="stat" title="RAM">${icon('memory', 13)} ${fmtBytes(m.memUsed)} / ${fmtBytes(m.memTotal)} ${meter(memPct)}</span>
      <span class="stat" title="Ổ đĩa / (${fmtBytes(m.diskUsed)} / ${fmtBytes(m.diskTotal)})">${icon('disk', 13)} ${m.diskPct}% ${meter(m.diskPct)}</span>
      <span class="stat" title="Mạng gửi đi">${icon('arrowUp', 13)} ${fmtRate(m.tx)}</span>
      <span class="stat" title="Mạng nhận về">${icon('arrowDown', 13)} ${fmtRate(m.rx)}</span>
      <span class="stat" title="Uptime">${icon('clock', 13)} ${fmtUptime(m.uptime)}</span>`;
  }

  dispose() {
    clearTimeout(this.cwdTimer);
    clearTimeout(this.cwdTimer2);
    api.ssh.close(this.id).catch(() => {});
    this.ro.disconnect();
    this.term.dispose();
    this.view.remove();
  }
}

App.init();
