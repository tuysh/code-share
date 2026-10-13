const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  upload: svg('<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>'),
  download: svg('<path d="M12 4v12M6 10l6 6 6-6"/><path d="M4 20h16"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  file: svg('<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4"/>'),
  folder: svg('<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  raw: svg('<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  rename: svg('<path d="M4 7V5h16v2M9 19h6M12 5v14"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>'),
  settings: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  filePlus: svg('<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
};

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timeLeft(expiresAt, now = Date.now()) {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expirado';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back for plain-http deployments.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

let toastTimer;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

export function shortUrl(url) {
  return url.replace(/^https?:\/\//, '');
}

// Folders that are almost never meant to be shared and quickly blow past the limits.
export const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', '.cache']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export const skipped = (path) => {
  const parts = path.split('/');
  return SKIP_FILES.has(parts.at(-1)) || parts.slice(0, -1).some((p) => SKIP_DIRS.has(p));
};

const readEntries = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

async function walk(entry, prefix, out) {
  const path = prefix + entry.name;
  if (entry.isFile) {
    if (!skipped(path)) out.push({ file: await entryFile(entry), path });
  } else if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
    const reader = entry.createReader();
    // readEntries returns results in batches; keep reading until empty.
    for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
      for (const child of batch) await walk(child, `${path}/`, out);
    }
  }
}

/** Collects `{ file, path }` from a drop event, descending into dropped folders. */
export async function droppedFiles(dataTransfer) {
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((f) => ({ file: f, path: f.name }));
  const out = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}

/** Builds the multipart body the API expects: a path manifest plus the files, in order. */
export function uploadForm(items) {
  const form = new FormData();
  form.append('manifest', JSON.stringify(items.map((s) => s.path)));
  for (const s of items) form.append('files', s.file, s.path.split('/').pop());
  return form;
}

/**
 * Small modal built on <dialog>. With `input`, resolves to the entered text (or null);
 * otherwise resolves to true/false.
 */
export function ask({ title, message = '', input, placeholder = '', confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `<form method="dialog">
      <h2>${escapeHtml(title)}</h2>
      ${message ? `<p class="modal-text">${escapeHtml(message)}</p>` : ''}
      ${input !== undefined ? `<input class="modal-input" name="value" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}">` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" value="cancel">${escapeHtml(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-dark'}" value="ok">${escapeHtml(confirmText)}</button>
      </div>
    </form>`;
    document.body.append(dlg);
    const field = dlg.querySelector('input');
    if (field) field.value = input;
    dlg.querySelector('[value=cancel]').addEventListener('click', () => dlg.close('cancel'));
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      dlg.remove();
      if (field) resolve(ok ? field.value.trim() : null);
      else resolve(ok);
    });
    dlg.showModal();
    if (field) {
      field.focus();
      // Select the name but not the folder or extension, like a file manager.
      const slash = input.lastIndexOf('/') + 1;
      const dot = input.lastIndexOf('.');
      field.setSelectionRange(slash, dot > slash ? dot : input.length);
    }
  });
}

// Edit keys live only in this browser. The private edit link is the backup.
const KEYS_KEY = 'code-share:keys';

function readKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(KEYS_KEY) || '{}');
    return keys && typeof keys === 'object' ? keys : {};
  } catch {
    return {};
  }
}

export function getKey(id) {
  const entry = readKeys()[id];
  return entry && entry.expiresAt > Date.now() ? entry.key : '';
}

export function saveKey(id, key, expiresAt) {
  try {
    const keys = readKeys();
    for (const [k, v] of Object.entries(keys)) if (!(v?.expiresAt > Date.now())) delete keys[k];
    keys[id] = { key, expiresAt };
    localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}

// "Recent links" live only in this browser; storage may be unavailable.
const RECENT_KEY = 'code-share:recent';

export function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => p.expiresAt > Date.now()) : [];
  } catch {
    return [];
  }
}

export function saveRecent(project) {
  try {
    const list = loadRecent().filter((p) => p.id !== project.id);
    list.unshift(project);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* ignore */
  }
}
