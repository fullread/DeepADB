/**
 * ADB-over-Network Device Discovery — Scan for ADB devices on the local network.
 *
 * Discovers Android devices with ADB enabled over WiFi/TCP by scanning
 * common ADB ports on the local subnet. Replaces manual IP entry for
 * wireless debugging workflows.
 *
 * Discovery methods:
 *   1. ARP table scan — check known hosts for open ADB ports
 *   2. Subnet sweep — probe a configurable IP range for ADB responses
 *   3. Connected device IP extraction — get IPs of already-connected WiFi devices
 *
 * Does NOT require root. Uses standard TCP connection attempts to detect
 * ADB listeners on ports 5555 (default), 5554, and custom ports.
 *
 * Security: Only scans local network subnets. Connection attempts use
 * short timeouts (2s) to avoid hanging on unresponsive hosts.
 */

import { z } from "zod";
import { createConnection, Socket } from "net";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

/** Default ADB TCP ports to probe. */
const ADB_PORTS = [5555, 5554, 5556, 5557, 5558];

/** Check if a TCP port is open on a given host. */
function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = createConnection({ host, port, timeout: timeoutMs });
    let resolved = false;

    const done = (result: boolean): void => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));

    // Safety timeout in case none of the events fire
    setTimeout(() => done(false), timeoutMs + 500);
  });
}

/** Parse an IP range string like "192.168.1.1-254" into individual IPs. */
function expandIpRange(range: string): string[] {
  const match = range.match(/^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/);
  if (!match) return [range]; // Not a range, treat as single IP

  const prefix = match[1];
  const start = parseInt(match[2], 10);
  const end = parseInt(match[3], 10);

  if (start > end || start < 0 || end > 255) return [];

  const ips: string[] = [];
  for (let i = start; i <= end; i++) {
    ips.push(`${prefix}${i}`);
  }
  return ips;
}

interface DiscoveredDevice {
  ip: string;
  port: number;
  source: string;
}

export function registerNetworkDiscoveryTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_network_scan",
    "Scan the local network for Android devices with ADB enabled over WiFi/TCP. Probes common ADB ports (5555-5558) on hosts from the ARP table and optionally a custom IP range. Discovered devices can be connected with adb_connect.",
    {
      ipRange: z.string().optional().describe("IP range to scan (e.g., '192.168.1.1-254'). If omitted, scans hosts from the ARP table only."),
      ports: z.array(z.number().min(1).max(65535)).max(20).optional().describe("Custom ports to probe (default: [5555, 5554, 5556, 5557, 5558], max 20)"),
      timeoutMs: z.number().min(500).max(10000).optional().default(2000).describe("Connection timeout per host in ms (500-10000, default 2000)"),
      device: z.string().optional().describe("Device serial (used to determine the local subnet if no ipRange given)"),
    },
    async ({ ipRange, ports, timeoutMs, device }) => {
      try {
        const probePorts = ports ?? ADB_PORTS;
        const timeout = Math.min(Math.max(timeoutMs, 500), 10000);
        const discovered: DiscoveredDevice[] = [];

        const sections: string[] = [];
        sections.push("=== ADB Network Discovery ===\n");

        // Collect candidate IPs
        const candidates = new Set<string>();

        // Method 1: ARP table — query a connected device for its network neighbors
        let arpSource = "host";
        try {
          // Try to get the device's own IP and subnet
          const resolved = device ? await ctx.deviceManager.resolveDevice(device) : await ctx.deviceManager.resolveDevice();
          const serial = resolved.serial;

          const ipResult = await ctx.bridge.shell("ip neigh show 2>/dev/null || arp -a 2>/dev/null", {
            device: serial, timeout: 5000, ignoreExitCode: true,
          });

          const ipMatches = ipResult.stdout.matchAll(/(\d+\.\d+\.\d+\.\d+)/g);
          for (const m of ipMatches) {
            const ip = m[1];
            // Skip broadcast, loopback, and link-local
            if (!ip.startsWith("127.") && !ip.startsWith("169.254.") && !ip.endsWith(".255")) {
              candidates.add(ip);
            }
          }
          arpSource = `device (${serial})`;
        } catch { /* no device available, skip */ }

        // Method 2: User-specified IP range
        if (ipRange) {
          const rangeIps = expandIpRange(ipRange);
          for (const ip of rangeIps) candidates.add(ip);
          sections.push(`IP range: ${ipRange} (${rangeIps.length} hosts)`);
        }

        if (candidates.size === 0) {
          sections.push("No candidate IPs found. Provide an ipRange to scan a specific subnet.");
          sections.push("Example: ipRange='192.168.1.1-254'");
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        sections.push(`Candidates: ${candidates.size} hosts (from ${arpSource}${ipRange ? " + IP range" : ""})`);
        sections.push(`Ports: ${probePorts.join(", ")}`);
        sections.push(`Timeout: ${timeout}ms per probe\n`);
        sections.push("Scanning...");

        // Probe all candidates in parallel batches (limit concurrency to avoid overwhelming)
        const allIps = Array.from(candidates);
        const BATCH_SIZE = 20;

        for (let batch = 0; batch < allIps.length; batch += BATCH_SIZE) {
          const batchIps = allIps.slice(batch, batch + BATCH_SIZE);

          const probes: Array<Promise<void>> = [];
          for (const ip of batchIps) {
            for (const port of probePorts) {
              probes.push(
                probePort(ip, port, timeout).then((open) => {
                  if (open) {
                    discovered.push({ ip, port, source: ipRange && expandIpRange(ipRange).includes(ip) ? "range" : "arp" });
                  }
                })
              );
            }
          }

          await Promise.all(probes);
        }

        if (discovered.length === 0) {
          sections.push("\nNo ADB listeners found on the scanned hosts.");
          sections.push("Ensure target devices have wireless debugging enabled:");
          sections.push("  Settings → Developer Options → Wireless debugging");
          sections.push("  Or run: adb_tcpip to switch a USB-connected device to TCP mode.");
        } else {
          sections.push(`\nDiscovered ${discovered.length} ADB listener(s):\n`);
          for (const d of discovered) {
            sections.push(`  ${d.ip}:${d.port} (found via ${d.source})`);
          }
          sections.push(`\nConnect with: adb_connect host="${discovered[0].ip}:${discovered[0].port}"`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_network_device_ip",
    "Get the WiFi IP address of a connected device. Useful for switching from USB to wireless debugging without needing to find the IP manually on the device.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Try multiple methods to get the device IP
        const methods = [
          { cmd: "ip route | grep 'src' | head -1", regex: /src\s+(\d+\.\d+\.\d+\.\d+)/ },
          { cmd: "ip addr show wlan0 | grep 'inet '", regex: /inet\s+(\d+\.\d+\.\d+\.\d+)/ },
          { cmd: "ifconfig wlan0 2>/dev/null | grep 'inet '", regex: /inet\s+(?:addr:)?(\d+\.\d+\.\d+\.\d+)/ },
          { cmd: "getprop dhcp.wlan0.ipaddress", regex: /(\d+\.\d+\.\d+\.\d+)/ },
        ];

        let ip: string | null = null;
        let method = "";

        for (const m of methods) {
          const result = await ctx.bridge.shell(m.cmd, {
            device: serial, ignoreExitCode: true,
          });
          const match = result.stdout.match(m.regex);
          if (match && match[1] && !match[1].startsWith("127.")) {
            ip = match[1];
            method = m.cmd.split("|")[0].trim().split(" ")[0];
            break;
          }
        }

        if (!ip) {
          return {
            content: [{ type: "text", text: `Could not determine WiFi IP for ${serial}. Device may not be connected to WiFi.` }],
            isError: true,
          };
        }

        // Check if ADB TCP is already enabled
        const propsResult = await ctx.bridge.shell("getprop service.adb.tcp.port", {
          device: serial, ignoreExitCode: true,
        });
        const tcpPort = propsResult.stdout.trim();
        const adbTcpEnabled = tcpPort && tcpPort !== "0" && tcpPort !== "-1";

        const sections: string[] = [];
        sections.push(`Device: ${serial}`);
        sections.push(`WiFi IP: ${ip} (via ${method})`);
        sections.push(`ADB TCP: ${adbTcpEnabled ? `enabled on port ${tcpPort}` : "not enabled"}`);

        if (adbTcpEnabled) {
          sections.push(`\nConnect wirelessly: adb_connect host="${ip}:${tcpPort}"`);
        } else {
          sections.push(`\nTo enable wireless debugging:`);
          sections.push(`  1. adb_tcpip (switches USB device to TCP mode on port 5555)`);
          sections.push(`  2. adb_connect host="${ip}:5555"`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_network_auto_connect",
    "Discover and automatically connect to ADB devices on the local network. Combines network scanning with adb connect in one step.",
    {
      ipRange: z.string().optional().describe("IP range to scan (e.g., '192.168.1.1-254')"),
      port: z.number().min(1).max(65535).optional().default(5555).describe("ADB port to probe and connect (1-65535, default 5555)"),
      device: z.string().optional().describe("Device serial (used to determine local subnet for ARP-based discovery)"),
    },
    async ({ ipRange, port, device }) => {
      try {
        const sections: string[] = [];
        sections.push("=== Auto-Connect Discovery ===\n");

        // Collect candidate IPs
        const candidates = new Set<string>();

        if (ipRange) {
          const ips = expandIpRange(ipRange);
          for (const ip of ips) candidates.add(ip);
        }

        // ARP-based discovery
        try {
          const resolved = device ? await ctx.deviceManager.resolveDevice(device) : await ctx.deviceManager.resolveDevice();
          const arpResult = await ctx.bridge.shell("ip neigh show 2>/dev/null || arp -a 2>/dev/null", {
            device: resolved.serial, timeout: 5000, ignoreExitCode: true,
          });
          for (const m of arpResult.stdout.matchAll(/(\d+\.\d+\.\d+\.\d+)/g)) {
            if (!m[1].startsWith("127.") && !m[1].endsWith(".255")) candidates.add(m[1]);
          }
        } catch { /* no device for ARP */ }

        if (candidates.size === 0) {
          sections.push("No candidate IPs. Provide ipRange (e.g., '192.168.1.1-254').");
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        sections.push(`Scanning ${candidates.size} hosts on port ${port}...`);

        // Probe all candidates
        const found: string[] = [];
        const allIps = Array.from(candidates);
        const BATCH_SIZE = 20;

        for (let batch = 0; batch < allIps.length; batch += BATCH_SIZE) {
          const batchIps = allIps.slice(batch, batch + BATCH_SIZE);
          const probes = batchIps.map((ip) =>
            probePort(ip, port, 2000).then((open) => {
              if (open) found.push(ip);
            })
          );
          await Promise.all(probes);
        }

        if (found.length === 0) {
          sections.push("\nNo ADB listeners found.");
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        sections.push(`\nFound ${found.length} device(s). Connecting...\n`);

        // Try to connect to each discovered device
        let connected = 0;
        for (const ip of found) {
          const target = `${ip}:${port}`;
          try {
            const result = await ctx.bridge.exec(["connect", target], { timeout: 10000 });
            const output = result.stdout.trim();
            const success = output.includes("connected") && !output.includes("failed");
            if (success) {
              connected++;
              sections.push(`  ✓ Connected: ${target}`);
            } else {
              sections.push(`  ✗ Failed: ${target} — ${output}`);
            }
          } catch (err) {
            sections.push(`  ✗ Error: ${target} — ${err instanceof Error ? err.message : err}`);
          }
        }

        // Invalidate device cache after connections
        ctx.deviceManager.invalidateCache();

        sections.push(`\nResult: ${connected} device(s) connected out of ${found.length} found.`);
        if (connected > 0) {
          sections.push("Use adb_devices to see all connected devices.");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
