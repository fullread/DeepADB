/**
 * Thermal & Power Profiling — Temperature, CPU frequency, and battery drain analysis.
 *
 * Captures thermal zone temperatures, CPU frequency scaling states, cooling
 * device activity, and battery drain rates. Complements the existing regression
 * detection module by providing baselines for issues that manifest as heat or
 * battery drain rather than frame drops or memory growth.
 *
 * Data sources:
 *   - /sys/class/thermal/thermal_zone{n}/  — temperature readings per zone
 *   - /sys/devices/system/cpu/cpu{n}/cpufreq/ — CPU frequency and governor
 *   - /sys/class/power_supply/battery/ — detailed battery state
 *   - dumpsys batterystats — historical battery usage statistics
 *
 * All sysfs reads use hardcoded paths — no user input reaches shell interpolation.
 */

import { z } from "zod";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";

interface ThermalSnapshot {
  timestamp: string;
  device: string;
  zones: Array<{ name: string; type: string; temp: number }>;
  cpus: Array<{ cpu: number; curFreqMhz: number; maxFreqMhz: number; minFreqMhz: number; governor: string }>;
  battery: { level: number; temperature: number; currentNow: number; voltageNow: number; status: string };
}

function getThermalDir(tempDir: string): string {
  return join(tempDir, "thermal-profiles");
}

export function registerThermalPowerTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_thermal_snapshot",
    "Capture a thermal and power snapshot: all thermal zone temperatures, per-CPU frequencies and governors, cooling device states, and battery temperature/current draw. Optionally save as a baseline for later comparison.",
    {
      save: z.boolean().optional().default(false).describe("Save snapshot as a baseline JSON file"),
      label: z.string().optional().default("snapshot").describe("Label for saved baseline"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ save, label, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const sections: string[] = [];
        sections.push("=== Thermal & Power Snapshot ===");

        // Read thermal zones
        const thermalResult = await ctx.bridge.shell(
          "for z in /sys/class/thermal/thermal_zone*; do " +
          "echo \"ZONE:$(basename $z):$(cat $z/type 2>/dev/null):$(cat $z/temp 2>/dev/null)\"; " +
          "done 2>/dev/null",
          { device: serial, timeout: 10000, ignoreExitCode: true }
        );

        const zones: Array<{ name: string; type: string; temp: number }> = [];
        for (const line of thermalResult.stdout.split("\n")) {
          const match = line.match(/^ZONE:(\S+):(\S*):(\d+)/);
          if (match) {
            const tempC = parseInt(match[3], 10) / 1000; // millidegrees to degrees
            zones.push({ name: match[1], type: match[2] || "unknown", temp: tempC });
          }
        }

        if (zones.length > 0) {
          sections.push(`\nThermal zones (${zones.length}):`);
          const maxTemp = Math.max(...zones.map((z) => z.temp));
          for (const z of zones) {
            const warn = z.temp > 55 ? " 🔥 CRITICAL" : z.temp > 45 ? " ⚠ HOT" : "";
            sections.push(`  ${z.name} [${z.type}]: ${z.temp.toFixed(1)}°C${warn}`);
          }
          sections.push(`  Peak: ${maxTemp.toFixed(1)}°C`);
        } else {
          sections.push("\nThermal zones: not accessible (may require root)");
        }

        // Read CPU frequencies
        const cpuResult = await ctx.bridge.shell(
          "for c in /sys/devices/system/cpu/cpu[0-9]*; do " +
          "echo \"CPU:$(basename $c):" +
          "$(cat $c/cpufreq/scaling_cur_freq 2>/dev/null || echo 0):" +
          "$(cat $c/cpufreq/scaling_max_freq 2>/dev/null || echo 0):" +
          "$(cat $c/cpufreq/scaling_min_freq 2>/dev/null || echo 0):" +
          "$(cat $c/cpufreq/scaling_governor 2>/dev/null || echo unknown)\"; " +
          "done 2>/dev/null",
          { device: serial, timeout: 10000, ignoreExitCode: true }
        );

        const cpus: Array<{ cpu: number; curFreqMhz: number; maxFreqMhz: number; minFreqMhz: number; governor: string }> = [];
        for (const line of cpuResult.stdout.split("\n")) {
          const match = line.match(/^CPU:cpu(\d+):(\d+):(\d+):(\d+):(\S+)/);
          if (match) {
            cpus.push({
              cpu: parseInt(match[1], 10),
              curFreqMhz: parseInt(match[2], 10) / 1000,
              maxFreqMhz: parseInt(match[3], 10) / 1000,
              minFreqMhz: parseInt(match[4], 10) / 1000,
              governor: match[5],
            });
          }
        }

        if (cpus.length > 0) {
          sections.push(`\nCPU frequencies (${cpus.length} cores):`);
          for (const c of cpus) {
            const pct = c.maxFreqMhz > 0 ? ((c.curFreqMhz / c.maxFreqMhz) * 100).toFixed(0) : "?";
            sections.push(`  cpu${c.cpu}: ${c.curFreqMhz.toFixed(0)} MHz / ${c.maxFreqMhz.toFixed(0)} MHz (${pct}%) [${c.governor}]`);
          }
        }

        // Read battery details from sysfs
        const battResult = await ctx.bridge.shell(
          "echo \"LEVEL:$(cat /sys/class/power_supply/battery/capacity 2>/dev/null)\" && " +
          "echo \"TEMP:$(cat /sys/class/power_supply/battery/temp 2>/dev/null)\" && " +
          "echo \"CURRENT:$(cat /sys/class/power_supply/battery/current_now 2>/dev/null)\" && " +
          "echo \"VOLTAGE:$(cat /sys/class/power_supply/battery/voltage_now 2>/dev/null)\" && " +
          "echo \"STATUS:$(cat /sys/class/power_supply/battery/status 2>/dev/null)\"",
          { device: serial, timeout: 10000, ignoreExitCode: true }
        );

        const battParsed: Record<string, string> = {};
        for (const line of battResult.stdout.split("\n")) {
          const sep = line.indexOf(":");
          if (sep > 0) battParsed[line.substring(0, sep)] = line.substring(sep + 1).trim();
        }

        const battLevel = parseInt(battParsed["LEVEL"] ?? "0", 10);
        const battTemp = parseInt(battParsed["TEMP"] ?? "0", 10) / 10;
        const battCurrent = parseInt(battParsed["CURRENT"] ?? "0", 10) / 1000; // μA to mA
        const battVoltage = parseInt(battParsed["VOLTAGE"] ?? "0", 10) / 1000000; // μV to V
        const battStatus = battParsed["STATUS"] ?? "unknown";

        sections.push(`\nBattery:`);
        sections.push(`  Level: ${battLevel}%`);
        sections.push(`  Temperature: ${battTemp.toFixed(1)}°C${battTemp > 40 ? " ⚠ WARM" : ""}`);
        sections.push(`  Current: ${battCurrent.toFixed(0)} mA${battCurrent < 0 ? " (discharging)" : " (charging)"}`);
        sections.push(`  Voltage: ${battVoltage.toFixed(2)} V`);
        sections.push(`  Status: ${battStatus}`);
        if (battCurrent < 0 && battVoltage > 0) {
          const powerW = Math.abs(battCurrent / 1000) * battVoltage;
          sections.push(`  Power draw: ${(powerW * 1000).toFixed(0)} mW (${powerW.toFixed(2)} W)`);
        }

        // Cooling devices
        const coolingResult = await ctx.bridge.shell(
          "for c in /sys/class/thermal/cooling_device*; do " +
          "echo \"COOL:$(basename $c):$(cat $c/type 2>/dev/null):$(cat $c/cur_state 2>/dev/null):$(cat $c/max_state 2>/dev/null)\"; " +
          "done 2>/dev/null | head -20",
          { device: serial, timeout: 10000, ignoreExitCode: true }
        );

        const coolingLines = coolingResult.stdout.split("\n").filter((l) => l.startsWith("COOL:"));
        if (coolingLines.length > 0) {
          sections.push(`\nCooling devices (${coolingLines.length}):`);
          for (const line of coolingLines) {
            const parts = line.split(":");
            if (parts.length >= 5) {
              const active = parts[3] !== "0" ? " ACTIVE" : "";
              sections.push(`  ${parts[1]} [${parts[2]}]: state ${parts[3]}/${parts[4]}${active}`);
            }
          }
        }

        // Save if requested
        if (save) {
          const snapshot: ThermalSnapshot = {
            timestamp: new Date().toISOString(),
            device: serial,
            zones,
            cpus,
            battery: {
              level: battLevel,
              temperature: battTemp,
              currentNow: battCurrent,
              voltageNow: battVoltage,
              status: battStatus,
            },
          };

          const dir = getThermalDir(ctx.config.tempDir);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
          const safeDevice = serial.replace(/[^a-zA-Z0-9_-]/g, "_");
          const filePath = join(dir, `${safeDevice}_${safeLabel}_${Date.now()}.json`);
          writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
          sections.push(`\nSaved: ${filePath}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_thermal_compare",
    "Compare current thermal/power state against a saved baseline. Reports temperature changes per zone, CPU frequency shifts, and battery drain rate differences.",
    {
      baselinePath: z.string().optional().describe("Path to baseline JSON. If omitted, uses the most recent baseline for the device."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ baselinePath, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Find baseline
        let savedPath = baselinePath;
        if (!savedPath) {
          const dir = getThermalDir(ctx.config.tempDir);
          if (!existsSync(dir)) {
            return { content: [{ type: "text", text: "No thermal baselines saved. Use adb_thermal_snapshot with save=true first." }], isError: true };
          }
          const safeDevice = serial.replace(/[^a-zA-Z0-9_-]/g, "_");
          const files = readdirSync(dir)
            .filter((f) => f.startsWith(safeDevice) && f.endsWith(".json"))
            .sort()
            .reverse();
          if (files.length === 0) {
            return { content: [{ type: "text", text: `No thermal baselines for device ${serial}.` }], isError: true };
          }
          savedPath = join(dir, files[0]);
        }

        if (!existsSync(savedPath)) {
          return { content: [{ type: "text", text: `Baseline not found: ${savedPath}` }], isError: true };
        }

        let baseline: ThermalSnapshot;
        try {
          baseline = JSON.parse(readFileSync(savedPath, "utf-8"));
        } catch {
          return { content: [{ type: "text", text: `Corrupt baseline file: ${savedPath}` }], isError: true };
        }

        // Capture current state (reuse the snapshot logic inline)
        const thermalResult = await ctx.bridge.shell(
          "for z in /sys/class/thermal/thermal_zone*; do " +
          "echo \"ZONE:$(basename $z):$(cat $z/type 2>/dev/null):$(cat $z/temp 2>/dev/null)\"; " +
          "done 2>/dev/null",
          { device: serial, timeout: 10000, ignoreExitCode: true }
        );

        const currentZones: Array<{ name: string; type: string; temp: number }> = [];
        for (const line of thermalResult.stdout.split("\n")) {
          const match = line.match(/^ZONE:(\S+):(\S*):(\d+)/);
          if (match) currentZones.push({ name: match[1], type: match[2] || "unknown", temp: parseInt(match[3], 10) / 1000 });
        }

        const battResult = await ctx.bridge.shell(
          "cat /sys/class/power_supply/battery/temp 2>/dev/null && echo '|' && " +
          "cat /sys/class/power_supply/battery/current_now 2>/dev/null",
          { device: serial, timeout: 5000, ignoreExitCode: true }
        );
        const battParts = battResult.stdout.split("|").map((s) => s.trim());
        const currentBattTemp = parseInt(battParts[0] ?? "0", 10) / 10;
        const currentBattCurrent = parseInt(battParts[1] ?? "0", 10) / 1000;

        const sections: string[] = [];
        sections.push("=== Thermal Comparison ===");
        sections.push(`Baseline: ${baseline.timestamp.substring(0, 19)}`);
        sections.push(`Current: ${new Date().toISOString().substring(0, 19)}\n`);

        // Compare zones
        let zonesHotter = 0;
        let zonesCooler = 0;
        if (currentZones.length > 0 && baseline.zones.length > 0) {
          sections.push("Thermal zones:");
          const baselineMap = new Map(baseline.zones.map((z) => [z.name, z.temp]));
          for (const cz of currentZones) {
            const bTemp = baselineMap.get(cz.name);
            if (bTemp !== undefined) {
              const diff = cz.temp - bTemp;
              const marker = diff > 3 ? " ⚠ HOTTER" : diff < -3 ? " COOLER" : "";
              if (diff > 0) zonesHotter++;
              if (diff < 0) zonesCooler++;
              sections.push(`  ${cz.name}: ${bTemp.toFixed(1)}°C → ${cz.temp.toFixed(1)}°C (${diff > 0 ? "+" : ""}${diff.toFixed(1)}°C)${marker}`);
            }
          }
        }

        // Compare battery
        sections.push("\nBattery:");
        const baseBattTemp = baseline.battery.temperature ?? 0;
        const baseBattCurrent = baseline.battery.currentNow ?? 0;
        const battTempDiff = currentBattTemp - baseBattTemp;
        sections.push(`  Temperature: ${baseBattTemp.toFixed(1)}°C → ${currentBattTemp.toFixed(1)}°C (${battTempDiff > 0 ? "+" : ""}${battTempDiff.toFixed(1)}°C)`);
        const currentDiff = currentBattCurrent - baseBattCurrent;
        sections.push(`  Current draw: ${baseBattCurrent.toFixed(0)} mA → ${currentBattCurrent.toFixed(0)} mA (${currentDiff > 0 ? "+" : ""}${currentDiff.toFixed(0)} mA)`);

        // Summary
        sections.push("\nSummary:");
        sections.push(`  Zones hotter: ${zonesHotter}, cooler: ${zonesCooler}`);
        if (zonesHotter > zonesCooler + 2) {
          sections.push("  ⚠ Device is running significantly hotter than baseline.");
        } else if (zonesCooler > zonesHotter + 2) {
          sections.push("  ✓ Device is running cooler than baseline.");
        } else {
          sections.push("  ✓ Thermal state is similar to baseline.");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_battery_drain",
    "Measure battery drain rate over a specified duration. Takes initial and final readings and calculates mA draw, mW power consumption, and estimated percentage per hour. Useful for profiling power impact of specific operations.",
    {
      durationMs: z.number().min(3000).max(60000).optional().default(10000).describe("Measurement duration in ms (3s-60s, default 10s)"),
      packageName: z.string().optional().describe("If specified, show battery stats for this package (requires root for detailed stats)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ durationMs, packageName, device }) => {
      try {
        if (packageName) {
          const pkgErr = validateShellArg(packageName, "packageName");
          if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const duration = Math.min(Math.max(durationMs, 3000), 60000); // 3-60 seconds

        const readBattery = async (): Promise<{ level: number; temp: number; current: number; voltage: number }> => {
          const result = await ctx.bridge.shell(
            "cat /sys/class/power_supply/battery/capacity 2>/dev/null && echo '|' && " +
            "cat /sys/class/power_supply/battery/temp 2>/dev/null && echo '|' && " +
            "cat /sys/class/power_supply/battery/current_now 2>/dev/null && echo '|' && " +
            "cat /sys/class/power_supply/battery/voltage_now 2>/dev/null",
            { device: serial, timeout: 5000, ignoreExitCode: true }
          );
          const parts = result.stdout.split("|").map((s) => parseInt(s.trim(), 10));
          return {
            level: parts[0] || 0,
            temp: (parts[1] || 0) / 10,
            current: (parts[2] || 0) / 1000, // μA → mA
            voltage: (parts[3] || 0) / 1000000, // μV → V
          };
        };

        // Initial reading
        const start = await readBattery();
        const startTime = Date.now();

        // Wait
        await new Promise((r) => setTimeout(r, duration));

        // Final reading
        const end = await readBattery();
        const elapsed = (Date.now() - startTime) / 1000;

        const sections: string[] = [];
        sections.push(`=== Battery Drain Measurement ===`);
        sections.push(`Duration: ${elapsed.toFixed(1)}s\n`);

        sections.push("Battery state:");
        sections.push(`  Level: ${start.level}% → ${end.level}%`);
        sections.push(`  Temperature: ${start.temp.toFixed(1)}°C → ${end.temp.toFixed(1)}°C`);

        // Average current draw
        const avgCurrent = (start.current + end.current) / 2;
        const avgVoltage = (start.voltage + end.voltage) / 2;
        sections.push(`\nPower consumption:`);
        sections.push(`  Average current: ${Math.abs(avgCurrent).toFixed(0)} mA${avgCurrent < 0 ? " (discharging)" : " (charging)"}`);
        sections.push(`  Average voltage: ${avgVoltage.toFixed(2)} V`);

        if (avgCurrent < 0 && avgVoltage > 0) {
          const powerMw = Math.abs(avgCurrent) * avgVoltage;
          sections.push(`  Power draw: ${powerMw.toFixed(0)} mW (${(powerMw / 1000).toFixed(2)} W)`);

          // Estimate drain per hour
          // Typical phone battery 3000-5000 mAh
          const drainPerHour = (Math.abs(avgCurrent) / 30); // rough % per hour assuming 3000mAh
          sections.push(`  Estimated drain: ~${drainPerHour.toFixed(1)}%/hour (assuming 3000mAh battery)`);
        }

        // Package-specific stats if requested
        if (packageName) {
          const statsResult = await ctx.bridge.shell(
            `dumpsys batterystats ${packageName} | grep -E 'Uid|Total|Screen|Wifi|Cell|Sensor|Wake' | head -20`,
            { device: serial, timeout: 10000, ignoreExitCode: true }
          );
          if (statsResult.stdout.trim()) {
            sections.push(`\nBattery stats for ${packageName}:`);
            for (const line of statsResult.stdout.trim().split("\n").slice(0, 15)) {
              sections.push(`  ${line.trim()}`);
            }
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
