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

/** AT commands that can brick, factory-reset, or disable the modem. */
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
 * Send an AT command to a device node and capture the response.
 * Uses `echo` + `cat` with timeout via root shell.
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

  const cmd = command.trimEnd();

  // Send the command and read response with a timeout.
  // Both cmd and deviceNode are validated above — no shell metacharacters.
  // Use printf instead of echo -e for portable carriage return handling
  // (echo -e is not supported by all Android shell implementations).
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const shellCmd = `printf '${cmd}\\r' > '${deviceNode}' && timeout ${timeoutSec} cat '${deviceNode}' 2>&1 || true`;

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

export function registerAtCommandTools(ctx: ToolContext): void {

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
        const existCmd = allPaths.map((p) => `test -e ${p} && echo "EXISTS:${p}"`).join("; ");
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
      port: z.string().optional().describe("Modem device node (e.g., '/dev/umts_router0'). If omitted, auto-detects."),
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
          const props = await ctx.deviceManager.getDeviceProps(serial);
          const family = detectChipsetFamily(props);
          const paths = MODEM_PATHS[family] ?? MODEM_PATHS.generic;

          // Quick probe: find first existing node
          const existCmd = paths.map((p) => `test -e ${p} && echo "EXISTS:${p}"`).join("; ");
          const existResult = await ctx.bridge.rootShell(existCmd, {
            device: serial, timeout: 5000, ignoreExitCode: true,
          });
          const existing = existResult.stdout.split("\n")
            .filter((l) => l.startsWith("EXISTS:"))
            .map((l) => l.replace("EXISTS:", "").trim());

          if (existing.length === 0) {
            return {
              content: [{ type: "text", text: "No modem device node found. Use adb_at_detect to identify available ports, or specify 'port' manually." }],
              isError: true,
            };
          }
          targetPort = existing[0];
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
          const props = await ctx.deviceManager.getDeviceProps(serial);
          const family = detectChipsetFamily(props);
          const paths = MODEM_PATHS[family] ?? MODEM_PATHS.generic;
          const existCmd = paths.map((p) => `test -e ${p} && echo "EXISTS:${p}"`).join("; ");
          const existResult = await ctx.bridge.rootShell(existCmd, {
            device: serial, timeout: 5000, ignoreExitCode: true,
          });
          const existing = existResult.stdout.split("\n")
            .filter((l) => l.startsWith("EXISTS:"))
            .map((l) => l.replace("EXISTS:", "").trim());
          if (existing.length === 0) {
            return {
              content: [{ type: "text", text: "No modem device node found. Use adb_at_detect or specify 'port'." }],
              isError: true,
            };
          }
          targetPort = existing[0];
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
          const props = await ctx.deviceManager.getDeviceProps(serial);
          const family = detectChipsetFamily(props);
          const paths = MODEM_PATHS[family] ?? MODEM_PATHS.generic;
          const existCmd = paths.map((p) => `test -e ${p} && echo "EXISTS:${p}"`).join("; ");
          const existResult = await ctx.bridge.rootShell(existCmd, {
            device: serial, timeout: 5000, ignoreExitCode: true,
          });
          const existing = existResult.stdout.split("\n")
            .filter((l) => l.startsWith("EXISTS:"))
            .map((l) => l.replace("EXISTS:", "").trim());
          if (existing.length === 0) {
            return {
              content: [{ type: "text", text: "No modem device node found. Use adb_at_detect or specify 'port'." }],
              isError: true,
            };
          }
          targetPort = existing[0];
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
}
