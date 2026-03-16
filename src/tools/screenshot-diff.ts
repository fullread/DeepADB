/**
 * Screenshot Diffing Tools — Pixel-level screenshot comparison for visual regression detection.
 *
 * Extends the regression detection capabilities with visual comparison.
 * Captures baseline screenshots, compares current screen state against them,
 * and reports differences. Uses raw screencap data for pixel-level comparison
 * without external image processing dependencies.
 *
 * Baselines are saved as PNG files in {tempDir}/screenshot-baselines/.
 */

import { z } from "zod";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { inflateSync } from "zlib";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { isOnDevice } from "../config/config.js";
import { shellEscape } from "../middleware/sanitize.js";

interface ScreenshotMeta {
  name: string;
  timestamp: string;
  device: string;
  width: number;
  height: number;
  sha256: string;
  fileSize: number;
}

function getBaselineDir(tempDir: string): string {
  return join(tempDir, "screenshot-baselines");
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Capture a screenshot and return the local PNG path plus basic metadata.
 * Uses /data/local/tmp/ on-device to avoid scoped storage issues.
 * Cleans up the remote file in a finally block to prevent device file leaks.
 */
async function captureScreenshot(
  ctx: ToolContext,
  serial: string,
  localPath: string,
): Promise<{ width: number; height: number; fileSize: number; sha256: string }> {
  const remoteDir = isOnDevice() ? "/data/local/tmp" : "/sdcard";
  const remotePath = `${remoteDir}/DA_diff_${Date.now()}.png`;

  try {
    await ctx.bridge.shell(`screencap -p '${shellEscape(remotePath)}'`, { device: serial, timeout: 15000 });
    await ctx.bridge.exec(["pull", remotePath, localPath], { device: serial, timeout: 30000 });

    // Get dimensions from device
    const sizeResult = await ctx.bridge.shell("wm size", { device: serial, ignoreExitCode: true });
    const sizeMatch = sizeResult.stdout.match(/(\d+)x(\d+)/);
    const width = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
    const height = sizeMatch ? parseInt(sizeMatch[2], 10) : 0;

    // Compute hash and size
    const fileData = readFileSync(localPath);
    const sha256 = createHash("sha256").update(fileData).digest("hex");
    const fileSize = fileData.length;

    return { width, height, fileSize, sha256 };
  } finally {
    // Always clean up the device-side screenshot, even if pull/hash throws
    await ctx.bridge.shell(`rm '${shellEscape(remotePath)}'`, { device: serial, ignoreExitCode: true }).catch(() => {});
  }
}

/**
 * Decode a PNG file into raw RGBA pixel data.
 * Parses IHDR for dimensions, concatenates IDAT chunks, inflates, and unfilters.
 * Only handles RGBA (colorType 6) and RGB (colorType 2) — the formats produced
 * by Android's screencap. Returns null if decoding fails.
 */
function decodePngPixels(pngPath: string): { width: number; height: number; bytesPerPixel: number; pixels: Buffer } | null {
  try {
    const buf = readFileSync(pngPath);

    // Verify PNG signature
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;

    let offset = 8;
    let width = 0, height = 0, colorType = 0;
    const idatChunks: Buffer[] = [];

    while (offset + 12 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      if (offset + 12 + length > buf.length) break;

      const type = buf.slice(offset + 4, offset + 8).toString("ascii");
      const data = buf.slice(offset + 8, offset + 8 + length);

      if (type === "IHDR" && length >= 13) {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        colorType = data[9];
      } else if (type === "IDAT") {
        idatChunks.push(data);
      } else if (type === "IEND") {
        break;
      }

      offset += 12 + length;
    }

    if (width === 0 || height === 0 || idatChunks.length === 0) return null;

    const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (bytesPerPixel === 0) return null; // Unsupported color type

    const compressed = Buffer.concat(idatChunks);
    const raw = inflateSync(compressed);

    const rowBytes = 1 + width * bytesPerPixel;
    if (raw.length < rowBytes * height) return null;

    // Unfilter — reconstruct actual pixel values from filtered rows
    const pixels = Buffer.alloc(width * height * bytesPerPixel);
    const prevRow = Buffer.alloc(width * bytesPerPixel);

    for (let y = 0; y < height; y++) {
      const rowStart = y * rowBytes;
      const filterType = raw[rowStart];
      const pixelRowStart = y * width * bytesPerPixel;

      for (let x = 0; x < width * bytesPerPixel; x++) {
        let val = raw[rowStart + 1 + x];
        const a = x >= bytesPerPixel ? pixels[pixelRowStart + x - bytesPerPixel] : 0;
        const b = prevRow[x];
        const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;

        switch (filterType) {
          case 0: break;
          case 1: val = (val + a) & 0xFF; break;
          case 2: val = (val + b) & 0xFF; break;
          case 3: val = (val + Math.floor((a + b) / 2)) & 0xFF; break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            val = (val + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xFF;
            break;
          }
          default: break; // Unknown filter — treat as None
        }
        pixels[pixelRowStart + x] = val;
      }

      pixels.copy(prevRow, 0, pixelRowStart, pixelRowStart + width * bytesPerPixel);
    }

    return { width, height, bytesPerPixel, pixels };
  } catch {
    return null; // Any decoding failure returns null — caller falls back to byte comparison
  }
}

interface PixelDiffResult {
  totalPixels: number;
  diffPixels: number;
  diffPercent: number;
  identical: boolean;
  /** Bounding box of changed region, null if identical */
  region: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } | null;
}

/**
 * Compare two PNG files at the pixel level.
 * Decodes both PNGs and compares actual RGB pixel values, ignoring alpha.
 * Falls back to byte-level comparison if PNG decoding fails.
 */
function compareScreenshots(pathA: string, pathB: string): PixelDiffResult {
  // Attempt pixel-level comparison
  const imgA = decodePngPixels(pathA);
  const imgB = decodePngPixels(pathB);

  if (imgA && imgB && imgA.width === imgB.width && imgA.height === imgB.height) {
    const totalPixels = imgA.width * imgA.height;
    const bpp = imgA.bytesPerPixel;
    let diffPixels = 0;
    let minX = imgA.width, maxX = 0, minY = imgA.height, maxY = 0;

    for (let y = 0; y < imgA.height; y++) {
      for (let x = 0; x < imgA.width; x++) {
        const off = (y * imgA.width + x) * bpp;
        let same = true;
        // Compare RGB channels only (skip alpha at index 3 for RGBA)
        for (let c = 0; c < Math.min(bpp, 3); c++) {
          if (imgA.pixels[off + c] !== imgB.pixels[off + c]) { same = false; break; }
        }
        if (!same) {
          diffPixels++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const region = diffPixels > 0
      ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null;

    return {
      totalPixels,
      diffPixels,
      diffPercent: totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0,
      identical: diffPixels === 0,
      region,
    };
  }

  // Fallback: byte-level comparison (if decoding fails or dimensions differ)
  const bufA = readFileSync(pathA);
  const bufB = readFileSync(pathB);

  if (bufA.equals(bufB)) {
    return { totalPixels: 0, diffPixels: 0, diffPercent: 0, identical: true, region: null };
  }

  // Byte diff as rough estimate — report as negative diffPixels to signal fallback
  const maxLen = Math.max(bufA.length, bufB.length);
  let diffBytes = Math.abs(bufA.length - bufB.length);
  for (let i = 0; i < Math.min(bufA.length, bufB.length); i++) {
    if (bufA[i] !== bufB[i]) diffBytes++;
  }

  return {
    totalPixels: maxLen,
    diffPixels: diffBytes,
    diffPercent: maxLen > 0 ? (diffBytes / maxLen) * 100 : 0,
    identical: false,
    region: null,
  };
}

export function registerScreenshotDiffTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_screenshot_baseline",
    "Capture a named screenshot baseline for later comparison. Saves the screenshot and metadata to the baselines directory.",
    {
      name: z.string().describe("Baseline name (e.g., 'home_screen', 'login_page', 'threat_alert')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ name, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const dir = getBaselineDir(ctx.config.tempDir);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const safeName = sanitizeName(name);
        const pngPath = join(dir, `${safeName}.png`);
        const metaPath = join(dir, `${safeName}.meta.json`);

        const { width, height, fileSize, sha256 } = await captureScreenshot(ctx, serial, pngPath);

        const meta: ScreenshotMeta = {
          name,
          timestamp: new Date().toISOString(),
          device: serial,
          width,
          height,
          sha256,
          fileSize,
        };
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        return {
          content: [{
            type: "text",
            text: `Screenshot baseline saved: ${safeName}\nPath: ${pngPath}\nDimensions: ${width}x${height}\nSize: ${(fileSize / 1024).toFixed(1)} KB\nSHA-256: ${sha256.substring(0, 16)}...`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_screenshot_diff",
    "Compare the current screen against a saved screenshot baseline. Decodes PNGs and performs pixel-level comparison (RGB channels), reporting exact pixel difference count, percentage, and the bounding box of the changed region. Supports a tolerance threshold for absorbing minor dynamic elements like clocks or notification badges.",
    {
      baseline: z.string().describe("Baseline name to compare against (from adb_screenshot_baseline)"),
      tolerancePercent: z.number().min(0).max(100).optional().default(0)
        .describe("Pixel difference percentage threshold below which the result reports IDENTICAL. 0 = exact match required. 1-2 absorbs clock/status bar changes."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ baseline, tolerancePercent, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const dir = getBaselineDir(ctx.config.tempDir);
        const safeName = sanitizeName(baseline);
        const baselinePngPath = join(dir, `${safeName}.png`);
        const baselineMetaPath = join(dir, `${safeName}.meta.json`);

        if (!existsSync(baselinePngPath)) {
          return {
            content: [{ type: "text", text: `Baseline "${baseline}" not found. Use adb_screenshot_baseline to create one first.` }],
            isError: true,
          };
        }

        // Capture current screenshot
        const currentPngPath = join(dir, `_diff_current_${Date.now()}.png`);
        const current = await captureScreenshot(ctx, serial, currentPngPath);

        // Load baseline metadata if available
        let baselineMeta: ScreenshotMeta | null = null;
        if (existsSync(baselineMetaPath)) {
          try {
            baselineMeta = JSON.parse(readFileSync(baselineMetaPath, "utf-8"));
          } catch { /* ignore corrupt meta */ }
        }

        // Quick hash comparison — exact match fast path
        const baselineHash = createHash("sha256").update(readFileSync(baselinePngPath)).digest("hex");
        const hashMatch = baselineHash === current.sha256;

        // Pixel-level comparison (only needed if hashes differ)
        const diff = hashMatch ? null : compareScreenshots(baselinePngPath, currentPngPath);
        const withinTolerance = diff !== null && tolerancePercent > 0 && diff.diffPercent <= tolerancePercent;
        const isMatch = hashMatch || withinTolerance;

        const sections: string[] = [];
        sections.push(`=== Screenshot Diff: ${baseline} ===`);
        if (baselineMeta) {
          sections.push(`Baseline: ${baselineMeta.timestamp} (${baselineMeta.width}x${baselineMeta.height})`);
        }
        sections.push(`Current: ${current.width}x${current.height}, ${(current.fileSize / 1024).toFixed(1)} KB`);
        if (tolerancePercent > 0) {
          sections.push(`Tolerance: ${tolerancePercent}%`);
        }

        if (hashMatch) {
          sections.push(`\nResult: ✓ IDENTICAL — screens match exactly.`);
        } else if (diff) {
          if (withinTolerance) {
            sections.push(`\nResult: ✓ IDENTICAL (within ${tolerancePercent}% tolerance)`);
            sections.push(`Pixel difference: ${diff.diffPixels.toLocaleString()} of ${diff.totalPixels.toLocaleString()} pixels (${diff.diffPercent.toFixed(4)}%)`);
          } else {
            sections.push(`\nResult: ✗ DIFFERENT`);
            sections.push(`Changed pixels: ${diff.diffPixels.toLocaleString()} of ${diff.totalPixels.toLocaleString()} (${diff.diffPercent.toFixed(4)}%)`);
          }

          // Region analysis
          if (diff.region) {
            const r = diff.region;
            sections.push(`Changed region: (${r.minX},${r.minY}) → (${r.maxX},${r.maxY}) — ${r.width}×${r.height} px`);
            if (current.height > 0) {
              const topPct = ((r.minY / current.height) * 100).toFixed(1);
              const botPct = ((r.maxY / current.height) * 100).toFixed(1);
              sections.push(`Vertical span: ${topPct}%–${botPct}% of screen height`);
            }
          }

          // Dimension comparison
          if (baselineMeta) {
            if (baselineMeta.width !== current.width || baselineMeta.height !== current.height) {
              sections.push(`Dimensions changed: ${baselineMeta.width}x${baselineMeta.height} → ${current.width}x${current.height}`);
            }

            const sizeDiff = current.fileSize - baselineMeta.fileSize;
            const sizePct = baselineMeta.fileSize > 0 ? ((sizeDiff / baselineMeta.fileSize) * 100).toFixed(1) : "N/A";
            sections.push(`File size: ${(baselineMeta.fileSize / 1024).toFixed(1)} KB → ${(current.fileSize / 1024).toFixed(1)} KB (${sizeDiff > 0 ? "+" : ""}${sizePct}%)`);
          }

          if (!isMatch) {
            sections.push(`\nCurrent screenshot saved: ${currentPngPath}`);
          }
        }

        // Clean up current screenshot if match (exact or within tolerance)
        if (isMatch) {
          try { unlinkSync(currentPngPath); } catch { /* ignore */ }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_screenshot_history",
    "List all saved screenshot baselines with their metadata (timestamp, dimensions, device, file size).",
    {},
    async () => {
      try {
        const dir = getBaselineDir(ctx.config.tempDir);
        if (!existsSync(dir)) {
          return { content: [{ type: "text", text: "No screenshot baselines found. Use adb_screenshot_baseline to create one." }] };
        }

        const metaFiles = readdirSync(dir).filter((f) => f.endsWith(".meta.json")).sort();
        if (metaFiles.length === 0) {
          return { content: [{ type: "text", text: "No screenshot baselines found." }] };
        }

        const lines: string[] = [`${metaFiles.length} screenshot baseline(s):\n`];

        for (const metaFile of metaFiles) {
          try {
            const meta: ScreenshotMeta = JSON.parse(readFileSync(join(dir, metaFile), "utf-8"));
            const pngFile = metaFile.replace(".meta.json", ".png");
            const pngPath = join(dir, pngFile);
            const exists = existsSync(pngPath);
            const sizeKb = exists ? (statSync(pngPath).size / 1024).toFixed(1) : "?";

            lines.push(`${meta.name}`);
            lines.push(`  ${meta.timestamp.substring(0, 19)} | ${meta.width}x${meta.height} | ${sizeKb} KB | device: ${meta.device}`);
          } catch {
            lines.push(`${metaFile.replace(".meta.json", "")} — metadata corrupt`);
          }
        }

        lines.push(`\nBaseline directory: ${dir}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
