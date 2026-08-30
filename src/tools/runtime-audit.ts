// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Unified, read-only DeepADB runtime readiness audit. */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { MODEM_PATHS, detectChipsetFamily } from "../middleware/chipset.js";
import { isOnDevice } from "../config/config.js";
import { shellQuote } from "../middleware/sanitize.js";

interface Capability {
  name: string;
  available: boolean;
}

/** Build a safe probe that accepts modem character devices only. */
export function buildModemCharacterDeviceProbe(paths: string[]): string {
  return paths.map((path) => `test -c ${shellQuote(path)} && echo ${shellQuote(path)}`).join("; ");
}

function parseCapabilities(output: string, names: string[]): Capability[] {
  const found = new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return names.map((name) => ({ name, available: found.has(name) }));
}

export function registerRuntimeAuditTools(ctx: ToolContext): void {
  ctx.server.tool(
    "adb_runtime_audit",
    "Run a unified, read-only DeepADB readiness audit covering transport, authorization, Android state, root, SELinux, storage, common binaries, UI/network support, SQLite, chipset/modem nodes, and Wear prerequisites. Makes no device changes.",
    {
      device: z.string().optional().describe("Device serial to audit"),
    },
    async ({ device }) => {
      try {
        const devices = await ctx.deviceManager.listDevices();
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const family = detectChipsetFamily(props);
        const capabilityNames = ["am", "cmd", "dumpsys", "getenforce", "ip", "logcat", "pm", "settings", "sqlite3", "uiautomator"];

        const [version, identity, rootIdentity, selinux, boot, storage, capabilities, routes, battery, gms, characteristics] = await Promise.all([
          ctx.bridge.version().catch((error) => `unavailable: ${error instanceof Error ? error.message : error}`),
          ctx.bridge.shell("id", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("su -c id", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("getenforce", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("getprop sys.boot_completed", { device: serial, timeout: 5000, ignoreExitCode: true }),
          ctx.bridge.shell("df -k /data /sdcard", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell(`for c in ${capabilityNames.join(" ")}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done`, {
            device: serial, timeout: 10000, ignoreExitCode: true,
          }),
          ctx.bridge.shell("ip route show", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys battery", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("pm path com.google.android.gms", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("getprop ro.build.characteristics", { device: serial, timeout: 5000, ignoreExitCode: true }),
        ]);

        const rootAvailable = /uid=0\b/.test(rootIdentity.stdout);
        const modemPaths = MODEM_PATHS[family] ?? MODEM_PATHS.generic ?? [];
        let existingModemPaths: string[] = [];
        if (rootAvailable && modemPaths.length > 0) {
          const probe = buildModemCharacterDeviceProbe(modemPaths);
          const result = await ctx.bridge.rootShell(probe, { device: serial, timeout: 10000, ignoreExitCode: true });
          existingModemPaths = result.stdout.split(/\r?\n/).map((line) => line.trim())
            .filter((line) => modemPaths.includes(line));
        }

        const parsedCapabilities = parseCapabilities(capabilities.stdout, capabilityNames);
        const has = (name: string) => parsedCapabilities.some((item) => item.name === name && item.available);
        let hostSqlite = false;
        if (!isOnDevice()) {
          try {
            const sqlite = await import("node:sqlite");
            hostSqlite = typeof sqlite.DatabaseSync === "function";
          } catch { /* unavailable on early Node 22 builds */ }
        }
        const bootComplete = boot.stdout.trim() === "1";
        const routeAvailable = routes.stdout.trim().length > 0;
        const isWear = characteristics.stdout.toLowerCase().split(",").map((value) => value.trim()).includes("watch");

        const readiness = [
          ["Core ADB", bootComplete && /uid=\d+/.test(identity.stdout), bootComplete ? "transport and Android userspace responsive" : "device is not fully booted"],
          ["UI automation", has("uiautomator") && has("am"), has("uiautomator") ? "uiautomator available" : "uiautomator missing"],
          ["Network diagnostics", has("ip") && routeAvailable, routeAvailable ? "route table readable" : "no routes reported"],
          ["SQLite inspection", has("sqlite3") || hostSqlite, has("sqlite3") ? "device sqlite3 available" : hostSqlite ? "host read-only snapshot fallback available" : "no SQLite execution backend"],
          ["Root diagnostics", rootAvailable, rootAvailable ? "su returns uid=0" : "root unavailable"],
          ["Modem / AT", rootAvailable && existingModemPaths.length > 0, existingModemPaths.length ? `${existingModemPaths.length} ${family} node(s) visible` : `no visible ${family} modem node`],
          ["Wear Data Layer", gms.stdout.includes("package:"), `${isWear ? "watch" : "handheld"}; Google Play services ${gms.stdout.includes("package:") ? "present" : "missing"}`],
        ] as const;

        const sections = [
          "=== DeepADB Unified Runtime Audit (read-only) ===",
          `Mode: ${isOnDevice() ? "on-device LocalBridge" : "host ADB"}`,
          `ADB: ${version.split(/\r?\n/)[0]}`,
          `Connected devices: ${devices.length} (${devices.filter((item) => item.state === "device").length} online)`,
          `Target: ${props["ro.product.model"] ?? resolved.model ?? "unknown"} / Android ${props["ro.build.version.release"] ?? "unknown"} (SDK ${props["ro.build.version.sdk"] ?? "unknown"})`,
          `Boot completed: ${bootComplete ? "yes" : "no"}`,
          `Shell identity: ${identity.stdout.trim() || "unavailable"}`,
          `Root: ${rootAvailable ? "available" : "not available"}`,
          `SELinux: ${selinux.stdout.trim() || "unknown"}`,
          `Chipset family: ${family}`,
          "",
          "── Readiness matrix ──",
          ...readiness.map(([name, ready, detail]) => `${ready ? "✓" : "○"} ${name}: ${detail}`),
          "",
          "── Command capabilities ──",
          parsedCapabilities.map((item) => `${item.available ? "✓" : "○"} ${item.name}`).join("\n"),
          "",
          "── Storage snapshot ──",
          storage.stdout.trim() || "(unavailable)",
          "",
          "── Battery snapshot ──",
          battery.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(level|status|health|temperature|powered):/i.test(line)).join("\n") || "(unavailable)",
          "",
          "No files, settings, packages, routes, or device state were modified.",
        ];

        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n"), 40000) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    },
  );
}
