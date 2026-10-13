import { icons, formatSize, timeLeft, escapeHtml, copyText, toast, shortUrl, loadRecent, saveRecent } from './common.js';

const $ = (sel) => document.querySelector(sel);

// Folders that are almost never meant to be shared and quickly blow past the limits.
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', '.cache']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

let limits = { ttlMs: 24 * 3600e3, maxFiles: 100, maxFileSize: 10 * 1024 * 1024, maxTotalSize: 50 * 1024 * 1024 };
/** @type {{ file: Blob, path: string }[]} */
let staged = [];
let busy = false;

for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icons[el.dataset.icon];

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    limits = cfg;
    const hours = Math.round(cfg.ttlMs / 3600e3);
    for (const el of document.querySelectorAll('[data-ttl]')) el.textContent = `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
    render();
  })
  .catch(() => {});

// ---------- staging ----------

const skipped = (path) => {
  const parts = path.split('/');
  return SKIP_FILES.has(parts.at(-1)) || parts.slice(0, -1).some((p) => SKIP_DIRS.has(p));
};

function addFiles(items) {
  const existing = new Set(staged.map((s) => s.path));
  for (const item of items) {
    if (skipped(item.path)) continue;
    if (existing.has(item.path)) staged = staged.filter((s) => s.path !== item.path);
    staged.push(item);
    existing.add(item.path);
  }
  showError('');
  render();
}

function render() {
  const list = $('#staged');
  list.hidden = staged.length === 0;
  list.innerHTML = staged
    .map((s, i) => {
      const slash = s.path.lastIndexOf('/');
      const dir = slash >= 0 ? `<span class="dir">${escapeHtml(s.path.slice(0, slash + 1))}</span>` : '';
      const name = escapeHtml(s.path.slice(slash + 1));
      return `<li>
        <span class="name" title="${escapeHtml(s.path)}">${dir}${name}</span>
        <span class="size">${formatSize(s.file.size)}</span>
        <button type="button" class="btn btn-ghost btn-icon remove" data-i="${i}" aria-label="Quitar ${name}">${icons.x}</button>
      </li>`;
    })
    .join('');

  const total = staged.reduce((sum, s) => sum + s.file.size, 0);
  $('#summary').textContent = staged.length
    ? `${staged.length} ${staged.length === 1 ? 'archivo' : 'archivos'} · ${formatSize(total)}`
    : '';
  $('#share').disabled = busy || staged.length === 0;
}

$('#staged').addEventListener('click', (e) => {
  const btn = e.target.closest('.remove');
  if (!btn || busy) return;
  staged.splice(Number(btn.dataset.i), 1);
  render();
});

// ---------- pickers ----------

$('#pick-files').addEventListener('click', () => $('#file-input').click());
$('#pick-folder').addEventListener('click', () => $('#folder-input').click());

for (const input of [$('#file-input'), $('#folder-input')]) {
  input.addEventListener('change', () => {
    addFiles([...input.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
    input.value = '';
  });
}

// ---------- drag & drop (with folder traversal) ----------

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

const drop = $('#drop');
let depth = 0;
drop.addEventListener('dragenter', (e) => {
  e.preventDefault();
  depth++;
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => {
  if (--depth <= 0) {
    depth = 0;
    drop.classList.remove('over');
  }
});
drop.addEventListener('dragover', (e) => e.preventDefault());
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  depth = 0;
  drop.classList.remove('over');
  if (busy) return;

  const entries = [...e.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) {
    addFiles([...e.dataTransfer.files].map((f) => ({ file: f, path: f.name })));
    return;
  }
  const out = [];
  try {
    for (const entry of entries) await walk(entry, '', out);
  } catch {
    showError('No se pudieron leer algunos archivos.');
  }
  addFiles(out);
});

// Stop the browser from opening files dropped outside the zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- paste ----------

const paste = $('#paste');
$('#paste-open').addEventListener('click', () => {
  paste.hidden = false;
  $('#paste-body').focus();
});
$('#paste-cancel').addEventListener('click', () => {
  paste.hidden = true;
});
$('#paste-add').addEventListener('click', () => {
  const body = $('#paste-body').value;
  if (!body.trim()) return $('#paste-body').focus();
  const name = $('#paste-name').value.trim() || `snippet-${staged.length + 1}.txt`;
  addFiles([{ file: new Blob([body], { type: 'text/plain' }), path: name }]);
  $('#paste-name').value = '';
  $('#paste-body').value = '';
  paste.hidden = true;
});
$('#paste-body').addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
  }
});

// ---------- upload ----------

function showError(message) {
  $('#error').hidden = !message;
  $('#error').textContent = message;
}

function validate() {
  if (staged.length > limits.maxFiles) return `Puedes subir como máximo ${limits.maxFiles} archivos.`;
  const big = staged.find((s) => s.file.size > limits.maxFileSize);
  if (big) return `"${big.path}" supera el límite de ${formatSize(limits.maxFileSize)} por archivo.`;
  const total = staged.reduce((sum, s) => sum + s.file.size, 0);
  if (total > limits.maxTotalSize) return `El total supera el límite de ${formatSize(limits.maxTotalSize)}.`;
  return '';
}

function setProgress(fraction) {
  $('#progress').hidden = fraction === null;
  $('#progress > div').style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

$('#share').addEventListener('click', () => {
  const problem = validate();
  if (problem) return showError(problem);

  const form = new FormData();
  form.append('manifest', JSON.stringify(staged.map((s) => s.path)));
  for (const s of staged) form.append('files', s.file, s.path.split('/').pop());

  busy = true;
  showError('');
  setProgress(0);
  render();
  $('#share').textContent = 'Subiendo…';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/projects');
  xhr.responseType = 'json';
  xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
  xhr.onload = () => {
    if (xhr.status === 201) return done(xhr.response);
    fail(xhr.response?.error || 'No se pudo subir. Intenta de nuevo.');
  };
  xhr.onerror = () => fail('Error de conexión. Intenta de nuevo.');
  xhr.send(form);
});

function fail(message) {
  busy = false;
  setProgress(null);
  $('#share').textContent = 'Crear link';
  showError(message);
  render();
}

function done(project) {
  busy = false;
  setProgress(null);
  $('#share').textContent = 'Crear link';
  staged = [];
  render();

  saveRecent({ id: project.id, url: project.url, expiresAt: project.expiresAt, files: project.files.length });
  const link = $('#result-link');
  link.href = project.url;
  link.textContent = shortUrl(project.url);
  const n = project.files.length;
  $('#result-meta').textContent = `${n} ${n === 1 ? 'archivo' : 'archivos'} · expira en ${timeLeft(project.expiresAt)}`;
  $('#compose').hidden = true;
  $('#result').hidden = false;
  renderRecent();
}

$('#result-copy').addEventListener('click', async () => {
  if (await copyText($('#result-link').href)) toast('Link copiado');
});

$('#again').addEventListener('click', () => {
  $('#result').hidden = true;
  $('#compose').hidden = false;
});

function renderRecent() {
  const list = loadRecent();
  $('#recent').hidden = list.length === 0;
  $('#recent ul').innerHTML = list
    .map(
      (p) => `<li><a href="/${escapeHtml(p.id)}">
        <span class="rid">/${escapeHtml(p.id)}</span>
        <span class="rmeta">${p.files} ${p.files === 1 ? 'archivo' : 'archivos'} · expira en ${timeLeft(p.expiresAt)}</span>
      </a></li>`,
    )
    .join('');
}

renderRecent();
render();
