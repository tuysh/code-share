import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

let dataDir, store, server, base;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-share-edit-'));
  const config = loadConfig({ DATA_DIR: dataDir, MAX_FILES: '3', UPLOADS_PER_HOUR: '1000' });
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

async function create(editMode) {
  const form = new FormData();
  if (editMode) form.append('editMode', editMode);
  form.append('files', new Blob(['uno\n']), 'a.txt');
  const res = await fetch(`${base}/api/projects`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  return res.json();
}

const api = (p, { token, ...init } = {}) =>
  fetch(`${base}/api/projects/${p}`, { ...init, headers: { ...(token ? { 'x-edit-token': token } : {}), ...init.headers } });

const addFile = (id, name, content, token) => {
  const form = new FormData();
  form.append('manifest', JSON.stringify([name]));
  form.append('files', new Blob([content]), 'x');
  return api(`${id}/files`, { method: 'POST', body: form, token });
};

test('creator gets a private key; without it the project is read-only', async () => {
  const p = await create();
  assert.equal(p.editMode, 'owner');
  assert.ok(p.isOwner && p.canEdit);
  assert.ok(p.editToken.length >= 32);
  assert.equal(p.editUrl, `${p.url}#key=${p.editToken}`);

  const anon = await (await api(p.id)).json();
  assert.equal(anon.canEdit, false);
  assert.equal(anon.isOwner, false);
  assert.equal(anon.editToken, undefined);

  assert.equal((await api(`${p.id}/files/0`, { method: 'PUT', body: 'hack' })).status, 403);
  assert.equal((await api(`${p.id}/files/0`, { method: 'PUT', body: 'hack', token: 'wrong' })).status, 403);
  assert.equal((await addFile(p.id, 'b.txt', 'x')).status, 403);
  assert.equal((await api(`${p.id}/files/0`, { method: 'DELETE' })).status, 403);
  assert.equal(await (await api(`${p.id}/files/0`)).text(), 'uno\n');

  const meta = JSON.parse(await fs.readFile(store.metaPath(p.id), 'utf8'));
  assert.ok(!JSON.stringify(meta).includes(p.editToken), 'only a hash of the key is stored');
});

test('owner can edit, add, rename and delete files', async () => {
  const p = await create();
  const token = p.editToken;

  let res = await api(`${p.id}/files/0`, { method: 'PUT', body: 'dos\n', token, headers: { 'x-base-version': '1' } });
  assert.equal(res.status, 200);
  let meta = await res.json();
  assert.equal(meta.files[0].version, 2);
  assert.equal(meta.rev, 2);
  assert.equal(await (await api(`${p.id}/files/0`)).text(), 'dos\n');

  res = await addFile(p.id, 'src/b.js', 'let b;', token);
  assert.equal(res.status, 201);
  meta = await res.json();
  assert.deepEqual(meta.files.map((f) => f.path), ['a.txt', 'src/b.js']);
  const bId = meta.added[0];

  res = await api(`${p.id}/files/${bId}`, {
    method: 'PATCH', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'lib/../c.js' }),
  });
  assert.equal((await res.json()).files[1].path, 'lib/c.js');

  res = await api(`${p.id}/files/${bId}`, {
    method: 'PATCH', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'a.txt' }),
  });
  assert.equal(res.status, 409);

  res = await api(`${p.id}/files/0`, { method: 'DELETE', token });
  assert.deepEqual((await res.json()).files.map((f) => f.path), ['lib/c.js']);
  assert.equal((await api(`${p.id}/files/0`)).status, 404);
  assert.equal((await api(`${p.id}/files/${bId}`, { method: 'DELETE', token })).status, 400, 'keeps at least one file');
});

test('stale saves are rejected with 409', async () => {
  const p = await create();
  const put = (body, v) => api(`${p.id}/files/0`, { method: 'PUT', body, token: p.editToken, headers: { 'x-base-version': v } });
  assert.equal((await put('primero', '1')).status, 200);
  assert.equal((await put('segundo', '1')).status, 409);
  assert.equal(await (await api(`${p.id}/files/0`)).text(), 'primero');
});

test('"anyone" mode lets everybody edit, but only the owner manages the project', async () => {
  const p = await create('anyone');
  const anon = await (await api(p.id)).json();
  assert.equal(anon.canEdit, true);
  assert.equal(anon.isOwner, false);

  assert.equal((await api(`${p.id}/files/0`, { method: 'PUT', body: 'de todos' })).status, 200);
  assert.equal((await addFile(p.id, 'nuevo.txt', 'hola')).status, 201);

  const patch = (body, token) =>
    api(p.id, { method: 'PATCH', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await patch({ editMode: 'owner' })).status, 403);
  assert.equal((await api(p.id, { method: 'DELETE' })).status, 403);

  assert.equal((await patch({ editMode: 'owner' }, p.editToken)).status, 200);
  assert.equal((await api(`${p.id}/files/0`, { method: 'PUT', body: 'otra vez' })).status, 403);

  assert.equal((await api(p.id, { method: 'DELETE', token: p.editToken })).status, 204);
  assert.equal((await api(p.id)).status, 404);
  await assert.rejects(fs.access(store.projectDir(p.id)));
});

test('edits respect file count limits and do not extend expiry', async () => {
  const p = await create();
  assert.equal((await addFile(p.id, 'b', '1', p.editToken)).status, 201);
  assert.equal((await addFile(p.id, 'c', '1', p.editToken)).status, 201);
  const res = await addFile(p.id, 'd', '1', p.editToken);
  assert.equal(res.status, 413);
  assert.equal((await fs.readdir(store.tmpDir)).length, 0);
  const meta = await (await api(p.id)).json();
  assert.equal(meta.expiresAt, p.expiresAt);
});

test('concurrent edits do not lose files', async () => {
  const p = await create('anyone');
  await Promise.all([addFile(p.id, 'x.txt', 'x'), addFile(p.id, 'y.txt', 'y')]);
  const meta = await (await api(p.id)).json();
  assert.deepEqual(meta.files.map((f) => f.path).sort(), ['a.txt', 'x.txt', 'y.txt']);
});

test('projects stored by the previous version still load (read-only)', async () => {
  const id = 'Legacy1';
  const dir = path.join(dataDir, 'projects', id);
  await fs.mkdir(path.join(dir, 'files'), { recursive: true });
  await fs.writeFile(path.join(dir, 'files', '0'), 'viejo');
  const now = Date.now();
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, createdAt: now, expiresAt: now + 60_000, files: [{ path: 'a.txt', size: 5, binary: false }] }),
  );
  const fresh = new Store({ dataDir, ttlMs: 1000, idLength: 6 });
  await fresh.init();
  const meta = await fresh.get(id);
  assert.equal(meta.files[0].id, '0');
  assert.equal(meta.editMode, 'owner');
  assert.equal(fresh.canEdit(meta, ''), false);
  assert.equal(fresh.canEdit(meta, 'anything'), false);
});
