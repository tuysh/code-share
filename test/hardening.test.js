import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig, parseTrustProxy } from '../src/config.js';
import { Store } from '../src/store.js';
import { createApp, clientKey } from '../src/app.js';
import { sanitizePath, zipNames } from '../src/paths.js';

const MB = 1024 * 1024;
const servers = [];

async function start(env = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-share-hard-'));
  const config = loadConfig({ DATA_DIR: dataDir, UPLOADS_PER_HOUR: '1000', EDITS_PER_HOUR: '10000', ...env });
  const store = new Store(config);
  await store.init();
  const server = createApp(config, store).listen(0);
  await new Promise((r) => server.once('listening', r));
  const ctx = { dataDir, store, server, base: `http://127.0.0.1:${server.address().port}` };
  servers.push(ctx);
  return ctx;
}

after(async () => {
  for (const { server, dataDir } of servers) {
    server.closeAllConnections();
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

let main;
before(async () => {
  main = await start();
});

async function create(base, files, { editMode, manifest } = {}) {
  const form = new FormData();
  if (editMode) form.append('editMode', editMode);
  if (manifest) form.append('manifest', JSON.stringify(manifest));
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  const res = await fetch(`${base}/api/projects`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

const openFds = () => readdirSync('/proc/self/fd').length;
// Bugs here tend to hang a response rather than fail it; never wait forever.
const get = (url, init = {}) => fetch(url, { signal: AbortSignal.timeout(5000), ...init });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a download, reads one chunk and hangs up, like a cancelled download. */
function abortAfterFirstChunk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
      res.once('end', resolve);
    });
    req.on('error', resolve);
  });
}

test('a file missing on disk returns 404 instead of crashing the server', async () => {
  const { body: p } = await create(main.base, [['a.txt', 'hola'], ['b.txt', 'adiós']]);
  await fs.rm(main.store.filePath(p.id, '0'));
  assert.equal((await get(`${main.base}/api/projects/${p.id}/files/0`)).status, 404);
  assert.equal((await get(`${main.base}/${p.id}/raw/a.txt`)).status, 404);
  assert.equal(await (await get(`${main.base}/api/projects/${p.id}/files/1`)).text(), 'adiós');
});

test('reading a file while it is being deleted never crashes the server', async () => {
  for (let round = 0; round < 20; round++) {
    const { body: p } = await create(main.base, [['big.bin', crypto.randomBytes(64 * 1024)], ['keep.txt', 'x']]);
    let deleting = true;
    // Keep GETs in flight for the whole duration of the DELETE.
    const workers = Array.from({ length: 16 }, async () => {
      while (deleting) {
        await get(`${main.base}/api/projects/${p.id}/files/0`)
          .then((r) => r.arrayBuffer())
          .catch(() => {});
      }
    });
    await sleep(5);
    await get(`${main.base}/api/projects/${p.id}/files/0`, {
      method: 'DELETE',
      headers: { 'x-edit-token': p.editToken },
    }).catch(() => {});
    deleting = false;
    await Promise.all(workers);
  }
  assert.equal((await get(`${main.base}/healthz`)).status, 200);
});

test('cancelled downloads release their files (no fd leak)', async () => {
  const { body: p } = await create(main.base, [
    ['a.bin', crypto.randomBytes(2 * MB)],
    ['b.bin', crypto.randomBytes(2 * MB)],
  ]);
  // Warm up lazily-opened handles so they don't count as leaks.
  await abortAfterFirstChunk(`${main.base}/api/projects/${p.id}/files/0`);
  await abortAfterFirstChunk(`${main.base}/api/projects/${p.id}/zip`);
  await sleep(200);
  const baseline = openFds();

  for (let i = 0; i < 20; i++) {
    await abortAfterFirstChunk(`${main.base}/api/projects/${p.id}/files/0`);
    await abortAfterFirstChunk(`${main.base}/api/projects/${p.id}/zip`);
  }
  await sleep(300);
  assert.ok(openFds() <= baseline + 3, `fds grew from ${baseline} to ${openFds()}`);

  // A full zip download still works.
  const zip = await fetch(`${main.base}/api/projects/${p.id}/zip`);
  assert.equal(zip.status, 200);
  assert.ok((await zip.arrayBuffer()).byteLength > 4 * MB);
});

test('uploads stop writing to disk as soon as they exceed the project budget', async () => {
  const ctx = await start({ MAX_TOTAL_SIZE_MB: '1', MAX_FILE_SIZE_MB: '1' });
  let peak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      let total = 0;
      for (const name of await fs.readdir(ctx.store.tmpDir).catch(() => [])) {
        total += (await fs.stat(path.join(ctx.store.tmpDir, name)).catch(() => ({ size: 0 }))).size;
      }
      peak = Math.max(peak, total);
      await sleep(2);
    }
  })();

  // 8 × 0.9 MB: each file is under the per-file limit but the request is 7.2 MB.
  const files = Array.from({ length: 8 }, (_, i) => [`f${i}.bin`, crypto.randomBytes(0.9 * MB)]);
  const res = await create(ctx.base, files);
  sampling = false;
  await sampler;

  assert.equal(res.status, 413);
  assert.match(res.body.error, /1 MB/);
  assert.ok(peak <= 1.5 * MB, `wrote ${(peak / MB).toFixed(1)} MB to disk before rejecting`);
  assert.deepEqual(await fs.readdir(ctx.store.tmpDir), []);

  // Adding files only gets what is left of the project's budget.
  const { body: p } = await create(ctx.base, [['a.bin', crypto.randomBytes(0.8 * MB)]]);
  const form = new FormData();
  form.append('files', new Blob([crypto.randomBytes(0.5 * MB)]), 'b.bin');
  const add = await fetch(`${ctx.base}/api/projects/${p.id}/files`, {
    method: 'POST',
    body: form,
    headers: { 'x-edit-token': p.editToken },
  });
  assert.equal(add.status, 413);
  assert.deepEqual(await fs.readdir(ctx.store.tmpDir), []);
});

test('oversized saves get a 413 response, declared or chunked', async () => {
  const ctx = await start({ MAX_FILE_SIZE_MB: '1' });
  const { body: p } = await create(ctx.base, [['a.txt', 'hola']]);
  const url = `${ctx.base}/api/projects/${p.id}/files/0`;
  const headers = { 'x-edit-token': p.editToken };

  const declared = await fetch(url, { method: 'PUT', headers, body: 'x'.repeat(MB + 1) });
  assert.equal(declared.status, 413);

  const chunks = [Buffer.alloc(600 * 1024, 'a'), Buffer.alloc(600 * 1024, 'b')];
  const chunked = await fetch(url, {
    method: 'PUT',
    headers,
    duplex: 'half',
    body: new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    }),
  });
  assert.equal(chunked.status, 413);
  assert.equal(await (await fetch(url)).text(), 'hola');
  assert.deepEqual(await fs.readdir(ctx.store.tmpDir), []);
});

test('a write still uploading when the owner locks the project is rejected', async () => {
  const { body: p } = await create(main.base, [['a.txt', 'original']], { editMode: 'anyone' });
  let release;
  const gate = new Promise((r) => (release = r));
  let sent = false;
  const slowPut = fetch(`${main.base}/api/projects/${p.id}/files/0`, {
    method: 'PUT',
    duplex: 'half',
    body: new ReadableStream({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('vandal'));
          return;
        }
        await gate;
        controller.enqueue(new TextEncoder().encode('ismo'));
        controller.close();
      },
    }),
  });
  await sleep(100);
  const lock = await fetch(`${main.base}/api/projects/${p.id}`, {
    method: 'PATCH',
    headers: { 'x-edit-token': p.editToken, 'content-type': 'application/json' },
    body: JSON.stringify({ editMode: 'owner' }),
  });
  assert.equal(lock.status, 200);
  release();
  assert.equal((await slowPut).status, 403);
  assert.equal(await (await fetch(`${main.base}/api/projects/${p.id}/files/0`)).text(), 'original');
});

test('a deleted file stays listed if its deletion could not be saved', async () => {
  const { body: p } = await create(main.base, [['a.txt', 'a'], ['b.txt', 'b']]);
  const original = main.store.writeMeta.bind(main.store);
  main.store.writeMeta = async () => {
    throw new Error('disk full');
  };
  try {
    const res = await fetch(`${main.base}/api/projects/${p.id}/files/0`, {
      method: 'DELETE',
      headers: { 'x-edit-token': p.editToken },
    });
    assert.equal(res.status, 500);
  } finally {
    main.store.writeMeta = original;
  }
  // Still listed, and still readable: the file was not removed before meta was saved.
  assert.equal(await (await get(`${main.base}/api/projects/${p.id}/files/0`)).text(), 'a');
});

test('a file and a folder can never share a path', async () => {
  const { body: p } = await create(main.base, [['x', '1'], ['y', '2']], { manifest: ['lib', 'lib/x.js'] });
  assert.deepEqual(p.files.map((f) => f.path), ['lib', 'lib (2)/x.js']);

  const rename = (fileId, newPath) =>
    fetch(`${main.base}/api/projects/${p.id}/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'x-edit-token': p.editToken, 'content-type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    });
  assert.equal((await rename('1', 'lib/x.js')).status, 409, 'folder would collide with file "lib"');
  assert.equal((await rename('0', 'lib (2)')).status, 409, 'file would collide with folder "lib (2)"');
  assert.equal((await rename('0', 'docs/lib')).status, 200);
});

test('long names are cut without breaking characters', async () => {
  const long = `${'a'.repeat(199)}😀😀.txt`;
  const clean = sanitizePath(long, 'x');
  assert.ok(clean.isWellFormed());
  assert.ok(Buffer.byteLength(clean) <= 200);
  assert.equal(sanitizePath('bad\uD800name.js', 'x'), 'bad�name.js');

  const { body: p } = await create(main.base, [['x', 'hola']], { manifest: [long] });
  assert.ok(p.files[0].path.isWellFormed());
  assert.equal((await fetch(`${main.base}/api/projects/${p.id}/files/0`)).status, 200);
  assert.equal((await fetch(`${main.base}/api/projects/${p.id}/files/0?download`)).status, 200);
});

test('zip entry names are portable', () => {
  assert.deepEqual(
    zipNames(['a:b?.txt', 'CON.txt', 'src/nul', 'README.md', 'readme.md', 'notes. ', 'Docs/a.js', 'docs/b.js']),
    ['a_b_.txt', '_CON.txt', 'src/_nul', 'README.md', 'readme (2).md', 'notes__', 'Docs/a.js', 'docs/b.js'],
  );
});

test('stray files left by a crash are removed on start', async () => {
  const { body: p } = await create(main.base, [['a.txt', 'a']]);
  const dir = main.store.projectDir(p.id);
  await fs.writeFile(path.join(dir, 'files', '7'), 'orphan');
  await fs.writeFile(path.join(dir, 'files', '0.tmp'), 'half');
  await fs.writeFile(path.join(dir, 'meta.json.tmp'), '{');
  const fresh = new Store(loadConfig({ DATA_DIR: main.dataDir }));
  await fresh.init();
  assert.deepEqual(await fs.readdir(path.join(dir, 'files')), ['0']);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['files', 'meta.json']);
});

test('TRUST_PROXY never lets clients pick their own IP', async () => {
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('true'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');

  // Behind one proxy that appends the real client IP, a forged entry must not reset the limit.
  const ctx = await start({ TRUST_PROXY: 'true', UPLOADS_PER_HOUR: '2' });
  const statuses = [];
  for (let n = 1; n <= 4; n++) {
    const form = new FormData();
    form.append('files', new Blob(['x']), 'a.txt');
    const res = await fetch(`${ctx.base}/api/projects`, {
      method: 'POST',
      body: form,
      headers: { 'x-forwarded-for': `1.2.3.${n}, 203.0.113.7` },
    });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [201, 201, 429, 429]);
});

test('IPv6 clients are rate-limited per /64', () => {
  assert.equal(clientKey('2001:db8:1:2:3:4:5:6'), clientKey('2001:db8:1:2::9'));
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
  assert.equal(clientKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(clientKey('1.2.3.4'), '1.2.3.4');
});

test('out-of-range settings are clamped', () => {
  const config = loadConfig({ SWEEP_INTERVAL_SECONDS: '3000000', ID_LENGTH: '100', TTL_HOURS: '0', MAX_FILES: '-5' });
  assert.equal(config.sweepIntervalMs, 86_400_000);
  assert.equal(config.idLength, 32);
  assert.equal(config.ttlMs, 3_600_000);
  assert.equal(config.maxFiles, 1);
  assert.equal(loadConfig({ ID_LENGTH: 'abc' }).idLength, 6);
});

test('highlight.js is served from a versioned URL', async () => {
  const ctx = await start({ NODE_ENV: 'production' });
  const html = await (await fetch(`${ctx.base}/zzzzzz`)).text();
  const src = /src="(\/vendor\/hljs\/[\d.]+\/highlight\.min\.js)"/.exec(html)?.[1];
  assert.ok(src, 'project page points at a versioned highlight.js');
  const res = await fetch(ctx.base + src);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /immutable/);
});
