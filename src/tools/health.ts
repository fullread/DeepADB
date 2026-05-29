// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Health Check Tools — Validate the ADB chain and diagnose connection issues.
 * Runs through: ADB binary → ADB server → device connection → authorization.
 */

import { z } from "zod";
import { existsSync } from "fs";
import { shellQuote } from "../middleware/sanitize.js";
import { ToolContext } from "../tool-context.js";
import { isOnDevice } from "../config/config.js";

export function registerHealthTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_health_check",
    "Run a comprehensive health check of the ADB toolchain. Validates: ADB binary, server, device connection, authorization, and root access.",
    { device: z.string().optional().describe("Device serial to check (optional)") },
    async ({ device }) => {
      const checks: string[] = [];
      let allPassed = true;

      // 1. ADB binary exists (not applicable in on-device mode)
      if (isOnDevice()) {
        checks.push("✓ On-device mode: no ADB binary needed (LocalBridge)");
      } else {
        const adbPath = ctx.config.adbPath;
        if (adbPath === "adb") {
          checks.push("✓ ADB binary: using PATH lookup");
        } else if (existsSync(adbPath)) {
          checks.push(`✓ ADB binary: found at ${adbPath}`);
        } else {
          checks.push(`✗ ADB binary: NOT FOUND at ${adbPath}`);
          allPassed = false;
        }
      }

      // 2. ADB version / server reachable
      try {
        const version = await ctx.bridge.version();
        const firstLine = version.split("\n")[0] ?? version;
        checks.push(`✓ ADB server: ${firstLine}`);
      } catch (error) {
        checks.push(`✗ ADB server: unreachable — ${error instanceof Error ? error.message : error}`);
        checks.push("\n--- Health check aborted: ADB server must be running ---");
        return { content: [{ type: "text", text: checks.join("\n") }], isError: true };
      }

      // 3. Device discovery
      try {
        const devices = await ctx.deviceManager.listDevices();
        const online = devices.filter((d) => d.state === "device");
        const unauthorized = devices.filter((d) => d.state === "unauthorized");
        const offline = devices.filter((d) => d.state === "offline");

        checks.push(`✓ Devices found: ${devices.length} total (${online.length} online, ${unauthorized.length} unauthorized, ${offline.length} offline)`);

        for (const d of devices) {
          const label = d.model ? `${d.serial} (${d.model})` : d.serial;
          checks.push(`  ${d.state === "device" ? "✓" : "✗"} ${label}: ${d.state}`);
        }

        if (online.length === 0) {
          allPassed = false;
          if (unauthorized.length > 0) {
            checks.push("  → Action: Accept the USB debugging prompt on the device screen");
          } else {
            checks.push("  → Action: Connect a device via USB with USB debugging enabled");
          }
        }
      } catch (error) {
        checks.push(`✗ Device discovery failed: ${error instanceof Error ? error.message : error}`);
        allPassed = false;
      }

      // 4. Target device deep check (if we have one)
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        checks.push(`\n--- Target device: ${resolved.serial} ---`);

        // OS version
        const verResult = await ctx.bridge.shell("getprop ro.build.version.release", { device: resolved.serial });
        const sdkResult = await ctx.bridge.shell("getprop ro.build.version.sdk", { device: resolved.serial });
        checks.push(`✓ Android ${verResult.stdout.trim()} (SDK ${sdkResult.stdout.trim()})`);

        // Root check
        try {
          const rootResult = await ctx.bridge.shell("su -c id", {
            device: resolved.serial, timeout: 5000, ignoreExitCode: true,
          });
          if (rootResult.stdout.includes("uid=0")) {
            checks.push("✓ Root access: available");
          } else {
            checks.push("○ Root access: not available (non-critical)");
          }
        } catch {
          checks.push("○ Root access: not available (non-critical)");
        }

        // Temp dir writable
        // AG1 fix: include PID + timestamp + random suffix in the probe filename
        // so two concurrent health checks (from different DeepADB processes
        // sharing the same device) don't race on a fixed path. The race is
        // benign — both succeed since touch+rm is idempotent — but if one
        // process's rm runs between the other's touch and rm, the OK echo
        // could fire incorrectly. Using a per-invocation unique name eliminates
        // the cross-process interleaving entirely.
        const probeId = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const probePath = `/sdcard/.DA_health_check_${probeId}`;
        const tempCheck = await ctx.bridge.shell(`touch ${shellQuote(probePath)} && rm ${shellQuote(probePath)} && echo OK`, {
          device: resolved.serial, ignoreExitCode: true,
        });
        if (tempCheck.stdout.includes("OK")) {
          checks.push("✓ Device storage: writable");
        } else {
          checks.push("✗ Device storage: /sdcard not writable");
          allPassed = false;
        }

      } catch {
        // No target device — already reported above
        if (!device) {
          checks.push("\n○ No target device to deep-check (expected if no device connected)");
        }
      }

      // Summary
      checks.push(`\n${allPassed ? "=== ALL CHECKS PASSED ===" : "=== ISSUES FOUND — see above ==="}`);
      return { content: [{ type: "text", text: checks.join("\n") }] };
    }
  );
}
