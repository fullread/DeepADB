// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Unified, read-only DeepADB runtime readiness audit. */

import { z } from "zod";
import { BuiltinToolContext as ToolContext } from "../tool-context.js";
import { AdbError, type AdbResult } from "../bridge/adb-bridge.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { MODEM_PATHS, detectChipsetFamily } from "../middleware/chipset.js";
import { isOnDevice } from "../config/config.js";
import { shellQuote } from "../middleware/sanitize.js";

type Probe<T> = { ok: true; value: T } | { ok: false; reason: string };
type Readiness = "available" | "unavailable" | "inconclusive";

// Only server-owned messages belong in the probe-issues section. Raw bridge
// errors can contain command output, paths or control characters.
class ProbeError extends Error {}

async function probe<T>(run: () => Promise<T>): Promise<Probe<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) {
    let reason = "probe failed";
    if (error instanceof ProbeError) reason = error.message;
    else if (error instanceof AdbError) reason = commandFailure(error.result) ?? reason;
    return { ok: false, reason };
  }
}

function commandFailure(result: AdbResult): string | undefined {
  if (result.timedOut) return "command timed out";
  if (result.bufferExceeded) return "output exceeded the capture limit";
  if (result.exitCode !== 0) return `command exited with code ${result.exitCode}`;
  return undefined;
}

function commandOutput(result: AdbResult): string {
  const reason = commandFailure(result);
  if (reason) throw new ProbeError(reason);
  return result.stdout.trim();
}

function requireOutput(value: string): string {
  if (!value.trim()) throw new ProbeError("empty response");
  return value.trim();
}

function parseIdentity(value: string): string {
  if (!/^uid=\d+\b/.test(value)) throw new ProbeError("unrecognized identity response");
  return value;
}

function parseBoot(value: string): boolean {
  if (value !== "0" && value !== "1") throw new ProbeError("unrecognized boot state");
  return value === "1";
}

function status(value: Probe<boolean>): Readiness {
  return value.ok ? value.value ? "available" : "unavailable" : "inconclusive";
}

function allReady(...values: Readiness[]): Readiness {
  if (values.includes("unavailable")) return "unavailable";
  return values.includes("inconclusive") ? "inconclusive" : "available";
}

function show(value: Probe<string>): string {
  return value.ok ? value.value : `inconclusive (${value.reason})`;
}

/** Absence is a valid observation, not the exit status of the final test. */
export function buildModemCharacterDeviceProbe(paths: string[]): string {
  return [...paths.map((path) => `if test -c ${shellQuote(path)}; then echo ${shellQuote(path)}; fi`), ":"].join("; ");
}

export function registerRuntimeAuditTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    "adb_runtime_audit",
    {
      description: "Run a unified, read-only DeepADB readiness audit covering transport, authorization, Android state, root, SELinux, storage, common binaries, UI/network support, SQLite, chipset/modem nodes, and Wear prerequisites. Makes no device changes.",
      inputSchema: z.object({
        device: z.string().optional().describe("Device serial to audit"),
      }),
    },
    async ({ device }) => {
      try {
        // Target selection is mandatory. Never continue on another device when
        // the requested target is missing, unauthorized or ambiguous.
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const local = isOnDevice();
        const capabilityNames = ["am", "cmd", "dumpsys", "getenforce", "ip", "logcat", "pm", "settings", "sqlite3", "uiautomator"];
        const shell = async (command: string, timeout = 5000): Promise<string> => commandOutput(
          await ctx.bridge.shell(command, { device: serial, timeout, retries: 0, ignoreExitCode: true }),
        );

        // Each probe settles independently, including synchronous exceptions.
        // Explicit exit/timeout/buffer checks prevent partial stdout from being
        // mistaken for a successful capability check.
        const [devices, props, version, identity, rootIdentity, selinux, boot, storage, capabilities, routes, battery, gms, characteristics] = await Promise.all([
          probe(() => ctx.deviceManager.listDevices()),
          probe(async () => {
            const parsed = OutputProcessor.parseGetprop(await shell("getprop", 10000));
            if (!Object.keys(parsed).length) throw new ProbeError("empty or unrecognized properties");
            return parsed;
          }),
          probe(async () => requireOutput(await ctx.bridge.version())),
          probe(async () => parseIdentity(await shell("id"))),
          probe(async () => parseIdentity(await shell("su -c id"))),
          probe(async () => {
            const value = await shell("getenforce");
            if (!["Enforcing", "Permissive", "Disabled"].includes(value)) throw new ProbeError("unrecognized SELinux state");
            return value;
          }),
          probe(async () => parseBoot(await shell("getprop sys.boot_completed"))),
          probe(async () => requireOutput(await shell("df -k /data /sdcard", 10000))),
          probe(() => shell(`for c in ${capabilityNames.join(" ")}; do if command -v "$c" >/dev/null 2>&1; then printf '%s=1\\n' "$c"; else printf '%s=0\\n' "$c"; fi; done`, 10000)),
          probe(() => shell("ip route show", 10000)),
          probe(async () => {
            const value = (await shell("dumpsys battery", 10000)).split(/\r?\n/).map((line) => line.trim())
              .filter((line) => /^(level|status|health|temperature|(?:AC |USB |Wireless |Dock )?powered):/i.test(line)).join("\n");
            if (!value) throw new ProbeError("empty or unrecognized battery response");
            return value;
          }),
          probe(async () => {
            const value = await shell("pm path com.google.android.gms", 10000);
            if (value && !value.split(/\r?\n/).every((line) => /^package:\/.+/.test(line))) {
              throw new ProbeError("unrecognized package response");
            }
            return value.length > 0;
          }),
          probe(async () => requireOutput(await shell("getprop ro.build.characteristics"))),
        ]);

        // Explicit presence/absence for every command avoids inferring absence
        // from a failed or incomplete batch. Retain independently valid rows.
        const commandStates = new Map<string, Readiness>();
        const lines = capabilities.ok ? capabilities.value.split(/\r?\n/) : [];
        for (const name of capabilityNames) {
          const matches = lines.filter((line) => line.startsWith(`${name}=`));
          commandStates.set(name, matches.length === 1 && matches[0] === `${name}=1` ? "available"
            : matches.length === 1 && matches[0] === `${name}=0` ? "unavailable" : "inconclusive");
        }
        const has = (name: string): Readiness => commandStates.get(name) ?? "inconclusive";
        const root: Readiness = rootIdentity.ok ? /^uid=0\b/.test(rootIdentity.value) ? "available" : "unavailable" : "inconclusive";
        const family = props.ok ? detectChipsetFamily(props.value) : "unknown";
        let modem: Probe<string[]> = { ok: false, reason: "not checked: root or device properties inconclusive" };
        if (root === "available" && props.ok) {
          const modemPaths = MODEM_PATHS[family] ?? MODEM_PATHS.generic ?? [];
          modem = await probe(async () => {
            const output = commandOutput(await ctx.bridge.rootShell(buildModemCharacterDeviceProbe(modemPaths), {
              device: serial, timeout: 10000, retries: 0, ignoreExitCode: true,
            }));
            const paths = output ? output.split(/\r?\n/) : [];
            if (paths.some((path) => !modemPaths.includes(path))) throw new ProbeError("unrecognized modem-node response");
            return [...new Set(paths)];
          });
        } else if (root === "unavailable") {
          modem = { ok: true, value: [] };
        }

        let hostSqlite = false;
        if (!local) {
          try {
            const sqlite = await import("node:sqlite");
            const [major, minor] = process.versions.node.split(".").map(Number);
            hostSqlite = (major > 22 || (major === 22 && minor >= 16)) && typeof sqlite.DatabaseSync === "function";
          } catch { /* unavailable on early Node 22 builds */ }
        }
        // Match executeHostSnapshotQuery: host mode always uses its Node worker;
        // LocalBridge uses the device CLI. They are not interchangeable fallbacks.
        const sqliteState: Readiness = local ? has("sqlite3") : hostSqlite ? "available" : "unavailable";
        const sqliteDetail = local ? `device sqlite3: ${has("sqlite3")}`
          : hostSqlite ? "host Node SQLite backend available"
            : "host Node SQLite backend unavailable; requires Node 22.16+ with node:sqlite enabled";
        const role = characteristics.ok
          ? characteristics.value.toLowerCase().split(",").map((value) => value.trim()).includes("watch") ? "watch" : "handheld"
          : "device role inconclusive";
        const readiness: [string, Readiness, string][] = [
          ["Core ADB", allReady(status(boot), identity.ok ? "available" : "inconclusive"),
            boot.ok && !boot.value ? "device is not fully booted" : boot.ok && identity.ok ? "transport and Android userspace responsive" : "boot or shell identity inconclusive"],
          ["UI automation", allReady(has("uiautomator"), has("am")), `uiautomator: ${has("uiautomator")}; am: ${has("am")}`],
          ["Network diagnostics", allReady(has("ip"), routes.ok ? routes.value ? "available" : "unavailable" : "inconclusive"),
            `ip: ${has("ip")}; ${routes.ok ? routes.value ? "route table readable" : "no routes reported" : "route check inconclusive"}`],
          ["SQLite inspection", sqliteState, sqliteDetail],
          ["Root diagnostics", root, rootIdentity.ok ? root === "available" ? "su returns uid=0" : "su did not return uid=0" : rootIdentity.reason],
          ["Modem / AT", root === "unavailable" ? "unavailable" : modem.ok ? modem.value.length ? "available" : "unavailable" : "inconclusive",
            root === "unavailable" ? "not checked: root unavailable" : modem.ok ? modem.value.length ? `${modem.value.length} ${family} character node(s) visible; handshake not tested` : `no visible ${family} modem character node` : modem.reason],
          ["Wear Data Layer", status(gms), `${role}; Google Play services ${gms.ok ? gms.value ? "present" : "missing" : "inconclusive"}; pairing not tested`],
        ];

        const probes: [string, Probe<unknown>][] = [
          ["Device list", devices], ["Device properties", props], ["ADB version", version],
          ["Shell identity", identity], ["Root identity", rootIdentity], ["SELinux", selinux],
          ["Boot state", boot], ["Storage", storage], ["Command capabilities", capabilities],
          ["Routes", routes], ["Battery", battery], ["Google Play services", gms],
          ["Device role", characteristics], ["Modem nodes", modem],
        ];
        const issues = probes.flatMap(([name, result]) => result.ok ? [] : [`${name}: ${result.reason}`]);
        if (capabilities.ok && capabilityNames.some((name) => has(name) === "inconclusive")) {
          issues.push("Command capabilities: missing, duplicate or invalid result rows");
        }
        const properties = props.ok ? props.value : {};
        const sections = [
          "=== DeepADB Unified Runtime Audit (read-only) ===",
          `Audit status: ${issues.length ? "partial — some checks are inconclusive" : "complete"}`,
          "Readiness: available / unavailable / inconclusive (not a full functional test)",
          `Mode: ${local ? "on-device LocalBridge" : "host ADB"}`,
          `ADB: ${OutputProcessor.process(show(version).split(/\r?\n/)[0], 500)}`,
          `Connected devices: ${devices.ok ? `${devices.value.length} (${devices.value.filter((item) => item.state === "device").length} online)` : `inconclusive (${devices.reason})`}`,
          OutputProcessor.process(`Target: ${properties["ro.product.model"] ?? resolved.model ?? "unknown"} / Android ${properties["ro.build.version.release"] ?? "unknown"} (SDK ${properties["ro.build.version.sdk"] ?? "unknown"})`, 1000),
          `Boot completed: ${boot.ok ? boot.value ? "yes" : "no" : "inconclusive"}`,
          `Shell identity: ${OutputProcessor.process(show(identity), 500)}`,
          `Root: ${root}`,
          `SELinux: ${show(selinux)}`,
          `Chipset family: ${family}`,
          "",
          "── Readiness matrix ──",
          ...readiness.map(([name, state, detail]) => `${state === "available" ? "✓" : state === "unavailable" ? "○" : "?"} ${name}: ${state} — ${detail}`),
          "",
          "── Probe issues ──",
          ...(issues.length ? issues : ["None"]),
          "",
          "── Command capabilities ──",
          ...capabilityNames.map((name) => `${name}: ${has(name)}`),
          "",
          "── Storage snapshot ──",
          OutputProcessor.process(show(storage), 8000),
          "",
          "── Battery snapshot ──",
          OutputProcessor.process(show(battery), 4000),
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
