// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Device Profile Library — Device-specific knowledge base.
 *
 * Maintains a library of device profiles containing known modem device nodes,
 * chipset quirks, supported AT command sets, root method requirements, and
 * hardware capabilities. Improves auto-detection accuracy across the tool suite.
 *
 * Profiles can be auto-detected from connected devices and saved for reuse,
 * or loaded from the built-in library of known devices. Community contributions
 * can extend the library through saved profiles.
 *
 * Profiles are stored as JSON in {tempDir}/device-profiles/.
 */

import { z } from "zod";
import { join } from "path";
import { readFileSync, existsSync, readdirSync} from "fs";
import { ensurePrivateDir, sanitizeFilenameComponent, writeAtomicSync} from "../middleware/fs-utils.js";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { MODEM_PATHS, detectChipsetFamily, detectSimConfig } from "../middleware/chipset.js";

interface DeviceProfile {
  /** Profile metadata */
  name: string;
  timestamp: string;
  source: "auto-detected" | "manual" | "built-in";

  /** Device identification */
  model: string;
  manufacturer: string;
  device: string;         // ro.product.device (codename)
  hardware: string;       // ro.hardware
  boardPlatform: string;  // ro.board.platform
  chipname: string;       // ro.hardware.chipname
  socModel: string;       // ro.soc.model

  /** Modem/radio information */
  chipsetFamily: string;  // shannon, qualcomm, mediatek, unisoc, generic
  basebandVersion: string;
  rilImplementation: string;
  modemDeviceNodes: string[];
  respondingAtPort: string | null;

  /** Capabilities */
  rootAvailable: boolean;
  androidVersion: string;
  sdkLevel: number;
  abPartition: boolean;
  supports5G: boolean;
  dualSim: boolean;
  simSlots: number;

  /** Known quirks or notes */
  quirks: string[];
}

/** Built-in profiles for well-known devices. */
const BUILTIN_PROFILES: Partial<DeviceProfile>[] = [
  {
    name: "Pixel 6a (bluejay)",
    model: "Pixel 6a",
    device: "bluejay",
    hardware: "bluejay",
    chipname: "s5e8535",
    chipsetFamily: "shannon",
    modemDeviceNodes: ["/dev/umts_router0", "/dev/umts_router1", "/dev/umts_atc0"],
    supports5G: false,
    quirks: [
      "Shannon/Exynos Modem 5123 baseband",
      "AT commands via /dev/umts_router0 (root required)",
      "Radio logcat uses RILJ/RILC tags",
    ],
  },
  {
    name: "Pixel 7 (panther)",
    model: "Pixel 7",
    device: "panther",
    chipname: "s5e9925",
    chipsetFamily: "shannon",
    modemDeviceNodes: ["/dev/umts_router0", "/dev/umts_router1"],
    supports5G: true,
    quirks: [
      "Shannon/Exynos Modem 5300 baseband",
      "Supports NR NSA and SA",
    ],
  },
  {
    name: "Pixel 8 (shiba)",
    model: "Pixel 8",
    device: "shiba",
    chipname: "s5e9945",
    chipsetFamily: "shannon",
    modemDeviceNodes: ["/dev/umts_router0", "/dev/umts_router1"],
    supports5G: true,
    quirks: [
      "Shannon/Exynos Modem 5400 baseband",
      "Tensor G3 SoC with integrated modem",
    ],
  },
  {
    name: "Samsung Galaxy S24 (e2s)",
    model: "SM-S921",
    device: "e2s",
    chipsetFamily: "qualcomm",
    modemDeviceNodes: ["/dev/smd11", "/dev/smd7"],
    supports5G: true,
    quirks: [
      "Snapdragon 8 Gen 3 (US/KR) or Exynos 2400 (global)",
      "Modem paths vary by SoC variant",
      "Qualcomm variant: /dev/smd11, Exynos variant: /dev/umts_router0",
    ],
  },
  {
    name: "OnePlus (generic Qualcomm)",
    model: "OnePlus",
    chipsetFamily: "qualcomm",
    modemDeviceNodes: ["/dev/smd11", "/dev/smd7", "/dev/smd0"],
    supports5G: true,
    quirks: [
      "Most OnePlus devices use Qualcomm Snapdragon",
      "AT command access typically via /dev/smd11",
    ],
  },
];

function getProfileDir(tempDir: string): string {
  return join(tempDir, "device-profiles");
}

export function registerDeviceProfileTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_profile_detect",
    "Auto-detect and build a device profile from the connected device. Captures hardware identification, chipset family, modem info, root status, and matches against the built-in profile library for known quirks.",
    {
      save: z.boolean().optional().default(false).describe("Automatically save the detected profile"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ save, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const family = detectChipsetFamily(props);

        // Check root
        let rootAvailable = false;
        try {
          const rootResult = await ctx.bridge.shell("su -c id", {
            device: serial, timeout: 5000, ignoreExitCode: true,
          });
          rootAvailable = rootResult.stdout.includes("uid=0");
        } catch { /* no root */ }

        // Check 5G support
        const supports5G = (props["gsm.network.type"] ?? "").includes("NR") ||
          (props["ro.telephony.default_network"] ?? "").includes("26") ||
          (props["ro.telephony.default_network"] ?? "").includes("33");

        // Check A/B
        const abPartition = (props["ro.boot.slot_suffix"] ?? "").length > 0;

        // Check dual SIM (shared logic in chipset.ts)
        const { dualSim, simSlots } = detectSimConfig(props);

        // Probe modem device nodes using shared MODEM_PATHS
        const paths = MODEM_PATHS[family] ?? MODEM_PATHS.generic;
        let existingNodes: string[] = [];
        const respondingPort: string | null = null;

        if (rootAvailable) {
          const existCmd = paths.map((p) => `test -e ${p} && echo "EXISTS:${p}"`).join("; ");
          const existResult = await ctx.bridge.rootShell(existCmd, {
            device: serial, timeout: 10000, ignoreExitCode: true,
          });
          existingNodes = existResult.stdout.split("\n")
            .filter((l) => l.startsWith("EXISTS:"))
            .map((l) => l.replace("EXISTS:", "").trim());
        }

        const profile: DeviceProfile = {
          name: `${props["ro.product.model"] ?? "Unknown"} (${props["ro.product.device"] ?? serial})`,
          timestamp: new Date().toISOString(),
          source: "auto-detected",
          model: props["ro.product.model"] ?? "unknown",
          manufacturer: props["ro.product.manufacturer"] ?? "unknown",
          device: props["ro.product.device"] ?? "unknown",
          hardware: props["ro.hardware"] ?? "unknown",
          boardPlatform: props["ro.board.platform"] ?? "unknown",
          chipname: props["ro.hardware.chipname"] ?? "unknown",
          socModel: props["ro.soc.model"] ?? "unknown",
          chipsetFamily: family,
          basebandVersion: props["gsm.version.baseband"] ?? "unknown",
          rilImplementation: props["gsm.version.ril-impl"] ?? "unknown",
          modemDeviceNodes: existingNodes,
          respondingAtPort: respondingPort,
          rootAvailable,
          androidVersion: props["ro.build.version.release"] ?? "unknown",
          sdkLevel: parseInt(props["ro.build.version.sdk"] ?? "0", 10) || 0,
          abPartition,
          supports5G,
          dualSim,
          simSlots,
          quirks: [],
        };

        // Match against built-in profiles
        const deviceCodename = profile.device.toLowerCase();
        const builtinMatch = BUILTIN_PROFILES.find((bp) =>
          bp.device?.toLowerCase() === deviceCodename ||
          bp.model?.toLowerCase() === profile.model.toLowerCase()
        );

        if (builtinMatch) {
          profile.quirks = builtinMatch.quirks ?? [];
          // Supplement modem paths from built-in if we couldn't probe (no root)
          if (existingNodes.length === 0 && builtinMatch.modemDeviceNodes) {
            profile.modemDeviceNodes = builtinMatch.modemDeviceNodes;
          }
        }

        // Save if requested
        if (save) {
          const dir = getProfileDir(ctx.config.tempDir);
          if (!existsSync(dir)) ensurePrivateDir(dir);
          const safeName = sanitizeFilenameComponent(profile.device);
          const filePath = join(dir, `${safeName}.json`);
          writeAtomicSync(filePath, JSON.stringify(profile, null, 2));
          profile.quirks.push(`(saved to ${filePath})`);
        }

        // Format output
        const sections: string[] = [];
        sections.push(`=== Device Profile ===`);
        sections.push(`Name: ${profile.name}`);
        sections.push(`Manufacturer: ${profile.manufacturer}`);
        sections.push(`Chipset: ${profile.chipname} (${profile.chipsetFamily})`);
        sections.push(`Platform: ${profile.boardPlatform}`);
        sections.push(`SoC: ${profile.socModel}`);
        sections.push(`Android: ${profile.androidVersion} (SDK ${profile.sdkLevel})`);
        sections.push(`Baseband: ${profile.basebandVersion}`);
        sections.push(`RIL: ${profile.rilImplementation}`);
        sections.push(`Root: ${profile.rootAvailable ? "available" : "not available"}`);
        sections.push(`5G: ${profile.supports5G ? "supported" : "not detected"}`);
        sections.push(`Dual SIM: ${profile.dualSim ? `yes (${profile.simSlots} slots)` : "no"}`);
        sections.push(`A/B partition: ${profile.abPartition ? "yes" : "no"}`);

        if (profile.modemDeviceNodes.length > 0) {
          sections.push(`\nModem device nodes: ${profile.modemDeviceNodes.join(", ")}`);
        } else {
          sections.push(`\nModem device nodes: none found${rootAvailable ? "" : " (root required to probe)"}`);
        }

        if (builtinMatch) {
          sections.push(`\nMatched built-in profile: ${builtinMatch.name}`);
        }

        if (profile.quirks.length > 0) {
          sections.push(`\nKnown quirks/notes:`);
          for (const q of profile.quirks) sections.push(`  - ${q}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // Z1 fix: Zod schema for DeviceProfile so save-time validation rejects
  // malformed payloads (wrong types, missing required fields, mistyped
  // booleans, etc.). Uses z.looseObject() (the Zod 4 replacement for the
  // deprecated z.object().passthrough() pattern) so extra fields are kept
  // as the structure evolves while the known fields stay locked. The
  // optional sections match the Partial<DeviceProfile> shape used by
  // built-in profiles.
  const deviceProfileSchema = z.looseObject({
    name: z.string().min(1),
    timestamp: z.string().optional(),
    source: z.enum(["auto-detected", "manual", "built-in"]).optional(),
    model: z.string().optional(),
    manufacturer: z.string().optional(),
    device: z.string().optional(),
    hardware: z.string().optional(),
    boardPlatform: z.string().optional(),
    chipname: z.string().optional(),
    socModel: z.string().optional(),
    chipsetFamily: z.string().optional(),
    basebandVersion: z.string().optional(),
    rilImplementation: z.string().optional(),
    modemDeviceNodes: z.array(z.string()).optional(),
    respondingAtPort: z.string().nullable().optional(),
    rootAvailable: z.boolean().optional(),
    androidVersion: z.string().optional(),
    sdkLevel: z.number().int().min(1).max(99).optional(),
    abPartition: z.boolean().optional(),
    supports5G: z.boolean().optional(),
    dualSim: z.boolean().optional(),
    simSlots: z.number().int().min(0).max(8).optional(),
    quirks: z.array(z.string()).optional(),
  });

  ctx.server.tool(
    "adb_profile_save",
    "Save a device profile to the profiles library. Use after adb_profile_detect to persist the profile, or create a manual profile with custom quirks and notes.",
    {
      name: z.string().describe("Profile name (used as filename)"),
      profile: z.string().describe("Profile JSON string (from adb_profile_detect output or manually composed)"),
    },
    async ({ name, profile }) => {
      try {
        // Z5 fix: cap profile string size at 1 MB. A profile JSON has no
        // legitimate reason to exceed ~10 KB (manufacturer/model strings,
        // ~20 properties); 1 MB is a cheap defense against an operator
        // typo or paste mistake filling the temp directory.
        const Z5_MAX_PROFILE_BYTES = 1024 * 1024;
        if (profile.length > Z5_MAX_PROFILE_BYTES) {
          return { content: [{ type: "text", text: `Profile JSON too large (${profile.length} bytes, max ${Z5_MAX_PROFILE_BYTES}). Real device profiles should be under ~10 KB; if you intentionally need to store more, increase the cap in device-profiles.ts.` }], isError: true };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(profile);
        } catch (err) {
          return { content: [{ type: "text", text: `Invalid JSON: ${err instanceof Error ? err.message : err}` }], isError: true };
        }
        // Z1 fix: validate against schema after JSON parse
        const validation = deviceProfileSchema.safeParse(parsed);
        if (!validation.success) {
          const issues = validation.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
          return { content: [{ type: "text", text: `Profile schema validation failed: ${issues}` }], isError: true };
        }
        const validated = validation.data;

        // Z2 fix: validate that the `name` parameter (filename) matches
        // `profile.name` (internal field). Divergence creates confusing
        // listings where adb_profile_list shows one name but the file
        // is called something else. If the operator omits `profile.name`
        // we auto-derive from `name`; if it's present and differs, reject.
        if (validated.name && validated.name !== name) {
          return { content: [{ type: "text", text: `Profile name mismatch: parameter "name" is "${name}" but profile.name is "${validated.name}". They must match, or omit profile.name and it will be auto-derived from the parameter.` }], isError: true };
        }
        if (!validated.name) {
          validated.name = name;
        }
        const parsedFinal = validated;

        const dir = getProfileDir(ctx.config.tempDir);
        if (!existsSync(dir)) ensurePrivateDir(dir);

        const safeName = sanitizeFilenameComponent(name);
        const filePath = join(dir, `${safeName}.json`);
        writeAtomicSync(filePath, JSON.stringify(parsedFinal, null, 2));

        return { content: [{ type: "text", text: `Profile saved: ${filePath}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_profile_list",
    "List all device profiles: built-in library entries and user-saved profiles.",
    {},
    async () => {
      try {
        const sections: string[] = [];

        // Built-in profiles
        sections.push(`=== Built-in Profiles (${BUILTIN_PROFILES.length}) ===\n`);
        for (const bp of BUILTIN_PROFILES) {
          const quirksPreview = bp.quirks?.[0] ?? "";
          sections.push(`${bp.name ?? "Unknown"} [${bp.chipsetFamily}]${quirksPreview ? " — " + quirksPreview : ""}`);
        }

        // Saved profiles
        const dir = getProfileDir(ctx.config.tempDir);
        if (existsSync(dir)) {
          const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
          if (files.length > 0) {
            sections.push(`\n=== Saved Profiles (${files.length}) ===\n`);
            for (const file of files) {
              try {
                const p: DeviceProfile = JSON.parse(readFileSync(join(dir, file), "utf-8"));
                sections.push(`${p.name} [${p.chipsetFamily}] — ${p.source}, ${p.timestamp.substring(0, 10)}`);
              } catch {
                sections.push(`${file} — (corrupt JSON)`);
              }
            }
            sections.push(`\nProfile directory: ${dir}`);
          }
        } else {
          sections.push("\nNo saved profiles yet. Use adb_profile_detect with save=true.");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
