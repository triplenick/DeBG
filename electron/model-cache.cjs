const path = require('node:path');
const { statSync } = require('node:fs');
const modelIds = new Set(['birefnet-general', 'birefnet-portrait', 'bria-rmbg', 'isnet-general-use', 'isnet-anime', 'u2net_human_seg', 'silueta', 'u2netp', 'u2net']);
function isModelCached(root, id) {
  if (!modelIds.has(id)) return false;
  // Match rembg's current per-model directory and its legacy flat layout.
  return [path.join(root, 'models', id, `${id}.onnx`), path.join(root, `${id}.onnx`)].some(file => {
    try { const stat = statSync(file); return stat.isFile() && stat.size > 0; }
    catch { return false; }
  });
}
module.exports = { isModelCached };
