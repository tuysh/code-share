import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { sanitizePath, uniquePath, PathSet, zipNames } from '../src/paths.js';

let dataDir, store, server, base;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-share-'));
  const config = loadConfig({ DATA_DIR: dataDir, MAX_FILE_SIZE_MB: '1', UPLOADS_PER_HOUR: '1000' });
  store = new Store(config);
  await store.init();
  server = createApp(config, store).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function upload(files, manifest) {
  const form = new FormData();
  if (manifest) form.append('manifest', JSON.stringify(manifest));
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  return fetch(`${base}/api/projects`, { method: 'POST', body: form });
}

test('upload, list, read and zip a project', async () => {
  const res = await upload(
    [['index.js', 'console.log(1)\n'], ['util.py', 'print(2)\n'], ['logo.bin', Buffer.from([0, 1, 2, 3])]],
    ['src/index.js', 'src/lib/util.py', 'assets/logo.bin'],
  );
  assert.equal(res.status, 201);
  const project = await res.json();
  assert.match(project.id, /^[a-zA-Z0-9]{6}$/);
  assert.equal(project.url, `${base}/${project.id}`);
  assert.ok(project.expiresAt - project.createdAt === 24 * 3600 * 1000);
  assert.deepEqual(project.files.map((f) => [f.path, f.binary]), [
    ['src/index.js', false],
    ['src/lib/util.py', false],
    ['assets/logo.bin', true],
  ]);

  const meta = await (await fetch(`${base}/api/projects/${project.id}`)).json();
  assert.equal(meta.files.length, 3);

  const raw = await fetch(`${base}/api/projects/${project.id}/files/0`);
  assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(raw.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await raw.text(), 'console.log(1)\n');

  const short = await fetch(`${base}/${project.id}/raw/src/lib/util.py`);
  assert.equal(await short.text(), 'print(2)\n');

  const zip = await fetch(`${base}/api/projects/${project.id}/zip`);
  assert.equal(zip.status, 200);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');

  const page = await fetch(`${base}/${project.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /project\.js/);
});

test('paths are sanitized and deduplicated', async () => {
  const res = await upload(
    [['a', 'x'], ['b', 'y'], ['c', 'z']],
    ['../../etc/passwd', '/abs/../file.txt', 'abs/file.txt'],
  );
  const project = await res.json();
  assert.deepEqual(project.files.map((f) => f.path), ['etc/passwd', 'abs/file.txt', 'abs/file (2).txt']);

  assert.equal(sanitizePath('..\\..\\win\\x.c', 'f'), 'win/x.c');
  assert.equal(sanitizePath('../..', 'fallback'), 'fallback');
  assert.equal(uniquePath('a.js', new PathSet(['a.js', 'a (2).js'])), 'a (3).js');
});

test('rejects empty and oversized uploads', async () => {
  const empty = await fetch(`${base}/api/projects`, { method: 'POST', body: new FormData() });
  assert.equal(empty.status, 400);
  assert.ok((await empty.json()).error);

  const big = await upload([['big.txt', 'a'.repeat(1024 * 1024 + 1)]]);
  assert.equal(big.status, 413);
  const tmp = await fs.readdir(store.tmpDir);
  assert.equal(tmp.length, 0, 'temp files are cleaned up');
});

test('unknown projects return 404', async () => {
  assert.equal((await fetch(`${base}/api/projects/zzzzzz`)).status, 404);
  assert.equal((await fetch(`${base}/zzzzzz`)).status, 404);
  assert.equal((await fetch(`${base}/api/projects/zzzzzz/files/0`)).status, 404);
});

test('projects are deleted after they expire', async () => {
  const project = await (await upload([['a.txt', 'hola']])).json();
  const dir = store.projectDir(project.id);
  await fs.access(dir);

  await store.sweep(project.expiresAt - 1);
  await fs.access(dir);
  assert.ok(await store.sweep(project.expiresAt) >= 1);
  await assert.rejects(fs.access(dir));
  assert.equal((await fetch(`${base}/api/projects/${project.id}`)).status, 404);
});

test('expired projects are not served even before the sweep runs', async () => {
  const project = await (await upload([['a.txt', 'hola']])).json();
  store.index.set(project.id, Date.now() - 1);
  assert.equal((await fetch(`${base}/api/projects/${project.id}`)).status, 404);
  await assert.rejects(fs.access(store.projectDir(project.id)));
});

test('store reloads projects from disk on restart', async () => {
  const project = await (await upload([['a.txt', 'hola']])).json();
  const fresh = new Store({ dataDir, ttlMs: 1000, idLength: 6 });
  await fresh.init();
  assert.ok(await fresh.get(project.id));
});

test('pages reference versioned assets that are cached immutably in production', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-share-assets-'));
  const config = loadConfig({ DATA_DIR: dir, NODE_ENV: 'production' });
  const prodStore = new Store(config);
  await prodStore.init();
  const prod = createApp(config, prodStore).listen(0);
  await new Promise((r) => prod.once('listening', r));
  const url = `http://127.0.0.1:${prod.address().port}`;
  try {
    const page = await fetch(url);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const html = await page.text();
    const script = /src="(\/assets\/[0-9a-f]{10}\/upload\.js)"/.exec(html)?.[1];
    assert.ok(script, 'index.html points at a versioned script');
    assert.ok(!/"\/assets\/(?![0-9a-f]{10}\/)/.test(html), 'no unversioned asset URLs left');

    const asset = await fetch(url + script);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    // Relative module imports resolve under the same version prefix.
    assert.equal((await fetch(url + script.replace('upload.js', 'common.js'))).status, 200);

    const project = await (await fetch(`${url}/zzzzzz`)).text();
    assert.match(project, /\/assets\/[0-9a-f]{10}\/project\.js/);
  } finally {
    prod.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
