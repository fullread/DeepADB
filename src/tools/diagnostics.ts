/**
 * Diagnostics Tools — dumpsys, battery, network, telephony state.
 * Useful for device inspection, performance profiling, and radio diagnostics.
 */

import { z } from "zod";
import { join } from "path";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";

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
}
