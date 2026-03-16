/**
 * File Tools — Push, pull, list, and manage files on the device.
 */

import { z } from "zod";
import { join } from "path";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellEscape } from "../middleware/sanitize.js";

export function registerFileTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_push",
    "Push a local file to the device filesystem",
    {
      localPath: z.string().describe("Local file path to push"),
      remotePath: z.string().describe("Destination path on device"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ localPath, remotePath, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.exec(["push", localPath, remotePath], {
          device: resolved.serial, timeout: 120000,
        });
        return { content: [{ type: "text", text: result.stdout.trim() || "File pushed successfully." }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_pull",
    "Pull a file from the device to local filesystem",
    {
      remotePath: z.string().describe("File path on the device"),
      localPath: z.string().optional().describe("Local destination (defaults to temp dir)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ remotePath, localPath, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const fileName = remotePath.split("/").pop() ?? "pulled_file";
        const dest = localPath ?? join(ctx.config.tempDir, fileName);
        const result = await ctx.bridge.exec(["pull", remotePath, dest], {
          device: resolved.serial, timeout: 120000,
        });
        return {
          content: [{ type: "text", text: `${result.stdout.trim()}\nSaved to: ${dest}` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ls",
    "List files and directories on the device",
    {
      path: z.string().default("/sdcard").describe("Directory path on device"),
      device: z.string().optional().describe("Device serial"),
      details: z.boolean().optional().default(false).describe("Show detailed listing (ls -la)"),
    },
    async ({ path, device, details }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const cmd = details ? `ls -la '${shellEscape(path)}'` : `ls '${shellEscape(path)}'`;
        const result = await ctx.bridge.shell(cmd, { device: resolved.serial });
        return { content: [{ type: "text", text: OutputProcessor.process(result.stdout) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_cat",
    "Read a text file from the device",
    {
      path: z.string().describe("File path on device"),
      device: z.string().optional().describe("Device serial"),
      maxLines: z.number().min(1).max(10000).optional().describe("Maximum lines to return (1-10000)"),
    },
    async ({ path, device, maxLines }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        let cmd = `cat '${shellEscape(path)}'`;
        if (maxLines) cmd = `head -n ${maxLines} '${shellEscape(path)}'`;
        const result = await ctx.bridge.shell(cmd, { device: resolved.serial });
        return { content: [{ type: "text", text: OutputProcessor.process(result.stdout) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
