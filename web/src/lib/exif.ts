// Minimal JPEG EXIF reader: returns the capture date (DateTimeOriginal,
// falling back to IFD0 DateTime) or null when absent/unparseable.
// Only the first 256KB are read; EXIF lives in the APP1 segment near the head.

function parseExifDate(s: string): Date | null {
  // EXIF format: "YYYY:MM:DD HH:MM:SS" (local time, no timezone)
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
  return Number.isNaN(date.getTime()) ? null : date
}

export async function readExifCaptureDate(blob: Blob): Promise<Date | null> {
  try {
    const buf = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer())
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null // not JPEG
    let off = 2
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) return null
      const marker = buf[off + 1]
      const len = (buf[off + 2] << 8) | buf[off + 3]
      if (marker === 0xe1 && len > 6) {
        // APP1: check "Exif\0\0"
        const seg = buf.subarray(off + 4, off + 2 + len)
        if (seg[0] === 0x45 && seg[1] === 0x78 && seg[2] === 0x69 && seg[3] === 0x66) {
          return parseTiff(seg.subarray(6))
        }
      }
      if (marker === 0xda || marker === 0xd9) break // SOS / EOI
      off += 2 + len
    }
    return null
  } catch {
    return null
  }
}

function parseTiff(tiff: Uint8Array): Date | null {
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  if (tiff.length < 8) return null
  const little = dv.getUint16(0) === 0x4949 // "II"
  if (!little && dv.getUint16(0) !== 0x4d4d) return null
  const u16 = (o: number) => dv.getUint16(o, little)
  const u32 = (o: number) => dv.getUint32(o, little)
  if (u16(2) !== 42) return null

  const readAscii = (entryOff: number): string | null => {
    const type = u16(entryOff + 2)
    const count = u32(entryOff + 4)
    if (type !== 2 || count === 0) return null
    const valOff = count <= 4 ? entryOff + 8 : u32(entryOff + 8)
    if (valOff + count > tiff.length) return null
    let s = ''
    for (let i = 0; i < count; i++) {
      const ch = tiff[valOff + i]
      if (ch === 0) break
      s += String.fromCharCode(ch)
    }
    return s
  }

  const scanIfd = (ifdOff: number, tags: number[]): Map<number, string> => {
    const found = new Map<number, string>()
    if (ifdOff + 2 > tiff.length) return found
    const n = u16(ifdOff)
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12
      if (e + 12 > tiff.length) break
      const tag = u16(e)
      if (tags.includes(tag)) {
        const s = readAscii(e)
        if (s) found.set(tag, s)
      }
      if (tag === 0x8769) {
        // ExifIFD pointer (LONG offset stored inline)
        const subOff = u32(e + 8)
        for (const [k, v] of scanIfd(subOff, [0x9003])) found.set(k, v)
      }
    }
    return found
  }

  const ifd0 = scanIfd(u32(4), [0x0132])
  const original = ifd0.get(0x9003)
  if (original) {
    const d = parseExifDate(original)
    if (d) return d
  }
  const dt = ifd0.get(0x0132)
  return dt ? parseExifDate(dt) : null
}

/**
 * Best estimate of when the photo was taken:
 * EXIF capture date -> file lastModified -> the given fallback (queue time).
 */
export async function estimateCaptureDate(blob: Blob, fallbackMs: number): Promise<Date> {
  const exif = await readExifCaptureDate(blob)
  if (exif) return exif
  const lm = (blob as File).lastModified
  if (typeof lm === 'number' && lm > 0) return new Date(lm)
  return new Date(fallbackMs)
}
