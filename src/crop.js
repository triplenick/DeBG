// Bounds only: never change foreground pixels or scale the image. Alpha <= 2
// (less than 1% opacity) cannot anchor a crop. Keep a small edge guard plus
// the full support of the worker's three box-blur passes for soft feathering.
export function foregroundBounds(rgba, width, height, feather = 0) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= 2) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  // An empty/nearly invisible result has no reliable bounds. Preserve its
  // original dimensions rather than inventing a zero-sized or misleading crop.
  if (right < 0) return { x: 0, y: 0, width, height };
  // Include near-transparent feather tails near the significant foreground,
  // without letting isolated distant noise expand the crop to the whole image.
  const support = 2 + 3 * Math.max(0, Math.round(feather));
  const scanLeft = Math.max(0, left - support), scanRight = Math.min(width - 1, right + support);
  const scanTop = Math.max(0, top - support), scanBottom = Math.min(height - 1, bottom + support);
  for (let y = scanTop; y <= scanBottom; y++) {
    for (let x = scanLeft; x <= scanRight; x++) {
      if (!rgba[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const pad = 2;
  left = Math.max(0, left - pad); top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
