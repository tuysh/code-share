import { icons, formatSize, timeLeft, escapeHtml, copyText, toast } from './common.js';

const $ = (sel) => document.querySelector(sel);
const id = location.pathname.split('/')[1];
const api = `/api/projects/${encodeURIComponent(id)}`;

const NO_HIGHLIGHT_OVER = 512 * 1024;

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

let project;
let current = -1;
const cache = new Map();

for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icons[el.dataset.icon];

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const ext = (p) => {
  const name = basename(p).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
};

function languageFor(path) {
  const name = basename(path).toLowerCase();
  const lang = BY_NAME[name] || (name.startsWith('dockerfile') && 'dockerfile') || BY_EXT[ext(path)];
  return lang && window.hljs?.getLanguage(lang) ? lang : null;
}

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

function renderTree(node) {
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => byName(a, b));
  const files = [...node.files].sort((a, b) => byName(basename(a.path), basename(b.path)));
  return [
    ...dirs.map(
      ([name, child]) => `<li class="folder">
        <button type="button" class="node folder-node">${icons.chevron.replace('<svg', '<svg class="chev"')}<span>${escapeHtml(name)}</span></button>
        <ul>${renderTree(child)}</ul>
      </li>`,
    ),
    ...files.map(
      (f) => `<li><button type="button" class="node file-node" data-n="${f.index}" title="${escapeHtml(f.path)}">${icons.file}<span>${escapeHtml(basename(f.path))}</span></button></li>`,
    ),
  ].join('');
}

/** Files in the order they appear in the tree, so the default pick matches what's on screen. */
function treeOrder(node, out = []) {
  for (const [, child] of [...node.dirs.entries()].sort(([a], [b]) => byName(a, b))) treeOrder(child, out);
  out.push(...[...node.files].sort((a, b) => byName(basename(a.path), basename(b.path))));
  return out;
}

$('#tree-root').addEventListener('click', (e) => {
  const folder = e.target.closest('.folder-node');
  if (folder) return folder.parentElement.classList.toggle('closed');
  const file = e.target.closest('.file-node');
  if (file) {
    open(Number(file.dataset.n));
    if (matchMedia('(max-width: 760px)').matches) $('#tree').classList.add('collapsed');
  }
});

$('#tree-toggle').addEventListener('click', () => $('#tree').classList.toggle('collapsed'));

// ---------- viewer ----------

function fileHeader(f) {
  const slash = f.path.lastIndexOf('/');
  const dir = slash >= 0 ? escapeHtml(f.path.slice(0, slash + 1)) : '';
  const raw = `${api}/files/${f.index}`;
  return `<div class="file-head">
    <div class="crumbs" title="${escapeHtml(f.path)}">${dir}<b>${escapeHtml(basename(f.path))}</b></div>
    <span class="file-meta">${formatSize(f.size)}</span>
    <div class="file-tools">
      ${f.binary ? '' : `<button type="button" class="btn btn-ghost btn-icon" id="copy-file" title="Copiar contenido" aria-label="Copiar contenido">${icons.copy}</button>`}
      <a class="btn btn-ghost btn-icon" href="${raw}" target="_blank" rel="noopener" title="Ver raw" aria-label="Ver raw">${icons.raw}</a>
      <a class="btn btn-ghost btn-icon" href="${raw}?download" title="Descargar" aria-label="Descargar">${icons.download}</a>
    </div>
  </div>`;
}

async function open(n) {
  const f = project.files[n];
  if (!f) return;
  current = n;
  history.replaceState(null, '', `#${encodeURI(f.path)}`);
  document.title = `${basename(f.path)} · ${id} · codeshare`;
  for (const el of document.querySelectorAll('.file-node')) el.classList.toggle('active', Number(el.dataset.n) === n);

  const viewer = $('#viewer');
  const raw = `${api}/files/${n}`;

  if (f.binary) {
    viewer.innerHTML = IMAGE_EXT.has(ext(f.path))
      ? `${fileHeader(f)}<div class="preview"><img src="${raw}" alt="${escapeHtml(f.path)}"></div>`
      : `${fileHeader(f)}<div class="notice"><div><h2>Archivo binario</h2><p>No se puede mostrar como texto.</p><a class="btn" href="${raw}?download">${icons.download}Descargar · ${formatSize(f.size)}</a></div></div>`;
    return;
  }

  if (f.size === 0) {
    viewer.innerHTML = `${fileHeader(f)}<div class="notice"><p>Archivo vacío.</p></div>`;
    return;
  }

  let text = cache.get(n);
  if (text === undefined) {
    viewer.innerHTML = `${fileHeader(f)}<div class="notice"><p>Cargando…</p></div>`;
    try {
      const res = await fetch(raw);
      if (!res.ok) throw new Error();
      text = await res.text();
      cache.set(n, text);
    } catch {
      if (current === n) viewer.innerHTML = `${fileHeader(f)}<div class="notice"><p>No se pudo cargar el archivo.</p></div>`;
      return;
    }
    if (current !== n) return;
  }

  const lang = f.size <= NO_HIGHLIGHT_OVER ? languageFor(f.path) : null;
  const html = lang ? window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : escapeHtml(text);
  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  const gutter = Array.from({ length: lines }, (_, i) => i + 1).join('\n');

  viewer.innerHTML = `${fileHeader(f)}<div class="code-wrap"><div class="code">
    <pre class="gutter" aria-hidden="true">${gutter}</pre>
    <pre class="src"><code class="hljs">${html}</code></pre>
  </div></div>`;

  $('#copy-file').addEventListener('click', async () => {
    if (await copyText(text)) toast('Contenido copiado');
  });
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

function tickExpiry() {
  const left = timeLeft(project.expiresAt);
  $('#expires').textContent = left === 'expirado' ? 'expirado' : `expira en ${left}`;
  if (project.expiresAt <= Date.now()) {
    $('#tree').hidden = true;
    for (const el of ['#copy-link', '#zip', '#tree-toggle', '#expires']) $(el).hidden = true;
    notFound();
    return false;
  }
  return true;
}

async function boot() {
  if (!id) return notFound();
  let res;
  try {
    res = await fetch(api);
  } catch {
    $('#viewer').innerHTML = '<div class="notice"><p>Error de conexión.</p></div>';
    return;
  }
  if (!res.ok) return notFound();
  project = await res.json();

  // highlight.js loads with `defer`, which runs before module scripts, but be safe.
  if (!window.hljs) await new Promise((r) => window.addEventListener('load', r, { once: true }));

  $('#pid').textContent = `/${project.id}`;
  $('#pid').hidden = false;
  $('#expires').hidden = false;
  $('#copy-link').hidden = false;
  $('#tree-toggle').hidden = false;
  $('#zip').hidden = false;
  $('#zip').href = `${api}/zip`;
  $('#file-count').textContent = String(project.files.length);
  $('#copy-link').addEventListener('click', async () => {
    if (await copyText(`${location.origin}/${project.id}`)) toast('Link copiado');
  });

  if (!tickExpiry()) return;
  const timer = setInterval(() => tickExpiry() || clearInterval(timer), 30_000);

  const tree = buildTree(project.files);
  $('#tree-root').innerHTML = renderTree(tree);
  $('#tree').hidden = false;
  if (project.files.length === 1) {
    // A single file doesn't need a sidebar.
    $('#tree').hidden = true;
    $('#tree-toggle').hidden = true;
  }

  let wanted = '';
  try {
    wanted = decodeURI(location.hash.slice(1));
  } catch {
    /* malformed hash */
  }
  const fromHash = project.files.find((f) => f.path === wanted);
  open((fromHash || treeOrder(tree)[0]).index);
}

boot();
