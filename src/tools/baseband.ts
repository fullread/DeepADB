/**
 * Baseband/Modem Integration Tools — Deep cellular radio state inspection.
 * 
 * Provides detailed modem and radio diagnostics for advanced Android
 * development and cellular network research. Extracts modem identification,
 * cell identity, signal measurements, neighboring cells, carrier config,
 * and baseband logs.
 * 
 * Supports Shannon/Exynos, Qualcomm, MediaTek, and Unisoc chipset families
 * via standard Android telephony APIs. Root access enables additional
 * kernel-level modem logging.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";
import { detectSimConfig } from "../middleware/chipset.js";

export function registerBasebandTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_baseband_info",
    "Get comprehensive modem/baseband identification: firmware version, RIL implementation, chipset, IMEI, SIM state, and radio capabilities.",
    {
      device: z.string().optional().describe("Device serial"),
      includeImei: z.boolean().optional().default(false).describe("Include IMEI in output (sensitive permanent device identifier — opt-in only)"),
    },
    async ({ device, includeImei }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const propKeys = [
          "gsm.version.baseband",
          "gsm.version.ril-impl",
          "gsm.nitz.time",
          "gsm.sim.state",
          "gsm.sim.operator.alpha",
          "gsm.sim.operator.numeric",
          "gsm.operator.alpha",
          "gsm.operator.numeric",
          "gsm.operator.iso-country",
          "gsm.network.type",
          "persist.sys.radio.apm_sim_not_pwdn",
          "ro.telephony.default_network",
          "ro.baseband",
          "ro.hardware.chipname",
          // Dual SIM detection
          "telephony.active_modems.max_count",
          "persist.radio.multisim.config",
        ];

        const propResults = await Promise.allSettled(
          propKeys.map((key) =>
            ctx.bridge.shell(`getprop ${key}`, { device: serial })
              .then((r) => ({ key, value: r.stdout.trim() }))
          )
        );

        const props: Record<string, string> = {};
        for (const r of propResults) {
          if (r.status === "fulfilled" && r.value.value) {
            props[r.value.key] = r.value.value;
          }
        }

        // Detect dual SIM configuration (shared logic in chipset.ts)
        const { dualSim: isDualSim, simSlots, multisimMode: multisimConfig } = detectSimConfig(props);

        const sections: string[] = [];
        sections.push("=== Baseband/Modem ===");
        sections.push(`Baseband version: ${props["gsm.version.baseband"] ?? "unknown"}`);
        sections.push(`RIL implementation: ${props["gsm.version.ril-impl"] ?? "unknown"}`);
        sections.push(`Hardware chipset: ${props["ro.hardware.chipname"] ?? props["ro.baseband"] ?? "unknown"}`);
        sections.push(`Default network mode: ${props["ro.telephony.default_network"] ?? "unknown"}`);

        // SIM Configuration section
        sections.push("\n=== SIM Configuration ===");
        if (isDualSim) {
          const configLabel = multisimConfig === "dsda" ? "Dual SIM Dual Active (DSDA)"
            : multisimConfig === "dsds" ? "Dual SIM Dual Standby (DSDS)"
            : multisimConfig === "tsts" ? "Triple SIM Triple Standby (TSTS)"
            : `Dual SIM (${simSlots} slots)`;
          sections.push(`Mode: ${configLabel}`);

          // Query per-slot properties
          // Android uses varying suffix conventions: .0/.1, 2 suffix, or no suffix for slot 0
          const slotPropKeys = [
            "gsm.sim.state",
            "gsm.sim.operator.alpha",
            "gsm.sim.operator.numeric",
            "gsm.operator.alpha",
            "gsm.operator.numeric",
            "gsm.operator.iso-country",
            "gsm.network.type",
            "gsm.nitz.time",
            "gsm.version.baseband",
          ];

          // Build per-slot queries: try .0/.1 indexed and legacy 2-suffix
          const slotQueries: Array<{ slot: number; key: string; prop: string }> = [];
          for (let slot = 0; slot < simSlots; slot++) {
            for (const key of slotPropKeys) {
              // Try indexed suffix (.0, .1)
              slotQueries.push({ slot, key, prop: `${key}.${slot}` });
              // Try legacy suffix (key2 for slot 1)
              if (slot === 1) {
                const base = key.endsWith(".baseband") ? key.replace(".baseband", ".baseband1")
                  : key + "2";
                slotQueries.push({ slot, key, prop: base });
              }
            }
          }

          const slotResults = await Promise.allSettled(
            slotQueries.map((q) =>
              ctx.bridge.shell(`getprop ${q.prop}`, { device: serial })
                .then((r) => ({ ...q, value: r.stdout.trim() }))
            )
          );

          // Organize per-slot data: first non-empty value wins for each slot+key
          const slotData: Array<Record<string, string>> = Array.from({ length: simSlots }, () => ({}));
          for (const r of slotResults) {
            if (r.status === "fulfilled" && r.value.value) {
              const { slot, key, value } = r.value;
              if (!slotData[slot][key]) {
                slotData[slot][key] = value;
              }
            }
          }

          // Fall back to unsuffixed props for slot 0 (primary slot)
          for (const key of slotPropKeys) {
            if (!slotData[0][key] && props[key]) {
              slotData[0][key] = props[key];
            }
          }

          // Display per-slot info
          for (let slot = 0; slot < simSlots; slot++) {
            const sd = slotData[slot];
            const simState = sd["gsm.sim.state"] ?? "unknown";
            const simOp = sd["gsm.sim.operator.alpha"] ?? "";
            const simPlmn = sd["gsm.sim.operator.numeric"] ?? "";
            const netOp = sd["gsm.operator.alpha"] ?? "";
            const netPlmn = sd["gsm.operator.numeric"] ?? "";
            const netType = sd["gsm.network.type"] ?? "";
            const country = sd["gsm.operator.iso-country"] ?? "";
            const baseband = sd["gsm.version.baseband"] ?? "";

            sections.push(`\n  --- Slot ${slot} ---`);
            sections.push(`  SIM state: ${simState}`);
            if (simOp || simPlmn) {
              sections.push(`  SIM operator: ${simOp || "unknown"} (${simPlmn || "?"})`);
            }
            if (netOp || netPlmn || netType) {
              sections.push(`  Network: ${netOp || "unknown"} (${netPlmn || "?"}) — ${netType || "unknown"}`);
            }
            if (country) sections.push(`  Country: ${country}`);
            if (baseband && baseband !== (props["gsm.version.baseband"] ?? "")) {
              sections.push(`  Baseband: ${baseband}`);
            }
          }
        } else {
          sections.push("Mode: Single SIM");
          sections.push(`SIM state: ${props["gsm.sim.state"] ?? "unknown"}`);
          sections.push(`SIM operator: ${props["gsm.sim.operator.alpha"] ?? "unknown"} (${props["gsm.sim.operator.numeric"] ?? "?"})`);
        }

        sections.push("\n=== Network Registration ===");
        sections.push(`Network operator: ${props["gsm.operator.alpha"] ?? "unknown"} (${props["gsm.operator.numeric"] ?? "?"})`);
        sections.push(`Country: ${props["gsm.operator.iso-country"] ?? "unknown"}`);
        sections.push(`Network type: ${props["gsm.network.type"] ?? "unknown"}`);
        sections.push(`NITZ time: ${props["gsm.nitz.time"] ?? "not received"}`);

        // Try to get IMEI only if explicitly requested (sensitive permanent device identifier)
        if (includeImei) {
          const imeiResult = await ctx.bridge.shell(
            "service call iphonesubinfo 1 | grep -oP \"[0-9a-f]{8}\" | while read hex; do printf \"\\\\x$(echo $hex | sed 's/../\\\\x&/g')\"; done 2>/dev/null || echo UNAVAILABLE",
            { device: serial, ignoreExitCode: true, timeout: 5000 }
          );
          const imei = imeiResult.stdout.trim();
          if (imei && !imei.includes("UNAVAILABLE")) {
            sections.push(`\nIMEI: ${imei} (⚠ permanent device identifier)`);
          } else {
            sections.push("\nIMEI: unavailable (requires phone permission or root)");
          }
        } else {
          sections.push("\nIMEI: (omitted — set includeImei=true to retrieve)");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_cell_identity",
    "Extract detailed cell identity information: Cell ID (CID), TAC/LAC, EARFCN/ARFCN, Physical Cell ID (PCI), PLMN, and network type. Parses structured data from dumpsys for cellular network analysis.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const [phoneService, cellInfoList, serviceState] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys phone | grep -A 50 'mCellIdentity'", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys phone | grep -A 80 'mCellInfo'", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys phone | grep -A 30 'mServiceState'", { device: serial, timeout: 10000, ignoreExitCode: true }),
        ]);

        let output = "=== Serving Cell Identity ===\n";
        output += OutputProcessor.settledValue(phoneService, undefined, "Could not retrieve cell identity");
        output += "\n\n=== Cell Info List ===\n";
        output += OutputProcessor.settledValue(cellInfoList, undefined, "Could not retrieve cell info list");
        output += "\n\n=== Service State ===\n";
        output += OutputProcessor.settledValue(serviceState, undefined, "Could not retrieve service state");

        // Key getprop values for quick reference
        const [mcc, mnc, netType, identifiers] = await Promise.allSettled([
          ctx.bridge.shell("getprop gsm.operator.numeric", { device: serial }),
          ctx.bridge.shell("getprop gsm.sim.operator.numeric", { device: serial }),
          ctx.bridge.shell("getprop gsm.network.type", { device: serial }),
          ctx.bridge.shell("dumpsys phone | grep -i 'lac\\|tac\\|cid\\|earfcn\\|pci' | head -20", { device: serial, ignoreExitCode: true }),
        ]);

        output += "\n\n=== Quick Reference ===\n";
        output += `Network PLMN: ${OutputProcessor.settledValue(mcc)}\n`;
        output += `SIM PLMN: ${OutputProcessor.settledValue(mnc)}\n`;
        output += `Network type: ${OutputProcessor.settledValue(netType)}\n`;
        output += `Key identifiers:\n${OutputProcessor.settledValue(identifiers)}`;

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_signal_detail",
    "Get detailed signal strength measurements: RSRP, RSRQ, SINR, RSSI, timing advance, and signal bars. Provides raw radio measurements for signal analysis and anomaly detection.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const [signalStrength, cellSignal, rilSignal] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys phone | grep -A 15 'mSignalStrength'", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys phone | grep -A 10 'CellSignalStrength'", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys phone | grep -iE 'rsrp|rsrq|rssi|sinr|snr|ber|ecno|rscp|level|timingAdvance' | head -30", { device: serial, timeout: 10000, ignoreExitCode: true }),
        ]);

        let output = "=== Signal Strength ===\n";
        output += OutputProcessor.settledValue(signalStrength, undefined, "Could not retrieve signal strength");
        output += "\n\n=== Cell Signal Strength Detail ===\n";
        output += OutputProcessor.settledValue(cellSignal, undefined, "Could not retrieve cell signal");
        output += "\n\n=== Radio Measurements ===\n";
        output += OutputProcessor.settledValue(rilSignal, undefined, "Could not retrieve radio measurements");

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_neighboring_cells",
    "List all visible cells beyond the serving cell: neighboring LTE/5G/WCDMA/GSM cells with their identities and signal strengths. Useful for cellular network surveys, coverage analysis, and radio environment characterization.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const [cellInfoFull, neighborDump, registrationInfo] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys phone | sed -n '/mCellInfo/,/^[^ ]/p' | head -200", { device: serial, timeout: 15000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys phone | grep -A 5 'NeighboringCellInfo\\|CellInfoLte\\|CellInfoNr\\|CellInfoWcdma\\|CellInfoGsm' | head -100", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("dumpsys phone | grep -A 10 'NetworkRegistrationInfo' | head -60", { device: serial, timeout: 10000, ignoreExitCode: true }),
        ]);

        let output = "=== All Visible Cells ===\n";
        output += OutputProcessor.settledValue(cellInfoFull, 15000, "Could not retrieve cell info list");
        output += "\n\n=== Neighboring Cell Detail ===\n";
        output += OutputProcessor.settledValue(neighborDump, undefined, "Could not retrieve neighbor info");
        output += "\n\n=== Network Registration ===\n";
        output += OutputProcessor.settledValue(registrationInfo, undefined, "Could not retrieve registration info");

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_carrier_config",
    "Dump carrier configuration values. Useful for verifying carrier settings, detecting configuration anomalies, and inspecting APN configurations.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const [carrierConfig, carrierIdInfo, apnSettings] = await Promise.allSettled([
          ctx.bridge.shell("dumpsys carrier_config", { device: serial, timeout: 15000 }),
          ctx.bridge.shell("dumpsys phone | grep -A 10 'mCarrierId\\|carrierId\\|mSpecificCarrierId'", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("content query --uri content://telephony/carriers/preferapn 2>/dev/null || echo APN_QUERY_UNAVAILABLE", { device: serial, timeout: 10000, ignoreExitCode: true }),
        ]);

        let output = "=== Carrier Configuration ===\n";
        output += OutputProcessor.settledValue(carrierConfig, 20000, "Could not retrieve carrier config");
        output += "\n\n=== Carrier ID ===\n";
        output += OutputProcessor.settledValue(carrierIdInfo, undefined, "Could not retrieve carrier ID");
        output += "\n\n=== Preferred APN ===\n";
        output += OutputProcessor.settledValue(apnSettings, undefined, "Could not retrieve APN settings");

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_modem_logs",
    "Capture modem/baseband-related logs from multiple sources: RIL (Radio Interface Layer) logcat, telephony framework logs, and kernel modem messages via dmesg (root required for dmesg). Useful for radio diagnostics and tracing baseband-framework communication.",
    {
      lines: z.number().min(1).max(5000).optional().default(200).describe("Max lines per log source (1-5000, default 200)"),
      grep: z.string().optional().describe("Additional grep filter applied to all sources"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ lines, grep, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const maxLines = Math.min(lines, ctx.config.maxLogcatLines);

        if (grep) {
          const grepErr = validateShellArg(grep, "grep");
          if (grepErr) return { content: [{ type: "text", text: grepErr }], isError: true };
        }

        const grepSuffix = grep ? ` | grep -iF '${grep}'` : "";
        // Double-quotes intentional: this goes through rootShell (su -c '...'), so inner single quotes would break
        const dmesgGrepSuffix = grep ? ` | grep -iF "${grep}"` : "";

        const [rilLog, telephonyLog, radioLog, dmesgModem] = await Promise.allSettled([
          // RIL daemon logs from the radio buffer
          ctx.bridge.shell(`logcat -d -b radio -t ${maxLines}${grepSuffix}`, {
            device: serial, timeout: 10000, ignoreExitCode: true,
          }),
          // Telephony framework logs
          ctx.bridge.shell(`logcat -d -s Telephony:V TelephonyManager:V ServiceState:V GsmCdmaPhone:V -t ${maxLines}${grepSuffix}`, {
            device: serial, timeout: 10000, ignoreExitCode: true,
          }),
          // RILJ/RILC specific tags
          ctx.bridge.shell(`logcat -d -s RILJ:V RILC:V RIL:V -t ${maxLines}${grepSuffix}`, {
            device: serial, timeout: 10000, ignoreExitCode: true,
          }),
          // Kernel modem messages (requires root)
          ctx.bridge.rootShell(`dmesg | grep -iE "modem|baseband|shannon|ril|cellular|radio" | tail -${maxLines}${dmesgGrepSuffix}`, {
            device: serial, timeout: 10000, ignoreExitCode: true,
          }),
        ]);

        let output = "=== Radio Buffer (RIL) ===\n";
        output += OutputProcessor.settledValue(rilLog, 15000, "Could not retrieve radio log");
        output += "\n\n=== Telephony Framework ===\n";
        output += OutputProcessor.settledValue(telephonyLog, 10000, "Could not retrieve telephony log");
        output += "\n\n=== RIL Interface (RILJ/RILC) ===\n";
        output += OutputProcessor.settledValue(radioLog, 10000, "Could not retrieve RIL log");
        output += "\n\n=== Kernel Modem (dmesg, requires root) ===\n";
        output += OutputProcessor.settledValue(dmesgModem, 10000, "Could not retrieve dmesg (root required)");

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
