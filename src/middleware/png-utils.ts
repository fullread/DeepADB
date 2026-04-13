/**
 * PNG Utilities — Zero-dependency PNG decode and encode for screenshot analysis and annotation.
 *
 * Provides pixel-level PNG decode (used by screenshot-diff.ts and ui.ts),
 * PNG encode (used by ui.ts for annotated screenshots), and drawing primitives
 * for compositing bounding boxes and number labels onto pixel buffers.
 *
 * No external image library dependencies — uses only Node.js built-ins (zlib, fs).
 */

import { readFileSync } from "fs";
import { inflateSync, deflateSync } from "zlib";

// ── CRC32 ─────────────────────────────────────────────────────────────

const CRC32_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = ((CRC32_TABLE[(crc ^ buf[i]!) & 0xFF] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── 5×7 pixel font for digits 0–9 ─────────────────────────────────────

/**
 * Each digit: 7 rows, each row a 5-bit mask (MSB = leftmost pixel).
 * Bit 16 (0b10000) = leftmost column, bit 1 (0b00001) = rightmost.
 */
const DIGIT_FONT: readonly (readonly number[])[] = [
  [14,17,17,17,17,17,14], // 0
  [ 4,12, 4, 4, 4, 4,14], // 1
  [14,17, 1, 2, 4, 8,31], // 2
  [30, 1, 1,14, 1, 1,30], // 3
  [ 2, 6,10,18,31, 2, 2], // 4
  [31,16,16,30, 1, 1,30], // 5
  [14,16,16,30,17,17,14], // 6
  [31, 1, 2, 4, 8, 8, 8], // 7
  [14,17,17,14,17,17,14], // 8
  [14,17,17,15, 1, 1,14], // 9
] as const;

// ── Color palette ──────────────────────────────────────────────────────

/** Cycling color palette for element bounding box annotation. */
export const ELEMENT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255,  50,  50], // red
  [ 50, 210,  50], // green
  [ 50, 100, 255], // blue
  [255, 200,   0], // yellow
  [  0, 210, 210], // cyan
  [255, 100, 200], // pink
  [220, 110,   0], // orange
  [160,  50, 220], // purple
] as const;

// ── Pixel operations ───────────────────────────────────────────────────

/** Write one pixel into a packed row-major RGB/RGBA pixel buffer. No-op if x is out of range. */
function setPixel(
  pixels: Buffer, imgWidth: number, bpp: number,
  x: number, y: number, r: number, g: number, b: number,
): void {
  if (x < 0 || x >= imgWidth) return;
  const off = (y * imgWidth + x) * bpp;
  pixels[off]     = r;
  pixels[off + 1] = g;
  pixels[off + 2] = b;
  if (bpp === 4) pixels[off + 3] = 255;
}

/**
 * Draw a rectangle border on a pixel buffer (in-place).
 * Coordinates are clamped to image bounds. Thickness applies inward from each edge.
 */
export function drawRect(
  pixels: Buffer, imgWidth: number, imgHeight: number, bpp: number,
  x1: number, y1: number, x2: number, y2: number,
  color: readonly [number, number, number],
  thickness = 2,
): void {
  x1 = Math.max(0, Math.min(x1, imgWidth - 1));
  y1 = Math.max(0, Math.min(y1, imgHeight - 1));
  x2 = Math.max(0, Math.min(x2, imgWidth - 1));
  y2 = Math.max(0, Math.min(y2, imgHeight - 1));
  const [r, g, b] = color;

  for (let t = 0; t < thickness; t++) {
    const top = y1 + t, bot = y2 - t, left = x1 + t, right = x2 - t;
    if (top > bot || left > right) break;
    for (let x = left; x <= right; x++) {
      setPixel(pixels, imgWidth, bpp, x, top, r, g, b);
      setPixel(pixels, imgWidth, bpp, x, bot, r, g, b);
    }
    for (let y = top + 1; y < bot; y++) {
      setPixel(pixels, imgWidth, bpp, left,  y, r, g, b);
      setPixel(pixels, imgWidth, bpp, right, y, r, g, b);
    }
  }
}

/**
 * Draw a filled label showing a number at pixel position (x, y).
 * Background uses the provided color; foreground (digit pixels) auto-contrasts.
 * Label is clamped to stay within image bounds.
 * Each digit glyph is 5×7 px with 1 px padding on all sides.
 */
export function drawLabel(
  pixels: Buffer, imgWidth: number, imgHeight: number, bpp: number,
  x: number, y: number, num: number,
  bgColor: readonly [number, number, number],
): void {
  const text = num.toString();
  const GLYPH_W = 5, GLYPH_H = 7;
  const CHAR_W  = 6; // glyph + 1 px gap between digits
  const PAD     = 1;
  // Total label dims: pad on each side, glyphs side by side, no trailing gap
  const labelW = text.length * CHAR_W - 1 + PAD * 2;
  const labelH = GLYPH_H + PAD * 2;

  // Clamp to image so label never partially overflows
  const lx = Math.max(0, Math.min(x, imgWidth  - labelW));
  const ly = Math.max(0, Math.min(y, imgHeight - labelH));

  const [bgR, bgG, bgB] = bgColor;
  // Perceived brightness for contrast decision (ITU-R BT.601)
  const bright = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  const [fr, fg, fb] = bright < 140
    ? [255, 255, 255] as const
    : [  0,   0,   0] as const;

  // Fill background rectangle
  for (let dy = 0; dy < labelH && ly + dy < imgHeight; dy++) {
    for (let dx = 0; dx < labelW && lx + dx < imgWidth; dx++) {
      setPixel(pixels, imgWidth, bpp, lx + dx, ly + dy, bgR, bgG, bgB);
    }
  }

  // Render each digit glyph
  for (let ci = 0; ci < text.length; ci++) {
    const digit = parseInt(text[ci], 10);
    const glyph = DIGIT_FONT[digit] ?? DIGIT_FONT[0]!;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row] ?? 0;
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits & (16 >> col)) { // 16 = 0b10000; MSB-first 5-bit mask
          const px = lx + PAD + ci * CHAR_W + col;
          const py = ly + PAD + row;
          if (px < imgWidth && py < imgHeight) {
            setPixel(pixels, imgWidth, bpp, px, py, fr, fg, fb);
          }
        }
      }
    }
  }
}

// ── PNG decode ─────────────────────────────────────────────────────────

/** Decoded PNG image: raw RGB or RGBA pixel data with dimensions. */
export interface PngImage {
  width:         number;
  height:        number;
  bytesPerPixel: number;
  pixels:        Buffer;
}

/**
 * Decode a PNG file into raw pixel data.
 * Handles RGBA (colorType 6) and RGB (colorType 2) — both produced by Android screencap.
 * All 5 PNG row filter types (None, Sub, Up, Average, Paeth) are unfiltered.
 * Returns null on any parse or decompression error — callers should handle gracefully.
 */
export function decodePngPixels(pngPath: string): PngImage | null {
  try {
    const buf = readFileSync(pngPath);
    // Verify full 8-byte PNG signature — rejects non-PNG files that happen to share partial magic bytes
    const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (buf.length < 8 || !PNG_SIG.every((b, i) => buf[i] === b)) return null;

    let offset = 8;
    let width = 0, height = 0, colorType = 0;
    const idatChunks: Buffer[] = [];

    while (offset + 12 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      if (offset + 12 + length > buf.length) break;
      const type = buf.slice(offset + 4, offset + 8).toString("ascii");
      const data = buf.slice(offset + 8, offset + 8 + length);

      if (type === "IHDR" && length >= 13) {
        width     = data.readUInt32BE(0);
        height    = data.readUInt32BE(4);
        colorType = data[9]!;
      } else if (type === "IDAT") {
        idatChunks.push(data);
      } else if (type === "IEND") {
        break;
      }
      offset += 12 + length;
    }

    if (width === 0 || height === 0 || idatChunks.length === 0) return null;
    const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (bytesPerPixel === 0) return null; // unsupported colorType

    // Defense-in-depth: reject absurd dimensions that would cause OOM.
    // 10000×10000×4 = 400 MB pixel buffer — generous ceiling for any real screenshot.
    const MAX_DIM = 10000;
    if (width > MAX_DIM || height > MAX_DIM) return null;

    // Cap decompressed output to prevent zip-bomb decompression attacks.
    // Expected size: (1 + width*bpp) * height — add 1% headroom for safety.
    const expectedRawSize = (1 + width * bytesPerPixel) * height;
    const maxInflateSize = Math.ceil(expectedRawSize * 1.01) + 1024;
    const raw     = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: maxInflateSize });
    const rowBytes = 1 + width * bytesPerPixel;
    if (raw.length < rowBytes * height) return null;

    const pixels  = Buffer.alloc(width * height * bytesPerPixel);
    const prevRow = Buffer.alloc(width * bytesPerPixel);

    for (let y = 0; y < height; y++) {
      const rowStart    = y * rowBytes;
      const filterType  = raw[rowStart]!;
      const pixRowStart = y * width * bytesPerPixel;

      for (let x = 0; x < width * bytesPerPixel; x++) {
        let val = raw[rowStart + 1 + x] ?? 0;
        const a = x >= bytesPerPixel ? pixels[pixRowStart + x - bytesPerPixel]! : 0;
        const b = prevRow[x]!;
        const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel]! : 0;

        switch (filterType) {
          case 0: break;                                              // None
          case 1: val = (val + a) & 0xFF; break;                     // Sub
          case 2: val = (val + b) & 0xFF; break;                     // Up
          case 3: val = (val + Math.floor((a + b) / 2)) & 0xFF; break; // Average
          case 4: {                                                   // Paeth
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            val = (val + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xFF;
            break;
          }
          default: break; // Unknown filter — treat as None
        }
        pixels[pixRowStart + x] = val;
      }
      pixels.copy(prevRow, 0, pixRowStart, pixRowStart + width * bytesPerPixel);
    }

    return { width, height, bytesPerPixel, pixels };
  } catch {
    return null; // Any decode failure is non-fatal for callers
  }
}

// ── PNG encode ─────────────────────────────────────────────────────────

/**
 * Encode a raw pixel buffer as a PNG file in memory.
 * Uses filter type 0 (None) on every scanline and level-1 (fast) deflate.
 * bpp must be 3 (RGB) or 4 (RGBA) to match the input data.
 */
export function encodePng(width: number, height: number, pixels: Buffer, bpp: 3 | 4): Buffer {
  const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;               // bit depth
  ihdr[9]  = bpp === 4 ? 6 : 2; // colorType 6=RGBA, 2=RGB
  ihdr[10] = 0;               // compression (deflate)
  ihdr[11] = 0;               // filter method
  ihdr[12] = 0;               // no interlacing

  // Prepend filter byte 0 (None) to each scanline
  const rowSize = 1 + width * bpp;
  const rawData = Buffer.allocUnsafe(rowSize * height);
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0; // filter = None
    pixels.copy(rawData, y * rowSize + 1, y * width * bpp, (y + 1) * width * bpp);
  }

  return Buffer.concat([
    SIG,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", deflateSync(rawData, { level: 1 })),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}
