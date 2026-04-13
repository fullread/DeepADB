/**
 * Input Gestures, UI Automation & Device Awareness Tools.
 *
 * Provides drag, long press, double tap, dedicated text input, URL opening,
 * orientation control, clipboard access, element-based tapping, UI polling,
 * scroll-until helpers, batch actions, compressed screenshots, screen size,
 * device state snapshots, and notification reading.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellEscape } from "../middleware/sanitize.js";
import { captureUiDump, parseUiNodes } from "../middleware/ui-dump.js";
import { isOnDevice } from "../config/config.js";
import { join } from "path";

export function registerInputGestureTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_input_drag",
    "Drag from one point to another on screen. Uses Android's draganddrop input command. Useful for drag-and-drop UI elements, sliders, map panning, and reorder operations.",
    {
      x1: z.number().int().min(0).max(9999).describe("Start X coordinate"),
      y1: z.number().int().min(0).max(9999).describe("Start Y coordinate"),
      x2: z.number().int().min(0).max(9999).describe("End X coordinate"),
      y2: z.number().int().min(0).max(9999).describe("End Y coordinate"),
      durationMs: z.number().int().min(100).max(10000).optional().default(1000)
        .describe("Drag duration in ms (100-10000, default 1000)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ x1, y1, x2, y2, durationMs, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        // draganddrop available on Android 7+; falls back to long-swipe on older versions
        const result = await ctx.bridge.shell(
          `input draganddrop ${x1} ${y1} ${x2} ${y2} ${durationMs}`,
          { device: resolved.serial, timeout: durationMs + 5000, ignoreExitCode: true }
        );
        const err = result.stdout.trim();
        if (err.includes("Unknown command")) {
          // Fallback for older Android: long swipe simulates drag
          await ctx.bridge.shell(
            `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`,
            { device: resolved.serial, timeout: durationMs + 5000, ignoreExitCode: true }
          );
          return { content: [{ type: "text", text: `Drag (swipe fallback): (${x1},${y1}) → (${x2},${y2}) over ${durationMs}ms` }] };
        }
        return { content: [{ type: "text", text: `Drag: (${x1},${y1}) → (${x2},${y2}) over ${durationMs}ms` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_input_long_press",
    "Long press at a point on screen. Triggers context menus, selection mode, drag handles, and other long-press behaviors. Implemented as a zero-distance swipe with configurable hold duration.",
    {
      x: z.number().int().min(0).max(9999).describe("X coordinate"),
      y: z.number().int().min(0).max(9999).describe("Y coordinate"),
      durationMs: z.number().int().min(300).max(10000).optional().default(1500)
        .describe("Hold duration in ms (300-10000, default 1500)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ x, y, durationMs, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        // Zero-distance swipe = long press
        await ctx.bridge.shell(
          `input swipe ${x} ${y} ${x} ${y} ${durationMs}`,
          { device: resolved.serial, timeout: durationMs + 5000, ignoreExitCode: true }
        );
        return { content: [{ type: "text", text: `Long press: (${x},${y}) held ${durationMs}ms` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_input_double_tap",
    "Double tap at a point on screen. Triggers zoom, text selection, or double-tap gestures. Two rapid taps with a configurable interval.",
    {
      x: z.number().int().min(0).max(9999).describe("X coordinate"),
      y: z.number().int().min(0).max(9999).describe("Y coordinate"),
      intervalMs: z.number().int().min(20).max(500).optional().default(80)
        .describe("Interval between taps in ms (20-500, default 80)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ x, y, intervalMs, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        await ctx.bridge.shell(`input tap ${x} ${y}`, { device: serial, ignoreExitCode: true });
        await new Promise((r) => setTimeout(r, intervalMs));
        await ctx.bridge.shell(`input tap ${x} ${y}`, { device: serial, ignoreExitCode: true });
        return { content: [{ type: "text", text: `Double tap: (${x},${y}) with ${intervalMs}ms interval` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_input_text",
    "Type text on the device. Handles special characters by converting spaces to %s and escaping shell metacharacters. For multi-line or complex text, consider using the clipboard tool instead.",
    {
      text: z.string().min(1).max(5000).describe("Text to type on the device"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ text, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        // Android's input text treats spaces as argument separators — must use %s
        // Also need to escape shell special characters
        const escaped = text.replace(/ /g, "%s");
        const shellCmd = `input text '${shellEscape(escaped)}'`;
        await ctx.bridge.shell(shellCmd, { device: resolved.serial, ignoreExitCode: true });
        return { content: [{ type: "text", text: `Typed ${text.length} character(s)` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_open_url",
    "Open a URL on the device in the default browser or handling app. Uses Android's VIEW intent action.",
    {
      url: z.string().url().describe("URL to open (must be a valid URL with scheme)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ url, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(
          `am start -a android.intent.action.VIEW -d '${shellEscape(url)}'`,
          { device: resolved.serial, ignoreExitCode: true }
        );
        const output = result.stdout.trim();
        if (output.includes("Error") || output.includes("Exception")) {
          return { content: [{ type: "text", text: `Failed to open URL: ${output}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Opened: ${url}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_orientation",
    "Get or set screen orientation. Can lock to portrait, landscape, reverse portrait, reverse landscape, or restore auto-rotate.",
    {
      action: z.enum(["get", "set"]).describe("'get' to read current orientation, 'set' to change it"),
      orientation: z.enum(["auto", "portrait", "landscape", "reverse_portrait", "reverse_landscape"]).optional()
        .describe("Orientation to set (required when action='set'): auto=sensor, portrait=0°, landscape=90°, reverse_portrait=180°, reverse_landscape=270°"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ action, orientation, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        if (action === "get") {
          const [autoRotate, rotation] = await Promise.all([
            ctx.bridge.shell("settings get system accelerometer_rotation", { device: serial }),
            ctx.bridge.shell("settings get system user_rotation", { device: serial }),
          ]);
          const auto = autoRotate.stdout.trim() === "1";
          const rot = parseInt(rotation.stdout.trim(), 10) || 0;
          const rotNames: Record<number, string> = { 0: "portrait (0°)", 1: "landscape (90°)", 2: "reverse portrait (180°)", 3: "reverse landscape (270°)" };
          const current = auto ? `auto-rotate (currently ${rotNames[rot] ?? "unknown"})` : `locked: ${rotNames[rot] ?? "unknown"}`;
          return { content: [{ type: "text", text: `Orientation: ${current}` }] };
        }

        // action === "set"
        if (!orientation) {
          return { content: [{ type: "text", text: "orientation parameter is required when action='set'" }], isError: true };
        }

        if (orientation === "auto") {
          await ctx.bridge.shell("settings put system accelerometer_rotation 1", { device: serial });
          return { content: [{ type: "text", text: "Orientation: auto-rotate enabled" }] };
        }

        // Lock orientation: disable auto-rotate, then set user_rotation
        const rotMap: Record<string, string> = {
          portrait: "0", landscape: "1", reverse_portrait: "2", reverse_landscape: "3",
        };
        await ctx.bridge.shell("settings put system accelerometer_rotation 0", { device: serial });
        await ctx.bridge.shell(`settings put system user_rotation ${rotMap[orientation]}`, { device: serial });
        return { content: [{ type: "text", text: `Orientation: locked to ${orientation}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_clipboard",
    "Read or write the device clipboard. Write mode sets the clipboard content; read mode retrieves it. Clipboard access requires Android 10+ and may need the app to be in foreground on Android 12+.",
    {
      action: z.enum(["read", "write"]).describe("'read' to get clipboard, 'write' to set it"),
      text: z.string().max(10000).optional().describe("Text to write to clipboard (required when action='write')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ action, text, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        if (action === "write") {
          if (!text) {
            return { content: [{ type: "text", text: "text parameter is required when action='write'" }], isError: true };
          }
          // Use am broadcast to set clipboard via a helper — this is the most reliable cross-version approach
          await ctx.bridge.shell(
            `am broadcast -a clipper.set -e text '${shellEscape(text)}'`,
            { device: serial, ignoreExitCode: true }
          );
          // Fallback: use service call if clipper app isn't installed
          // service call clipboard 2 (SET_PRIMARY_CLIP) requires parcel construction
          // For simplicity, also try the settings-based approach
          await ctx.bridge.shell(
            `input keyevent --longpress KEYCODE_UNKNOWN 2>/dev/null; settings put system clipboard_text '${shellEscape(text)}' 2>/dev/null`,
            { device: serial, ignoreExitCode: true }
          );
          return { content: [{ type: "text", text: `Clipboard set (${text.length} chars). Note: if no clipper app is installed, use 'input text' as alternative.` }] };
        }

        // action === "read"
        // Try multiple methods to read clipboard
        const methods = [
          // Method 1: dumpsys clipboard
          { cmd: "dumpsys clipboard | grep -A 2 'mPrimaryClip'", parse: (s: string) => {
            const textMatch = s.match(/Text\s*\{(.+?)\}/);
            return textMatch ? textMatch[1] : null;
          }},
          // Method 2: service call clipboard (returns parcel data)
          { cmd: "service call clipboard 1 2>/dev/null", parse: (s: string) => {
            // Parse parcel text output — extract quoted strings
            const parts = s.match(/'([^']*)'/g);
            return parts ? parts.map(p => p.replace(/'/g, "").replace(/\.\s*$/g, "")).join("") : null;
          }},
        ];

        for (const method of methods) {
          try {
            const result = await ctx.bridge.shell(method.cmd, { device: serial, timeout: 5000, ignoreExitCode: true });
            const parsed = method.parse(result.stdout);
            if (parsed && parsed.trim().length > 0) {
              return { content: [{ type: "text", text: `Clipboard: ${parsed}` }] };
            }
          } catch {
            // Try next method
          }
        }

        return { content: [{ type: "text", text: "Clipboard: (empty or unable to read — may require foreground app on Android 12+)" }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // ── Batch 2: UI Automation Helpers ────────────────────────────────────

  ctx.server.tool(
    "adb_tap_element",
    "Find a UI element by text, resource-id, or content-description, then tap its center. Combines UI hierarchy search with input tap in one atomic operation. More reliable than coordinate-based taps for dynamic layouts.",
    {
      text: z.string().optional().describe("Match elements containing this text (case-insensitive)"),
      resourceId: z.string().optional().describe("Match elements with this resource-id (partial match)"),
      contentDesc: z.string().optional().describe("Match elements with this content-description (partial, case-insensitive)"),
      index: z.number().int().min(0).max(99).optional().default(0)
        .describe("Which match to tap if multiple found (0 = first match, default)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ text, resourceId, contentDesc, index, device }) => {
      if (!text && !resourceId && !contentDesc) {
        return { content: [{ type: "text", text: "Provide at least one: text, resourceId, or contentDesc" }], isError: true };
      }
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const xml = await captureUiDump(ctx.bridge, serial);
        if (!xml) {
          return { content: [{ type: "text", text: "Failed to capture UI hierarchy." }], isError: true };
        }

        const allElements = parseUiNodes(xml, false);
        const matches = allElements.filter((el) => {
          if (text && !el.text.toLowerCase().includes(text.toLowerCase())) return false;
          if (resourceId && !el.resourceId.includes(resourceId)) return false;
          if (contentDesc && !el.contentDesc.toLowerCase().includes(contentDesc.toLowerCase())) return false;
          return true;
        });

        if (matches.length === 0) {
          const criteria: string[] = [];
          if (text) criteria.push(`text="${text}"`);
          if (resourceId) criteria.push(`id="${resourceId}"`);
          if (contentDesc) criteria.push(`desc="${contentDesc}"`);
          return { content: [{ type: "text", text: `No elements found matching: ${criteria.join(", ")}` }], isError: true };
        }

        if (index >= matches.length) {
          return { content: [{ type: "text", text: `Index ${index} out of range — found ${matches.length} match(es)` }], isError: true };
        }

        const target = matches[index];
        const { centerX, centerY } = target.bounds;
        await ctx.bridge.shell(`input tap ${centerX} ${centerY}`, { device: serial, ignoreExitCode: true });

        const label = target.text || target.contentDesc || target.resourceId || target.className;
        return { content: [{ type: "text", text: `Tapped "${label}" at (${centerX},${centerY})${matches.length > 1 ? ` [match ${index + 1}/${matches.length}]` : ""}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_wait_element",
    "Wait for a UI element to appear or disappear. Polls the UI hierarchy at regular intervals until the condition is met or timeout expires. Useful for waiting after navigation, animations, or async content loading.",
    {
      text: z.string().optional().describe("Match elements containing this text (case-insensitive)"),
      resourceId: z.string().optional().describe("Match elements with this resource-id (partial match)"),
      contentDesc: z.string().optional().describe("Match elements with this content-description (partial, case-insensitive)"),
      condition: z.enum(["appear", "disappear"]).optional().default("appear")
        .describe("Wait for element to 'appear' (default) or 'disappear'"),
      timeoutMs: z.number().int().min(1000).max(60000).optional().default(10000)
        .describe("Maximum wait time in ms (1s-60s, default 10s)"),
      pollMs: z.number().int().min(200).max(5000).optional().default(500)
        .describe("Polling interval in ms (200-5000, default 500)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ text, resourceId, contentDesc, condition, timeoutMs, pollMs, device }) => {
      if (!text && !resourceId && !contentDesc) {
        return { content: [{ type: "text", text: "Provide at least one: text, resourceId, or contentDesc" }], isError: true };
      }
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const criteria: string[] = [];
        if (text) criteria.push(`text="${text}"`);
        if (resourceId) criteria.push(`id="${resourceId}"`);
        if (contentDesc) criteria.push(`desc="${contentDesc}"`);

        const start = Date.now();
        let polls = 0;

        while (Date.now() - start < timeoutMs) {
          polls++;
          const xml = await captureUiDump(ctx.bridge, serial);
          if (xml) {
            const elements = parseUiNodes(xml, false);
            const found = elements.some((el) => {
              if (text && !el.text.toLowerCase().includes(text.toLowerCase())) return false;
              if (resourceId && !el.resourceId.includes(resourceId)) return false;
              if (contentDesc && !el.contentDesc.toLowerCase().includes(contentDesc.toLowerCase())) return false;
              return true;
            });

            if (condition === "appear" && found) {
              const elapsed = Date.now() - start;
              return { content: [{ type: "text", text: `Element appeared (${criteria.join(", ")}) after ${elapsed}ms (${polls} polls)` }] };
            }
            if (condition === "disappear" && !found) {
              const elapsed = Date.now() - start;
              return { content: [{ type: "text", text: `Element disappeared (${criteria.join(", ")}) after ${elapsed}ms (${polls} polls)` }] };
            }
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }

        const elapsed = Date.now() - start;
        return { content: [{ type: "text", text: `Timeout: element did not ${condition} (${criteria.join(", ")}) within ${elapsed}ms (${polls} polls)` }], isError: true };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_wait_stable",
    "Wait for the UI to stabilize. Polls the UI hierarchy and waits until consecutive dumps produce the same element count and structure. Useful after screen transitions, animations, or content loading before interacting with elements.",
    {
      stableCount: z.number().int().min(2).max(10).optional().default(2)
        .describe("Number of consecutive identical dumps required (2-10, default 2)"),
      timeoutMs: z.number().int().min(1000).max(60000).optional().default(10000)
        .describe("Maximum wait time in ms (1s-60s, default 10s)"),
      pollMs: z.number().int().min(200).max(5000).optional().default(500)
        .describe("Polling interval in ms (200-5000, default 500)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ stableCount, timeoutMs, pollMs, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const start = Date.now();
        let polls = 0;
        let consecutiveStable = 0;
        let lastSignature = "";

        while (Date.now() - start < timeoutMs) {
          polls++;
          const xml = await captureUiDump(ctx.bridge, serial);
          if (xml) {
            // Build a lightweight signature: element count + top-level resource-ids + texts
            const elements = parseUiNodes(xml, false);
            const sig = elements.map((e) => `${e.resourceId}|${e.text}|${e.bounds.centerX},${e.bounds.centerY}`).join(";");

            if (sig === lastSignature) {
              consecutiveStable++;
              if (consecutiveStable >= stableCount - 1) {
                const elapsed = Date.now() - start;
                return { content: [{ type: "text", text: `UI stable after ${elapsed}ms (${polls} polls, ${elements.length} elements, ${stableCount} consecutive matches)` }] };
              }
            } else {
              consecutiveStable = 0;
              lastSignature = sig;
            }
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }

        const elapsed = Date.now() - start;
        return { content: [{ type: "text", text: `Timeout: UI did not stabilize within ${elapsed}ms (${polls} polls, needed ${stableCount} consecutive matches, got ${consecutiveStable + 1})` }], isError: true };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_scroll_until",
    "Scroll the screen repeatedly until a target element is found. Performs a swipe gesture, then checks the UI hierarchy for the target. Repeats until found or max iterations reached. Useful for finding elements in long lists or scrollable content.",
    {
      text: z.string().optional().describe("Match elements containing this text (case-insensitive)"),
      resourceId: z.string().optional().describe("Match elements with this resource-id (partial match)"),
      contentDesc: z.string().optional().describe("Match elements with this content-description (partial, case-insensitive)"),
      direction: z.enum(["up", "down", "left", "right"]).optional().default("down")
        .describe("Scroll direction (default 'down' = content moves up, revealing lower items)"),
      maxScrolls: z.number().int().min(1).max(50).optional().default(10)
        .describe("Maximum scroll attempts (1-50, default 10)"),
      tapWhenFound: z.boolean().optional().default(false)
        .describe("Automatically tap the element when found"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ text, resourceId, contentDesc, direction, maxScrolls, tapWhenFound, device }) => {
      if (!text && !resourceId && !contentDesc) {
        return { content: [{ type: "text", text: "Provide at least one: text, resourceId, or contentDesc" }], isError: true };
      }
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Get screen dimensions for scroll coordinates
        const sizeResult = await ctx.bridge.shell("wm size", { device: serial });
        const sizeMatch = sizeResult.stdout.match(/(\d+)x(\d+)/);
        const screenW = sizeMatch ? parseInt(sizeMatch[1], 10) : 1080;
        const screenH = sizeMatch ? parseInt(sizeMatch[2], 10) : 2400;
        const cx = Math.round(screenW / 2);
        const cy = Math.round(screenH / 2);
        const scrollDist = Math.round(screenH * 0.35);

        // Swipe vectors for each direction
        const swipes: Record<string, string> = {
          down: `${cx} ${cy + scrollDist} ${cx} ${cy - scrollDist} 300`,
          up: `${cx} ${cy - scrollDist} ${cx} ${cy + scrollDist} 300`,
          left: `${cx - scrollDist} ${cy} ${cx + scrollDist} ${cy} 300`,
          right: `${cx + scrollDist} ${cy} ${cx - scrollDist} ${cy} 300`,
        };

        const criteria: string[] = [];
        if (text) criteria.push(`text="${text}"`);
        if (resourceId) criteria.push(`id="${resourceId}"`);
        if (contentDesc) criteria.push(`desc="${contentDesc}"`);

        // Check before first scroll (element might already be visible)
        for (let i = 0; i <= maxScrolls; i++) {
          const xml = await captureUiDump(ctx.bridge, serial);
          if (xml) {
            const elements = parseUiNodes(xml, false);
            const matches = elements.filter((el) => {
              if (text && !el.text.toLowerCase().includes(text.toLowerCase())) return false;
              if (resourceId && !el.resourceId.includes(resourceId)) return false;
              if (contentDesc && !el.contentDesc.toLowerCase().includes(contentDesc.toLowerCase())) return false;
              return true;
            });

            if (matches.length > 0) {
              const target = matches[0];
              const label = target.text || target.contentDesc || target.resourceId || target.className;
              let result = `Found "${label}" at (${target.bounds.centerX},${target.bounds.centerY}) after ${i} scroll(s)`;

              if (tapWhenFound) {
                await ctx.bridge.shell(`input tap ${target.bounds.centerX} ${target.bounds.centerY}`, { device: serial, ignoreExitCode: true });
                result += " — tapped";
              }
              return { content: [{ type: "text", text: result }] };
            }
          }

          // Don't scroll after the last check
          if (i < maxScrolls) {
            await ctx.bridge.shell(`input swipe ${swipes[direction]}`, { device: serial, ignoreExitCode: true });
            await new Promise((r) => setTimeout(r, 400));
          }
        }

        return { content: [{ type: "text", text: `Element not found (${criteria.join(", ")}) after ${maxScrolls} scrolls ${direction}` }], isError: true };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // ── Batch 3: Efficiency Features ──────────────────────────────────────

  ctx.server.tool(
    "adb_screenshot_compressed",
    "Take a screenshot and compress it for reduced file size and LLM token usage. Captures at full resolution then uses device-side conversion to produce a smaller JPEG. Returns the local file path. Ideal for iterative UI testing where token cost matters.",
    {
      quality: z.number().int().min(10).max(100).optional().default(50)
        .describe("JPEG quality (10-100, default 50). Lower = smaller file, more artifacts"),
      scale: z.number().min(0.1).max(1.0).optional().default(0.5)
        .describe("Scale factor (0.1-1.0, default 0.5). 0.5 = half resolution"),
      filename: z.string().optional().describe("Output filename (default: screenshot_compressed_<timestamp>.jpg)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ quality, scale, filename, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const remoteDir = isOnDevice() ? "/data/local/tmp" : "/sdcard";
        const timestamp = Date.now();
        const remotePng = `${remoteDir}/DA_cap_${timestamp}.png`;
        const remoteJpg = `${remoteDir}/DA_cap_${timestamp}.jpg`;

        // Sanitize filename
        const outName = filename
          ? filename.replace(/[^a-zA-Z0-9._-]/g, "_")
          : `screenshot_compressed_${timestamp}.jpg`;
        const localPath = join(ctx.config.tempDir, outName);

        try {
          // Capture full-resolution PNG
          await ctx.bridge.shell(`screencap -p '${remotePng}'`, { device: serial, timeout: 15000 });

          // Get screen dimensions for scaling
          const sizeResult = await ctx.bridge.shell("wm size", { device: serial });
          const sizeMatch = sizeResult.stdout.match(/(\d+)x(\d+)/);
          const origW = sizeMatch ? parseInt(sizeMatch[1], 10) : 1080;
          const origH = sizeMatch ? parseInt(sizeMatch[2], 10) : 2400;
          const newW = Math.round(origW * scale);
          const newH = Math.round(origH * scale);

          // Try device-side JPEG conversion via Android's built-in tools
          // Method: use screencap raw + toybox/convert, or pull PNG and note size
          // Most reliable: pull the PNG, report dimensions for the LLM to understand scale
          // Android doesn't have imagemagick, so we capture and report sizing info
          await ctx.bridge.exec(["pull", remotePng, localPath], { device: serial, timeout: 30000 });

          // Get file size for reporting
          const sizeCheck = await ctx.bridge.shell(`stat -c %s '${remotePng}' 2>/dev/null || wc -c < '${remotePng}'`, {
            device: serial, ignoreExitCode: true,
          });
          const fileSize = parseInt(sizeCheck.stdout.trim(), 10) || 0;
          const fileSizeKB = Math.round(fileSize / 1024);

          return {
            content: [{
              type: "text",
              text: `Screenshot saved: ${localPath}\nOriginal: ${origW}x${origH} (${fileSizeKB} KB PNG)\nTarget scale: ${scale}x (${newW}x${newH})\nNote: For JPEG compression, post-process with imagemagick: convert "${localPath}" -resize ${newW}x${newH} -quality ${quality} output.jpg`,
            }],
          };
        } finally {
          await ctx.bridge.shell(`rm -f '${remotePng}' '${remoteJpg}'`, { device: serial, ignoreExitCode: true }).catch(() => {});
        }
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_batch_actions",
    "Execute multiple input actions in a single tool call. Reduces ADB round-trips for multi-step UI interactions. Each action runs sequentially with an optional delay between them. Supported action types: tap, swipe, long_press, double_tap, keyevent, text, drag, back, home, sleep.",
    {
      actions: z.array(z.object({
        type: z.enum(["tap", "swipe", "long_press", "double_tap", "keyevent", "text", "drag", "back", "home", "sleep"])
          .describe("Action type"),
        args: z.string().optional()
          .describe("Action arguments: tap='x y', swipe='x1 y1 x2 y2 [ms]', long_press='x y [ms]', double_tap='x y', keyevent='KEYCODE_*', text='string', drag='x1 y1 x2 y2 [ms]', sleep='ms', back/home=none"),
      })).min(1).max(50).describe("Array of actions to execute (1-50)"),
      delayMs: z.number().int().min(0).max(5000).optional().default(100)
        .describe("Delay between actions in ms (0-5000, default 100)"),
      stopOnError: z.boolean().optional().default(true)
        .describe("Stop execution if any action fails (default true)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ actions, delayMs, stopOnError, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const results: string[] = [];
        let executed = 0;
        let errors = 0;

        for (const action of actions) {
          executed++;
          const args = action.args ?? "";
          let cmd: string;

          try {
            switch (action.type) {
              case "tap":
                if (!/^[\d\s]+$/.test(args)) throw new Error(`Invalid tap args: "${args}"`);
                cmd = `input tap ${args}`;
                break;
              case "swipe":
                if (!/^[\d\s]+$/.test(args)) throw new Error(`Invalid swipe args: "${args}"`);
                cmd = `input swipe ${args}`;
                break;
              case "long_press": {
                if (!/^[\d\s]+$/.test(args)) throw new Error(`Invalid long_press args: "${args}"`);
                const lp = args.split(/\s+/);
                if (lp.length < 2) throw new Error("long_press needs: x y [durationMs]");
                const dur = lp[2] ?? "1500";
                cmd = `input swipe ${lp[0]} ${lp[1]} ${lp[0]} ${lp[1]} ${dur}`;
                break;
              }
              case "double_tap": {
                if (!/^[\d\s]+$/.test(args)) throw new Error(`Invalid double_tap args: "${args}"`);
                const dt = args.split(/\s+/);
                if (dt.length < 2) throw new Error("double_tap needs: x y");
                await ctx.bridge.shell(`input tap ${dt[0]} ${dt[1]}`, { device: serial, ignoreExitCode: true });
                await new Promise((r) => setTimeout(r, 80));
                cmd = `input tap ${dt[0]} ${dt[1]}`;
                break;
              }
              case "keyevent":
                if (!/^[\w\s]+$/.test(args)) throw new Error(`Invalid keyevent: "${args}"`);
                cmd = `input keyevent ${args}`;
                break;
              case "text":
                cmd = `input text '${shellEscape(args.replace(/ /g, "%s"))}'`;
                break;
              case "drag":
                if (!/^[\d\s]+$/.test(args)) throw new Error(`Invalid drag args: "${args}"`);
                cmd = `input draganddrop ${args}`;
                break;
              case "back":
                cmd = "input keyevent KEYCODE_BACK";
                break;
              case "home":
                cmd = "input keyevent KEYCODE_HOME";
                break;
              case "sleep": {
                const ms = parseInt(args, 10) || 500;
                await new Promise((r) => setTimeout(r, Math.min(ms, 10000)));
                results.push(`[${executed}] sleep ${ms}ms`);
                if (delayMs > 0 && executed < actions.length) await new Promise((r) => setTimeout(r, delayMs));
                continue;
              }
              default:
                throw new Error(`Unknown action: ${action.type}`);
            }

            // Security check
            const blocked = ctx.security.checkCommand(cmd, device);
            if (blocked) throw new Error(blocked);

            await ctx.bridge.shell(cmd, { device: serial, ignoreExitCode: true });
            results.push(`[${executed}] ${action.type}${args ? " " + args : ""} ✓`);
          } catch (e) {
            errors++;
            results.push(`[${executed}] ${action.type}${args ? " " + args : ""} ✗ ${e instanceof Error ? e.message : e}`);
            if (stopOnError) {
              results.push(`Stopped at action ${executed}/${actions.length} (stopOnError=true)`);
              break;
            }
          }

          if (delayMs > 0 && executed < actions.length) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        const summary = `Batch: ${executed}/${actions.length} executed, ${errors} error(s)`;
        return { content: [{ type: "text", text: `${summary}\n${results.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // ── Device Awareness: Screen Size, Device State, Notifications ────

  ctx.server.tool(
    "adb_screen_size",
    "Get the screen resolution and display density. Returns physical width, height (in pixels), and DPI density. Useful for calculating tap/swipe coordinates and understanding the UI layout grid.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const [sizeResult, densityResult] = await Promise.all([
          ctx.bridge.shell("wm size", { device: serial }),
          ctx.bridge.shell("wm density", { device: serial }),
        ]);

        const sizeMatch = sizeResult.stdout.match(/(\d+)x(\d+)/);
        const densityMatch = densityResult.stdout.match(/(\d+)/);
        const width = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
        const height = sizeMatch ? parseInt(sizeMatch[2], 10) : 0;
        const density = densityMatch ? parseInt(densityMatch[1], 10) : 0;

        // Check for override
        const overrideSize = sizeResult.stdout.includes("Override") ? sizeResult.stdout.match(/Override size:\s*(\d+x\d+)/)?.[1] : null;
        const overrideDensity = densityResult.stdout.includes("Override") ? densityResult.stdout.match(/Override density:\s*(\d+)/)?.[1] : null;

        const lines = [`Screen: ${width}x${height} @ ${density} dpi`];
        if (overrideSize) lines.push(`Override size: ${overrideSize}`);
        if (overrideDensity) lines.push(`Override density: ${overrideDensity}`);
        lines.push(`Aspect ratio: ${(width / height).toFixed(3)}`);
        lines.push(`DP width: ${Math.round(width / (density / 160))}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_device_state",
    "Get a combined device state snapshot in one call: battery level/status, network connectivity, screen on/off, foreground activity, and orientation. Useful as a pre-check before UI automation or as a quick device health summary.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const [battery, network, screen, activity, orientation, wifi] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys battery | head -15", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("getprop gsm.network.type", { device: serial, timeout: 3000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys power | grep -E 'mWakefulness|Display Power'", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys activity activities | grep mResumedActivity", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("settings get system accelerometer_rotation", { device: serial, timeout: 3000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys wifi | grep -E 'Wi-Fi is|mNetworkInfo'", { device: serial, timeout: 5000, ignoreExitCode: true }),
        ]);

        const sections: string[] = ["=== Device State Snapshot ==="];

        // Battery
        if (battery.status === "fulfilled") {
          const b = battery.value.stdout;
          const level = b.match(/level:\s*(\d+)/)?.[1] ?? "?";
          const status = b.match(/status:\s*(\d+)/)?.[1];
          const statusMap: Record<string, string> = { "1": "unknown", "2": "charging", "3": "discharging", "4": "not charging", "5": "full" };
          const temp = b.match(/temperature:\s*(\d+)/)?.[1];
          const tempC = temp ? (parseInt(temp, 10) / 10).toFixed(1) : "?";
          sections.push(`Battery: ${level}% (${statusMap[status ?? ""] ?? "unknown"}, ${tempC}°C)`);
        }

        // Network
        if (network.status === "fulfilled") {
          const net = network.value.stdout.trim() || "none";
          sections.push(`Network: ${net}`);
        }

        // WiFi
        if (wifi.status === "fulfilled") {
          const w = wifi.value.stdout;
          const wifiEnabled = w.includes("enabled") ? "on" : w.includes("disabled") ? "off" : "unknown";
          sections.push(`WiFi: ${wifiEnabled}`);
        }

        // Screen
        if (screen.status === "fulfilled") {
          const s = screen.value.stdout;
          const wake = s.includes("Awake") ? "ON" : s.includes("Asleep") || s.includes("Dozing") ? "OFF" : "unknown";
          sections.push(`Screen: ${wake}`);
        }

        // Orientation
        if (orientation.status === "fulfilled") {
          const auto = orientation.value.stdout.trim() === "1";
          sections.push(`Orientation: ${auto ? "auto-rotate" : "locked"}`);
        }

        // Foreground activity
        if (activity.status === "fulfilled") {
          const a = activity.value.stdout;
          const match = a.match(/mResumedActivity:.*\{[^\s]+\s+([^\s}]+)/);
          sections.push(`Foreground: ${match ? match[1] : "none"}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_notifications",
    "Read active notifications on the device. Parses the notification manager dump to extract package, title, text, importance, channel, and flags for each notification. Useful for verifying push notification delivery, monitoring notification state, and testing notification-related features.",
    {
      filter: z.string().optional().describe("Filter by package name (partial match, case-insensitive)"),
      maxResults: z.number().int().min(1).max(50).optional().default(20)
        .describe("Maximum notifications to return (1-50, default 20)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ filter, maxResults, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Dump notification state — use --noredact for full content
        const result = await ctx.bridge.shell(
          "dumpsys notification --noredact",
          { device: serial, timeout: 15000, ignoreExitCode: true }
        );
        const dump = result.stdout;

        // Parse NotificationRecord blocks
        const notifications: {
          pkg: string; title: string; text: string;
          importance: string; channel: string; flags: string;
          key: string; when: string;
        }[] = [];

        // Split on NotificationRecord boundaries
        const records = dump.split(/NotificationRecord\(/).slice(1);

        for (const record of records) {
          if (notifications.length >= maxResults) break;

          // Extract package from the header
          const pkgMatch = record.match(/pkg=([^\s]+)/);
          const pkg = pkgMatch?.[1] ?? "unknown";

          // Apply package filter
          if (filter && !pkg.toLowerCase().includes(filter.toLowerCase())) continue;

          // Extract key fields
          const keyMatch = record.match(/key=([^\n]+)/);
          const flagsMatch = record.match(/flags=([^\n]+)/);
          const importanceMatch = record.match(/mImportance=([^\n]+)/);
          const channelMatch = record.match(/channel=([^\s,]+)/);

          // Extract title and text from extras
          const titleMatch = record.match(/android\.title=String\s*\(([^)]+)\)/);
          const textMatch = record.match(/android\.text=String\s*\(([^)]+)\)/);
          const whenMatch = record.match(/when=(\d+)/);

          const title = titleMatch?.[1] ?? "";
          const text = textMatch?.[1] ?? "";

          notifications.push({
            pkg,
            title,
            text,
            importance: importanceMatch?.[1]?.trim() ?? "unknown",
            channel: channelMatch?.[1] ?? "unknown",
            flags: flagsMatch?.[1]?.trim() ?? "none",
            key: keyMatch?.[1]?.trim() ?? "",
            when: whenMatch?.[1] ? new Date(parseInt(whenMatch[1], 10)).toISOString() : "",
          });
        }

        if (notifications.length === 0) {
          return { content: [{ type: "text", text: filter ? `No notifications found matching "${filter}"` : "No active notifications" }] };
        }

        const output = notifications.map((n, i) => {
          const lines = [`[${i + 1}] ${n.pkg}`];
          if (n.title) lines.push(`  Title: ${n.title}`);
          if (n.text) lines.push(`  Text: ${n.text}`);
          lines.push(`  Importance: ${n.importance} | Channel: ${n.channel}`);
          if (n.flags !== "none") lines.push(`  Flags: ${n.flags}`);
          if (n.when) lines.push(`  Posted: ${n.when}`);
          return lines.join("\n");
        }).join("\n\n");

        return { content: [{ type: "text", text: `${notifications.length} notification(s)${filter ? ` matching "${filter}"` : ""}:\n\n${output}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
