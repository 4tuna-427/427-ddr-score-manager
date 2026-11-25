// Browser-side perceptual hash (pHash) for DDR jacket matching.
//
// Standard imagehash-style pHash: crop jacket_bbox -> center-square ->
// 32x32 grayscale -> 2D DCT-II -> 8x8 low frequencies -> median threshold
// -> 64-bit hex. The output format matches songs.phash_8 (16 hex chars)
// in the master data, so it can be queried against GET /api/songs/by-phash.
//
// NOTE (Phase 2.4 verification, 2026-11-25): on the 6 Phase 0 photos the
// correct song ranked 2-1271 with hamming distances 18-36/64, while
// unrelated songs matched at 16-20 by chance. Screen-photo moire, glare,
// perspective and unreliable jacket_bbox dominate the hash, so this must
// NOT be used for automatic linking as-is. The function is kept (with the
// /api/songs/by-phash endpoint) as a verified building block; see
// docs/API.md and overnight/REPORT.md for the numbers and what would be
// needed to revisit it (better bbox, a different matching signal).

/** 1D DCT-II (unnormalized, matching scipy fftpack.dct default). */
function dct1d(input: readonly number[]): number[] {
  const n = input.length;
  const out = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let m = 0; m < n; m++) {
      sum += input[m] * Math.cos((Math.PI * k * (2 * m + 1)) / (2 * n));
    }
    out[k] = sum;
  }
  return out;
}

/**
 * pHash from a 32x32 grayscale image (1024 values, row-major).
 * Pure function: 2D DCT (rows then columns), 8x8 low frequencies,
 * median threshold (DC coefficient included, as in imagehash), bits packed
 * row-major, MSB first, as 16 lowercase hex chars.
 */
export function phashFromGray32(gray: ArrayLike<number>): string {
  if (gray.length !== 1024) throw new Error("phashFromGray32 needs 1024 grayscale values");
  // Row DCT, then column DCT.
  const tmp = new Float64Array(1024);
  for (let r = 0; r < 32; r++) {
    const row = dct1d(Array.from({ length: 32 }, (_, c) => gray[r * 32 + c]));
    for (let c = 0; c < 32; c++) tmp[r * 32 + c] = row[c];
  }
  const dct = new Float64Array(1024);
  for (let c = 0; c < 32; c++) {
    const col = dct1d(Array.from({ length: 32 }, (_, r) => tmp[r * 32 + c]));
    for (let r = 0; r < 32; r++) dct[r * 32 + c] = col[r];
  }
  const low: number[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) low.push(dct[r * 32 + c]);
  }
  const sorted = [...low].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) {
      nibble = (nibble << 1) | (low[i + j] > median ? 1 : 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

export type JacketBbox = [number, number, number, number];

/**
 * Compute the jacket pHash of an image Blob.
 * `bbox` is the Gemini jacket_bbox in 0-1000 coordinates
 * [x_min, y_min, x_max, y_max]. The largest centered square inside the
 * box is used (the box is usually loose and non-square; see the Phase 2.4
 * verification). Returns null when the image cannot be decoded or the
 * bbox is unusable. Runs in the browser only (Canvas + createImageBitmap);
 * no image data leaves the device.
 */
export async function computeJacketPhash(blob: Blob, bbox: JacketBbox): Promise<string | null> {
  const [bx0, by0, bx1, by1] = bbox;
  if (
    !bbox.every((v) => Number.isFinite(v)) ||
    bx1 <= bx0 || by1 <= by0
  ) {
    return null;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    // Clamp the box to the image, then take the largest centered square.
    const x0 = Math.max(0, Math.min(bitmap.width, (bx0 / 1000) * bitmap.width));
    const y0 = Math.max(0, Math.min(bitmap.height, (by0 / 1000) * bitmap.height));
    const x1 = Math.max(0, Math.min(bitmap.width, (bx1 / 1000) * bitmap.width));
    const y1 = Math.max(0, Math.min(bitmap.height, (by1 / 1000) * bitmap.height));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 8 || h < 8) return null;
    const side = Math.min(w, h);
    const sx = x0 + (w - side) / 2;
    const sy = y0 + (h - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    const gray = new Float64Array(1024);
    for (let i = 0; i < 1024; i++) {
      // ITU-R 601-2 luma, same as PIL convert("L").
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return phashFromGray32(gray);
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
