// Tiện ích giao diện dùng chung: escape, format, modal, prompt, confirm, toast, context menu.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const node = t.content.firstElementChild;
  hydrateIcons(node);
  return node;
}

function fmtBytes(n, digits = 1) {
  if (n == null || isNaN(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(digits)) + ' ' + u[i];
}

function fmtRate(n) {
  return n == null ? '–' : fmtBytes(n) + '/s';
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtUptime(sec) {
  if (!sec) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} ngày ${h} giờ`;
  if (h) return `${h} giờ ${m} phút`;
  return `${m} phút`;
}

function timeAgo(ms) {
  if (!ms) return 'chưa dùng';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'vừa xong';
  if (s < 3600) return Math.floor(s / 60) + ' phút trước';
  if (s < 86400) return Math.floor(s / 3600) + ' giờ trước';
  return Math.floor(s / 86400) + ' ngày trước';
}

// ---------- Modal ----------
const modalStack = [];

function openModal({ title, body, actions = [], width = 460, onClose, icon: ic, tone }) {
  const root = $('#modal-root');
  const wrap = el(`
    <div class="modal-backdrop">
      <div class="modal ${tone ? 'tone-' + tone : ''}" role="dialog" aria-modal="true" style="width:${width}px">
        <div class="modal-head">
          ${ic ? `<span class="modal-icon" data-icon="${ic}" data-size="18"></span>` : ''}
          <h3>${esc(title)}</h3>
          <button class="icon-btn modal-x" data-icon="x" title="Đóng (Esc)"></button>
        </div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>
    </div>`);
  const bodyEl = $('.modal-body', wrap);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  hydrateIcons(bodyEl);

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    wrap.classList.add('leaving');
    setTimeout(() => wrap.remove(), 120);
    const i = modalStack.indexOf(api);
    if (i >= 0) modalStack.splice(i, 1);
    onClose && onClose(result);
  };
  const foot = $('.modal-foot', wrap);
  if (!actions.length) foot.remove();
  for (const a of actions) {
    const b = el(`<button class="btn ${a.kind || ''}">${esc(a.label)}</button>`);
    b.addEventListener('click', async () => {
      if (a.onClick) {
        b.disabled = true;
        try {
          const r = await a.onClick(api);
          if (r === false) return;
        } finally {
          b.disabled = false;
        }
      }
      if (a.close !== false) close(a.value);
    });
    foot.appendChild(b);
  }
  $('.modal-x', wrap).addEventListener('click', () => close());
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) wrap.dataset.downOnBackdrop = '1';
  });
  wrap.addEventListener('mouseup', (e) => {
    if (e.target === wrap && wrap.dataset.downOnBackdrop) close();
    delete wrap.dataset.downOnBackdrop;
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const primary = $('.modal-foot .btn.primary, .modal-foot .btn.danger', wrap);
      if (primary) { e.preventDefault(); primary.click(); }
    }
  });
  root.appendChild(wrap);
  const api = { el: wrap, body: bodyEl, close };
  modalStack.push(api);
  requestAnimationFrame(() => {
    const f = $('[autofocus], input:not([type=checkbox]):not([type=radio]), select, textarea', bodyEl) || $('.modal-foot .btn.primary', wrap);
    f && f.focus();
    if (f && f.select && f.type !== 'number') f.select();
  });
  return api;
}

function closeTopModal() {
  const m = modalStack[modalStack.length - 1];
  if (m) { m.close(); return true; }
  return false;
}

function uiConfirm({ title, message, okLabel = 'Đồng ý', danger = false, icon: ic }) {
  return new Promise((resolve) => {
    openModal({
      title,
      icon: ic || (danger ? 'alert' : undefined),
      tone: danger ? 'danger' : undefined,
      body: `<p class="confirm-msg">${message}</p>`,
      actions: [
        { label: 'Huỷ', value: false },
        { label: okLabel, kind: danger ? 'danger' : 'primary', value: true },
      ],
      onClose: (v) => resolve(!!v),
    });
  });
}

function uiPrompt({ title, label, value = '', placeholder = '', type = 'text', okLabel = 'OK', checkbox, hint }) {
  return new Promise((resolve) => {
    const body = el(`
      <div class="form">
        <label class="field"><span>${esc(label || '')}</span>
          <input type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" />
        </label>
        ${hint ? `<p class="hint">${hint}</p>` : ''}
        ${checkbox ? `<label class="check"><input type="checkbox" ${checkbox.checked ? 'checked' : ''}/><span>${esc(checkbox.label)}</span></label>` : ''}
      </div>`);
    let result = null;
    openModal({
      title,
      body,
      actions: [
        { label: 'Huỷ' },
        {
          label: okLabel,
          kind: 'primary',
          onClick: () => {
            const cb = $('input[type=checkbox]', body);
            result = { value: $('input', body).value, checked: cb ? cb.checked : undefined };
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---------- Toast ----------
function toast(message, kind = 'info', ms = 3500) {
  const t = el(`<div class="toast ${kind}"><span data-icon="${kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'terminal'}"></span><span>${esc(message)}</span></div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 200); }, ms);
}

// ---------- Context menu ----------
function showMenu(x, y, items) {
  const m = $('#ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.appendChild(el('<div class="sep"></div>')); continue; }
    const b = el(`<button class="mi ${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>
      <span class="mi-ico">${it.icon ? icon(it.icon, 15) : ''}</span>
      <span class="mi-label">${esc(it.label)}</span>
      <span class="mi-kbd">${esc(it.kbd || '')}</span></button>`);
    b.addEventListener('click', () => { hideMenu(); it.onClick && it.onClick(); });
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
}

function hideMenu() {
  $('#ctxmenu').hidden = true;
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctxmenu')) hideMenu();
});
window.addEventListener('blur', hideMenu);
