// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * AT Command Interface — Raw modem AT command passthrough via root access.
 *
 * Enables direct modem interrogation beyond what the Android telephony
 * framework exposes. Useful for advanced baseband research, cellular
 * protocol analysis, and low-level radio diagnostics.
 *
 * Multi-device support: auto-detects modem device node by chipset family
 * (Shannon/Exynos, Qualcomm, MediaTek, Unisoc, generic USB modems).
 * Manual port override available for unknown hardware.
 *
 * Root access required — AT commands go through /dev/ serial device nodes.
 *
 * SAFETY: Certain AT commands can disable the radio (AT+CFUN=0), factory
 * reset the modem, or alter NVRAM. A blocklist prevents accidental execution
 * of the most dangerous commands. Use `force: true` to bypass.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { MODEM_PATHS, detectChipsetFamily } from "../middleware/chipset.js";
import { shellQuote } from "../middleware/sanitize.js";

/**
 * AT commands that can brick, factory-reset, or disable the modem.
 *
 * T1 note: NON-EXHAUSTIVE. Covers the well-known cross-vendor dangerous
 * commands but vendor-specific surfaces have many more entries that aren't
 * listed here. Notable missing vendor-specific commands:
 *   - Huawei:    AT^SYSCFG*  (system config, can disable bands/RATs)
 *   - MediaTek:  AT^EFNAME   (EF file writes, can corrupt SIM)
 *   - Quectel:   AT+QCFG     (config writes)
 *   - Cinterion: AT^SCFG     (config writes)
 *   - Generic:   AT+CPOL     (preferred operator list write)
 *
 * Operators MUST review their modem's vendor datasheet before using
 * `force: true` — the blocklist is a safety net for the common case, not
 * a substitute for understanding what a command does.
 */
const DANGEROUS_AT_COMMANDS = [
  "AT+CFUN=0",     // Minimum functionality — kills radio
  "AT+CFUN=4",     // Disable TX
  "AT+CLCK",       // Lock facility (can lock SIM permanently)
  "AT^RESET",      // Modem hard reset (vendor-specific)
  "AT+NVRAM",      // NVRAM write (vendor-specific)
  "AT+EGMR",       // Write IMEI (illegal in many jurisdictions)
  "AT%RESTART",    // Modem restart
  "AT+QPRTPARA",   // Qualcomm parameter write
];

function isDangerousCommand(cmd: string): string | null {
  const upper = cmd.toUpperCase().trim();
  for (const dangerous of DANGEROUS_AT_COMMANDS) {
    if (upper.startsWith(dangerous)) {
      return `Blocked dangerous AT command: ${dangerous}. This command can disable/damage the modem. Use force=true to override.`;
    }
  }
  return null;
}

/**
 * Characters that are dangerous inside shell double-quotes or bare interpolation.
 * AT commands legitimately contain: + = ? , . # * but never shell operators.
 */
const AT_UNSAFE_CHARS = /["'`$\\!;|&(){}<>\n\r]/;

/**
 * Validate that a device node path looks like a real /dev/ path.
 * Rejects anything that doesn't start with /dev/ or contains shell metacharacters.
 */
function validateDeviceNode(port: string): string | null {
  if (!port.startsWith("/dev/")) {
    return `Invalid port: must start with /dev/ (got: "${port}")`;
  }
  if (AT_UNSAFE_CHARS.test(port)) {
    return `Invalid port: contains shell metacharacters`;
  }
  if (port.includes("..")) {
    return `Invalid port: path traversal not allowed`;
  }
  return null;
}

/**
 * Validate that an AT command string is safe to echo into a device node.
 * AT commands contain alphanumeric chars plus + = ? , . # * : / but
 * must never contain shell metacharacters that could enable injection.
 */
function validateAtCommand(cmd: string): string | null {
  if (AT_UNSAFE_CHARS.test(cmd)) {
    return `Invalid AT command: contains shell-unsafe characters. AT commands must not include: \` " $ \\ ! ; | & ( ) { } < >`;
  }
  return null;
}

/**
 * Build the guarded device-side AT exchange.
 *
 * CPIF/SIPC nodes return an empty read after roughly 100ms when their RX queue
 * is empty. A one-shot `cat` therefore exits before a slightly delayed modem
 * response. Re-arm bounded reads until a terminal result arrives, and start the
 * writer after the first read is waiting. `dd conv=nocreat` is deliberate: a
 * shell redirection would create a regular file under /dev when a candidate
 * node is absent and the caller has root.
 */
export function buildAtShellCommand(
  deviceNode: string,
  command: string,
  timeoutMs: number,
): string {
  const portErr = validateDeviceNode(deviceNode);
  if (portErr) throw new Error(portErr);
  const cmdErr = validateAtCommand(command);
  if (cmdErr) throw new Error(cmdErr);

  const cmd = command.trimEnd();
  const node = shellQuote(deviceNode);
  const payload = shellQuote(cmd);
  const maxReads = Math.max(1, Math.ceil(timeoutMs / 100));
  const terminator = (MODEM_PATHS.shannon ?? []).includes(deviceNode) ? "%s\\r\\n" : "%s\\r";

  return [
    `test -c ${node} || { printf '%s\\n' 'DeepADB: target is not a character device' >&2; exit 1; }`,
    `(sleep 0.1; printf '${terminator}' ${payload} | dd of=${node} conv=nocreat,notrunc status=none) & writer_pid=$!`,
    "i=0",
    `while [ "$i" -lt ${maxReads} ]; do chunk=$(dd if=${node} bs=4096 count=1 status=none 2>/dev/null); if [ -n "$chunk" ]; then printf '%s\\n' "$chunk"; if printf '%s\\n' "$chunk" | tr -d '\\r' | grep -Eq '^(OK|ERROR|\\+CME ERROR:|\\+CMS ERROR:)'; then break; fi; fi; i=$((i + 1)); done`,
    'wait "$writer_pid"',
  ].join("; ");
}

/**
 * Send an AT command to a character-device modem node and capture its response.
 * Both the command and device node are validated before interpolation.
 */
async function sendAtCommand(
  ctx: ToolContext,
  serial: string,
  deviceNode: string,
  command: string,
  timeoutMs: number,
): Promise<{ response: string; error?: string }> {
  // Validate device node path
  const portErr = validateDeviceNode(deviceNode);
  if (portErr) return { response: "", error: portErr };

  // Validate AT command for shell safety
  const cmdErr = validateAtCommand(command);
  if (cmdErr) return { response: "", error: cmdErr };

  const shellCmd = buildAtShellCommand(deviceNode, command, timeoutMs);

  try {
    const result = await ctx.bridge.rootShell(shellCmd, {
      device: serial,
      timeout: timeoutMs + 3000, // Extra buffer for ADB overhead
      ignoreExitCode: true,
    });

    const response = result.stdout.trim();
    if (result.stderr && result.stderr.trim()) {
      return { response, error: result.stderr.trim() };
    }
    return { response };
  } catch (err) {
    return { response: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Auto-detect the first existing modem device node for the given chipset family.
 * Probes MODEM_PATHS entries via `test -c` through root shell so regular files,
 * block devices, and stale filesystem artifacts can never be selected.
 * Returns the first existing node path, or null if none found.
 */
async function autoDetectAtPort(
  ctx: ToolContext,
  serial: string,
  family?: string,
): Promise<string | null> {
  if (!family) {
    const props = await ctx.deviceManager.getDeviceProps(serial);
    family = detectChipsetFamily(props);
  }
  const paths = MODEM_PATHS[family] ?? MODEM_PATHS.generic;
  // T5 fix: defense-in-depth shellQuote on MODEM_PATHS entries. Current
  // values are hardcoded /dev/... constants from chipset.ts (no whitespace
  // or metacharacters), so this is safe by construction today. Wrapping
  // ensures a future contributor adding a path with whitespace doesn't
  // accidentally word-split here.
  const existCmd = paths.map((p) => `test -c ${shellQuote(p)} && echo "EXISTS:${p}"`).join("; ");
  const existResult = await ctx.bridge.rootShell(existCmd, {
    device: serial, timeout: 5000, ignoreExitCode: true,
  });
  const existing = existResult.stdout.split("\n")
    .filter((l) => l.startsWith("EXISTS:"))
    .map((l) => l.replace("EXISTS:", "").trim());
  return existing.length > 0 ? existing[0]! : null;
}

export function registerAtCommandTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_shannon_session",
    "Preflight a Samsung Shannon/Exynos modem session by checking the chipset, root access, known AT ports, and a benign AT handshake together. Optionally sends ATI for identification after a successful handshake. Makes no modem configuration changes.",
    {
      port: z.string().optional().describe("Optional Shannon device node override (for example /dev/umts_router)"),
      timeout: z.number().int().min(1000).max(10000).optional().default(3000)
        .describe("Handshake timeout per port in milliseconds (1000-10000, default 3000)"),
      includeIdentity: z.boolean().optional().default(false)
        .describe("After a successful AT handshake, also send the read-only ATI identity query"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ port, timeout, includeIdentity, device }) => {
      try {
        if (port) {
          const portError = validateDeviceNode(port);
          if (portError) {
            return { content: [{ type: "text", text: portError }], isError: true };
          }
          if (!(MODEM_PATHS.shannon ?? []).includes(port)) {
            return {
              content: [{ type: "text", text: `Shannon session port must be one of the known Shannon AT nodes: ${(MODEM_PATHS.shannon ?? []).join(", ")}` }],
              isError: true,
            };
          }
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const family = detectChipsetFamily(props);
        const sections = [
          "=== Shannon Session Preflight ===",
          `Device: ${props["ro.product.model"] ?? "unknown"}`,
          `Chipset family: ${family}`,
        ];

        if (family !== "shannon") {
          sections.push("Result: this device does not identify as Shannon/Exynos. Use adb_at_detect for generic modem discovery.");
          return { content: [{ type: "text", text: sections.join("\n") }], isError: true };
        }

        const rootProbe = await ctx.bridge.shell("su -c id", {
          device: serial, timeout: 5000, ignoreExitCode: true,
        });
        if (!/uid=0\b/.test(rootProbe.stdout)) {
          sections.push("Root: unavailable", "Result: Shannon device nodes require root access.");
          return { content: [{ type: "text", text: sections.join("\n") }], isError: true };
        }
        sections.push("Root: available");

        const candidates = port ? [port] : (MODEM_PATHS.shannon ?? []);
        const existenceProbe = candidates
          .map((candidate) => `test -c ${shellQuote(candidate)} && echo ${shellQuote(`EXISTS:${candidate}`)}`)
          .join("; ");
        const existence = await ctx.bridge.rootShell(existenceProbe, {
          device: serial, timeout: 10000, ignoreExitCode: true,
        });
        const existing = existence.stdout.split(/\r?\n/)
          .filter((line) => line.startsWith("EXISTS:"))
          .map((line) => line.slice("EXISTS:".length).trim())
          .filter((candidate) => candidates.includes(candidate));

        sections.push(`Ports checked: ${candidates.length}`, `Ports present: ${existing.length ? existing.join(", ") : "none"}`);
        if (existing.length === 0) {
          sections.push("Result: no Shannon AT device node is currently visible.");
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        let selected: string | null = null;
        let identity = "";
        sections.push("", "── Handshakes ──");
        for (const candidate of existing) {
          const handshake = await sendAtCommand(ctx, serial, candidate, "AT", timeout);
          const ok = /(^|\r?\n)\s*OK\s*($|\r?\n)/i.test(handshake.response) || handshake.response.trim() === "OK";
          if (handshake.error) {
            sections.push(`○ ${candidate}: ${handshake.error}`);
          } else if (ok) {
            sections.push(`✓ ${candidate}: AT / OK handshake complete`);
            selected = candidate;
            if (includeIdentity) {
              const identityResult = await sendAtCommand(ctx, serial, candidate, "ATI", timeout);
              identity = identityResult.error
                ? `Identity query error: ${identityResult.error}`
                : (identityResult.response.trim() || "Identity query returned no text");
            }
            break;
          } else {
            sections.push(`○ ${candidate}: ${handshake.response.trim() ? "response received without OK" : "no response before timeout"}`);
          }
        }

        if (selected) {
          sections.push("", "=== SHANNON SESSION READY ===", `Selected port: ${selected}`);
          if (includeIdentity) sections.push("", "── ATI identity ──", identity);
        } else {
          sections.push("", "=== SHANNON SESSION NOT READY ===", "Device nodes are present, but no AT / OK handshake completed.");
        }
        sections.push("Only AT and, when requested, ATI were sent; no modem configuration was changed.");
        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n"), 20000) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    },
  );

  ctx.server.tool(
    "adb_at_detect",
    "Auto-detect the modem AT command device node. Identifies the chipset family (Shannon, Qualcomm, MediaTek, Unisoc) and probes known device node paths. Requires root. Returns the first responding node.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Detect chipset family
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const family = detectChipsetFamily(props);
        const chipname = props["ro.hardware.chipname"] ?? "unknown";
        const platform = props["ro.board.platform"] ?? "unknown";

        const sections: string[] = [];
        sections.push(`Chipset: ${chipname} (platform: ${platform})`);
        sections.push(`Detected family: ${family}`);

        // Probe paths for this family, then fall back to all others
        const familyPaths = MODEM_PATHS[family] ?? [];
        const otherPaths = Object.entries(MODEM_PATHS)
          .filter(([k]) => k !== family)
          .flatMap(([, v]) => v);
        const allPaths = [...familyPaths, ...otherPaths];

        sections.push(`\nProbing ${allPaths.length} device nodes...`);

        // Check which device nodes exist
        // T5 fix (same rationale as autoDetectAtPort)
        const existCmd = allPaths.map((p) => `test -c ${shellQuote(p)} && echo "EXISTS:${p}"`).join("; ");
        const existResult = await ctx.bridge.rootShell(existCmd, {
          device: serial, timeout: 10000, ignoreExitCode: true,
        });

        const existingPaths = existResult.stdout
          .split("\n")
          .filter((l) => l.startsWith("EXISTS:"))
          .map((l) => l.replace("EXISTS:", "").trim());

        if (existingPaths.length === 0) {
          sections.push("\nNo modem device nodes found. The device may not expose AT command interfaces, or may require a different access method.");
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        sections.push(`Found ${existingPaths.length} existing node(s): ${existingPaths.join(", ")}`);

        // Try sending "AT" to each existing node and check for "OK" response
        let respondingNode: string | null = null;
        for (const nodePath of existingPaths) {
          sections.push(`\nProbing ${nodePath}...`);
          const { response, error } = await sendAtCommand(ctx, serial, nodePath, "AT", 3000);

          if (error) {
            sections.push(`  Error: ${error}`);
            continue;
          }

          if (response.includes("OK")) {
            sections.push(`  ✓ Response: OK — this node accepts AT commands`);
            respondingNode = nodePath;
            break;
          } else if (response.length > 0) {
            sections.push(`  ? Response: ${response.substring(0, 100)}`);
          } else {
            sections.push(`  ✗ No response (timeout)`);
          }
        }

        if (respondingNode) {
          sections.push(`\n=== Detected AT port: ${respondingNode} ===`);
          sections.push(`Use this as the 'port' parameter in adb_at_send and adb_at_batch.`);
        } else {
          sections.push(`\nNo responding AT port found. Nodes exist but did not respond to "AT".`);
          sections.push(`Try manually with adb_at_send using one of: ${existingPaths.join(", ")}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_at_send",
    "Send a single AT command to the modem and capture the response. Requires root. Use adb_at_detect to find the correct port, or specify it manually.",
    {
      command: z.string().describe("AT command to send (e.g., 'AT+CSQ', 'ATI', 'AT+COPS?')"),
      port: z.string().optional().describe("Modem device node (e.g., '/dev/umts_router'). If omitted, auto-detects."),
      timeout: z.number().min(1000).max(30000).optional().default(5000).describe("Response timeout in ms (1000-30000, default 5000)"),
      force: z.boolean().optional().default(false).describe("Bypass dangerous command safety check"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ command, port, timeout, force, device }) => {
      try {
        // Safety check
        if (!force) {
          const blocked = isDangerousCommand(command);
          if (blocked) {
            return { content: [{ type: "text", text: blocked }], isError: true };
          }
        }

        // Pre-flight input validation (same checks as sendAtCommand, but return isError)
        const cmdErr = validateAtCommand(command);
        if (cmdErr) {
          return { content: [{ type: "text", text: cmdErr }], isError: true };
        }
        if (port) {
          const portErr = validateDeviceNode(port);
          if (portErr) {
            return { content: [{ type: "text", text: portErr }], isError: true };
          }
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Auto-detect port if not specified
        let targetPort = port;
        if (!targetPort) {
          targetPort = await autoDetectAtPort(ctx, serial) ?? undefined;
          if (!targetPort) {
            return {
              content: [{ type: "text", text: "No modem device node found. Use adb_at_detect to identify available ports, or specify 'port' manually." }],
              isError: true,
            };
          }
        }

        const { response, error } = await sendAtCommand(ctx, serial, targetPort, command, timeout);

        let output = `Port: ${targetPort}\nCommand: ${command}\n\n`;
        if (error) {
          output += `Error: ${error}\n`;
        }
        output += `Response:\n${response || "(no response)"}`;

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_at_batch",
    "Send multiple AT commands sequentially and capture all responses. Useful for running a diagnostic sequence. Requires root.",
    {
      commands: z.array(z.string()).min(1).max(50).describe("Array of AT commands to send in order (max 50)"),
      port: z.string().optional().describe("Modem device node (auto-detects if omitted)"),
      timeout: z.number().min(1000).max(30000).optional().default(5000).describe("Timeout per command in ms"),
      delayMs: z.number().min(0).max(10000).optional().default(500).describe("Delay between commands in ms (0-10000, default 500)"),
      force: z.boolean().optional().default(false).describe("Bypass dangerous command safety checks"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ commands, port, timeout, delayMs, force, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Safety check all commands first
        if (!force) {
          for (const cmd of commands) {
            const blocked = isDangerousCommand(cmd);
            if (blocked) {
              return { content: [{ type: "text", text: `Batch aborted: ${blocked}` }], isError: true };
            }
          }
        }

        // Pre-flight input validation for all commands and port
        for (const cmd of commands) {
          const cmdErr = validateAtCommand(cmd);
          if (cmdErr) {
            return { content: [{ type: "text", text: `Batch aborted: ${cmdErr}` }], isError: true };
          }
        }
        if (port) {
          const portErr = validateDeviceNode(port);
          if (portErr) {
            return { content: [{ type: "text", text: portErr }], isError: true };
          }
        }

        // Auto-detect port if not specified
        let targetPort = port;
        if (!targetPort) {
          targetPort = await autoDetectAtPort(ctx, serial) ?? undefined;
          if (!targetPort) {
            return {
              content: [{ type: "text", text: "No modem device node found. Use adb_at_detect or specify 'port'." }],
              isError: true,
            };
          }
        }

        const results: string[] = [`Port: ${targetPort}`, `Commands: ${commands.length}`, ``];

        for (let i = 0; i < commands.length; i++) {
          const cmd = commands[i];
          results.push(`--- [${i + 1}/${commands.length}] ${cmd} ---`);

          const { response, error } = await sendAtCommand(ctx, serial, targetPort, cmd, timeout);
          if (error) {
            results.push(`Error: ${error}`);
          }
          results.push(response || "(no response)");
          results.push("");

          // Delay between commands (skip after last)
          if (i < commands.length - 1 && delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        return { content: [{ type: "text", text: OutputProcessor.process(results.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_at_probe",
    "Run a standard AT diagnostic probe: modem identification, signal quality, network registration, SIM status, and supported bands. Requires root.",
    {
      port: z.string().optional().describe("Modem device node (auto-detects if omitted)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ port, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Auto-detect port
        let targetPort = port;
        if (!targetPort) {
          targetPort = await autoDetectAtPort(ctx, serial) ?? undefined;
          if (!targetPort) {
            return {
              content: [{ type: "text", text: "No modem device node found. Use adb_at_detect or specify 'port'." }],
              isError: true,
            };
          }
        }

        // Standard diagnostic AT command sequence
        const probeCommands = [
          { cmd: "ATI", label: "Modem Identification" },
          { cmd: "AT+CGMM", label: "Model" },
          { cmd: "AT+CGMR", label: "Firmware Revision" },
          { cmd: "AT+CGSN", label: "IMEI (serial number)" },
          { cmd: "AT+CSQ", label: "Signal Quality (RSSI, BER)" },
          { cmd: "AT+CREG?", label: "Network Registration (CS)" },
          { cmd: "AT+CEREG?", label: "Network Registration (EPS/LTE)" },
          { cmd: "AT+C5GREG?", label: "Network Registration (5G NR)" },
          { cmd: "AT+COPS?", label: "Current Operator" },
          { cmd: "AT+CPIN?", label: "SIM Status" },
          { cmd: "AT+CFUN?", label: "Functionality Mode" },
          { cmd: "AT+CNMI?", label: "SMS Notification Mode" },
        ];

        const sections: string[] = [`=== AT Diagnostic Probe ===`, `Port: ${targetPort}`, ``];

        for (const { cmd, label } of probeCommands) {
          const { response, error } = await sendAtCommand(ctx, serial, targetPort, cmd, 4000);
          const display = error ? `Error: ${error}` : (response || "(no response)");
          sections.push(`[${label}] ${cmd}`);
          sections.push(`  ${display.replace(/\n/g, "\n  ")}`);
          sections.push("");

          // Brief delay between commands
          await new Promise((r) => setTimeout(r, 300));
        }

        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_at_cross_validate",
    "Cross-validate baseband firmware by comparing AT command responses (direct modem interrogation) against Android system properties (getprop). Discrepancies may indicate firmware tampering, incomplete OTA updates, or property spoofing. Sends ATI (identification), AT+CGMR (firmware revision), and AT+CGMM (model) to the modem and compares with gsm.version.baseband, ro.hardware.chipname, and related properties. Requires root.",
    {
      port: z.string().optional().describe("Modem device node (auto-detects if omitted)"),
      timeout: z.number().min(1000).max(30000).optional().default(5000).describe("Response timeout per command in ms"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ port, timeout, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const family = detectChipsetFamily(props);

        const sections: string[] = [];
        sections.push("=== AT Cross-Validation: Modem vs Properties ===");
        sections.push(`Device: ${props["ro.product.model"] ?? "unknown"} (${serial})`);
        sections.push(`Chipset family: ${family}`);

        // ── Auto-detect port if not specified ──
        let targetPort = port;
        if (!targetPort) {
          targetPort = await autoDetectAtPort(ctx, serial, family) ?? undefined;
        }

        sections.push(`AT port: ${targetPort ?? "not available"}`);

        // ── Gather AT command responses ──
        const atResults: Record<string, string> = {};

        if (targetPort) {
          const atCommands: [string, string][] = [
            ["ATI", "Identification"],
            ["AT+CGMR", "Firmware Revision"],
            ["AT+CGMM", "Model"],
          ];

          // Shannon-specific: AT+DEVCONINFO for extended device info
          if (family === "shannon") {
            atCommands.push(["AT+DEVCONINFO", "Device Config (Shannon)"]);
          }

          sections.push("\n── AT Command Responses ──");
          for (const [cmd, label] of atCommands) {
            const { response, error } = await sendAtCommand(ctx, serial, targetPort, cmd, timeout);
            if (error) {
              sections.push(`${label} (${cmd}): Error — ${error}`);
            } else {
              const clean = response
                .split("\n")
                .filter(l => l.trim().length > 0 && !l.includes("OK") && !l.trim().startsWith(cmd))
                .map(l => l.trim())
                .join(" | ");
              sections.push(`${label} (${cmd}): ${clean || "(empty response)"}`);
              atResults[cmd] = clean;
            }
            await new Promise((r) => setTimeout(r, 300));
          }
        } else {
          sections.push("\n── AT Command Responses ──");
          sections.push("No modem device node found — AT port auto-detection requires root and direct modem node access.");
          sections.push("This is expected in ADB mode. Use on-device mode (Termux) for full AT cross-validation.");
          sections.push("Alternatively, specify 'port' manually (e.g., '/dev/umts_router' for Google Tensor/Shannon).");
          sections.push("\nFalling back to property-only analysis...");
        }

        // ── Gather property-based firmware info ──
        const propBaseline: Record<string, string> = {};
        const propKeys: [string, string][] = [
          ["gsm.version.baseband", "Baseband version"],
          ["gsm.version.ril-impl", "RIL implementation"],
          ["ro.hardware.chipname", "Chipset name"],
          ["ro.board.platform", "Platform"],
          ["ro.baseband", "Baseband tag"],
          ["ro.build.expect.baseband", "Expected baseband"],
        ];

        sections.push("\n── System Property Baseline ──");
        for (const [key, label] of propKeys) {
          const val = props[key] ?? "";
          if (val) {
            sections.push(`${label} (${key}): ${val}`);
            propBaseline[key] = val;
          }
        }

        // ── Cross-validation analysis ──
        sections.push("\n── Cross-Validation Results ──");
        let discrepancies = 0;
        let checks = 0;

        // Check 1: AT+CGMR firmware revision vs gsm.version.baseband
        if (atResults["AT+CGMR"] && propBaseline["gsm.version.baseband"]) {
          checks++;
          const atFw = atResults["AT+CGMR"].toLowerCase();
          const propFw = propBaseline["gsm.version.baseband"].toLowerCase();
          // Check if either contains the other, or if they share significant substrings
          const atTokens = atFw.split(/[\s|,_-]+/).filter(t => t.length > 3);
          const propTokens = propFw.split(/[\s|,_-]+/).filter(t => t.length > 3);
          const overlap = atTokens.filter(t => propTokens.some(p => p.includes(t) || t.includes(p)));

          if (atFw.includes(propFw) || propFw.includes(atFw) || overlap.length >= 2) {
            sections.push("✓ Firmware revision: AT+CGMR consistent with gsm.version.baseband");
          } else if (overlap.length >= 1) {
            sections.push("⚠ Firmware revision: Partial match — AT+CGMR and gsm.version.baseband share some tokens but differ");
            sections.push(`  AT+CGMR: ${atResults["AT+CGMR"]}`);
            sections.push(`  getprop: ${propBaseline["gsm.version.baseband"]}`);
            sections.push(`  Overlap: ${overlap.join(", ")}`);
          } else {
            discrepancies++;
            sections.push("⚠ HEURISTIC MISMATCH: Firmware revision strings differ between AT+CGMR and gsm.version.baseband");
            sections.push(`  AT+CGMR: ${atResults["AT+CGMR"]}`);
            sections.push(`  getprop: ${propBaseline["gsm.version.baseband"]}`);
            // T7 fix: soften — this is a heuristic token-overlap check, not a tampering indicator
          sections.push("  Note: vendor AT+CGMR strings and Android getprop labels rarely match exactly even on healthy hardware. Treat as an investigation hint, not evidence of tampering.");
          }
        }

        // Check 2: ATI identification vs chipset family
        if (atResults["ATI"]) {
          checks++;
          const atiLower = atResults["ATI"].toLowerCase();
          let expectedFamily = "";
          if (family === "shannon") expectedFamily = "samsung|shannon|exynos|slsi";
          else if (family === "qualcomm") expectedFamily = "qualcomm|qcom|snapdragon";
          else if (family === "mediatek") expectedFamily = "mediatek|mtk";
          else if (family === "unisoc") expectedFamily = "unisoc|spreadtrum";
          else if (family === "hisilicon") expectedFamily = "hisilicon|kirin|huawei";
          else if (family === "intel") expectedFamily = "intel|xmm";

          if (expectedFamily) {
            const familyRegex = new RegExp(expectedFamily, "i");
            if (familyRegex.test(atiLower) || atiLower.includes(family)) {
              sections.push(`✓ Modem identity: ATI confirms ${family} chipset family`);
            } else {
              // Not necessarily a discrepancy — ATI format varies widely
              sections.push(`⚠ Modem identity: ATI response doesn't explicitly mention ${family} — may use vendor-specific format`);
              sections.push(`  ATI: ${atResults["ATI"]}`);
            }
          }
        }

        // Check 3: AT+CGMM model vs expected baseband
        if (atResults["AT+CGMM"] && propBaseline["ro.build.expect.baseband"]) {
          checks++;
          const atModel = atResults["AT+CGMM"].toLowerCase();
          const expected = propBaseline["ro.build.expect.baseband"].toLowerCase();
          // Extract model identifier from expected baseband string
          const modelMatch = expected.match(/^([a-z]\d{4}\w*)/i);
          if (modelMatch && atModel.includes(modelMatch[1].toLowerCase())) {
            sections.push("✓ Modem model: AT+CGMM consistent with ro.build.expect.baseband");
          } else if (modelMatch) {
            sections.push(`⚠ Modem model: AT+CGMM doesn't contain expected model identifier '${modelMatch[1]}'`);
            sections.push(`  AT+CGMM: ${atResults["AT+CGMM"]}`);
          }
        }

        // Check 4: Expected vs actual baseband (property-level consistency)
        if (propBaseline["ro.build.expect.baseband"] && propBaseline["gsm.version.baseband"]) {
          checks++;
          if (propBaseline["ro.build.expect.baseband"] === propBaseline["gsm.version.baseband"]) {
            sections.push("✓ Property consistency: ro.build.expect.baseband matches gsm.version.baseband");
          } else {
            discrepancies++;
            sections.push("⚠ HEURISTIC MISMATCH: Expected baseband string doesn't match running baseband string");
            sections.push(`  Expected: ${propBaseline["ro.build.expect.baseband"]}`);
            sections.push(`  Running:  ${propBaseline["gsm.version.baseband"]}`);
            sections.push("  ⚠ This may indicate a pending OTA, partial update, or firmware downgrade");
          }
        }

        // ── Summary ──
        sections.push(`\n── Summary ──`);
        sections.push(`Checks performed: ${checks}`);
        sections.push(`Discrepancies found: ${discrepancies}`);
        if (discrepancies === 0 && checks > 0) {
          sections.push("✓ All cross-validation checks passed — modem reports are consistent with system properties");
        } else if (discrepancies > 0) {
          sections.push("⚠ Discrepancies detected — investigate firmware integrity");
        } else {
          sections.push("No checks could be performed — AT port may not be responding or properties are missing");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
