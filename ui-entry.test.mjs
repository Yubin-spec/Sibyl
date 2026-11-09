import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_UI_PORT, listenLoopback} from './runtime.mjs';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');

test('default UI port is a usable loopback port', () => {
  assert.ok(Number.isInteger(DEFAULT_UI_PORT));
  assert.ok(DEFAULT_UI_PORT >= 1024 && DEFAULT_UI_PORT <= 65535);
});

test('listenLoopback prefers a free requested port', async () => {
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise(r => probe.close(r));
  const server = createServer((req, res) => res.end('ok'));
  assert.equal(await listenLoopback(server, free), free);
  await new Promise(r => server.close(r));
});

test('listenLoopback falls back only when the port is taken', async () => {
  const blocker = createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const server = createServer((req, res) => res.end('ok'));
  const port = await listenLoopback(server, taken);
  assert.notEqual(port, taken);
  assert.ok(port > 0);
  await new Promise(r => server.close(r));
  await new Promise(r => blocker.close(r));
});

test('an already listening server keeps its port', async () => {
  const server = createServer((req, res) => res.end('ok'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(await listenLoopback(server, DEFAULT_UI_PORT), port);
  await new Promise(r => server.close(r));
});

test('entry points expose a predictable observer address', async () => {
  const [browser, desktop, control] = await Promise.all([read('browser.mjs'), read('desktop.js'), read('control.mjs')]);
  assert.match(browser, /page:\{type:'string'\}/);
  assert.match(browser, /observer/);
  assert.match(desktop, /URLSearchParams\(location\.search\)/);
  assert.match(control, /DEFAULT_UI_PORT/);
  assert.match(control, /SIBYL_UI_PORT/);
});

test('control serves the observer page on the preferred port', async () => {
  const {createControl} = await import('./control.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'sibyl-ui-entry-'));
  const control = await createControl({dir, detect: async () => ({})});
  try {
    const port = await listenLoopback(control.server, DEFAULT_UI_PORT);
    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(base + '/?page=observer')).text();
    assert.match(html, /id="page-observer"/);
    assert.match(html, /type="module"/);
    const script = await (await fetch(base + '/desktop.js')).text();
    assert.match(script, /\/observer-model\.mjs/);
    const denied = await fetch(base + '/api/status');
    assert.equal(denied.status, 403);
  } finally {
    await control.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
});
