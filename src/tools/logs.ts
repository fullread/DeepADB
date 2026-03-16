/**
 * Log Tools — Logcat capture with filtering, tag selection, and snapshots.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg, shellEscape } from "../middleware/sanitize.js";

export function registerLogTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_logcat",
    "Capture a logcat snapshot. Supports tag filtering, priority levels, and grep patterns.",
    {
      lines: z.number().min(1).max(10000).optional().default(100).describe("Number of recent lines to capture (1-10000)"),
      tag: z.string().optional().describe("Filter by tag (e.g., 'ActivityManager' or 'MyApp')"),
      priority: z.enum(["V", "D", "I", "W", "E", "F"]).optional()
        .describe("Minimum priority: V(erbose), D(ebug), I(nfo), W(arn), E(rror), F(atal)"),
      grep: z.string().optional().describe("Grep filter applied to output (literal string match, case-insensitive)"),
      device: z.string().optional().describe("Device serial"),
      buffer: z.enum(["main", "system", "crash", "events", "all"]).optional().default("main")
        .describe("Logcat buffer to read from"),
    },
    async ({ lines, tag, priority, grep, device, buffer }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const maxLines = Math.min(lines, ctx.config.maxLogcatLines);
        if (tag) {
          const tagErr = validateShellArg(tag, "tag");
          if (tagErr) return { content: [{ type: "text", text: tagErr }], isError: true };
        }
        let cmd = "logcat -d";
        if (buffer === "all") {
          cmd += " -b main,system,crash,events";
        } else {
          cmd += ` -b ${buffer}`;
        }
        cmd += ` -t ${maxLines}`;
        if (tag && priority) {
          cmd += ` -s ${tag}:${priority}`;
        } else if (tag) {
          cmd += ` -s ${tag}:V`;
        } else if (priority) {
          cmd += ` *:${priority}`;
        }
        if (grep) {
          cmd += ` | grep -iF '${shellEscape(grep)}'`;
        }
        const result = await ctx.bridge.shell(cmd, { device: resolved.serial, timeout: 15000 });
        const output = result.stdout.trim();
        if (!output) {
          return { content: [{ type: "text", text: "No log entries matching the filter." }] };
        }
        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_logcat_clear",
    "Clear all logcat buffers on the device",
    { device: z.string().optional().describe("Device serial") },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        await ctx.bridge.shell("logcat -c", { device: resolved.serial });
        return { content: [{ type: "text", text: "Logcat buffers cleared." }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_logcat_crash",
    "Get recent crash logs from the crash buffer",
    {
      lines: z.number().min(1).max(10000).optional().default(50).describe("Number of lines (1-10000)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ lines, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const maxLines = Math.min(lines, ctx.config.maxLogcatLines);
        const result = await ctx.bridge.shell(`logcat -d -b crash -t ${maxLines}`, { device: resolved.serial });
        const output = result.stdout.trim();
        return { content: [{ type: "text", text: output || "No crash logs found." }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
