// Convert an image Blob to WebP with max side 1000px (quality 0.82) via Canvas.
export async function convertImage(blob: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob)
    const maxSide = 1000
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
    return out ?? blob
  } catch {
    // If decoding/conversion fails, send the original.
    return blob
  }
}
