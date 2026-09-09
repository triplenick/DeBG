import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { foregroundBounds } from '../src/crop.js';
import health from '../electron/server-health.cjs';
import drag from '../electron/drag-files.cjs';

function pixels(w, h, points) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, alpha] of points) data[(y * w + x) * 4 + 3] = alpha;
  return data;
}

test('crop ignores distant near-transparent noise and keeps edge guard', () => {
  const data = pixels(100, 80, [[40, 30, 255], [60, 50, 100], [0, 0, 2]]);
  assert.deepEqual(foregroundBounds(data, 100, 80), { x: 38, y: 28, width: 25, height: 25 });
});
test('crop preserves nearby alpha-1 feather tails without padding the whole blur radius', () => {
  const data = pixels(100, 100, [[50, 50, 255], [41, 41, 1], [59, 59, 2], [0, 0, 1]]);
  assert.deepEqual(foregroundBounds(data, 100, 100, 3), { x: 39, y: 39, width: 23, height: 23 });
});
test('empty, nearly empty, tiny and edge-touching foregrounds remain valid', () => {
  for (const alpha of [0, 1, 2]) {
    assert.deepEqual(foregroundBounds(pixels(9, 7, [[4, 3, alpha]]), 9, 7), { x: 0, y: 0, width: 9, height: 7 });
  }
  assert.deepEqual(foregroundBounds(pixels(1, 1, [[0, 0, 255]]), 1, 1), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(foregroundBounds(pixels(20, 20, [[0, 19, 255]]), 20, 20), { x: 0, y: 17, width: 3, height: 3 });
});
test('recomputed bounds reflect the current alpha without mutating pixels', () => {
  const data = pixels(100, 100, [[30, 30, 255], [70, 70, 255]]);
  const before = data.slice();
  assert.equal(foregroundBounds(data, 100, 100).width, 45);
  assert.deepEqual(data, before);
  data[(70 * 100 + 70) * 4 + 3] = 0;
  assert.equal(foregroundBounds(data, 100, 100).width, 5);
});
test('readiness requires HTTP success and the expected rembg API', async () => {
  let status = 404, body = '{}';
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/openapi.json');
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(health.checkReadiness(url), /HTTP 404/);
    status = 503;
    await assert.rejects(health.checkReadiness(url), /HTTP 503/);
    status = 200;
    await assert.rejects(health.checkReadiness(url), /expected API/);
    body = 'invalid JSON';
    await assert.rejects(health.checkReadiness(url));
    body = JSON.stringify({ info: { title: 'Rembg' }, paths: { '/api/remove': { post: {} } } });
    await health.checkReadiness(url);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(health.checkReadiness(url, controller.signal));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('drag files are immutable, owner-scoped PNGs independent of output settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'debg-test-'));
  const icon = { isEmpty: () => false, getSize: () => ({ width: 400, height: 200 }), resize: () => ({ thumbnail: true }) };
  const store = drag.createDragFiles(root, { createFromBuffer: () => icon });
  const png = Uint8Array.from(Buffer.from('89504e470d0a1a0a010203', 'hex')).buffer;
  try {
    await assert.rejects(store.prepare(1, 'bad.png', new ArrayBuffer(8)), /PNG/);
    const first = await store.prepare(1, '../../CON.png', png);
    let started;
    store.start(2, first, { startDrag: () => assert.fail('wrong owner') });
    store.start(1, first, { startDrag: value => { started = value; } });
    assert.equal(path.extname(started.file), '.png');
    assert.ok(started.file.startsWith(root + path.sep));
    assert.deepEqual(await readFile(started.file), Buffer.from(png));
    const second = await store.prepare(1, '../../CON.png', png);
    let newer;
    store.start(1, second, { startDrag: value => { newer = value; } });
    assert.notEqual(newer.file, started.file);
    store.release(1, first);
    store.start(1, first, { startDrag: () => assert.fail('released token') });
    await access(started.file); // receiver may still be reading after release
    await store.cleanup();
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('server readiness and exit events cannot be overwritten by a previous process', async () => {
  const children = [], probes = [];
  const realRequire = createRequire(new URL('../electron/main.cjs', import.meta.url));
  const app = { isPackaged: false, on() {}, whenReady: () => new Promise(() => {}) };
  const mocks = {
    electron: { app, ipcMain: { handle() {}, on() {} } },
    fs: { existsSync: () => true, mkdirSync() {}, promises: {} },
    './setup-helpers.cjs': { getRembgExe: () => 'test-rembg' },
    './server-health.cjs': { checkReadiness: () => new Promise(resolve => probes.push(resolve)) },
    child_process: { spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.exitCode = null; child.signalCode = null;
      child.kill = () => { queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); return true; };
      children.push(child); return child;
    } },
  };
  app.getPath = () => 'test-user-data';
  const context = { require: name => mocks[name] || realRequire(name), module: { exports: {} }, process, console, setTimeout, clearTimeout, AbortController, __dirname: path.resolve('electron') };
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports = { startServer, stopServer, state: () => serverState };', context);
  const lifecycle = context.module.exports;
  await lifecycle.startServer({});
  assert.equal(lifecycle.state().ready, false);
  assert.equal(lifecycle.state().starting, true);
  await lifecycle.startServer({});
  assert.equal(children.length, 2);
  probes[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lifecycle.state().ready, false);
  probes[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lifecycle.state().ready, true);
  children[0].emit('exit', 1);
  assert.equal(lifecycle.state().ready, true);
  children[1].emit('exit', 1);
  assert.equal(lifecycle.state().ready, false);
  assert.equal(lifecycle.state().running, false);
  assert.match(lifecycle.state().error, /exited/);
});
