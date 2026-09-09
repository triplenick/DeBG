const path = require('path');
const { randomUUID } = require('crypto');
const fs = require('fs');
const { mkdtemp, writeFile, rm } = fs.promises;

// Only main chooses paths. Renderer receives opaque capabilities, never paths.
function createDragFiles(tempRoot, nativeImage) {
  let root;
  const files = new Map();
  const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
  return {
    async prepare(owner, name, bytes) {
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 256 * 1024 * 1024) throw new Error('Invalid PNG payload.');
      const buffer = Buffer.from(bytes);
      if (!buffer.subarray(0, 8).equals(pngSignature)) throw new Error('Expected a PNG file.');
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw new Error('Invalid PNG image.');
      root ||= mkdtemp(path.join(tempRoot, 'debg-drag-'));
      const token = randomUUID();
      const dir = path.join(await root, token);
      await fs.promises.mkdir(dir);
      const base = String(name).replace(/\.png$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
      const filename = `${/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base) ? '_' : ''}${base || 'result'}.png`;
      const file = path.join(dir, filename);
      await writeFile(file, buffer, { flag: 'wx' });
      const size = image.getSize();
      const scale = Math.min(1, 128 / Math.max(size.width, size.height));
      const icon = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
      files.set(token, { owner, file, dir, icon, dragged: false });
      return token;
    },
    start(owner, token, sender) {
      const entry = files.get(token);
      if (!entry || entry.owner !== owner) return;
      // Receivers may read after the drag returns. Keep dragged files immutable
      // and alive through reprocessing/removal, until the app exits.
      entry.dragged = true;
      sender.startDrag({ file: entry.file, icon: entry.icon });
    },
    release(owner, token) {
      const entry = files.get(token);
      if (!entry || entry.owner !== owner) return;
      files.delete(token);
      if (!entry.dragged) rm(entry.dir, { recursive: true, force: true }).catch(console.error);
    },
    async cleanup() {
      if (root) await rm(await root, { recursive: true, force: true });
      files.clear();
    },
  };
}
module.exports = { createDragFiles };
