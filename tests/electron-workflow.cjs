// Run with: node_modules/electron/dist/electron.exe tests/electron-workflow.cjs
const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { createDragFiles } = require('../electron/drag-files.cjs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, webSecurity: false } });
  try {
    await win.loadFile(path.join(__dirname, 'worker.html'));
    const results = await win.webContents.executeJavaScript(`(async () => {
      const worker = new Worker('../src/worker.js', { type: 'module' });
      const canvas = new OffscreenCanvas(100, 80);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 100, 80);
      const source = await canvas.convertToBlob();
      ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 100, 80);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(30, 20, 20, 30);
      const maskBlob = await canvas.convertToBlob();
      const send = (type, payload) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker timeout')), 10000);
        const handler = ({ data }) => {
          if (!data.id) return;
          worker.removeEventListener('message', handler); clearTimeout(timer);
          data.stage === 'error' ? reject(new Error(data.error)) : resolve(data);
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ type, payload });
      });
      const inspect = async blob => {
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
        const p = x.getImageData(0, 0, c.width, c.height).data;
        const result = { width: c.width, height: c.height, center: Array.from(x.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data), nonzero: 0 };
        for (let i=3; i<p.length; i+=4) if (p[i]) result.nonzero++;
        bmp.close(); return result;
      };
      try {
        const first = await send('process', { id: 'product', maskBlob, imageBlob: source, width: 100, height: 80, settings: { threshold: 0 }, revision: 1 });
        const item = { id: 'product', maskFloat: first.maskFloat, imageBlob: source, width: 100, height: 80 };
        const shrink = await send('reprocess', { items: [item], settings: { threshold: 0, morphSize: -3 }, revision: 2 });
        const feather = await send('reprocess', { items: [item], settings: { threshold: 0, feather: 3 }, revision: 3 });
        const color = await send('reprocess', { items: [item], settings: { threshold: 0, outputMode: 'color' }, revision: 4 });
        const empty = await send('reprocess', { items: [{ ...item, maskFloat: new Float32Array(8000) }], settings: { threshold: 0 }, revision: 5 });
        ctx.clearRect(0, 0, 100, 80);
        const transparentSource = await canvas.convertToBlob();
        const alpha = await send('reprocess', { items: [{ ...item, imageBlob: transparentSource }], settings: { threshold: 0 }, revision: 6 });
        return { first: await inspect(first.resultBlob), preview: await inspect(first.previewBlob), shrink: await inspect(shrink.resultBlob), feather: await inspect(feather.resultBlob), color: await inspect(color.resultBlob), empty: await inspect(empty.resultBlob), alpha: await inspect(alpha.resultBlob), revision: shrink.revision, bytes: Array.from(new Uint8Array(await shrink.resultBlob.arrayBuffer())) };
      } finally { worker.terminate(); }
    })()`);
    assert.deepEqual([results.first.width, results.first.height], [24, 34]);
    assert.deepEqual(results.first.center, [255, 0, 0, 255]);
    assert.equal(results.first.nonzero, 600);
    assert.deepEqual([results.preview.width, results.preview.height], [100, 80]);
    assert.deepEqual([results.shrink.width, results.shrink.height], [18, 28]);
    assert.ok(results.feather.width > results.first.width);
    assert.ok(results.feather.width < 100);
    assert.deepEqual([results.color.width, results.color.height], [100, 80]);
    assert.equal(results.color.nonzero, 8000);
    assert.deepEqual([results.empty.width, results.empty.height, results.empty.nonzero], [100, 80, 0]);
    assert.equal(results.alpha.nonzero, 0);
    assert.equal(results.revision, 2);
    const store = createDragFiles(app.getPath('temp'), nativeImage);
    try {
      const bytes = Uint8Array.from(results.bytes).buffer;
      const token = await store.prepare(win.webContents.id, 'product.png', bytes);
      let payload;
      store.start(win.webContents.id, token, { startDrag: item => { payload = item; } });
      assert.deepEqual(await readFile(payload.file), Buffer.from(bytes));
      assert.equal(payload.icon.isEmpty(), false);
      assert.deepEqual(nativeImage.createFromPath(payload.file).getSize(), { width: 18, height: 28 });
    } finally { await store.cleanup(); }
    console.log('PASS: Electron worker PNG dimensions, pixel preservation, reprocess, feather, comparison, empty alpha, and real PNG drag preparation');
    app.exit(0);
  } catch (err) { console.error(err); app.exit(1); }
});
