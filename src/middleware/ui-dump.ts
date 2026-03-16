/**
 * UI Dump Utilities — Shared uiautomator XML capture and attribute parsing.
 *
 * Used by ui.ts, accessibility.ts, and test-gen.ts to avoid duplicating
 * the dump→cat→rm pattern and regex-based attribute extraction.
 */

import { AdbBridge } from "../bridge/adb-bridge.js";
import { isOnDevice } from "../config/config.js";
import { shellEscape } from "./sanitize.js";

/**
 * Pre-compiled regexes for uiautomator XML attribute extraction.
 * Avoids creating new RegExp objects inside hot parsing loops.
 */
export const UI_ATTR_REGEXES: Record<string, RegExp> = {
  "resource-id": /resource-id="([^"]*)"/,
  "text": /\btext="([^"]*)"/,
  "content-desc": /content-desc="([^"]*)"/,
  "class": /\bclass="([^"]*)"/,
  "clickable": /clickable="([^"]*)"/,
  "scrollable": /scrollable="([^"]*)"/,
  "focusable": /focusable="([^"]*)"/,
  "enabled": /enabled="([^"]*)"/,
  "bounds": /bounds="([^"]*)"/,
};

/** Extract an attribute value from a uiautomator node attributes string. */
export function getAttr(attrs: string, name: string): string {
  const regex = UI_ATTR_REGEXES[name];
  if (!regex) return "";
  const m = attrs.match(regex);
  return m ? m[1] : "";
}

/**
 * Capture the UI hierarchy XML from the device.
 * Handles the dump → cat → cleanup sequence in one place.
 * Uses a unique dump path per call to avoid collisions across concurrent tool invocations.
 * Cleanup runs in a finally block to prevent device file leaks on errors.
 * Returns the XML string, or null if the dump failed.
 */
export async function captureUiDump(
  bridge: AdbBridge,
  serial: string,
  dumpPath?: string,
): Promise<string | null> {
  // On-device: use /data/local/tmp/ which is world-readable/writable — avoids
  // scoped storage issues with /sdcard/ on Android 16+.
  // ADB mode: use /sdcard/ which is the standard ADB scratch location.
  const defaultDir = isOnDevice() ? "/data/local/tmp" : "/sdcard";
  const path = dumpPath ?? `${defaultDir}/DA_uidump_${Date.now()}.xml`;
  try {
    await bridge.shell(`uiautomator dump '${shellEscape(path)}'`, { device: serial, timeout: 15000 });
    const catResult = await bridge.shell(`cat '${shellEscape(path)}'`, { device: serial });

    const xml = catResult.stdout;
    if (!xml || xml.includes("ERROR") || !xml.includes("<hierarchy")) {
      return null;
    }
    return xml;
  } finally {
    // Always clean up the device-side dump file, even if cat/dump throws
    await bridge.shell(`rm '${shellEscape(path)}'`, { device: serial, ignoreExitCode: true }).catch(() => {});
  }
}
