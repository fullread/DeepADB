/**
 * Regression Detection Tools — Automated comparison of device state over time.
 *
 * Captures performance baselines, compares subsequent runs against them,
 * and maintains a history log for trend analysis. Tracks memory usage,
 * CPU, frame stats, and device state drift across sessions.
 */

import { z } from "zod";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";

interface PerfBaseline {
  timestamp: string;
  device: string;
  packageName: string;
  label: string;
  memoryKb: number | null;
  cpuPercent: number | null;
  totalFrames: number | null;
  jankyFrames: number | null;
  batteryLevel: number | null;
  networkType: string | null;
}

function getBaselineDir(tempDir: string): string {
  return join(tempDir, "regression");
}

function parseMemoryKb(output: string): number | null {
  const match = output.match(/TOTAL[:\s]+(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function parseCpuPercent(output: string, pkg: string): number | null {
  const escapedPkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`(\\d+\\.?\\d*)%.*${escapedPkg}`));
  return match ? parseFloat(match[1]) : null;
}

function parseFrameStats(output: string): { total: number | null; janky: number | null } {
  const totalMatch = output.match(/Total frames rendered:\s*(\d+)/);
  const jankyMatch = output.match(/Janky frames:\s*(\d+)/);
  return {
    total: totalMatch ? parseInt(totalMatch[1], 10) : null,
    janky: jankyMatch ? parseInt(jankyMatch[1], 10) : null,
  };
}

function parseBatteryLevel(output: string): number | null {
  const match = output.match(/level:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function registerRegressionTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_regression_baseline",
    "Capture a performance baseline for a package: memory, CPU, frame stats, battery, and network state. Saves to a timestamped JSON file for later comparison with adb_regression_check.",
    {
      packageName: z.string().describe("Package name to profile"),
      label: z.string().optional().default("baseline").describe("Label for this baseline (e.g., 'before-refactor', 'v2.5.0')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, label, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const [memResult, cpuResult, gfxResult, batteryResult, netTypeResult] = await Promise.allSettled([
          ctx.bridge.shell(`dumpsys meminfo ${packageName} | grep TOTAL`, { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell(`dumpsys cpuinfo | grep -F ${packageName}`, { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell(`dumpsys gfxinfo ${packageName} | grep -E 'Total frames|Janky frames'`, { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys battery", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("getprop gsm.network.type", { device: serial, ignoreExitCode: true }),
        ]);

        const memOut = memResult.status === "fulfilled" ? memResult.value.stdout : "";
        const cpuOut = cpuResult.status === "fulfilled" ? cpuResult.value.stdout : "";
        const gfxOut = gfxResult.status === "fulfilled" ? gfxResult.value.stdout : "";
        const battOut = batteryResult.status === "fulfilled" ? batteryResult.value.stdout : "";
        const netOut = netTypeResult.status === "fulfilled" ? netTypeResult.value.stdout.trim() : null;
        const frames = parseFrameStats(gfxOut);

        const baseline: PerfBaseline = {
          timestamp: new Date().toISOString(),
          device: serial,
          packageName,
          label,
          memoryKb: parseMemoryKb(memOut),
          cpuPercent: parseCpuPercent(cpuOut, packageName),
          totalFrames: frames.total,
          jankyFrames: frames.janky,
          batteryLevel: parseBatteryLevel(battOut),
          networkType: netOut || null,
        };

        const dir = getBaselineDir(ctx.config.tempDir);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
        const safePkg = packageName.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const filename = `${safePkg}_${safeLabel}_${Date.now()}.json`;
        const filePath = join(dir, filename);
        writeFileSync(filePath, JSON.stringify(baseline, null, 2));

        const summary: string[] = [`Baseline captured: ${label}`];
        summary.push(`Package: ${packageName}`);
        summary.push(`Memory: ${baseline.memoryKb ? `${(baseline.memoryKb / 1024).toFixed(1)} MB` : "unavailable"}`);
        summary.push(`CPU: ${baseline.cpuPercent !== null ? `${baseline.cpuPercent}%` : "unavailable"}`);
        summary.push(`Frames: ${baseline.totalFrames ?? "?"} total, ${baseline.jankyFrames ?? "?"} janky`);
        summary.push(`Battery: ${baseline.batteryLevel ?? "?"}%`);
        summary.push(`Network: ${baseline.networkType ?? "unknown"}`);
        summary.push(`Saved: ${filePath}`);

        return { content: [{ type: "text", text: summary.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_regression_check",
    "Compare current performance against a saved baseline. Flags regressions in memory (>20% increase), CPU (>50% increase), and jank rate (>25% increase). Thresholds are configurable.",
    {
      baselinePath: z.string().describe("Path to the saved baseline JSON file"),
      memoryThreshold: z.number().min(0).max(1000).optional().default(20).describe("Memory regression threshold in percent (0-1000, default 20%)"),
      cpuThreshold: z.number().min(0).max(1000).optional().default(50).describe("CPU regression threshold in percent (0-1000, default 50%)"),
      jankThreshold: z.number().min(0).max(1000).optional().default(25).describe("Jank rate regression threshold in percent (0-1000, default 25%)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ baselinePath, memoryThreshold, cpuThreshold, jankThreshold, device }) => {
      try {
        if (!existsSync(baselinePath)) {
          return { content: [{ type: "text", text: `Baseline not found: ${baselinePath}` }], isError: true };
        }
        const baseline: PerfBaseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
        const pkgErr = validateShellArg(baseline.packageName, "packageName (from baseline)");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const pkg = baseline.packageName;

        const [memResult, cpuResult, gfxResult] = await Promise.allSettled([
          ctx.bridge.shell(`dumpsys meminfo ${pkg} | grep TOTAL`, { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell(`dumpsys cpuinfo | grep -F ${pkg}`, { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell(`dumpsys gfxinfo ${pkg} | grep -E 'Total frames|Janky frames'`, { device: serial, timeout: 10000, ignoreExitCode: true }),
        ]);

        const memOut = memResult.status === "fulfilled" ? memResult.value.stdout : "";
        const cpuOut = cpuResult.status === "fulfilled" ? cpuResult.value.stdout : "";
        const gfxOut = gfxResult.status === "fulfilled" ? gfxResult.value.stdout : "";
        const currentMem = parseMemoryKb(memOut);
        const currentCpu = parseCpuPercent(cpuOut, pkg);
        const currentFrames = parseFrameStats(gfxOut);

        const regressions: string[] = [];
        const comparisons: string[] = [];

        comparisons.push(`Comparing against: ${baseline.label} (${baseline.timestamp})`);
        comparisons.push(`Package: ${pkg}\n`);

        // Memory comparison
        if (baseline.memoryKb && currentMem) {
          const pct = ((currentMem - baseline.memoryKb) / baseline.memoryKb) * 100;
          const flag = pct > memoryThreshold ? "✗ REGRESSION" : pct > 0 ? "○ Increased" : "✓ OK";
          comparisons.push(`Memory: ${(baseline.memoryKb / 1024).toFixed(1)} MB → ${(currentMem / 1024).toFixed(1)} MB (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%) ${flag}`);
          if (pct > memoryThreshold) regressions.push(`Memory increased ${pct.toFixed(1)}% (threshold: ${memoryThreshold}%)`);
        } else {
          comparisons.push(`Memory: baseline=${baseline.memoryKb ?? "?"} current=${currentMem ?? "?"} (comparison unavailable)`);
        }

        // CPU comparison
        if (baseline.cpuPercent !== null && currentCpu !== null) {
          const pct = baseline.cpuPercent > 0 ? ((currentCpu - baseline.cpuPercent) / baseline.cpuPercent) * 100 : 0;
          const flag = pct > cpuThreshold ? "✗ REGRESSION" : "✓ OK";
          comparisons.push(`CPU: ${baseline.cpuPercent}% → ${currentCpu}% (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%) ${flag}`);
          if (pct > cpuThreshold) regressions.push(`CPU increased ${pct.toFixed(1)}% (threshold: ${cpuThreshold}%)`);
        }

        // Jank comparison
        if (baseline.totalFrames && baseline.jankyFrames !== null && currentFrames.total && currentFrames.janky !== null) {
          const baseJankRate = baseline.totalFrames > 0 ? (baseline.jankyFrames / baseline.totalFrames) * 100 : 0;
          const currJankRate = currentFrames.total > 0 ? (currentFrames.janky / currentFrames.total) * 100 : 0;
          const diff = currJankRate - baseJankRate;
          const flag = diff > jankThreshold ? "✗ REGRESSION" : "✓ OK";
          comparisons.push(`Jank rate: ${baseJankRate.toFixed(1)}% → ${currJankRate.toFixed(1)}% (${diff > 0 ? "+" : ""}${diff.toFixed(1)}pp) ${flag}`);
          if (diff > jankThreshold) regressions.push(`Jank rate increased ${diff.toFixed(1)} percentage points (threshold: ${jankThreshold}%)`);
        }

        if (regressions.length > 0) {
          comparisons.push(`\n=== ${regressions.length} REGRESSION(S) DETECTED ===`);
          for (const r of regressions) comparisons.push(`  ✗ ${r}`);
        } else {
          comparisons.push("\n=== NO REGRESSIONS DETECTED ===");
        }

        return { content: [{ type: "text", text: comparisons.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_regression_history",
    "List all saved regression baselines, optionally filtered by package name. Shows trends over time.",
    {
      packageName: z.string().optional().describe("Filter by package name"),
    },
    async ({ packageName }) => {
      try {
        const dir = getBaselineDir(ctx.config.tempDir);
        if (!existsSync(dir)) {
          return { content: [{ type: "text", text: "No regression baselines found. Use adb_regression_baseline to create one." }] };
        }

        const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
        if (files.length === 0) {
          return { content: [{ type: "text", text: "No regression baselines found." }] };
        }

        const baselines: PerfBaseline[] = [];
        for (const file of files) {
          try {
            const data: PerfBaseline = JSON.parse(readFileSync(join(dir, file), "utf-8"));
            if (!packageName || data.packageName === packageName) {
              baselines.push(data);
            }
          } catch { /* skip corrupt files */ }
        }

        if (baselines.length === 0) {
          return { content: [{ type: "text", text: packageName ? `No baselines found for ${packageName}.` : "No baselines found." }] };
        }

        const lines = baselines.map((b) => {
          const mem = b.memoryKb ? `${(b.memoryKb / 1024).toFixed(1)}MB` : "?";
          const cpu = b.cpuPercent !== null ? `${b.cpuPercent}%` : "?";
          const jank = (b.totalFrames && b.jankyFrames !== null) ? `${((b.jankyFrames / b.totalFrames) * 100).toFixed(1)}%` : "?";
          return `${b.timestamp.substring(0, 19)} | ${b.label} | mem:${mem} cpu:${cpu} jank:${jank} | ${b.packageName}`;
        });

        return {
          content: [{
            type: "text",
            text: `${baselines.length} baseline(s):\n\n${lines.join("\n")}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
