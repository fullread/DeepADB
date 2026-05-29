// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Wireless Tools — WiFi-based ADB: pair, connect, disconnect.
 * Enables untethered device interaction for field testing.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

/**
 * N1: Host format validation for adb wireless commands.
 *
 * ADB accepts `host:port` where host is an IPv4 literal, a bracketed IPv6
 * literal, or a DNS name. The previous schema (`z.string()`) accepted any
 * string and relied on adb's own argv-style invocation to be injection-safe,
 * which it is — but a bad value still produced a confusing low-level adb
 * error rather than a clear schema error. This regex catches obvious
 * mistakes (missing port, stray whitespace, non-host characters) before
 * we ever shell out.
 *
 * Pattern accepts:
 *   IPv4:port      — 192.168.1.100:5555
 *   [IPv6]:port    — [fe80::1]:5555
 *   hostname:port  — phone.local:5555, my-pixel:41567
 *
 * Port: 1-65535 (5 digits max). The regex does not range-check the digit
 * value; adb itself will reject port 0 or > 65535 at invocation time.
 */
/**
 * BI5 note: this regex does NOT range-check IPv4 octets (must be 0-255)
 * or the port (must be 1-65535). `999.999.999.999:99999` passes this
 * regex. Acceptable degradation: adb itself rejects invalid port numbers
 * at invocation time (`failed to parse port number`) and IP misconfig
 * surfaces as a connection-refused error. A tighter regex matching the
 * full octet alternation would be 4× longer (`(?:25[0-5]|2[0-4]\d|[01]?\d\d?)`)
 * with no real security benefit — this is a syntax check, not a network
 * validator. The intent is to catch shell-metacharacter smuggling, which
 * is what the bracket-delimited character classes accomplish.
 */
const HOST_PORT_RE = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[[0-9a-fA-F:]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*):\d{1,5}$/;
const HOST_PORT_MSG = "Expected 'host:port' format — e.g., '192.168.1.100:5555', '[fe80::1]:5555', or 'phone.local:5555'.";
const hostSchema = z.string().regex(HOST_PORT_RE, HOST_PORT_MSG);
const hostSchemaOptional = z.string().regex(HOST_PORT_RE, HOST_PORT_MSG).optional();

export function registerWirelessTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_pair",
    "Pair with a device over WiFi using the pairing code from Developer Options → Wireless debugging → Pair device",
    {
      host: hostSchema.describe("Device IP and pairing port (e.g., '192.168.1.100:37123')"),
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
      host: hostSchema.describe("Device IP and port (e.g., '192.168.1.100:5555' or '192.168.1.100:41567')"),
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
      host: hostSchemaOptional.describe("Device IP:port to disconnect (omit for all)"),
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
