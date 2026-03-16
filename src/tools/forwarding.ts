/**
 * Port Forwarding Tools — TCP port mapping between host and device.
 * Wraps adb forward and adb reverse for network debugging.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

export function registerForwardingTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_forward",
    "Forward a local port to a port on the device (host → device). Use for connecting to services running on the device.",
    {
      local: z.string().describe("Local (host) spec, e.g., 'tcp:8080'"),
      remote: z.string().describe("Remote (device) spec, e.g., 'tcp:8080' or 'localabstract:app_socket'"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ local, remote, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.exec(["forward", local, remote], { device: resolved.serial });
        return { content: [{ type: "text", text: result.stdout.trim() || `Forwarding ${local} → ${remote}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_reverse",
    "Reverse-forward a device port to a port on the host (device → host). Use for letting device apps reach services on your machine.",
    {
      remote: z.string().describe("Remote (device) spec, e.g., 'tcp:3000'"),
      local: z.string().describe("Local (host) spec, e.g., 'tcp:3000'"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ remote, local, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.exec(["reverse", remote, local], { device: resolved.serial });
        return { content: [{ type: "text", text: result.stdout.trim() || `Reverse forwarding ${remote} → ${local}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_forward_list",
    "List all active port forwards and reverse forwards",
    { device: z.string().optional().describe("Device serial (omit for all devices)") },
    async ({ device }) => {
      try {
        const resolved = device ? await ctx.deviceManager.resolveDevice(device) : null;

        // Get forward list
        const fwdResult = await ctx.bridge.exec(["forward", "--list"], {
          device: resolved?.serial, ignoreExitCode: true,
        });

        // Get reverse list
        let revOutput = "";
        if (resolved) {
          const revResult = await ctx.bridge.exec(["reverse", "--list"], {
            device: resolved.serial, ignoreExitCode: true,
          });
          revOutput = revResult.stdout.trim();
        }

        let output = "=== Forward (host → device) ===\n";
        output += fwdResult.stdout.trim() || "(none)";
        if (resolved) {
          output += "\n\n=== Reverse (device → host) ===\n";
          output += revOutput || "(none)";
        }
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
