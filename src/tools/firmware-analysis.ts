/**
 * Modem Firmware Analysis — Comprehensive firmware version tracking and diffing.
 *
 * Parses and compares firmware version strings across OTA updates.
 * Understands version numbering conventions for major chipset families:
 *
 *   - Shannon/Exynos: Google Pixel/Tensor "g5123b-..." and Samsung "S5123AP_CL..." formats
 *   - Qualcomm: "MPSS.xx.yy.zz" (modem protocol software stack)
 *   - MediaTek: "MOLY.xxx.yyy" prefixed versions
 *   - Unisoc/Spreadtrum: SoC model + branch/version formats
 *   - HiSilicon/Kirin: Model + version with carrier codes, and encoded formats
 *   - Intel XMM: XMM model + branch/build formats
 *   - Generic: semver-like or date-based patterns
 *
 * Also parses bootloader versions (Pixel codename/version/build, Samsung model/carrier/revision)
 * and RIL implementation strings (Samsung S.LSI, Qualcomm, MediaTek).
 *
 * Builds on the OTA fingerprint system — reads saved fingerprints from
 * {tempDir}/ota-fingerprints/ to track firmware progression over time.
 * Can also query the live device for current firmware details.
 */

import { z } from "zod";
import { join } from "path";
import { readFileSync, existsSync, readdirSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { detectChipsetFamily } from "../middleware/chipset.js";

interface FirmwareInfo {
  raw: string;
  chipsetFamily: string;
  parsed: Record<string, string>;
}

/**
 * Parse a baseband firmware version string into structured components.
 * Different chipset families use different version formats.
 */
function parseFirmwareVersion(raw: string, chipsetFamily: string): FirmwareInfo {
  const info: FirmwareInfo = { raw, chipsetFamily, parsed: {} };

  if (!raw || raw === "unknown") return info;

  if (chipsetFamily === "shannon") {
    info.parsed.family = "Shannon/Exynos";

    // Google Pixel/Tensor format: "g5123b-145971-251030-B-14356419"
    // Pattern: <modemModel>-<changelist>-<YYMMDD>-<variant>-<buildNumber>
    const pixelMatch = raw.match(/^([a-z]\d{4}\w*)-(\d+)-(\d{6})-([A-Z])-(\d+)$/i);
    if (pixelMatch) {
      info.parsed.modemModel = pixelMatch[1];
      info.parsed.changelist = pixelMatch[2];
      const ds = pixelMatch[3];
      info.parsed.buildDate = `20${ds.substring(0, 2)}-${ds.substring(2, 4)}-${ds.substring(4, 6)}`;
      info.parsed.variant = pixelMatch[4];
      info.parsed.buildNumber = pixelMatch[5];
      return info;
    }

    // Classic Samsung format: "S5123AP_CL1234567_V1.2.3" or "SHANNON_xxxxx"
    const clMatch = raw.match(/CL(\d+)/i);
    if (clMatch) info.parsed.changelist = clMatch[1];
    const modelMatch = raw.match(/(S\d{4}\w*)/i);
    if (modelMatch) info.parsed.modemModel = modelMatch[1];
    const verMatch = raw.match(/V(\d+\.\d+[\.\d]*)/i);
    if (verMatch) info.parsed.version = verMatch[1];
    // Date patterns in Shannon strings (YYYYMMDD)
    const dateMatch = raw.match(/(\d{4})(\d{2})(\d{2})/);
    if (dateMatch && parseInt(dateMatch[1], 10) > 2010) {
      info.parsed.buildDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }
  } else if (chipsetFamily === "qualcomm") {
    // Qualcomm format: "MPSS.DE.3.1.1-00135-LAHAINA_GEN_PACK-1"
    info.parsed.family = "Qualcomm";
    const mpssMatch = raw.match(/MPSS\.(\S+)/i);
    if (mpssMatch) info.parsed.mpssVersion = mpssMatch[1];
    const genMatch = raw.match(/(\w+)_GEN_PACK/i);
    if (genMatch) info.parsed.platform = genMatch[1];
    const buildMatch = raw.match(/-(\d+)-/);
    if (buildMatch) info.parsed.buildNumber = buildMatch[1];
    // Extract version segments
    const segMatch = raw.match(/MPSS\.(\w+)\.(\d+)\.(\d+)\.(\d+)/i);
    if (segMatch) {
      info.parsed.branch = segMatch[1];
      info.parsed.major = segMatch[2];
      info.parsed.minor = segMatch[3];
      info.parsed.patch = segMatch[4];
    }
  } else if (chipsetFamily === "mediatek") {
    // MediaTek format: "MOLY.LR12A.R3.MP.V123.P45"
    info.parsed.family = "MediaTek";
    const molyMatch = raw.match(/MOLY\.(\S+)/i);
    if (molyMatch) info.parsed.molyVersion = molyMatch[1];
    const branchMatch = raw.match(/MOLY\.(\w+)\./i);
    if (branchMatch) info.parsed.branch = branchMatch[1];
    // Extract sub-version segments if present
    const segMatch = raw.match(/MOLY\.\w+\.(\w+)\.(\w+)\.(\w+)/i);
    if (segMatch) {
      info.parsed.release = segMatch[1];
      info.parsed.milestone = segMatch[2];
      info.parsed.revision = segMatch[3];
    }
  } else if (chipsetFamily === "unisoc") {
    // Unisoc/Spreadtrum formats:
    //   "UIS8581A3H00G_W21.50.6" — model + generation_version
    //   "S9863A1H10_U04.00.04" — SoC model + version
    //   "MOCOR5_Trunk_W24.22.2" — branch + version
    info.parsed.family = "Unisoc/Spreadtrum";
    const unisocMatch = raw.match(/^(\w+?)_(\w)(\d+\.\d+[\.\d]*)/);
    if (unisocMatch) {
      info.parsed.model = unisocMatch[1];
      info.parsed.branch = unisocMatch[2];
      info.parsed.version = unisocMatch[3];
    }
    // Model extraction for SoC-prefixed versions
    const socMatch = raw.match(/^((?:UIS|S|T)\d{4}\w*)/i);
    if (socMatch) info.parsed.socModel = socMatch[1];
  } else if (chipsetFamily === "hisilicon") {
    // HiSilicon/Kirin formats:
    //   "21C20B388S000C000" — encoded version string
    //   "Kirin990_11.0.1.168(C00E160R5P1)" — model + version with carrier code
    info.parsed.family = "HiSilicon/Kirin";
    const kirinMatch = raw.match(/(Kirin\d+)/i);
    if (kirinMatch) info.parsed.model = kirinMatch[1];
    const verMatch = raw.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (verMatch) info.parsed.version = verMatch[1];
    const carrierMatch = raw.match(/\((\w+)\)/);
    if (carrierMatch) info.parsed.carrierCode = carrierMatch[1];
    // Encoded format: extract segments
    const encodedMatch = raw.match(/^(\d{2})(\w)(\d{2})(\w)(\d+)/);
    if (encodedMatch && !kirinMatch) {
      info.parsed.majorVersion = encodedMatch[1];
      info.parsed.buildId = raw;
    }
  } else if (chipsetFamily === "intel") {
    // Intel XMM format: "XMM7560_LA_PEAR2.1-00115-GEN_PACK-1"
    info.parsed.family = "Intel XMM";
    const xmmMatch = raw.match(/(XMM\d+)/i);
    if (xmmMatch) info.parsed.model = xmmMatch[1];
    const verMatch = raw.match(/(\w+)\.(\d+)-(\d+)/);
    if (verMatch) {
      info.parsed.branch = verMatch[1];
      info.parsed.minor = verMatch[2];
      info.parsed.buildNumber = verMatch[3];
    }
  } else {
    // Generic: try date patterns, semver, or build numbers
    info.parsed.family = "Generic";
    const semverMatch = raw.match(/(\d+)\.(\d+)\.(\d+)/);
    if (semverMatch) {
      info.parsed.major = semverMatch[1];
      info.parsed.minor = semverMatch[2];
      info.parsed.patch = semverMatch[3];
    }
    const dateMatch = raw.match(/(\d{4})[\-.]?(\d{2})[\-.]?(\d{2})/);
    if (dateMatch && parseInt(dateMatch[1], 10) > 2010) {
      info.parsed.buildDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }
  }

  return info;
}

/**
 * Parse a bootloader version string into structured components.
 * Common formats:
 *   Pixel: "bluejay-16.4-14097577" → codename-version-build
 *   Samsung: "G991BXXS9FVL4" → model+carrier+revision
 *   Generic: semver or date-based
 */
function parseBootloaderVersion(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (!raw || raw === "unknown") return parsed;

  // Pixel/Google format: "codename-major.minor-buildnumber"
  const pixelBL = raw.match(/^(\w+)-(\d+\.\d+)-(\d+)$/);
  if (pixelBL) {
    parsed.codename = pixelBL[1];
    parsed.version = pixelBL[2];
    parsed.buildNumber = pixelBL[3];
    return parsed;
  }

  // Samsung format: model + carrier code + revision
  const samsungBL = raw.match(/^([A-Z]\d{3,4}\w?)([A-Z]{3,4})(\d?\w{3,5}\d?)$/);
  if (samsungBL) {
    parsed.model = samsungBL[1];
    parsed.carrierCode = samsungBL[2];
    parsed.revision = samsungBL[3];
    return parsed;
  }

  // Generic: just store the raw value
  parsed.raw = raw;
  return parsed;
}

/**
 * Parse the RIL implementation string into structured components.
 * Format: "Samsung S.LSI Vendor RIL 5400 V2.3 Build 2025-09-13 00:48:55"
 *         "android samsung-ril 1.0"
 *         "libril-qc-hal-qmi"
 */
function parseRilImpl(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (!raw || raw === "unknown") return parsed;

  // Samsung S.LSI format: "Samsung S.LSI Vendor RIL <id> V<ver> Build <date>"
  const samsungRil = raw.match(/Samsung\s+\S+\s+Vendor\s+RIL\s+(\d+)\s+V([\d.]+)\s+Build\s+([\d-]+\s*[\d:]*)/i);
  if (samsungRil) {
    parsed.vendor = "Samsung S.LSI";
    parsed.rilId = samsungRil[1];
    parsed.apiVersion = samsungRil[2];
    parsed.buildDate = samsungRil[3].trim();
    return parsed;
  }

  // Qualcomm format: "libril-qc-hal-qmi" or "android qualcomm-ril 1.0"
  if (raw.includes("qc") || raw.includes("qualcomm")) {
    parsed.vendor = "Qualcomm";
    const verMatch = raw.match(/([\d.]+)/);
    if (verMatch) parsed.version = verMatch[1];
    return parsed;
  }

  // MediaTek format: "mtk-ril" or similar
  if (raw.includes("mtk")) {
    parsed.vendor = "MediaTek";
    return parsed;
  }

  parsed.raw = raw;
  return parsed;
}

interface SavedFingerprint {
  timestamp: string;
  device: string;
  model: string;
  buildFingerprint?: string;
  basebandVersion: string;
  bootloaderVersion?: string;
  buildId: string;
  securityPatch: string;
  kernelVersion: string;
  androidVersion: string;
  sdkLevel?: string;
  buildDate?: string;
  incrementalBuild?: string;
  abUpdatePartition?: string;
  buildType?: string;
}

function getFingerprintDir(tempDir: string): string {
  return join(tempDir, "ota-fingerprints");
}

function loadFingerprints(dir: string, deviceFilter?: string): SavedFingerprint[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && (!deviceFilter || f.startsWith(deviceFilter)))
    .sort();

  const results: SavedFingerprint[] = [];
  for (const file of files) {
    try {
      results.push(JSON.parse(readFileSync(join(dir, file), "utf-8")));
    } catch { /* skip corrupt */ }
  }
  return results;
}

export function registerFirmwareAnalysisTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_firmware_probe",
    "Comprehensive firmware identification for the connected device. Reports all firmware components: baseband (parsed by chipset family — Shannon, Qualcomm, MediaTek, Unisoc, HiSilicon, Intel), bootloader, RIL implementation, kernel, security patch, A/B slot, verified boot state, and OTA-updatable partitions.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const family = detectChipsetFamily(props);

        const basebandRaw = props["gsm.version.baseband"] ?? "unknown";
        const rilImpl = props["gsm.version.ril-impl"] ?? "unknown";
        const bootloaderRaw = props["ro.bootloader"] ?? "unknown";
        const firmware = parseFirmwareVersion(basebandRaw, family);
        const bootloaderParsed = parseBootloaderVersion(bootloaderRaw);
        const rilParsed = parseRilImpl(rilImpl);

        const sections: string[] = [];
        sections.push("=== Comprehensive Firmware Analysis ===");
        sections.push(`Device: ${props["ro.product.model"] ?? "unknown"} (${serial})`);
        sections.push(`Chipset family: ${family}`);

        // ── Baseband ──
        sections.push(`\n── Baseband Firmware ──`);
        sections.push(`Raw: ${basebandRaw}`);
        if (props["ro.build.expect.baseband"] && props["ro.build.expect.baseband"] !== basebandRaw) {
          sections.push(`Expected: ${props["ro.build.expect.baseband"]}`);
        }
        if (Object.keys(firmware.parsed).length > 0) {
          sections.push("Parsed:");
          for (const [key, value] of Object.entries(firmware.parsed)) {
            sections.push(`  ${key}: ${value}`);
          }
        }

        // ── Bootloader ──
        sections.push(`\n── Bootloader ──`);
        sections.push(`Raw: ${bootloaderRaw}`);
        if (props["ro.build.expect.bootloader"] && props["ro.build.expect.bootloader"] !== bootloaderRaw) {
          sections.push(`Expected: ${props["ro.build.expect.bootloader"]}`);
        }
        if (Object.keys(bootloaderParsed).length > 0 && !bootloaderParsed.raw) {
          sections.push("Parsed:");
          for (const [key, value] of Object.entries(bootloaderParsed)) {
            sections.push(`  ${key}: ${value}`);
          }
        }

        // ── RIL Implementation ──
        sections.push(`\n── RIL Implementation ──`);
        sections.push(`Raw: ${rilImpl}`);
        if (Object.keys(rilParsed).length > 0 && !rilParsed.raw) {
          sections.push("Parsed:");
          for (const [key, value] of Object.entries(rilParsed)) {
            sections.push(`  ${key}: ${value}`);
          }
        }

        // ── Kernel ──
        const kernelVersion = props["ro.kernel.version"] ?? "unknown";
        sections.push(`\n── Kernel ──`);
        sections.push(`Version: ${kernelVersion}`);

        // ── Security & Build ──
        sections.push(`\n── Security & Build ──`);
        sections.push(`Android version: ${props["ro.build.version.release"] ?? "unknown"} (SDK ${props["ro.build.version.sdk"] ?? "?"})`);
        sections.push(`Security patch: ${props["ro.build.version.security_patch"] ?? "unknown"}`);
        sections.push(`Vendor security patch: ${props["ro.vendor.build.security_patch"] ?? "unknown"}`);
        sections.push(`Build ID: ${props["ro.build.id"] ?? "unknown"}`);
        sections.push(`Build fingerprint: ${props["ro.build.fingerprint"] ?? "unknown"}`);

        // ── A/B Partition & Boot ──
        const slotSuffix = props["ro.boot.slot_suffix"] ?? "";
        const abUpdate = props["ro.build.ab_update"] ?? "false";
        sections.push(`\n── Partition & Boot ──`);
        sections.push(`A/B update: ${abUpdate}`);
        if (slotSuffix) sections.push(`Active slot: ${slotSuffix}`);
        sections.push(`Secure boot: ${props["ro.boot.secure_boot"] ?? "unknown"}`);
        sections.push(`Verified boot state: ${props["ro.boot.verifiedbootstate"] ?? "unknown"}`);
        sections.push(`Flash lock: ${props["ro.boot.flash.locked"] === "1" ? "locked" : props["ro.boot.flash.locked"] === "0" ? "unlocked" : "unknown"}`);

        // ── VBMeta ──
        const vbmetaDigest = props["ro.boot.vbmeta.digest"];
        if (vbmetaDigest) {
          sections.push(`\n── Verified Boot Metadata ──`);
          sections.push(`AVB version: ${props["ro.boot.vbmeta.avb_version"] ?? "?"}`);
          sections.push(`Hash algorithm: ${props["ro.boot.vbmeta.hash_alg"] ?? "?"}`);
          sections.push(`Digest: ${vbmetaDigest.substring(0, 32)}...`);
        }

        // ── OTA Partitions ──
        const otaParts = props["ro.product.ab_ota_partitions"];
        if (otaParts) {
          const parts = otaParts.split(",").map(p => p.trim()).filter(p => p);
          sections.push(`\n── OTA Partitions (${parts.length}) ──`);
          sections.push(parts.join(", "));
        }

        // ── Hypervisor ──
        const hvVersion = props["ro.boot.hypervisor.version"];
        if (hvVersion) {
          sections.push(`\n── Hypervisor ──`);
          sections.push(`Version: ${hvVersion}`);
          sections.push(`VM supported: ${props["ro.boot.hypervisor.vm.supported"] ?? "?"}`);
          sections.push(`Protected VM: ${props["ro.boot.hypervisor.protected_vm.supported"] ?? "?"}`);
        }

        // ── Radio properties ──
        const radioProps = [
          "gsm.nitz.time",
          "gsm.operator.numeric",
          "gsm.sim.operator.numeric",
          "ro.telephony.default_network",
          "persist.radio.multisim.config",
        ];
        const extras: string[] = [];
        for (const prop of radioProps) {
          const val = props[prop];
          if (val) extras.push(`  ${prop}: ${val}`);
        }
        if (extras.length > 0) {
          sections.push(`\nRadio properties:`);
          sections.push(...extras);
        }

        // ── WiFi / Bluetooth / NFC firmware summary ──
        const wifiFw = props["vendor.wifi.firmware.version"] ?? props["wifi.firmware.version"] ?? "";
        const wifiHw = props["ro.hardware.wifi"] ?? "";
        const btFw = props["vendor.bluetooth.firmware.version"] ?? props["bluetooth.firmware.version"] ?? "";
        const btHw = props["ro.hardware.bt"] ?? "";
        const nfcHw = props["ro.hardware.nfc"] ?? props["ro.hardware.nfc_nci"] ?? "";

        sections.push(`\n── Wireless Firmware ──`);
        if (wifiHw) sections.push(`WiFi hardware: ${wifiHw}`);
        if (wifiFw) sections.push(`WiFi firmware: ${wifiFw}`);
        if (btHw) sections.push(`Bluetooth hardware: ${btHw}`);
        if (btFw) sections.push(`Bluetooth firmware: ${btFw}`);
        if (nfcHw) sections.push(`NFC hardware: ${nfcHw}`);
        const gpsHw = props["ro.hardware.gps"] ?? "";
        if (gpsHw) sections.push(`GPS hardware: ${gpsHw}`);
        if (!wifiFw && !wifiHw && !btFw && !btHw && !nfcHw && !gpsHw) {
          sections.push(`No wireless firmware properties exposed via getprop on this device`);
        }
        sections.push(`(Use adb_wifi_firmware, adb_bluetooth_firmware, adb_nfc_firmware, adb_gps_firmware for detailed info via dumpsys)`);

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_firmware_diff",
    "Compare all firmware components between two saved OTA fingerprints, or between the current device state and a saved fingerprint. Compares baseband (with chipset-specific parsed component diffs), bootloader, kernel, security patch, build ID, and Android version.",
    {
      from: z.string().optional().describe("Path to 'from' fingerprint JSON (or 'current' to use live device state). Defaults to the second-most-recent fingerprint."),
      to: z.string().optional().describe("Path to 'to' fingerprint JSON (or 'current' to use live device state). Defaults to the most recent fingerprint."),
      device: z.string().optional().describe("Device serial (used when 'from' or 'to' is 'current', or for auto-selecting fingerprints)"),
    },
    async ({ from, to, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const family = detectChipsetFamily(props);

        const dir = getFingerprintDir(ctx.config.tempDir);
        const safeDevice = serial.replace(/[^a-zA-Z0-9_-]/g, "_");

        // Helper: build a firmware component map from live device or saved fingerprint
        // Only includes fields that are stored in both live state and saved fingerprints
        // to avoid misleading "(absent)" diffs. RIL implementation is excluded because
        // saved OTA fingerprints don't capture it.
        function currentComponents(): Record<string, string> {
          return {
            baseband: props["gsm.version.baseband"] ?? "unknown",
            bootloader: props["ro.bootloader"] ?? "unknown",
            kernel: props["ro.kernel.version"] ?? "unknown",
            securityPatch: props["ro.build.version.security_patch"] ?? "unknown",
            buildId: props["ro.build.id"] ?? "unknown",
            androidVersion: props["ro.build.version.release"] ?? "unknown",
          };
        }

        function fpComponents(fp: SavedFingerprint): Record<string, string> {
          return {
            baseband: fp.basebandVersion ?? "unknown",
            bootloader: fp.bootloaderVersion ?? "unknown",
            kernel: fp.kernelVersion ?? "unknown",
            securityPatch: fp.securityPatch ?? "unknown",
            buildId: fp.buildId ?? "unknown",
            androidVersion: fp.androidVersion ?? "unknown",
          };
        }

        // Resolve 'from'
        let fromComps: Record<string, string>;
        let fromLabel: string;
        if (from === "current") {
          fromComps = currentComponents();
          fromLabel = "current device";
        } else if (from) {
          if (!existsSync(from)) return { content: [{ type: "text", text: `File not found: ${from}` }], isError: true };
          try {
            fromComps = fpComponents(JSON.parse(readFileSync(from, "utf-8")));
            fromLabel = from.split(/[\\/]/).pop() ?? from;
          } catch {
            return { content: [{ type: "text", text: `Corrupt fingerprint: ${from}` }], isError: true };
          }
        } else {
          const fps = loadFingerprints(dir, safeDevice);
          if (fps.length < 2) {
            return { content: [{ type: "text", text: `Need at least 2 fingerprints to auto-diff. Found ${fps.length}.` }], isError: true };
          }
          fromComps = fpComponents(fps[fps.length - 2]);
          fromLabel = fps[fps.length - 2].timestamp?.substring(0, 19) ?? "older";
        }

        // Resolve 'to'
        let toComps: Record<string, string>;
        let toLabel: string;
        if (to === "current") {
          toComps = currentComponents();
          toLabel = "current device";
        } else if (to) {
          if (!existsSync(to)) return { content: [{ type: "text", text: `File not found: ${to}` }], isError: true };
          try {
            toComps = fpComponents(JSON.parse(readFileSync(to, "utf-8")));
            toLabel = to.split(/[\\/]/).pop() ?? to;
          } catch {
            return { content: [{ type: "text", text: `Corrupt fingerprint: ${to}` }], isError: true };
          }
        } else {
          const fps = loadFingerprints(dir, safeDevice);
          if (fps.length < 1) {
            return { content: [{ type: "text", text: "No fingerprints saved. Use adb_ota_fingerprint first." }], isError: true };
          }
          toComps = fpComponents(fps[fps.length - 1]);
          toLabel = fps[fps.length - 1].timestamp?.substring(0, 19) ?? "newest";
        }

        const sections: string[] = [];
        sections.push("=== Comprehensive Firmware Diff ===");
        sections.push(`Chipset: ${family}`);
        sections.push(`From: ${fromLabel}`);
        sections.push(`To:   ${toLabel}`);

        // Compare all firmware components
        const componentLabels: Record<string, string> = {
          baseband: "Baseband",
          bootloader: "Bootloader",
          kernel: "Kernel",
          securityPatch: "Security Patch",
          buildId: "Build ID",
          androidVersion: "Android Version",
        };

        const changed: string[] = [];
        const unchanged: string[] = [];
        const allKeys = new Set([...Object.keys(fromComps), ...Object.keys(toComps)]);

        for (const key of allKeys) {
          const fv = fromComps[key] ?? "(absent)";
          const tv = toComps[key] ?? "(absent)";
          const label = componentLabels[key] ?? key;
          if (fv !== tv) {
            changed.push(`  ✗ ${label}: ${fv} → ${tv}`);
          } else {
            unchanged.push(`  ✓ ${label}: ${fv}`);
          }
        }

        if (changed.length === 0) {
          sections.push("\nResult: ✓ IDENTICAL — all firmware components unchanged.");
        } else {
          sections.push(`\nResult: ✗ ${changed.length} component(s) changed\n`);
          sections.push("Changed:");
          sections.push(...changed);

          // Deep baseband diff if baseband changed
          if (fromComps.baseband !== toComps.baseband) {
            const fromParsed = parseFirmwareVersion(fromComps.baseband, family);
            const toParsed = parseFirmwareVersion(toComps.baseband, family);
            const parsedKeys = new Set([...Object.keys(fromParsed.parsed), ...Object.keys(toParsed.parsed)]);
            const parsedChanges: string[] = [];
            for (const pk of parsedKeys) {
              const fpv = fromParsed.parsed[pk] ?? "(absent)";
              const tpv = toParsed.parsed[pk] ?? "(absent)";
              if (fpv !== tpv && pk !== "family") {
                parsedChanges.push(`    ${pk}: "${fpv}" → "${tpv}"`);
              }
            }
            if (parsedChanges.length > 0) {
              sections.push("\n  Baseband parsed diffs:");
              sections.push(...parsedChanges);
            }
          }

          // Deep bootloader diff if bootloader changed
          if (fromComps.bootloader !== toComps.bootloader) {
            const fromBL = parseBootloaderVersion(fromComps.bootloader);
            const toBL = parseBootloaderVersion(toComps.bootloader);
            const blKeys = new Set([...Object.keys(fromBL), ...Object.keys(toBL)]);
            const blChanges: string[] = [];
            for (const bk of blKeys) {
              if (bk === "raw") continue;
              const fbv = fromBL[bk] ?? "(absent)";
              const tbv = toBL[bk] ?? "(absent)";
              if (fbv !== tbv) blChanges.push(`    ${bk}: "${fbv}" → "${tbv}"`);
            }
            if (blChanges.length > 0) {
              sections.push("\n  Bootloader parsed diffs:");
              sections.push(...blChanges);
            }
          }
        }

        if (unchanged.length > 0) {
          sections.push("\nUnchanged:");
          sections.push(...unchanged);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_firmware_history",
    "Show firmware version progression across all saved OTA fingerprints for a device. Tracks baseband, bootloader, kernel, security patch, and build ID changes between consecutive snapshots with parsed component diffs.",
    {
      device: z.string().optional().describe("Device serial (filters fingerprints to this device)"),
    },
    async ({ device }) => {
      try {
        let serial: string | undefined;
        let family = "generic";

        if (device) {
          const resolved = await ctx.deviceManager.resolveDevice(device);
          serial = resolved.serial;
          const props = await ctx.deviceManager.getDeviceProps(serial);
          family = detectChipsetFamily(props);
        }

        const dir = getFingerprintDir(ctx.config.tempDir);
        const safeDevice = serial?.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fps = loadFingerprints(dir, safeDevice);

        if (fps.length === 0) {
          return { content: [{ type: "text", text: "No fingerprints saved. Use adb_ota_fingerprint to start tracking." }], isError: true };
        }

        const sections: string[] = [];
        sections.push("=== Firmware Version History ===");
        sections.push(`${fps.length} fingerprint(s)\n`);

        // Tracked fields for change detection
        const trackedFields: Array<{ key: keyof SavedFingerprint; label: string }> = [
          { key: "basebandVersion", label: "Baseband" },
          { key: "bootloaderVersion", label: "Bootloader" },
          { key: "kernelVersion", label: "Kernel" },
          { key: "securityPatch", label: "Security Patch" },
          { key: "buildId", label: "Build ID" },
          { key: "androidVersion", label: "Android" },
        ];

        let totalChanges = 0;
        for (let i = 0; i < fps.length; i++) {
          const fp = fps[i];
          const prev = i > 0 ? fps[i - 1] : null;

          // Detect changes across all tracked fields
          const fieldChanges: string[] = [];
          if (prev) {
            for (const { key, label } of trackedFields) {
              const pv = String(prev[key] ?? "");
              const cv = String(fp[key] ?? "");
              if (pv && cv && pv !== cv) {
                fieldChanges.push(`     ${label}: ${pv} → ${cv}`);
              }
            }
          }

          if (fieldChanges.length > 0) totalChanges++;
          const marker = fieldChanges.length > 0 ? ` ⚠ ${fieldChanges.length} CHANGE(S)` : "";
          sections.push(`[${i + 1}] ${fp.timestamp?.substring(0, 19) ?? "?"} | ${fp.basebandVersion ?? "unknown"}${marker}`);

          // Show deep baseband parsed diffs
          if (prev && prev.basebandVersion !== fp.basebandVersion) {
            const fromParsed = parseFirmwareVersion(prev.basebandVersion, family);
            const toParsed = parseFirmwareVersion(fp.basebandVersion, family);
            const allKeys = new Set([...Object.keys(fromParsed.parsed), ...Object.keys(toParsed.parsed)]);
            for (const key of allKeys) {
              const fv = fromParsed.parsed[key];
              const tv = toParsed.parsed[key];
              if (fv !== tv && key !== "family") {
                sections.push(`       baseband.${key}: "${fv ?? "(absent)"}" → "${tv ?? "(absent)"}"`);
              }
            }
          }

          // Show non-baseband field changes
          if (fieldChanges.length > 0) {
            for (const change of fieldChanges) {
              if (!change.includes("Baseband:")) sections.push(change);
            }
          }
        }

        sections.push(`\nSnapshots with firmware changes: ${totalChanges}`);
        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
