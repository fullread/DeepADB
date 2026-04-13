/**
 * UI Tools — Screenshots, input events, activity inspection, and UI hierarchy analysis.
 */

import { z } from "zod";
import { join, basename } from "path";
import { writeFileSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellEscape } from "../middleware/sanitize.js";
import { captureUiDump, parseUiNodes, UiElement } from "../middleware/ui-dump.js";
import { decodePngPixels, encodePng, drawRect, drawLabel, ELEMENT_COLORS } from "../middleware/png-utils.js";
import { isOnDevice } from "../config/config.js";

function sanitizeFilename(name: string): string {
  const base = basename(name);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized || `file_${Date.now()}`;
}

export function registerUiTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_screencap",
    "Take a screenshot and save to local filesystem. Returns the file path.",
    {
      filename: z.string().optional().describe("Output filename (default: screenshot_<timestamp>.png)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ filename, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const fname = sanitizeFilename(filename ?? `screenshot_${Date.now()}.png`);
        const localPath = join(ctx.config.tempDir, fname);
        const remoteDir = isOnDevice() ? "/data/local/tmp" : "/sdcard";
        const remotePath = `${remoteDir}/${fname}`;
        try {
          await ctx.bridge.shell(`screencap -p '${shellEscape(remotePath)}'`, { device: resolved.serial, timeout: 15000 });
          await ctx.bridge.exec(["pull", remotePath, localPath], { device: resolved.serial, timeout: 30000 });
        } finally {
          await ctx.bridge.shell(`rm '${shellEscape(remotePath)}'`, { device: resolved.serial, ignoreExitCode: true }).catch(() => {});
        }
        return { content: [{ type: "text", text: `Screenshot saved: ${localPath}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_current_activity",
    "Get the currently focused activity and window stack",
    { device: z.string().optional().describe("Device serial") },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const [focused, stack] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys activity activities | grep -E 'mResumedActivity|mFocusedActivity'", {
            device: resolved.serial, ignoreExitCode: true,
          }),
          ctx.bridge.shell("dumpsys activity top | head -20", {
            device: resolved.serial, ignoreExitCode: true,
          }),
        ]);
        let output = "=== Focused Activity ===\n";
        output += focused.status === "fulfilled" ? focused.value.stdout.trim() || "(none)" : "unavailable";
        output += "\n\n=== Top Activity ===\n";
        output += stack.status === "fulfilled" ? stack.value.stdout.trim() || "(none)" : "unavailable";
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_input",
    "Send input events to the device (tap, swipe, text, keyevent)",
    {
      type: z.enum(["tap", "swipe", "text", "keyevent"]).describe("Input type"),
      args: z.string().describe(
        "Arguments: tap='x y', swipe='x1 y1 x2 y2 [duration_ms]', text='string', keyevent='KEYCODE_HOME'"
      ),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ type, args, device }) => {
      try {
        // Security check — input commands can execute arbitrary text on device
        const blocked = ctx.security.checkCommand(`input ${type} ${args}`, device);
        if (blocked) {
          return { content: [{ type: "text", text: blocked }], isError: true };
        }

        // Type-specific validation to prevent shell injection via args
        let shellCmd: string;
        switch (type) {
          case "tap":
          case "swipe":
            // Should only contain digits, spaces, and optional minus sign
            if (!/^[\d\s.-]+$/.test(args)) {
              return { content: [{ type: "text", text: `Invalid ${type} args: must contain only numbers and spaces (got: "${args}")` }], isError: true };
            }
            shellCmd = `input ${type} ${args}`;
            break;
          case "keyevent":
            // Should only contain alphanumeric, underscore, and spaces (for multiple keycodes)
            if (!/^[\w\s]+$/.test(args)) {
              return { content: [{ type: "text", text: `Invalid keyevent args: must contain only alphanumeric characters and underscores (got: "${args}")` }], isError: true };
            }
            shellCmd = `input keyevent ${args}`;
            break;
          case "text":
            // Text can contain anything — must be shell-escaped to prevent injection
            // and to ensure special characters are typed literally on the device
            shellCmd = `input text '${shellEscape(args)}'`;
            break;
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(shellCmd, {
          device: resolved.serial, ignoreExitCode: true,
        });
        return { content: [{ type: "text", text: result.stdout.trim() || `Input ${type} sent.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_start_activity",
    "Start an activity or app by intent or component name",
    {
      intent: z.string().describe("Intent or component (e.g., 'com.example/.MainActivity' or '-a android.intent.action.VIEW -d https://example.com')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ intent, device }) => {
      try {
        // Security check — intents can trigger arbitrary actions
        const blocked = ctx.security.checkCommand(`am start ${intent}`, device);
        if (blocked) {
          return { content: [{ type: "text", text: blocked }], isError: true };
        }
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(`am start ${intent}`, {
          device: resolved.serial, ignoreExitCode: true,
        });
        return { content: [{ type: "text", text: result.stdout.trim() }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ui_dump",
    "Dump the current UI hierarchy. Parses the view tree into structured element data with coordinates, text, resource IDs, and interaction flags. Use format='tsv' for token-efficient compact output, format='xml' for raw uiautomator XML.",
    {
      clickableOnly: z.boolean().optional().default(false).describe("Only show clickable/interactive elements"),
      format: z.enum(["text", "tsv", "xml"]).optional().default("text")
        .describe("Output format: 'text' (default, human-readable), 'tsv' (tab-separated, token-efficient), 'xml' (raw uiautomator XML)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ clickableOnly, format, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const xml = await captureUiDump(ctx.bridge, resolved.serial);

        if (!xml) {
          return { content: [{ type: "text", text: "Failed to capture UI hierarchy. The screen may be in a state that doesn't support uiautomator dump (e.g., locked, transitioning)." }], isError: true };
        }

        if (format === "xml") {
          return { content: [{ type: "text", text: OutputProcessor.process(xml) }] };
        }

        const elements = parseUiNodes(xml, clickableOnly);

        if (elements.length === 0) {
          return { content: [{ type: "text", text: clickableOnly ? "No clickable elements found on screen." : "No UI elements found." }] };
        }

        if (format === "tsv") {
          const header = "index\ttext\tresource_id\tcontent_desc\tcenter_x\tcenter_y\tclickable\tscrollable";
          const rows = elements.map((el, i) => formatElementTsv(el, i));
          return { content: [{ type: "text", text: `${elements.length} elements:\n${header}\n${rows.join("\n")}` }] };
        }

        // format === "text" (default)
        const output = elements.map((el, i) => formatElement(el, i, true)).join("\n");
        return { content: [{ type: "text", text: `${elements.length} elements:\n\n${OutputProcessor.process(output)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ui_find",
    "Search the UI hierarchy for elements matching text, resource-id, or content-description. Returns matching elements with coordinates for precise adb_input targeting.",
    {
      text: z.string().optional().describe("Match elements containing this text (case-insensitive)"),
      resourceId: z.string().optional().describe("Match elements with this resource-id (partial match)"),
      contentDesc: z.string().optional().describe("Match elements with this content-description (partial, case-insensitive)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ text, resourceId, contentDesc, device }) => {
      if (!text && !resourceId && !contentDesc) {
        return { content: [{ type: "text", text: "Provide at least one search parameter: text, resourceId, or contentDesc." }], isError: true };
      }
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const xml = await captureUiDump(ctx.bridge, resolved.serial);

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
          if (resourceId) criteria.push(`resourceId="${resourceId}"`);
          if (contentDesc) criteria.push(`contentDesc="${contentDesc}"`);
          return { content: [{ type: "text", text: `No elements found matching: ${criteria.join(", ")}` }] };
        }

        const output = matches.map((el, i) => formatElement(el, i, false)).join("\n");
        return { content: [{ type: "text", text: `${matches.length} match(es):\n\n${output}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_screencap_annotated",
    "Take a screenshot with UI element bounding boxes and numbered labels composited directly onto the image. Returns the annotated PNG path plus a text legend mapping each element number to its identity. Ideal for LLM workflows that need to reference specific UI elements by number rather than by coordinates.",
    {
      clickableOnly: z.boolean().optional().default(true)
        .describe("Only annotate clickable/scrollable elements (default true — reduces visual noise)"),
      filename: z.string().optional()
        .describe("Output filename (default: annotated_<timestamp>.png)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ clickableOnly, filename, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const ts = Date.now();
        const remoteDir = isOnDevice() ? "/data/local/tmp" : "/sdcard";
        const remotePng = `${remoteDir}/DA_ann_${ts}.png`;
        const outName = filename
          ? filename.replace(/[^a-zA-Z0-9._-]/g, "_")
          : `annotated_${ts}.png`;
        const localPath = join(ctx.config.tempDir, outName);

        // Capture screenshot and UI hierarchy in parallel
        await ctx.bridge.shell(`screencap -p '${shellEscape(remotePng)}'`,
          { device: serial, timeout: 15000 });
        try {
          await ctx.bridge.exec(["pull", remotePng, localPath], { device: serial, timeout: 30000 });
        } finally {
          await ctx.bridge.shell(`rm '${shellEscape(remotePng)}'`,
            { device: serial, ignoreExitCode: true }).catch(() => {});
        }

        const xml = await captureUiDump(ctx.bridge, serial);
        if (!xml) {
          return { content: [{ type: "text", text: "Screenshot saved but UI hierarchy capture failed — returning plain screenshot." }] };
        }

        const elements = parseUiNodes(xml, clickableOnly);
        const img = decodePngPixels(localPath);
        if (!img) {
          return { content: [{ type: "text", text: `Screenshot saved: ${localPath}\n(PNG decode failed — annotation skipped)` }] };
        }

        // Composite: draw bounding box border + number label for each element
        const { width, height, bytesPerPixel, pixels } = img;
        const bpp = bytesPerPixel as 3 | 4;
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i]!;
          const color = ELEMENT_COLORS[i % ELEMENT_COLORS.length]!;
          drawRect(pixels, width, height, bpp,
            el.bounds.left, el.bounds.top, el.bounds.right, el.bounds.bottom, color, 2);
          drawLabel(pixels, width, height, bpp,
            el.bounds.left, el.bounds.top, i, color);
        }

        // Encode and save annotated PNG
        const annotatedPng = encodePng(width, height, pixels, bpp);
        writeFileSync(localPath, annotatedPng);

        // Build legend
        const legend = elements.map((el, i) => {
          const label = el.text || el.contentDesc || el.resourceId || el.className;
          const flags: string[] = [];
          if (el.clickable)  flags.push("tap");
          if (el.scrollable) flags.push("scroll");
          return `[${i}] ${label}${flags.length ? ` (${flags.join("/")})` : ""}`;
        }).join("\n");

        return {
          content: [{
            type: "text",
            text: `Annotated screenshot: ${localPath}\n${elements.length} elements labeled\n\n${legend}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_screen_state",
    "Get a combined screen state snapshot in one call: foreground activity, screen dimensions and density, orientation, battery level, and a TSV list of interactive UI elements. Replaces 3-4 separate tool calls with a single round-trip. Ideal as a first step in any automation workflow.",
    {
      clickableOnly: z.boolean().optional().default(true)
        .describe("Only include clickable/scrollable elements in TSV output (default true)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ clickableOnly, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // All system queries in parallel; UI dump runs after since it's slower
        const [activityR, sizeR, densityR, batteryR, orientR] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys activity activities | grep -m1 mResumedActivity",
            { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("wm size",    { device: serial, timeout: 3000, ignoreExitCode: true }),
          ctx.bridge.shell("wm density", { device: serial, timeout: 3000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys battery | head -10",
            { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("settings get system accelerometer_rotation",
            { device: serial, timeout: 3000, ignoreExitCode: true }),
        ]);

        const xml = await captureUiDump(ctx.bridge, serial);

        // Build header section
        const lines: string[] = [];

        // Activity
        const actLine = activityR.status === "fulfilled" ? activityR.value.stdout : "";
        const actMatch = actLine.match(/mResumedActivity:.*?\{[^\s]+\s+([^\s}]+)/);
        lines.push(`Activity: ${actMatch?.[1] ?? "(unknown)"}`);

        // Screen size + density
        const sizeStr   = sizeR.status === "fulfilled" ? sizeR.value.stdout : "";
        const densStr   = densityR.status === "fulfilled" ? densityR.value.stdout : "";
        const sizeMatch = sizeStr.match(/(\d+)x(\d+)/);
        const densMatch = densStr.match(/(\d+)/);
        const w = sizeMatch?.[1] ?? "?", h = sizeMatch?.[2] ?? "?";
        const dpi = densMatch?.[1] ?? "?";
        lines.push(`Screen: ${w}×${h} @ ${dpi} dpi`);

        // Orientation
        const autoRot = orientR.status === "fulfilled" ? orientR.value.stdout.trim() : "";
        lines.push(`Orientation: ${autoRot === "1" ? "auto-rotate" : "locked"}`);

        // Battery
        if (batteryR.status === "fulfilled") {
          const b = batteryR.value.stdout;
          const level  = b.match(/level:\s*(\d+)/)?.[1]  ?? "?";
          const status = b.match(/status:\s*(\d+)/)?.[1];
          const statusMap: Record<string, string> = {
            "2": "charging", "3": "discharging", "4": "not charging", "5": "full",
          };
          const temp  = b.match(/temperature:\s*(\d+)/)?.[1];
          const tempC = temp ? (parseInt(temp, 10) / 10).toFixed(1) : "?";
          lines.push(`Battery: ${level}% (${statusMap[status ?? ""] ?? "unknown"}, ${tempC}°C)`);
        }

        // TSV element table
        if (!xml) {
          lines.push("\n(UI hierarchy unavailable)");
        } else {
          const elements = parseUiNodes(xml, clickableOnly);
          lines.push(`Elements: ${elements.length}`);
          lines.push("");
          lines.push("index\ttext\tresource_id\tcontent_desc\tcenter_x\tcenter_y\tclickable\tscrollable");
          for (let i = 0; i < elements.length; i++) {
            lines.push(formatElementTsv(elements[i]!, i));
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}

// ── UI Hierarchy Helpers ──────────────────────────────────────────────

/** Format a UI element for output. `showFlags` includes interaction flags (for dump); omit for find (shows tap coords instead). */
function formatElement(el: UiElement, index: number, showFlags: boolean): string {
  const parts = [`[${index}]`];
  if (el.resourceId) parts.push(`id: ${el.resourceId}`);
  if (el.text) parts.push(`text: "${el.text}"`);
  if (el.contentDesc) parts.push(`desc: "${el.contentDesc}"`);
  parts.push(`class: ${el.className}`);

  if (showFlags) {
    parts.push(`bounds: [${el.bounds.centerX},${el.bounds.centerY}] (${el.bounds.left},${el.bounds.top})-(${el.bounds.right},${el.bounds.bottom})`);
    const flags: string[] = [];
    if (el.clickable) flags.push("clickable");
    if (el.scrollable) flags.push("scrollable");
    if (el.focusable) flags.push("focusable");
    if (el.enabled === false) flags.push("disabled");
    if (flags.length) parts.push(`[${flags.join(", ")}]`);
  } else {
    parts.push(`tap: ${el.bounds.centerX} ${el.bounds.centerY}`);
    parts.push(`bounds: (${el.bounds.left},${el.bounds.top})-(${el.bounds.right},${el.bounds.bottom})`);
  }

  return parts.join(" | ");
}

/** Format a UI element as a TSV row for token-efficient output. */
function formatElementTsv(el: UiElement, index: number): string {
  const cols = [
    index,
    el.text.replace(/\t/g, " "),
    el.resourceId,
    el.contentDesc.replace(/\t/g, " "),
    el.bounds.centerX,
    el.bounds.centerY,
    el.clickable  ? "true" : "false",
    el.scrollable ? "true" : "false",
  ];
  return cols.join("\t");
}
