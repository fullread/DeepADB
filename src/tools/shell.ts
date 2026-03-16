/**
 * Shell Tools — Execute arbitrary shell commands on the device.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

export function registerShellTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_shell",
    "Execute a shell command on the Android device. Returns stdout and stderr.",
    {
      command: z.string().describe("Shell command to execute on the device"),
      device: z.string().optional().describe("Device serial"),
      timeout: z.number().min(1000).max(600000).optional().describe("Timeout in milliseconds (1s-10min)"),
    },
    async ({ command, device, timeout }) => {
      try {
        // Security check
        const blocked = ctx.security.checkCommand(command, device);
        if (blocked) {
          return { content: [{ type: "text", text: blocked }], isError: true };
        }
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(command, {
          device: resolved.serial,
          timeout,
          ignoreExitCode: true,
        });
        let output = result.stdout;
        if (result.stderr) {
          output += `\n--- STDERR ---\n${result.stderr}`;
        }
        if (result.exitCode !== 0) {
          output += `\n--- Exit code: ${result.exitCode} ---`;
        }
        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_root_shell",
    "Execute a command as root via su. Requires rooted device.",
    {
      command: z.string().describe("Command to run as root"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ command, device }) => {
      try {
        // Security check (root commands get extra scrutiny)
        const blocked = ctx.security.checkCommand(`su: ${command}`, device);
        if (blocked) {
          return { content: [{ type: "text", text: blocked }], isError: true };
        }
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.rootShell(command, {
          device: resolved.serial,
          ignoreExitCode: true,
        });
        let output = result.stdout;
        if (result.stderr) {
          output += `\n--- STDERR ---\n${result.stderr}`;
        }
        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
