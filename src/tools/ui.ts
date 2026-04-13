/**
 * UI Tools — Screenshots, input events, activity inspection, and UI hierarchy analysis.
 */

import { z } from "zod";
import { join, basename } from "path";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellEscape } from "../middleware/sanitize.js";
import { captureUiDump, parseUiNodes, UiElement } from "../middleware/ui-dump.js";
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
    "Dump the current UI hierarchy. Parses the view tree into structured element data with coordinates, text, resource IDs, and interaction flags.",
    {
      clickableOnly: z.boolean().optional().default(false).describe("Only show clickable/interactive elements"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ clickableOnly, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const xml = await captureUiDump(ctx.bridge, resolved.serial);

        if (!xml) {
          return { content: [{ type: "text", text: "Failed to capture UI hierarchy. The screen may be in a state that doesn't support uiautomator dump (e.g., locked, transitioning)." }], isError: true };
        }

        const elements = parseUiNodes(xml, clickableOnly);

        if (elements.length === 0) {
          return { content: [{ type: "text", text: clickableOnly ? "No clickable elements found on screen." : "No UI elements found." }] };
        }

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
