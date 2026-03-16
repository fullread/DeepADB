/**
 * Network Capture Tools — On-device packet capture via tcpdump.
 * 
 * Captures network traffic for analysis. Requires tcpdump on device
 * (available on rooted devices or via manual installation).
 * Pulls pcap files locally for Wireshark analysis.
 */

import { z } from "zod";
import { join } from "path";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg, shellEscape } from "../middleware/sanitize.js";

/** Track active captures. Key = device serial. */
const activeCaptures = new Map<string, { remotePath: string; startedAt: number }>();

export function registerNetworkCaptureTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_tcpdump_start",
    "Start a packet capture on the device using tcpdump. Requires root or tcpdump binary on device. Capture runs in background.",
    {
      interface: z.string().optional().default("any").describe("Network interface to capture (default: 'any')"),
      filter: z.string().optional().describe("tcpdump filter expression (e.g., 'port 443', 'host 10.0.0.1')"),
      maxPackets: z.number().min(1).max(1000000).optional().describe("Stop after N packets (1-1000000, omit for continuous until stop)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ interface: iface, filter, maxPackets, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        if (activeCaptures.has(serial)) {
          return { content: [{ type: "text", text: `Capture already running on ${serial}. Stop it first with adb_tcpdump_stop.` }], isError: true };
        }

        // Check if tcpdump is available
        const which = await ctx.bridge.shell("which tcpdump || echo NOT_FOUND", {
          device: serial, ignoreExitCode: true,
        });
        if (which.stdout.includes("NOT_FOUND")) {
          return { content: [{ type: "text", text: "tcpdump not found on device. Requires root or manual installation of tcpdump binary." }], isError: true };
        }

        const filename = `capture_${Date.now()}.pcap`;
        const remotePath = `/sdcard/${filename}`;

        // Validate parameters that get interpolated into the shell command
        const ifaceErr = validateShellArg(iface, "interface");
        if (ifaceErr) return { content: [{ type: "text", text: ifaceErr }], isError: true };
        if (filter) {
          const filterErr = validateShellArg(filter, "filter");
          if (filterErr) return { content: [{ type: "text", text: filterErr }], isError: true };
        }

        let cmd = `nohup tcpdump -i ${iface} -w '${shellEscape(remotePath)}'`;
        if (maxPackets) cmd += ` -c ${maxPackets}`;
        if (filter) cmd += ` ${filter}`;
        cmd += " > /dev/null 2>&1 &";

        await ctx.bridge.shell(cmd, { device: serial, ignoreExitCode: true });
        activeCaptures.set(serial, { remotePath, startedAt: Date.now() });

        return {
          content: [{
            type: "text",
            text: `Packet capture started on ${serial}\nInterface: ${iface}\nDevice path: ${remotePath}${filter ? "\nFilter: " + filter : ""}${maxPackets ? "\nMax packets: " + maxPackets : ""}\nUse adb_tcpdump_stop to finish and pull the pcap file.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_tcpdump_stop",
    "Stop an active packet capture and pull the pcap file locally for analysis.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      let resolvedSerial: string | undefined;
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        resolvedSerial = resolved.serial;
        const serial = resolved.serial;
        const capture = activeCaptures.get(serial);

        if (!capture) {
          return { content: [{ type: "text", text: `No active capture on ${serial}.` }], isError: true };
        }

        // Kill the tcpdump process writing to our specific file.
        // Uses pgrep (by binary name) + /proc/cmdline grep to avoid the pkill -f
        // self-match bug: on-device, pkill -f runs through su -c whose cmdline
        // contains the pattern, causing pkill to kill itself instead of tcpdump.
        const captureFilename = capture.remotePath.split("/").pop() ?? "";
        await ctx.bridge.shell(
          `pgrep tcpdump | while read p; do grep -q '${captureFilename}' /proc/$p/cmdline 2>/dev/null && kill $p; done 2>/dev/null; true`,
          { device: serial, ignoreExitCode: true }
        );
        await new Promise((r) => setTimeout(r, 1000));

        // Pull pcap file
        const localFilename = capture.remotePath.split("/").pop() ?? "capture.pcap";
        const localPath = join(ctx.config.tempDir, localFilename);
        await ctx.bridge.exec(["pull", capture.remotePath, localPath], { device: serial, timeout: 60000 });

        // Get file size
        const sizeResult = await ctx.bridge.shell(`stat -c %s '${shellEscape(capture.remotePath)}'`, {
          device: serial, ignoreExitCode: true,
        });
        const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;

        // Clean up device file
        await ctx.bridge.shell(`rm '${shellEscape(capture.remotePath)}'`, { device: serial, ignoreExitCode: true });

        const elapsed = ((Date.now() - capture.startedAt) / 1000).toFixed(1);
        activeCaptures.delete(serial);

        return {
          content: [{
            type: "text",
            text: `Capture saved: ${localPath}\nDuration: ${elapsed}s\nSize: ${(sizeBytes / 1024).toFixed(1)} KB\nOpen in Wireshark for analysis.`,
          }],
        };
      } catch (error) {
        if (resolvedSerial) {
          activeCaptures.delete(resolvedSerial);
        }
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_network_connections",
    "Show active network connections on the device (TCP/UDP). Similar to netstat — shows established connections, listening ports, and connection states.",
    {
      protocol: z.enum(["tcp", "udp", "all"]).optional().default("all").describe("Filter by protocol"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ protocol, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const commands: string[] = [];
        if (protocol === "tcp" || protocol === "all") commands.push("cat /proc/net/tcp /proc/net/tcp6 2>/dev/null");
        if (protocol === "udp" || protocol === "all") commands.push("cat /proc/net/udp /proc/net/udp6 2>/dev/null");

        // Also try ss or netstat if available
        const ssResult = await ctx.bridge.shell("ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null || echo FALLBACK", {
          device: serial, ignoreExitCode: true,
        });

        if (!ssResult.stdout.includes("FALLBACK")) {
          return { content: [{ type: "text", text: OutputProcessor.process(ssResult.stdout) }] };
        }

        // Fallback: parse /proc/net
        const results = await Promise.allSettled(
          commands.map((cmd) => ctx.bridge.shell(cmd, { device: serial, ignoreExitCode: true }))
        );
        const output = results
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<{ stdout: string }>).value.stdout.trim())
          .filter((s) => s.length > 0)
          .join("\n\n");

        return { content: [{ type: "text", text: OutputProcessor.process(output || "No connection data available.") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
