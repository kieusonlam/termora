// Panel SFTP của một tab.
const posixJoin = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);
const posixDir = (p) => {
  if (p === '/') return '/';
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

const CODE_EXT = /\.(js|ts|json|ya?ml|sh|bash|conf|cfg|ini|env|py|php|rb|go|rs|java|c|h|cpp|css|scss|html?|vue|xml|md|txt|log|sql|toml|service|nginx)$/i;

class SftpPanel {
  constructor(tab, root) {
    this.tab = tab;
    this.root = root;
    this.path = null;
    this.items = [];
    this.selected = new Set();
    this.anchor = null;
    this.sort = { key: 'name', dir: 1 };
    this.filter = '';
    this.showHidden = !!App.settings.showHidden;
    this.loading = false;
    this.ready = false;
    this.build();
  }

  get tabId() { return this.tab.id; }

  build() {
    this.root.innerHTML = `
      <div class="sftp-head">
        <div class="sftp-title"><span data-icon="folder"></span><span>SFTP</span><span class="sftp-state muted">đang mở…</span></div>
        <div class="sftp-tools">
          <button class="icon-btn" data-act="up" data-icon="up" title="Lên thư mục cha (Backspace)"></button>
          <button class="icon-btn" data-act="home" data-icon="home" title="Thư mục home"></button>
          <button class="icon-btn" data-act="refresh" data-icon="refresh" title="Làm mới (F5)"></button>
          <span class="tsep"></span>
          <button class="icon-btn" data-act="upload" data-icon="upload" title="Upload file"></button>
          <button class="icon-btn" data-act="download" data-icon="download" title="Tải xuống mục đã chọn"></button>
          <button class="icon-btn" data-act="mkdir" data-icon="folderPlus" title="Thư mục mới"></button>
          <button class="icon-btn" data-act="newfile" data-icon="filePlus" title="File mới"></button>
          <span class="tsep"></span>
          <button class="icon-btn toggle" data-act="hidden" data-icon="eye" title="Hiện file ẩn"></button>
          <button class="icon-btn toggle" data-act="follow" data-icon="crosshair" title="Theo thư mục của terminal"></button>
        </div>
      </div>
      <div class="pathbar">
        <div class="crumbs"></div>
        <input class="path-input" spellcheck="false" hidden />
      </div>
      <div class="sftp-filter">
        <span data-icon="search" data-size="14"></span>
        <input placeholder="Lọc theo tên…" spellcheck="false" />
        <span class="count muted"></span>
      </div>
      <div class="flist-wrap" tabindex="0">
        <table class="flist">
          <thead><tr>
            <th data-sort="name">Tên</th>
            <th data-sort="size" class="num">Kích thước</th>
            <th data-sort="mtime">Sửa đổi</th>
            <th data-sort="perms">Quyền</th>
            <th data-sort="owner">Chủ:nhóm</th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div class="flist-empty" hidden></div>
        <div class="drop-hint"><span data-icon="upload" data-size="28"></span><span class="drop-text">Thả file vào để upload</span></div>
      </div>`;
    hydrateIcons(this.root);
    this.tbody = $('tbody', this.root);
    this.listWrap = $('.flist-wrap', this.root);
    this.crumbs = $('.crumbs', this.root);
    this.pathInput = $('.path-input', this.root);
    this.filterInput = $('.sftp-filter input', this.root);
    this.syncToggles();

    $('.sftp-tools', this.root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'up') this.up();
      else if (act === 'home') this.goHome();
      else if (act === 'refresh') this.refresh();
      else if (act === 'upload') this.uploadDialog(false);
      else if (act === 'download') this.downloadSelected();
      else if (act === 'mkdir') this.mkdir();
      else if (act === 'newfile') this.newFile();
      else if (act === 'hidden') {
        this.showHidden = !this.showHidden;
        App.saveSettings({ showHidden: this.showHidden });
        this.syncToggles();
        this.render();
      } else if (act === 'follow') {
        this.tab.follow = !this.tab.follow;
        this.syncToggles();
        if (this.tab.follow) this.tab.checkCwd(0);
      }
    });

    // Breadcrumb: click để đi, double-click vùng trống để gõ đường dẫn
    this.crumbs.addEventListener('click', (e) => {
      const c = e.target.closest('[data-path]');
      if (c) this.load(c.dataset.path);
      else this.editPath();
    });
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.load(this.pathInput.value.trim() || '/'); this.pathInput.hidden = true; this.crumbs.hidden = false; }
      if (e.key === 'Escape') { this.pathInput.hidden = true; this.crumbs.hidden = false; e.stopPropagation(); }
    });
    this.pathInput.addEventListener('blur', () => { this.pathInput.hidden = true; this.crumbs.hidden = false; });

    this.filterInput.addEventListener('input', () => { this.filter = this.filterInput.value.toLowerCase(); this.render(); });
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.filterInput.value = ''; this.filter = ''; this.render(); this.listWrap.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.listWrap.focus(); this.moveSel(1, false); }
    });

    $('thead', this.root).addEventListener('click', (e) => {
      const th = e.target.closest('[data-sort]');
      if (!th) return;
      const k = th.dataset.sort;
      this.sort = this.sort.key === k ? { key: k, dir: -this.sort.dir } : { key: k, dir: 1 };
      this.render();
    });

    this.tbody.addEventListener('mousedown', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const it = this.visible[Number(tr.dataset.i)];
      if (e.button === 2 && this.selected.has(it.path)) return;
      this.selectItem(it, e.ctrlKey, e.shiftKey);
    });
    this.tbody.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (tr) this.open(this.visible[Number(tr.dataset.i)]);
    });
    this.listWrap.addEventListener('mousedown', (e) => {
      if (!e.target.closest('tr[data-i]') && !e.target.closest('thead') && !e.ctrlKey) { this.selected.clear(); this.paintSel(); }
    });
    this.listWrap.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(e); });
    this.listWrap.addEventListener('keydown', (e) => this.onKey(e));

    // Kéo thả từ Explorer
    let depth = 0;
    this.listWrap.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      depth++;
      this.listWrap.classList.add('dropping');
    });
    this.listWrap.addEventListener('dragleave', () => {
      if (--depth <= 0) { depth = 0; this.listWrap.classList.remove('dropping'); this.clearDropRow(); }
    });
    this.listWrap.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const tr = e.target.closest('tr[data-i]');
      const it = tr && this.visible[Number(tr.dataset.i)];
      this.clearDropRow();
      const target = it && it.isDir ? it.path : this.path;
      if (it && it.isDir) tr.classList.add('drop-target');
      $('.drop-text', this.root).textContent = 'Thả để upload vào ' + target;
    });
    this.listWrap.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.listWrap.classList.remove('dropping');
      const tr = e.target.closest('tr[data-i]');
      const it = tr && this.visible[Number(tr.dataset.i)];
      this.clearDropRow();
      const paths = Array.from(e.dataTransfer.files).map((f) => api.util.pathForFile(f)).filter(Boolean);
      if (paths.length) this.upload(paths, it && it.isDir ? it.path : this.path);
    });
  }

  clearDropRow() {
    $$('.drop-target', this.tbody).forEach((r) => r.classList.remove('drop-target'));
  }

  syncToggles() {
    $('[data-act=hidden]', this.root).classList.toggle('on', this.showHidden);
    $('[data-act=follow]', this.root).classList.toggle('on', !!this.tab.follow);
  }

  setState(text, kind) {
    const s = $('.sftp-state', this.root);
    s.textContent = text || '';
    s.className = 'sftp-state ' + (kind || 'muted');
  }

  async onReady() {
    this.ready = true;
    this.setState('');
    try {
      await this.load(await api.sftp.home(this.tabId));
    } catch (e) {
      await this.load('/');
    }
  }

  async load(p, { quiet } = {}) {
    if (!this.ready) return;
    this.loading = true;
    if (!quiet) this.setState('đang tải…');
    try {
      const res = await api.sftp.list(this.tabId, p);
      const changed = res.path !== this.path;
      this.path = res.path;
      this.items = res.items;
      if (changed) {
        this.selected.clear();
        this.filter = '';
        this.filterInput.value = '';
        this.listWrap.scrollTop = 0;
      } else {
        const names = new Set(this.items.map((i) => i.path));
        for (const s of [...this.selected]) if (!names.has(s)) this.selected.delete(s);
      }
      this.renderCrumbs();
      this.render();
      this.setState('');
    } catch (e) {
      this.setState('', '');
      toast(`Không mở được ${p}: ${e.message}`, 'error');
    } finally {
      this.loading = false;
    }
  }

  refresh() { if (this.path) return this.load(this.path, { quiet: true }); }
  up() { if (this.path && this.path !== '/') this.load(posixDir(this.path)); }
  async goHome() { this.load(await api.sftp.home(this.tabId).catch(() => '/')); }

  editPath() {
    this.crumbs.hidden = true;
    this.pathInput.hidden = false;
    this.pathInput.value = this.path || '/';
    this.pathInput.focus();
    this.pathInput.select();
  }

  renderCrumbs() {
    const parts = this.path.split('/').filter(Boolean);
    let acc = '';
    let html = `<button class="crumb" data-path="/">/</button>`;
    parts.forEach((p, i) => {
      acc += '/' + p;
      html += `${i ? '<span class="crumb-sep">/</span>' : ''}<button class="crumb" data-path="${esc(acc)}">${esc(p)}</button>`;
    });
    this.crumbs.innerHTML = html + '<span class="crumb-fill" title="Bấm để gõ đường dẫn"></span>';
    this.crumbs.scrollLeft = this.crumbs.scrollWidth;
  }

  computeVisible() {
    let list = this.items.filter((i) => this.showHidden || !i.name.startsWith('.'));
    if (this.filter) list = list.filter((i) => i.name.toLowerCase().includes(this.filter));
    const { key, dir } = this.sort;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let x = a[key], y = b[key];
      if (typeof x === 'string') return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) * dir;
      return ((x || 0) - (y || 0)) * dir;
    });
    return list;
  }

  render() {
    this.visible = this.computeVisible();
    const rows = [];
    if (this.path && this.path !== '/' && !this.filter) {
      rows.push(`<tr class="parent" data-parent="1"><td colspan="5"><span class="fname"><span class="ficon dir">${icon('folder', 15)}</span>..</span></td></tr>`);
    }
    this.visible.forEach((it, i) => {
      const ic = it.isDir ? 'folder' : it.isLink ? 'link' : CODE_EXT.test(it.name) ? 'fileCode' : 'file';
      const cls = it.isDir ? 'dir' : it.isLink ? 'lnk' : it.mode & 0o111 ? 'exe' : '';
      const own = it.group && it.group !== it.owner ? `${it.owner}:${it.group}` : it.owner;
      // Panel hẹp thì một số cột bị thu lại; tooltip luôn đủ thông tin.
      const tip = [it.isLink && it.target ? it.name + ' → ' + it.target : it.name, `${it.perms}  ${it.owner}:${it.group}`, fmtDate(it.mtime)].join('\n');
      rows.push(`<tr data-i="${i}" class="${this.selected.has(it.path) ? 'sel' : ''}" title="${esc(tip)}">
        <td><span class="fname"><span class="ficon ${cls}">${icon(ic, 15)}</span><span class="fn ${it.name.startsWith('.') ? 'hidden-f' : ''}">${esc(it.name)}</span>${it.isLink ? '<span class="lnk-tag">↪</span>' : ''}</span></td>
        <td class="num">${it.isDir ? '' : fmtBytes(it.size)}</td>
        <td class="muted">${fmtDate(it.mtime)}</td>
        <td class="mono muted">${esc(it.perms)}</td>
        <td class="owner ${it.owner === 'root' ? 'is-root' : ''}">${esc(own)}</td>
      </tr>`);
    });
    this.tbody.innerHTML = rows.join('');
    const parentRow = $('tr[data-parent]', this.tbody);
    if (parentRow) parentRow.addEventListener('dblclick', () => this.up());

    $$('thead th', this.root).forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === this.sort.key);
      th.dataset.dir = this.sort.dir > 0 ? 'asc' : 'desc';
    });
    const empty = $('.flist-empty', this.root);
    empty.hidden = this.visible.length > 0;
    empty.textContent = this.filter ? 'Không có mục nào khớp bộ lọc' : 'Thư mục trống — kéo file vào đây để upload';
    const hiddenCount = this.items.length - this.items.filter((i) => this.showHidden || !i.name.startsWith('.')).length;
    $('.count', this.root).textContent = `${this.visible.length} mục${hiddenCount ? ` · ${hiddenCount} ẩn` : ''}`;
  }

  paintSel() {
    $$('tr[data-i]', this.tbody).forEach((tr) => {
      tr.classList.toggle('sel', this.selected.has(this.visible[Number(tr.dataset.i)].path));
    });
  }

  selectItem(it, ctrl, shift) {
    if (shift && this.anchor) {
      const a = this.visible.findIndex((x) => x.path === this.anchor);
      const b = this.visible.indexOf(it);
      if (!ctrl) this.selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(this.visible[i].path);
    } else if (ctrl) {
      this.selected.has(it.path) ? this.selected.delete(it.path) : this.selected.add(it.path);
      this.anchor = it.path;
    } else {
      this.selected.clear();
      this.selected.add(it.path);
      this.anchor = it.path;
    }
    this.paintSel();
  }

  selectedItems() {
    return this.visible.filter((i) => this.selected.has(i.path));
  }

  moveSel(delta, shift) {
    if (!this.visible.length) return;
    let idx = this.visible.findIndex((x) => x.path === this.anchor);
    idx = idx < 0 ? 0 : Math.max(0, Math.min(this.visible.length - 1, idx + delta));
    const it = this.visible[idx];
    if (shift) {
      this.selected.add(it.path);
      this.anchor = it.path;
      this.paintSel();
    } else this.selectItem(it, false, false);
    const tr = $(`tr[data-i="${idx}"]`, this.tbody);
    tr && tr.scrollIntoView({ block: 'nearest' });
  }

  onKey(e) {
    if (e.target !== this.listWrap) return;
    const sel = this.selectedItems();
    if (e.key === 'ArrowDown') { e.preventDefault(); this.moveSel(1, e.shiftKey); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveSel(-1, e.shiftKey); }
    else if (e.key === 'Enter' && sel.length === 1) this.open(sel[0]);
    else if (e.key === 'Backspace') this.up();
    else if (e.key === 'Delete' && sel.length) this.remove(sel);
    else if (e.key === 'F2' && sel.length === 1) this.rename(sel[0]);
    else if (e.key === 'F5') { e.preventDefault(); this.refresh(); }
    else if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); this.visible.forEach((i) => this.selected.add(i.path)); this.paintSel(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { this.filterInput.focus(); }
  }

  open(it) {
    if (it.isDir) return this.load(it.path);
    this.edit(it);
  }

  async edit(it) {
    try {
      toast(`Đang mở ${it.name}… Lưu file trong editor sẽ tự upload lên server.`, 'info', 4500);
      await api.sftp.edit(this.tabId, it.path);
    } catch (e) {
      toast('Không mở được file: ' + e.message, 'error');
    }
  }

  async upload(localPaths, dir = this.path) {
    try {
      await api.sftp.upload(this.tabId, localPaths, dir);
      if (dir === this.path || posixDir(dir) === this.path) this.refresh();
    } catch (e) {
      toast('Upload lỗi: ' + e.message, 'error', 6000);
      this.refresh();
    }
  }

  async uploadDialog(folders) {
    try {
      const r = await api.sftp.uploadDialog(this.tabId, this.path, folders);
      if (r) this.refresh();
    } catch (e) {
      toast('Upload lỗi: ' + e.message, 'error', 6000);
      this.refresh();
    }
  }

  async downloadSelected(items = this.selectedItems()) {
    if (!items.length) return toast('Chọn file hoặc thư mục cần tải', 'info');
    try {
      await api.sftp.download(this.tabId, items.map((i) => i.path));
    } catch (e) {
      toast('Tải xuống lỗi: ' + e.message, 'error', 6000);
    }
  }

  async mkdir() {
    const r = await uiPrompt({ title: 'Thư mục mới', label: 'Tên thư mục', placeholder: 'new-folder', okLabel: 'Tạo' });
    if (!r || !r.value.trim()) return;
    try {
      await api.sftp.mkdir(this.tabId, posixJoin(this.path, r.value.trim()));
      await this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async newFile() {
    const r = await uiPrompt({ title: 'File mới', label: 'Tên file', placeholder: 'file.txt', okLabel: 'Tạo' });
    if (!r || !r.value.trim()) return;
    try {
      await api.sftp.newFile(this.tabId, posixJoin(this.path, r.value.trim()));
      await this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async rename(it) {
    const r = await uiPrompt({ title: 'Đổi tên', label: 'Tên mới', value: it.name, okLabel: 'Đổi tên' });
    if (!r || !r.value.trim() || r.value === it.name) return;
    try {
      await api.sftp.rename(this.tabId, it.path, posixJoin(posixDir(it.path), r.value.trim()));
      await this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async remove(items) {
    const names = items.slice(0, 5).map((i) => `<code>${esc(i.name)}</code>`).join(', ') + (items.length > 5 ? ` và ${items.length - 5} mục khác` : '');
    const hasDir = items.some((i) => i.isDir);
    const ok = await uiConfirm({
      title: `Xoá ${items.length} mục?`,
      message: `${names}${hasDir ? '<br><br>Thư mục sẽ bị xoá cùng toàn bộ nội dung bên trong.' : ''}<br>Không thể hoàn tác.`,
      okLabel: 'Xoá',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.sftp.remove(this.tabId, items.map((i) => i.path));
      this.selected.clear();
      await this.refresh();
    } catch (e) { toast('Xoá lỗi: ' + e.message, 'error'); this.refresh(); }
  }

  chmod(it) {
    const bits = [
      ['Chủ', 0o400, 0o200, 0o100],
      ['Nhóm', 0o040, 0o020, 0o010],
      ['Khác', 0o004, 0o002, 0o001],
    ];
    let mode = it.mode & 0o777;
    const body = el(`<div class="chmod">
      <table><thead><tr><th></th><th>Đọc</th><th>Ghi</th><th>Chạy</th></tr></thead><tbody>
      ${bits.map(([n, r, w, x]) => `<tr><td>${n}</td>${[r, w, x].map((b) => `<td><input type="checkbox" data-bit="${b}" ${mode & b ? 'checked' : ''}/></td>`).join('')}</tr>`).join('')}
      </tbody></table>
      <label class="field inline"><span>Octal</span><input class="octal mono" value="${mode.toString(8).padStart(3, '0')}" maxlength="4"/></label>
      ${it.isDir ? '<p class="hint">Chỉ áp dụng cho thư mục này, không đệ quy.</p>' : ''}
    </div>`);
    const oct = $('.octal', body);
    const sync = () => { $$('[data-bit]', body).forEach((c) => (c.checked = !!(mode & Number(c.dataset.bit)))); oct.value = mode.toString(8).padStart(3, '0'); };
    body.addEventListener('change', (e) => {
      if (e.target.dataset.bit) { mode ^= Number(e.target.dataset.bit); sync(); }
    });
    oct.addEventListener('input', () => { const v = parseInt(oct.value, 8); if (!isNaN(v)) { mode = v & 0o7777; $$('[data-bit]', body).forEach((c) => (c.checked = !!(mode & Number(c.dataset.bit)))); } });
    openModal({
      title: `Phân quyền: ${it.name}`,
      body,
      width: 360,
      actions: [
        { label: 'Huỷ' },
        { label: 'Áp dụng', kind: 'primary', onClick: async () => {
          try { await api.sftp.chmod(this.tabId, it.path, mode); await this.refresh(); }
          catch (e) { toast(e.message, 'error'); return false; }
        } },
      ],
    });
  }

  contextMenu(e) {
    const tr = e.target.closest('tr[data-i]');
    const sel = tr ? this.selectedItems() : [];
    const one = sel.length === 1 ? sel[0] : null;
    const items = [];
    if (one) {
      items.push(one.isDir
        ? { label: 'Mở', icon: 'folderOpen', onClick: () => this.open(one) }
        : { label: 'Mở / sửa bằng editor', icon: 'edit', kbd: 'Enter', onClick: () => this.edit(one) });
    }
    if (sel.length) {
      items.push({ label: `Tải xuống${sel.length > 1 ? ` (${sel.length})` : ''}`, icon: 'download', onClick: () => this.downloadSelected(sel) });
    }
    if (one) {
      items.push({ label: 'Đổi tên', icon: 'edit', kbd: 'F2', onClick: () => this.rename(one) });
      items.push({ label: 'Phân quyền (chmod)', icon: 'lock', onClick: () => this.chmod(one) });
      items.push({ label: 'Copy đường dẫn', icon: 'copy', onClick: () => api.util.clipboardWrite(one.path).then(() => toast('Đã copy đường dẫn', 'ok')) });
      items.push({ label: 'cd tới đây trong terminal', icon: 'terminal', onClick: () => this.tab.typeCommand(`cd ${shQuote(one.isDir ? one.path : posixDir(one.path))}`) });
    }
    if (sel.length) items.push({ label: `Xoá${sel.length > 1 ? ` (${sel.length})` : ''}`, icon: 'trash', kbd: 'Del', danger: true, onClick: () => this.remove(sel) });
    if (items.length) items.push('-');
    items.push(
      { label: 'Upload file…', icon: 'upload', onClick: () => this.uploadDialog(false) },
      { label: 'Upload thư mục…', icon: 'upload', onClick: () => this.uploadDialog(true) },
      { label: 'Thư mục mới', icon: 'folderPlus', onClick: () => this.mkdir() },
      { label: 'File mới', icon: 'filePlus', onClick: () => this.newFile() },
      '-',
      { label: 'cd thư mục hiện tại trong terminal', icon: 'terminal', onClick: () => this.tab.typeCommand(`cd ${shQuote(this.path)}`) },
      { label: 'Làm mới', icon: 'refresh', kbd: 'F5', onClick: () => this.refresh() }
    );
    showMenu(e.clientX, e.clientY, items);
  }
}
