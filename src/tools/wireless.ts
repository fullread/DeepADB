/**
 * Wireless Tools — WiFi-based ADB: pair, connect, disconnect.
 * Enables untethered device interaction for field testing.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

export function registerWirelessTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_pair",
    "Pair with a device over WiFi using the pairing code from Developer Options → Wireless debugging → Pair device",
    {
      host: z.string().describe("Device IP and pairing port (e.g., '192.168.1.100:37123')"),
      code: z.string().describe("6-digit pairing code shown on the device"),
    },
    async ({ host, code }) => {
      try {
        const result = await ctx.bridge.exec(["pair", host, code], {
          timeout: 30000,
          retries: 0,
        });
        ctx.deviceManager.invalidateCache();
        const output = result.stdout.trim() || result.stderr.trim();
        return { content: [{ type: "text", text: output || "Pairing initiated." }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_connect",
    "Connect to a device over WiFi/TCP. Device must be paired first or have TCP/IP enabled.",
    {
      host: z.string().describe("Device IP and port (e.g., '192.168.1.100:5555' or '192.168.1.100:41567')"),
    },
    async ({ host }) => {
      try {
        const result = await ctx.bridge.exec(["connect", host], {
          timeout: 15000,
          retries: 0,
        });
        ctx.deviceManager.invalidateCache();
        return { content: [{ type: "text", text: result.stdout.trim() }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_disconnect",
    "Disconnect from a wireless device, or all wireless devices if no host specified",
    {
      host: z.string().optional().describe("Device IP:port to disconnect (omit for all)"),
    },
    async ({ host }) => {
      try {
        const args = host ? ["disconnect", host] : ["disconnect"];
        const result = await ctx.bridge.exec(args, { timeout: 10000, retries: 0 });
        ctx.deviceManager.invalidateCache();
        return { content: [{ type: "text", text: result.stdout.trim() || "Disconnected." }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_tcpip",
    "Switch a USB-connected device to TCP/IP mode on the specified port (default 5555). After this, you can disconnect USB and use adb_connect.",
    {
      port: z.number().min(1).max(65535).optional().default(5555).describe("TCP port for ADB (1-65535, default 5555)"),
      device: z.string().optional().describe("Device serial (must be USB-connected)"),
    },
    async ({ port, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.exec(["tcpip", String(port)], {
          device: resolved.serial,
          timeout: 10000,
        });
        // Get the device IP for convenience
        const ipResult = await ctx.bridge.shell(
          "ip route | grep 'src' | head -1 | awk '{print $NF}'",
          { device: resolved.serial, ignoreExitCode: true }
        );
        const ip = ipResult.stdout.trim();
        let msg = result.stdout.trim() || `Restarting in TCP mode on port ${port}`;
        if (ip) {
          msg += `\nDevice IP: ${ip}\nConnect with: adb_connect host="${ip}:${port}"`;
        }
        ctx.deviceManager.invalidateCache();
        return { content: [{ type: "text", text: msg }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
