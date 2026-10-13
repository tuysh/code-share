import {
  icons, formatSize, timeLeft, escapeHtml, copyText, toast, shortUrl,
  ask, getKey, saveKey, droppedFiles, uploadForm,
} from './common.js';

const $ = (sel) => document.querySelector(sel);
const id = location.pathname.split('/')[1];
const api = `/api/projects/${encodeURIComponent(id)}`;

const NO_HIGHLIGHT_OVER = 512 * 1024;
const LIVE_HIGHLIGHT_OVER = 100 * 1024;
const POLL_MS = 10_000;

const BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  hpp: 'cpp', hh: 'cpp', cs: 'csharp', php: 'php', swift: 'swift', m: 'objectivec',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
  sql: 'sql', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', env: 'bash',
  md: 'markdown', markdown: 'markdown', lua: 'lua', r: 'r', pl: 'perl', pm: 'perl',
  dart: 'dart', scala: 'scala', diff: 'diff', patch: 'diff', graphql: 'graphql',
  gql: 'graphql', proto: 'protobuf', ex: 'elixir', exs: 'elixir', hs: 'haskell',
  vb: 'vbnet', conf: 'nginx', mk: 'makefile', gradle: 'kotlin',
};

const BY_NAME = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
  '.bashrc': 'bash', '.zshrc': 'bash', '.env': 'bash', 'nginx.conf': 'nginx',
  '.gitignore': 'bash', '.dockerignore': 'bash',
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp']);

// The private edit link carries the key in the fragment (#key=…), which is never
// sent to the server. Remember it locally and drop it from the address bar.
let key = '';
if (location.hash.startsWith('#key=')) {
  key = location.hash.slice(5);
  history.replaceState(null, '', location.pathname);
} else {
  key = getKey(id);
}

let project;
/** id of the file on screen */
let current = null;
/** fileId -> { version, text } */
const cache = new Map();
/** Folder paths the user collapsed, kept across tree re-renders. */
const closed = new Set();
/** Active editor session, or null. */
let editing = null;

for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icons[el.dataset.icon];

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const ext = (p) => {
  const name = basename(p).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
};
const fileById = (fileId) => project.files.find((f) => f.id === fileId);

function languageFor(path) {
  const name = basename(path).toLowerCase();
  const lang = BY_NAME[name] || (name.startsWith('dockerfile') && 'dockerfile') || BY_EXT[ext(path)];
  return lang && window.hljs?.getLanguage(lang) ? lang : null;
}

function highlight(text, path, limit = NO_HIGHLIGHT_OVER) {
  const lang = text.length <= limit ? languageFor(path) : null;
  return lang ? window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : escapeHtml(text);
}

const lineCount = (text) => (text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length) || 1;
const gutterFor = (text) => Array.from({ length: lineCount(text) }, (_, i) => i + 1).join('\n');

// ---------- API ----------

async function call(method, url, { body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    body,
    cache: 'no-store',
    headers: { ...(key ? { 'x-edit-token': key } : {}), ...headers },
  });
  if (res.ok) return res.status === 204 ? null : res.json();
  let message = 'Algo salió mal. Intenta de nuevo.';
  try {
    message = (await res.json()).error || message;
  } catch {
    /* not JSON */
  }
  const err = new Error(message);
  err.status = res.status;
  throw err;
}

const failed = (err) => toast(err.message || 'Error de conexión.');

// ---------- tree ----------

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push(f);
  }
  return root;
}

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const sortedDirs = (node) => [...node.dirs.entries()].sort(([a], [b]) => byName(a, b));
const sortedFiles = (node) => [...node.files].sort((a, b) => byName(basename(a.path), basename(b.path)));

function renderTree(node, prefix = '') {
  return [
    ...sortedDirs(node).map(([name, child]) => {
      const full = `${prefix}${name}/`;
      return `<li class="folder${closed.has(full) ? ' closed' : ''}" data-path="${escapeHtml(full)}">
        <button type="button" class="node folder-node">${icons.chevron.replace('<svg', '<svg class="chev"')}<span>${escapeHtml(name)}</span></button>
        <ul>${renderTree(child, full)}</ul>
      </li>`;
    }),
    ...sortedFiles(node).map(
      (f) => `<li><button type="button" class="node file-node${f.id === current ? ' active' : ''}" data-id="${escapeHtml(f.id)}" title="${escapeHtml(f.path)}">${icons.file}<span>${escapeHtml(basename(f.path))}</span></button></li>`,
    ),
  ].join('');
}

/** Files in the order they appear in the tree, so the default pick matches what's on screen. */
function treeOrder(node, out = []) {
  for (const [, child] of sortedDirs(node)) treeOrder(child, out);
  out.push(...sortedFiles(node));
  return out;
}

function renderSidebar() {
  $('#tree-root').innerHTML = renderTree(buildTree(project.files));
  $('#file-count').textContent = String(project.files.length);
  // A single read-only file doesn't need a sidebar.
  const showTree = project.files.length > 1 || project.canEdit;
  $('#tree').hidden = !showTree;
  $('#tree-toggle').hidden = !showTree;
  $('#tree-actions').hidden = !project.canEdit;
  $('#tree-hint').hidden = !project.canEdit;
}

$('#tree-root').addEventListener('click', async (e) => {
  const folder = e.target.closest('.folder-node');
  if (folder) {
    const li = folder.parentElement;
    li.classList.toggle('closed');
    if (li.classList.contains('closed')) closed.add(li.dataset.path);
    else closed.delete(li.dataset.path);
    return;
  }
  const file = e.target.closest('.file-node');
  if (file && (await leaveEditor())) {
    open(file.dataset.id);
    if (matchMedia('(max-width: 760px)').matches) $('#tree').classList.add('collapsed');
  }
});

$('#tree-toggle').addEventListener('click', () => $('#tree').classList.toggle('collapsed'));

// ---------- header / chrome ----------

function renderChrome() {
  $('#pid').textContent = `/${project.id}`;
  $('#pid').hidden = false;
  $('#expires').hidden = false;
  $('#copy-link').hidden = false;
  $('#zip').hidden = false;
  $('#zip').href = `${api}/zip`;
  $('#open-settings').hidden = !project.isOwner;

  const chip = $('#mode-chip');
  chip.hidden = !project.canEdit;
  chip.innerHTML = project.editMode === 'anyone' ? `${icons.users}edición abierta` : `${icons.lock}puedes editar`;
}

$('#copy-link').addEventListener('click', async () => {
  if (await copyText(`${location.origin}/${project.id}`)) toast('Link copiado');
});

// ---------- viewer ----------

function toolButton(action, icon, label) {
  return `<button type="button" class="btn btn-ghost btn-icon" data-action="${action}" title="${label}" aria-label="${label}">${icons[icon]}</button>`;
}

function fileHeader(f) {
  const raw = `${api}/files/${encodeURIComponent(f.id)}`;
  const crumbs = `<div class="crumbs" title="${escapeHtml(f.path)}">${escapeHtml(dirname(f.path))}<b>${escapeHtml(basename(f.path))}</b><span class="dirty" hidden>●</span></div>`;

  if (editing?.id === f.id) {
    return `<div class="file-head editing">
      ${crumbs}
      <span class="file-meta">Ctrl + S para guardar</span>
      <div class="file-tools">
        <button type="button" class="btn btn-ghost" data-action="cancel">Cancelar</button>
        <button type="button" class="btn btn-dark" data-action="save">Guardar</button>
      </div>
    </div>`;
  }

  const editTools = project.canEdit
    ? `${f.binary ? '' : toolButton('edit', 'edit', 'Editar')}${toolButton('rename', 'rename', 'Renombrar')}${toolButton('delete', 'trash', 'Eliminar')}<span class="tool-sep"></span>`
    : '';
  return `<div class="file-head">
    ${crumbs}
    <span class="file-meta">${formatSize(f.size)}</span>
    <div class="file-tools">
      ${editTools}
      ${f.binary ? '' : toolButton('copy', 'copy', 'Copiar contenido')}
      <a class="btn btn-ghost btn-icon" href="${raw}" target="_blank" rel="noopener" title="Ver raw" aria-label="Ver raw">${icons.raw}</a>
      <a class="btn btn-ghost btn-icon" href="${raw}?download" title="Descargar" aria-label="Descargar">${icons.download}</a>
    </div>
  </div>`;
}

async function loadText(f) {
  const hit = cache.get(f.id);
  if (hit && hit.version === f.version) return hit.text;
  const res = await fetch(`${api}/files/${encodeURIComponent(f.id)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error();
  const text = await res.text();
  cache.set(f.id, { version: f.version, text });
  return text;
}

function markCurrent(f) {
  current = f.id;
  history.replaceState(null, '', `#${encodeURI(f.path)}`);
  document.title = `${basename(f.path)} · ${id} · codeshare`;
  for (const el of document.querySelectorAll('.file-node')) el.classList.toggle('active', el.dataset.id === f.id);
}

async function open(fileId) {
  const f = fileById(fileId);
  if (!f) return;
  markCurrent(f);

  const viewer = $('#viewer');
  const raw = `${api}/files/${encodeURIComponent(f.id)}`;

  if (f.binary) {
    viewer.innerHTML = IMAGE_EXT.has(ext(f.path))
      ? `${fileHeader(f)}<div class="preview"><img src="${raw}?v=${f.version}" alt="${escapeHtml(f.path)}"></div>`
      : `${fileHeader(f)}<div class="notice"><div><h2>Archivo binario</h2><p>No se puede mostrar como texto.</p><a class="btn" href="${raw}?download">${icons.download}Descargar · ${formatSize(f.size)}</a></div></div>`;
    return;
  }

  let text = '';
  if (f.size > 0) {
    const hit = cache.get(f.id);
    if (!hit || hit.version !== f.version) viewer.innerHTML = `${fileHeader(f)}<div class="notice"><p>Cargando…</p></div>`;
    try {
      text = await loadText(f);
    } catch {
      if (current === fileId) viewer.innerHTML = `${fileHeader(f)}<div class="notice"><p>No se pudo cargar el archivo.</p></div>`;
      return;
    }
    if (current !== fileId) return;
  }

  if (editing?.id === f.id) return renderEditor(f);

  if (f.size === 0) {
    viewer.innerHTML = `${fileHeader(f)}<div class="notice"><div><p>Archivo vacío.</p>${
      project.canEdit ? `<button type="button" class="btn" data-action="edit">${icons.edit}Escribir</button>` : ''
    }</div></div>`;
    return;
  }

  viewer.innerHTML = `${fileHeader(f)}<div class="code-wrap"><div class="code">
    <pre class="gutter" aria-hidden="true">${gutterFor(text)}</pre>
    <pre class="src"><code class="hljs">${highlight(text, f.path)}</code></pre>
  </div></div>`;
}

$('#viewer').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const f = fileById(current);
  if (!f) return;
  const action = btn.dataset.action;
  if (action === 'copy') {
    const text = cache.get(f.id)?.text ?? '';
    if (await copyText(text)) toast('Contenido copiado');
  } else if (action === 'edit') startEditing(f);
  else if (action === 'save') save();
  else if (action === 'cancel') {
    if (await leaveEditor()) open(f.id);
  } else if (action === 'rename') renameFile(f);
  else if (action === 'delete') deleteFile(f);
});

// ---------- editor ----------

function startEditing(f) {
  const text = cache.get(f.id)?.text ?? '';
  editing = { id: f.id, baseVersion: f.version, original: text, text };
  renderEditor(f);
}

function renderEditor(f) {
  markCurrent(f);
  const viewer = $('#viewer');
  viewer.innerHTML = `${fileHeader(f)}<div class="code-wrap"><div class="code">
    <pre class="gutter" aria-hidden="true"></pre>
    <div class="editor">
      <pre class="src" aria-hidden="true"><code class="hljs"></code></pre>
      <textarea class="src input" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="Contenido de ${escapeHtml(f.path)}"></textarea>
    </div>
  </div></div>`;

  const ta = viewer.querySelector('textarea');
  const code = viewer.querySelector('.editor code');
  const gutter = viewer.querySelector('.gutter');
  const dirty = viewer.querySelector('.dirty');
  const indent = /^\t/m.test(editing.original) ? '\t' : '  ';
  ta.value = editing.text;

  let frame = 0;
  const paint = () => {
    frame = 0;
    // A trailing newline keeps the overlay as tall as the textarea's last line.
    code.innerHTML = `${highlight(ta.value, f.path, LIVE_HIGHLIGHT_OVER)}\n`;
    gutter.textContent = gutterFor(ta.value);
    dirty.hidden = ta.value === editing.original;
  };
  paint();

  ta.addEventListener('input', () => {
    editing.text = ta.value;
    if (!frame) frame = requestAnimationFrame(paint);
  });

  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      // execCommand keeps the native undo stack intact; setRangeText is the fallback.
      if (!document.execCommand('insertText', false, indent)) {
        ta.setRangeText(indent, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    }
  });

  // Clicks on the empty space below the last line should still land in the editor.
  viewer.querySelector('.code-wrap').addEventListener('mousedown', (e) => {
    if (e.target === ta) return;
    e.preventDefault();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  ta.focus({ preventScroll: true });
  ta.setSelectionRange(0, 0);
}

const isDirty = () => editing && editing.text !== editing.original;

/** Ends the editor session, asking first if there are unsaved changes. */
async function leaveEditor() {
  if (!editing) return true;
  if (isDirty()) {
    const ok = await ask({
      title: '¿Descartar cambios?',
      message: 'Tienes cambios sin guardar en este archivo.',
      confirmText: 'Descartar',
      danger: true,
    });
    if (!ok) return false;
  }
  editing = null;
  return true;
}

async function save(force = false) {
  if (!editing) return;
  const session = editing;
  const btn = $('[data-action=save]');
  if (btn) btn.disabled = true;
  try {
    const headers = { 'content-type': 'text/plain; charset=utf-8' };
    if (!force) headers['x-base-version'] = String(session.baseVersion);
    const meta = await call('PUT', `${api}/files/${encodeURIComponent(session.id)}`, { body: session.text, headers });
    const saved = meta.files.find((f) => f.id === session.id);
    if (saved) cache.set(session.id, { version: saved.version, text: session.text });
    editing = null;
    applyMeta(meta);
    toast('Guardado');
  } catch (err) {
    if (btn) btn.disabled = false;
    if (err.status === 409) {
      const overwrite = await ask({
        title: 'El archivo cambió',
        message: 'Otra persona guardó cambios en este archivo mientras lo editabas. ¿Quieres reemplazarlos con tu versión?',
        confirmText: 'Sobrescribir',
        danger: true,
      });
      if (overwrite) save(true);
    } else failed(err);
  }
}

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) e.preventDefault();
});

// ---------- file operations ----------

async function newFile() {
  if (!(await leaveEditor())) return;
  const folder = current && fileById(current) ? dirname(fileById(current).path) : '';
  const name = await ask({ title: 'Nuevo archivo', input: folder, placeholder: 'carpeta/archivo.js', confirmText: 'Crear' });
  if (!name) return;
  if (project.files.some((f) => f.path === name)) return toast('Ya existe un archivo con ese nombre.');
  try {
    const meta = await call('POST', `${api}/files`, { body: uploadForm([{ file: new Blob([]), path: name }]) });
    const fileId = meta.added[0];
    cache.set(fileId, { version: 1, text: '' });
    editing = { id: fileId, baseVersion: 1, original: '', text: '' };
    current = fileId;
    applyMeta(meta);
  } catch (err) {
    failed(err);
  }
}

async function uploadFiles(items) {
  if (!items.length) return;
  try {
    const meta = await call('POST', `${api}/files`, { body: uploadForm(items) });
    applyMeta(meta);
    if (!editing && meta.added[0]) open(meta.added[0]);
    toast(meta.added.length === 1 ? 'Archivo añadido' : `${meta.added.length} archivos añadidos`);
  } catch (err) {
    failed(err);
  }
}

async function renameFile(f) {
  const name = await ask({ title: 'Renombrar', input: f.path, confirmText: 'Renombrar' });
  if (!name || name === f.path) return;
  try {
    applyMeta(await call('PATCH', `${api}/files/${encodeURIComponent(f.id)}`, {
      body: JSON.stringify({ path: name }),
      headers: { 'content-type': 'application/json' },
    }));
  } catch (err) {
    failed(err);
  }
}

async function deleteFile(f) {
  const ok = await ask({
    title: `¿Eliminar ${basename(f.path)}?`,
    message: 'Se eliminará para todos los que tengan el link.',
    confirmText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  try {
    applyMeta(await call('DELETE', `${api}/files/${encodeURIComponent(f.id)}`));
    toast('Archivo eliminado');
  } catch (err) {
    failed(err);
  }
}

$('#new-file').addEventListener('click', newFile);
$('#upload-files').addEventListener('click', () => $('#upload-input').click());
$('#upload-input').addEventListener('change', (e) => {
  uploadFiles([...e.target.files].map((file) => ({ file, path: file.name })));
  e.target.value = '';
});

// Drag files anywhere onto the page to add them.
let dragDepth = 0;
const draggingFiles = (e) => project?.canEdit && [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!draggingFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (!draggingFiles(e)) return;
  try {
    uploadFiles(await droppedFiles(e.dataTransfer));
  } catch {
    toast('No se pudieron leer algunos archivos.');
  }
});

// ---------- settings (owner only) ----------

const settings = $('#settings');
const editUrl = () => `${location.origin}/${project.id}#key=${key}`;

$('#open-settings').addEventListener('click', () => {
  $('#mode-toggle').checked = project.editMode === 'anyone';
  $('#settings-edit-link').textContent = `${shortUrl(location.origin)}/${project.id}#key=••••••`;
  settings.showModal();
});

$('#settings-edit-copy').addEventListener('click', async () => {
  if (await copyText(editUrl())) toast('Link de edición copiado');
});

$('#mode-toggle').addEventListener('change', async (e) => {
  const editMode = e.target.checked ? 'anyone' : 'owner';
  try {
    applyMeta(await call('PATCH', api, {
      body: JSON.stringify({ editMode }),
      headers: { 'content-type': 'application/json' },
    }));
    toast(editMode === 'anyone' ? 'Ahora cualquiera con el link puede editar' : 'Ahora solo tú puedes editar');
  } catch (err) {
    e.target.checked = !e.target.checked;
    failed(err);
  }
});

$('#delete-project').addEventListener('click', async () => {
  settings.close();
  const ok = await ask({
    title: '¿Eliminar el proyecto?',
    message: 'Se borrarán todos los archivos y el link dejará de funcionar. No se puede deshacer.',
    confirmText: 'Eliminar proyecto',
    danger: true,
  });
  if (!ok) return;
  try {
    await call('DELETE', api);
    editing = null;
    location.href = '/';
  } catch (err) {
    failed(err);
  }
});

// ---------- state sync ----------

/** Re-renders everything that depends on project metadata, keeping the user's place. */
function applyMeta(meta) {
  const prev = project ? fileById(current) : null;
  const permissionsChanged = project && project.canEdit !== meta.canEdit;
  project = meta;
  renderChrome();
  renderSidebar();

  for (const [fileId, entry] of cache) {
    const f = fileById(fileId);
    if (!f || f.version !== entry.version) cache.delete(fileId);
  }

  const now = fileById(current);
  if (!now) {
    // The open file was deleted (by us or someone else).
    if (editing?.id === current) {
      editing = null;
      toast('El archivo que editabas fue eliminado.');
    }
    const first = treeOrder(buildTree(project.files))[0];
    if (first) open(first.id);
    return;
  }
  if (editing?.id === now.id && permissionsChanged && !project.canEdit) {
    toast('Ya no tienes permiso para editar. Copia tus cambios si los necesitas.');
  }
  if (editing?.id === now.id) {
    // Keep typing undisturbed; only refresh the header if the name changed.
    if (!prev || prev.path !== now.path || !$('#viewer textarea')) renderEditor(now);
    return;
  }
  const stale = !prev || prev.version !== now.version || prev.path !== now.path || permissionsChanged;
  if (stale || !$('#viewer .file-head')) open(now.id);
}

async function poll() {
  if (document.hidden || !project) return;
  try {
    const meta = await call('GET', api);
    if (meta.rev !== project.rev || meta.canEdit !== project.canEdit || meta.editMode !== project.editMode) applyMeta(meta);
  } catch (err) {
    if (err.status === 404) expire();
  }
}

// ---------- boot ----------

function notFound() {
  document.title = 'No encontrado · codeshare';
  $('#viewer').innerHTML = `<div class="notice"><div>
    <h2>Este proyecto no existe o ya expiró</h2>
    <p>Los proyectos se eliminan automáticamente después de 24 horas.</p>
    <a class="btn btn-primary" href="/">Compartir archivos</a>
  </div></div>`;
}

function expire() {
  editing = null;
  $('#tree').hidden = true;
  for (const el of ['#copy-link', '#zip', '#tree-toggle', '#expires', '#mode-chip', '#open-settings']) $(el).hidden = true;
  project = null;
  notFound();
}

function tickExpiry() {
  if (!project) return false;
  if (project.expiresAt <= Date.now()) {
    expire();
    return false;
  }
  $('#expires').textContent = `expira en ${timeLeft(project.expiresAt)}`;
  return true;
}

async function boot() {
  if (!id) return notFound();
  let meta;
  try {
    meta = await call('GET', api);
  } catch (err) {
    if (err.status === 404) return notFound();
    $('#viewer').innerHTML = '<div class="notice"><p>Error de conexión.</p></div>';
    return;
  }

  // highlight.js loads with `defer`, which runs before module scripts, but be safe.
  if (!window.hljs) await new Promise((r) => window.addEventListener('load', r, { once: true }));

  if (key && meta.isOwner) saveKey(id, key, meta.expiresAt);
  else if (key && !meta.isOwner) toast('El link de edición no es válido para este proyecto.');

  let wanted = '';
  try {
    wanted = decodeURI(location.hash.slice(1));
  } catch {
    /* malformed hash */
  }
  const fromHash = meta.files.find((f) => f.path === wanted);
  current = (fromHash || treeOrder(buildTree(meta.files))[0]).id;
  applyMeta(meta);

  if (!tickExpiry()) return;
  const timer = setInterval(() => tickExpiry() || clearInterval(timer), 30_000);
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll);
}

boot();
