/**
 * OTA Update Monitoring — Track system updates across sessions.
 *
 * Captures a comprehensive system fingerprint (build ID, security patch,
 * bootloader version, kernel, baseband firmware) and compares against
 * previously saved state to detect when a device has been updated.
 * 
 * Useful for: detecting post-OTA behavioral changes in apps under test,
 * verifying security patch currency, and triggering automatic re-baselining
 * of performance and screenshots after updates.
 *
 * Fingerprints are saved as JSON in {tempDir}/ota-fingerprints/.
 */

import { z } from "zod";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

interface SystemFingerprint {
  timestamp: string;
  device: string;
  model: string;
  buildFingerprint: string;
  buildId: string;
  buildType: string;
  androidVersion: string;
  sdkLevel: string;
  securityPatch: string;
  bootloaderVersion: string;
  basebandVersion: string;
  kernelVersion: string;
  buildDate: string;
  incrementalBuild: string;
  abUpdatePartition: string;
}

function getFingerprintDir(tempDir: string): string {
  return join(tempDir, "ota-fingerprints");
}

async function captureFingerprint(ctx: ToolContext, serial: string): Promise<SystemFingerprint> {
  const props = await ctx.deviceManager.getDeviceProps(serial);

  // Get kernel version separately (not in getprop)
  const kernelResult = await ctx.bridge.shell("uname -r", {
    device: serial, ignoreExitCode: true,
  });

  // Check A/B partition slot
  const slotResult = await ctx.bridge.shell("getprop ro.boot.slot_suffix", {
    device: serial, ignoreExitCode: true,
  });

  return {
    timestamp: new Date().toISOString(),
    device: serial,
    model: props["ro.product.model"] ?? "unknown",
    buildFingerprint: props["ro.build.fingerprint"] ?? "unknown",
    buildId: props["ro.build.display.id"] ?? "unknown",
    buildType: props["ro.build.type"] ?? "unknown",
    androidVersion: props["ro.build.version.release"] ?? "unknown",
    sdkLevel: props["ro.build.version.sdk"] ?? "unknown",
    securityPatch: props["ro.build.version.security_patch"] ?? "unknown",
    bootloaderVersion: props["ro.bootimage.build.fingerprint"] ?? props["ro.bootloader"] ?? "unknown",
    basebandVersion: props["gsm.version.baseband"] ?? "unknown",
    kernelVersion: kernelResult.stdout.trim() || "unknown",
    buildDate: props["ro.build.date"] ?? "unknown",
    incrementalBuild: props["ro.build.version.incremental"] ?? "unknown",
    abUpdatePartition: slotResult.stdout.trim() || "none",
  };
}

function compareFingerprints(saved: SystemFingerprint, current: SystemFingerprint): { changed: string[]; unchanged: string[] } {
  const fields: Array<{ key: keyof SystemFingerprint; label: string }> = [
    { key: "buildFingerprint", label: "Build Fingerprint" },
    { key: "buildId", label: "Build ID" },
    { key: "androidVersion", label: "Android Version" },
    { key: "sdkLevel", label: "SDK Level" },
    { key: "securityPatch", label: "Security Patch" },
    { key: "bootloaderVersion", label: "Bootloader" },
    { key: "basebandVersion", label: "Baseband Firmware" },
    { key: "kernelVersion", label: "Kernel" },
    { key: "incrementalBuild", label: "Incremental Build" },
    { key: "abUpdatePartition", label: "A/B Slot" },
  ];

  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const { key, label } of fields) {
    const oldVal = saved[key];
    const newVal = current[key];
    if (oldVal !== newVal) {
      changed.push(`${label}: "${oldVal}" → "${newVal}"`);
    } else {
      unchanged.push(`${label}: ${newVal}`);
    }
  }

  return { changed, unchanged };
}

export function registerOtaMonitorTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_ota_fingerprint",
    "Capture and save the current system fingerprint: build ID, Android version, security patch, bootloader, baseband firmware, kernel version, and A/B partition slot. Saves to a timestamped JSON file for later comparison.",
    {
      label: z.string().optional().default("current").describe("Label for this fingerprint (e.g., 'pre-update', 'post-ota')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ label, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const fp = await captureFingerprint(ctx, serial);

        const dir = getFingerprintDir(ctx.config.tempDir);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
        const safeDevice = serial.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `${safeDevice}_${safeLabel}_${Date.now()}.json`;
        const filePath = join(dir, filename);
        writeFileSync(filePath, JSON.stringify(fp, null, 2));

        const summary: string[] = [];
        summary.push(`System fingerprint captured: ${label}`);
        summary.push(`Device: ${fp.model} (${serial})`);
        summary.push(`Android: ${fp.androidVersion} (SDK ${fp.sdkLevel})`);
        summary.push(`Build: ${fp.buildId}`);
        summary.push(`Security Patch: ${fp.securityPatch}`);
        summary.push(`Baseband: ${fp.basebandVersion}`);
        summary.push(`Bootloader: ${fp.bootloaderVersion}`);
        summary.push(`Kernel: ${fp.kernelVersion}`);
        summary.push(`A/B Slot: ${fp.abUpdatePartition}`);
        summary.push(`Saved: ${filePath}`);

        return { content: [{ type: "text", text: summary.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ota_check",
    "Compare the current system state against a saved fingerprint. Detects OTA updates by identifying changes in build ID, security patch, baseband firmware, bootloader, or kernel version.",
    {
      fingerprintPath: z.string().optional().describe("Path to saved fingerprint JSON. If omitted, compares against the most recent fingerprint for this device."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ fingerprintPath, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Find the fingerprint to compare against
        let savedPath = fingerprintPath;
        if (!savedPath) {
          const dir = getFingerprintDir(ctx.config.tempDir);
          if (!existsSync(dir)) {
            return { content: [{ type: "text", text: "No saved fingerprints. Use adb_ota_fingerprint to capture one first." }], isError: true };
          }
          const safeDevice = serial.replace(/[^a-zA-Z0-9_-]/g, "_");
          const files = readdirSync(dir)
            .filter((f) => f.startsWith(safeDevice) && f.endsWith(".json"))
            .sort()
            .reverse();
          if (files.length === 0) {
            return { content: [{ type: "text", text: `No saved fingerprints for device ${serial}. Use adb_ota_fingerprint first.` }], isError: true };
          }
          savedPath = join(dir, files[0]);
        }

        if (!existsSync(savedPath)) {
          return { content: [{ type: "text", text: `Fingerprint file not found: ${savedPath}` }], isError: true };
        }

        const saved: SystemFingerprint = JSON.parse(readFileSync(savedPath, "utf-8"));
        const current = await captureFingerprint(ctx, serial);
        const { changed, unchanged } = compareFingerprints(saved, current);

        const sections: string[] = [];
        sections.push(`=== OTA Update Check ===`);
        sections.push(`Saved: ${saved.timestamp} (${saved.buildId})`);
        sections.push(`Current: ${current.buildId}`);
        sections.push(`Device: ${current.model} (${serial})\n`);

        if (changed.length === 0) {
          sections.push("Result: ✓ NO UPDATE DETECTED — system state unchanged.\n");
          sections.push(`Unchanged fields (${unchanged.length}):`);
          for (const u of unchanged) sections.push(`  ✓ ${u}`);
        } else {
          sections.push(`Result: ⚠ UPDATE DETECTED — ${changed.length} field(s) changed.\n`);
          sections.push("Changed:");
          for (const c of changed) sections.push(`  ✗ ${c}`);
          if (unchanged.length > 0) {
            sections.push("\nUnchanged:");
            for (const u of unchanged) sections.push(`  ✓ ${u}`);
          }
          sections.push("\nRecommendation: Re-baseline performance (adb_regression_baseline) and screenshots (adb_screenshot_baseline) after an OTA update.");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ota_history",
    "List all saved system fingerprints for a device, showing version progression over time. Highlights changes between consecutive snapshots.",
    {
      device: z.string().optional().describe("Device serial (filters to this device). Omit for all devices."),
    },
    async ({ device }) => {
      try {
        const dir = getFingerprintDir(ctx.config.tempDir);
        if (!existsSync(dir)) {
          return { content: [{ type: "text", text: "No fingerprint history. Use adb_ota_fingerprint to start tracking." }] };
        }

        let deviceFilter = "";
        if (device) {
          const resolved = await ctx.deviceManager.resolveDevice(device);
          deviceFilter = resolved.serial.replace(/[^a-zA-Z0-9_-]/g, "_");
        }

        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".json") && (!deviceFilter || f.startsWith(deviceFilter)))
          .sort();

        if (files.length === 0) {
          return { content: [{ type: "text", text: device ? `No fingerprints for device ${device}.` : "No fingerprints saved." }] };
        }

        const fingerprints: SystemFingerprint[] = [];
        for (const file of files) {
          try {
            fingerprints.push(JSON.parse(readFileSync(join(dir, file), "utf-8")));
          } catch { /* skip corrupt */ }
        }

        const lines: string[] = [`${fingerprints.length} fingerprint(s):\n`];

        for (let i = 0; i < fingerprints.length; i++) {
          const fp = fingerprints[i];
          const changeMarker = i > 0 && fp.buildFingerprint !== fingerprints[i - 1].buildFingerprint
            ? " ⚠ UPDATE"
            : "";
          lines.push(`[${i + 1}] ${fp.timestamp.substring(0, 19)} | ${fp.model} | Android ${fp.androidVersion} | ${fp.buildId} | Patch: ${fp.securityPatch}${changeMarker}`);
        }

        lines.push(`\nDirectory: ${dir}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
