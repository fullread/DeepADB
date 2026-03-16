/**
 * Snapshot Tools — Save and compare device state for reproducible testing.
 * 
 * Captures a comprehensive device state snapshot (packages, settings, properties)
 * and can compare the current state against a saved snapshot to detect drift.
 */

import { z } from "zod";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArgs } from "../middleware/sanitize.js";

interface DeviceSnapshot {
  timestamp: string;
  device: string;
  model: string;
  androidVersion: string;
  sdkLevel: string;
  packages: string[];
  settings: { global: Record<string, string>; secure: Record<string, string>; system: Record<string, string> };
  properties: Record<string, string>;
}

export function registerSnapshotTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_snapshot_capture",
    "Capture a comprehensive device state snapshot: installed packages, key settings, and system properties. Saves to a JSON file.",
    {
      name: z.string().optional().describe("Snapshot name (default: auto-generated timestamp)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ name, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Gather state in parallel
        const [pkgResult, globalResult, secureResult, systemResult, propResult] = await Promise.allSettled([
          ctx.bridge.shell("pm list packages -3", { device: serial }),
          ctx.bridge.shell("settings list global", { device: serial }),
          ctx.bridge.shell("settings list secure", { device: serial }),
          ctx.bridge.shell("settings list system", { device: serial }),
          ctx.bridge.shell("getprop", { device: serial }),
        ]);

        const parsePackages = (r: PromiseSettledResult<{ stdout: string }>): string[] => {
          if (r.status !== "fulfilled") return [];
          return r.value.stdout.split("\n")
            .map((l) => l.replace("package:", "").trim())
            .filter((l) => l.length > 0).sort();
        };

        const parseSettings = (r: PromiseSettledResult<{ stdout: string }>): Record<string, string> => {
          if (r.status !== "fulfilled") return {};
          const map: Record<string, string> = {};
          for (const line of r.value.stdout.split("\n")) {
            const idx = line.indexOf("=");
            if (idx > 0) map[line.substring(0, idx)] = line.substring(idx + 1).trim();
          }
          return map;
        };

        const parseProps = (r: PromiseSettledResult<{ stdout: string }>): Record<string, string> => {
          if (r.status !== "fulfilled") return {};
          const map: Record<string, string> = {};
          for (const line of r.value.stdout.split("\n")) {
            const match = line.trim().match(/^\[(.+?)\]: \[(.*)?\]$/);
            if (match) map[match[1]] = match[2] ?? "";
          }
          return map;
        };

        const props = parseProps(propResult);
        const snapshot: DeviceSnapshot = {
          timestamp: new Date().toISOString(),
          device: serial,
          model: props["ro.product.model"] ?? "unknown",
          androidVersion: props["ro.build.version.release"] ?? "unknown",
          sdkLevel: props["ro.build.version.sdk"] ?? "unknown",
          packages: parsePackages(pkgResult),
          settings: {
            global: parseSettings(globalResult),
            secure: parseSettings(secureResult),
            system: parseSettings(systemResult),
          },
          properties: props,
        };

        const safeName = (name ?? `snapshot_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = join(ctx.config.tempDir, "snapshots", `${safeName}.json`);
        const dir = join(ctx.config.tempDir, "snapshots");
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(filePath, JSON.stringify(snapshot, null, 2));

        return {
          content: [{
            type: "text",
            text: `Snapshot captured: ${filePath}\nDevice: ${snapshot.model} (Android ${snapshot.androidVersion})\nPackages: ${snapshot.packages.length}\nSettings: ${Object.keys(snapshot.settings.global).length} global, ${Object.keys(snapshot.settings.secure).length} secure, ${Object.keys(snapshot.settings.system).length} system\nProperties: ${Object.keys(snapshot.properties).length}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_snapshot_compare",
    "Compare current device state against a saved snapshot. Shows added/removed packages, changed settings, and property differences.",
    {
      snapshotPath: z.string().describe("Path to the saved snapshot JSON file"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ snapshotPath, device }) => {
      try {
        if (!existsSync(snapshotPath)) {
          return { content: [{ type: "text", text: `Snapshot file not found: ${snapshotPath}` }], isError: true };
        }
        const saved: DeviceSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Get current packages
        const pkgResult = await ctx.bridge.shell("pm list packages -3", { device: serial });
        const currentPkgs = pkgResult.stdout.split("\n")
          .map((l) => l.replace("package:", "").trim())
          .filter((l) => l.length > 0).sort();

        const added = currentPkgs.filter((p) => !saved.packages.includes(p));
        const removed = saved.packages.filter((p) => !currentPkgs.includes(p));

        // Compare key settings
        const settingsChanges: string[] = [];
        for (const ns of ["global", "secure"] as const) {
          const savedNs = saved.settings[ns];
          const currentResult = await ctx.bridge.shell(`settings list ${ns}`, { device: serial });
          const currentNs: Record<string, string> = {};
          for (const line of currentResult.stdout.split("\n")) {
            const idx = line.indexOf("=");
            if (idx > 0) currentNs[line.substring(0, idx)] = line.substring(idx + 1).trim();
          }
          for (const [key, val] of Object.entries(savedNs)) {
            if (currentNs[key] !== undefined && currentNs[key] !== val) {
              settingsChanges.push(`${ns}/${key}: "${val}" → "${currentNs[key]}"`);
            }
          }
        }

        const sections: string[] = [];
        sections.push(`Comparing against: ${saved.timestamp}`);
        sections.push(`Snapshot device: ${saved.model} (Android ${saved.androidVersion})`);

        if (added.length === 0 && removed.length === 0 && settingsChanges.length === 0) {
          sections.push("\nNo differences detected.");
        } else {
          if (added.length > 0) sections.push(`\nPackages added (+${added.length}):\n  ${added.join("\n  ")}`);
          if (removed.length > 0) sections.push(`\nPackages removed (-${removed.length}):\n  ${removed.join("\n  ")}`);
          if (settingsChanges.length > 0) sections.push(`\nSettings changed (${settingsChanges.length}):\n  ${settingsChanges.join("\n  ")}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_snapshot_restore_settings",
    "Restore settings from a saved snapshot to the current device. Only restores global and secure settings — does not install/uninstall packages.",
    {
      snapshotPath: z.string().describe("Path to the saved snapshot JSON file"),
      namespace: z.enum(["global", "secure", "both"]).optional().default("both")
        .describe("Which settings namespace to restore"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ snapshotPath, namespace, device }) => {
      try {
        if (!existsSync(snapshotPath)) {
          return { content: [{ type: "text", text: `Snapshot file not found: ${snapshotPath}` }], isError: true };
        }
        const saved: DeviceSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const namespaces = namespace === "both" ? ["global", "secure"] as const : [namespace] as const;
        let restored = 0;
        const errors: string[] = [];

        for (const ns of namespaces) {
          const savedSettings = saved.settings[ns];
          for (const [key, value] of Object.entries(savedSettings)) {
            try {
              // Validate deserialized JSON values before shell interpolation
              const argErr = validateShellArgs([[key, "setting key"], [value, "setting value"]]);
              if (argErr) {
                errors.push(`${ns}/${key}: skipped — ${argErr}`);
                continue;
              }
              await ctx.bridge.shell(`settings put ${ns} ${key} ${value}`, { device: serial });
              restored++;
            } catch (err) {
              errors.push(`${ns}/${key}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }

        let output = `Restored ${restored} settings from snapshot (${saved.timestamp})`;
        if (errors.length > 0) {
          output += `\n${errors.length} errors:\n  ${errors.slice(0, 10).join("\n  ")}`;
          if (errors.length > 10) output += `\n  ... and ${errors.length - 10} more`;
        }
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
