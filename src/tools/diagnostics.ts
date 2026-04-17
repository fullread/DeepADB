/**
 * Diagnostics Tools — dumpsys, battery, network, telephony state,
 * bug reports, crash logs, heap dumps, and device reboot.
 */

import { z } from "zod";
import { join } from "path";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg, shellEscape } from "../middleware/sanitize.js";

export function registerDiagnosticTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_dumpsys",
    "Run dumpsys for a specific service. Use 'list' as the service to see all available services.",
    {
      service: z.string().describe("Service name (e.g., 'battery', 'telephony.registry', 'activity') or 'list'"),
      args: z.string().optional().describe("Additional arguments passed to dumpsys"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ service, args, device }) => {
      try {
        const svcErr = validateShellArg(service, "service");
        if (svcErr) return { content: [{ type: "text", text: svcErr }], isError: true };
        if (args) {
          const argsErr = validateShellArg(args, "args");
          if (argsErr) return { content: [{ type: "text", text: argsErr }], isError: true };
        }
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const cmd = service === "list"
          ? "dumpsys -l"
          : `dumpsys ${service}${args ? ` ${args}` : ""}`;
        const result = await ctx.bridge.shell(cmd, { device: resolved.serial, timeout: 30000 });
        return { content: [{ type: "text", text: OutputProcessor.process(result.stdout) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_telephony",
    "Get telephony state including cell info, signal strength, and network registration.",
    { device: z.string().optional().describe("Device serial") },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const [registry, cellInfo, signalStrength] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys telephony.registry", { device: resolved.serial, timeout: 15000 }),
          ctx.bridge.shell("dumpsys phone | grep -A 20 'mCellInfo'", { device: resolved.serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys phone | grep -A 5 'mSignalStrength'", { device: resolved.serial, timeout: 10000, ignoreExitCode: true }),
        ]);
        let output = "=== Telephony Registry ===\n";
        output += OutputProcessor.settledValue(registry, 20000, "Error");
        output += "\n\n=== Cell Info ===\n";
        output += OutputProcessor.settledValue(cellInfo, undefined, "Could not retrieve cell info");
        output += "\n\n=== Signal Strength ===\n";
        output += OutputProcessor.settledValue(signalStrength, undefined, "Could not retrieve signal strength");
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_battery",
    "Get battery status, level, temperature, and charging info",
    { device: z.string().optional().describe("Device serial") },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell("dumpsys battery", { device: resolved.serial });
        return { content: [{ type: "text", text: result.stdout.trim() }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_network",
    "Get network connectivity info including WiFi, cellular, and active connections",
    { device: z.string().optional().describe("Device serial") },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const [connectivity, wifi, netstat] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys connectivity | head -100", { device: resolved.serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys wifi | grep -A 30 'Wi-Fi is'", { device: resolved.serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("ip addr show", { device: resolved.serial, timeout: 5000, ignoreExitCode: true }),
        ]);
        let output = "=== Connectivity ===\n";
        output += OutputProcessor.settledValue(connectivity);
        output += "\n\n=== WiFi ===\n";
        output += OutputProcessor.settledValue(wifi);
        output += "\n\n=== IP Addresses ===\n";
        output += OutputProcessor.settledValue(netstat);
        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_top",
    "Get current CPU and memory usage snapshot",
    {
      count: z.number().min(1).max(100).optional().default(1).describe("Number of iterations (1-100, 1 = snapshot)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ count, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(`top -b -n ${count} -d 1`, {
          device: resolved.serial,
          timeout: (count * 2 + 5) * 1000,
        });
        return { content: [{ type: "text", text: OutputProcessor.process(result.stdout, 30000) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_perf_snapshot",
    "Capture a performance snapshot for a package: memory usage, frame stats, and CPU info in one call.",
    {
      packageName: z.string().describe("Package name to profile (e.g., 'com.example.app')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const [meminfo, gfxinfo, cpuinfo] = await Promise.allSettled([
          ctx.bridge.shell(`dumpsys meminfo ${packageName}`, { device: serial, timeout: 15000 }),
          ctx.bridge.shell(`dumpsys gfxinfo ${packageName}`, { device: serial, timeout: 10000 }),
          ctx.bridge.shell("dumpsys cpuinfo", { device: serial, timeout: 10000 }),
        ]);

        let output = `=== Memory (${packageName}) ===\n`;
        output += OutputProcessor.settledValue(meminfo, 15000, "Could not retrieve meminfo");
        output += `\n\n=== Frame Stats (${packageName}) ===\n`;
        output += OutputProcessor.settledValue(gfxinfo, 10000, "Could not retrieve gfxinfo");
        output += "\n\n=== CPU Usage (system) ===\n";
        output += OutputProcessor.settledValue(cpuinfo, 10000, "Could not retrieve cpuinfo");

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_bugreport",
    "Capture a full bug report zip (device state, logs, dumpsys, system info). Returns the local file path.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const filename = `bugreport_${serial}_${Date.now()}.zip`;
        const localPath = join(ctx.config.tempDir, filename);

        const result = await ctx.bridge.exec(["bugreport", localPath], {
          device: serial,
          timeout: 300000, // 5 minutes — bugreports can be slow
        });

        const output = result.stdout.trim();
        return {
          content: [{
            type: "text",
            text: `Bug report captured: ${localPath}${output ? "\n" + output : ""}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // ── Debugging & Crash Analysis ────────────────────────────────────

  ctx.server.tool(
    "adb_crash_logs",
    "Read ANR (Application Not Responding) traces and tombstone crash dumps from the device. Requires root access for /data/anr/ and /data/tombstones/. Returns the most recent entries.",
    {
      type: z.enum(["anr", "tombstones", "both"]).optional().default("both")
        .describe("Type of crash data to retrieve (default: both)"),
      maxEntries: z.number().int().min(1).max(20).optional().default(5)
        .describe("Maximum entries to return per type (1-20, default 5)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ type, maxEntries, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const sections: string[] = [];

        if (type === "anr" || type === "both") {
          const anrList = await ctx.bridge.shell(
            `ls -lt /data/anr/ 2>/dev/null | head -${maxEntries + 1}`,
            { device: serial, timeout: 5000, ignoreExitCode: true }
          );
          if (anrList.stdout.trim()) {
            sections.push("=== ANR Traces (/data/anr/) ===");
            sections.push(anrList.stdout.trim());
            // Get content of most recent trace
            const latest = await ctx.bridge.shell(
              "cat /data/anr/traces.txt 2>/dev/null | head -200",
              { device: serial, timeout: 10000, ignoreExitCode: true }
            );
            if (latest.stdout.trim()) {
              sections.push("\n--- Latest trace (first 200 lines) ---");
              sections.push(latest.stdout.trim());
            }
          } else {
            sections.push("=== ANR Traces === (none found)");
          }
        }

        if (type === "tombstones" || type === "both") {
          const tombList = await ctx.bridge.shell(
            `ls -lt /data/tombstones/ 2>/dev/null | head -${maxEntries + 1}`,
            { device: serial, timeout: 5000, ignoreExitCode: true }
          );
          if (tombList.stdout.trim()) {
            sections.push("\n=== Tombstones (/data/tombstones/) ===");
            sections.push(tombList.stdout.trim());
            // Get header of most recent tombstone
            const files = await ctx.bridge.shell(
              `ls -t /data/tombstones/ 2>/dev/null | head -1`,
              { device: serial, timeout: 3000, ignoreExitCode: true }
            );
            const latest = files.stdout.trim();
            if (latest) {
              const content = await ctx.bridge.shell(
                `head -100 '/data/tombstones/${shellEscape(latest)}'`,
                { device: serial, timeout: 10000, ignoreExitCode: true }
              );
              if (content.stdout.trim()) {
                sections.push(`\n--- ${latest} (first 100 lines) ---`);
                sections.push(content.stdout.trim());
              }
            }
          } else {
            sections.push("\n=== Tombstones === (none found)");
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") || "No crash data found" }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_heap_dump",
    "Capture a heap dump from a running process for memory analysis. Triggers `am dumpheap` and pulls the resulting .hprof file. Requires the target process PID or package name.",
    {
      target: z.string().describe("Process PID (number) or package name (e.g., com.example.app)"),
      filename: z.string().optional().describe("Output filename (default: heap_<target>_<timestamp>.hprof)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ target, filename, device }) => {
      try {
        const targetErr = validateShellArg(target, "target");
        if (targetErr) return { content: [{ type: "text", text: targetErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const remoteDir = "/data/local/tmp";
        const timestamp = Date.now();
        const remotePath = `${remoteDir}/DA_heap_${timestamp}.hprof`;
        const fname = (filename ?? `heap_${target.replace(/\./g, "_")}_${timestamp}.hprof`).replace(/[^a-zA-Z0-9._-]/g, "_");
        const localPath = join(ctx.config.tempDir, fname);

        try {
          await ctx.bridge.shell(
            `am dumpheap '${shellEscape(target)}' '${remotePath}'`,
            { device: serial, timeout: 60000 }
          );
          // Wait for dump to complete (am dumpheap is async)
          await new Promise((r) => setTimeout(r, 3000));
          await ctx.bridge.exec(["pull", remotePath, localPath], { device: serial, timeout: 60000 });
          return { content: [{ type: "text", text: `Heap dump saved: ${localPath}\nTarget: ${target}` }] };
        } finally {
          await ctx.bridge.shell(`rm -f '${remotePath}'`, { device: serial, ignoreExitCode: true }).catch(() => {});
        }
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
