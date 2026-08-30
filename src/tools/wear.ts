// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Read-only Wear OS Data Layer preflight across a phone/watch pair. */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { DeviceInfo } from "../bridge/device-manager.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellQuote } from "../middleware/sanitize.js";

const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

export function isWearDeviceProperties(props: Record<string, string>): boolean {
  return (props["ro.build.characteristics"] ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .includes("watch");
}

interface ClassifiedDevice {
  info: DeviceInfo;
  props: Record<string, string>;
  wear: boolean;
}

interface SidePreflight {
  model: string;
  gms: boolean;
  bluetooth: boolean;
  app?: { packageName: string; installed: boolean; enabled: boolean };
  dataLayerSignal: boolean;
}

async function inspectSide(
  ctx: ToolContext,
  device: ClassifiedDevice,
  packageName?: string,
): Promise<SidePreflight> {
  const serial = device.info.serial;
  const [gms, bluetooth, services, app] = await Promise.all([
    ctx.bridge.shell("pm path com.google.android.gms", { device: serial, timeout: 10000, ignoreExitCode: true }),
    ctx.bridge.shell("settings get global bluetooth_on", { device: serial, timeout: 5000, ignoreExitCode: true }),
    ctx.bridge.shell("dumpsys activity services com.google.android.gms", { device: serial, timeout: 20000, ignoreExitCode: true }),
    packageName
      ? ctx.bridge.shell(`dumpsys package ${shellQuote(packageName)}`, { device: serial, timeout: 15000, ignoreExitCode: true })
      : Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false, bufferExceeded: false }),
  ]);

  let appState: SidePreflight["app"];
  if (packageName) {
    const installed = /\bPackage \[|\buserId=/.test(app.stdout);
    const disabled = /enabled=(?:0|false|disabled)|enabledSetting=(?:2|3|4)/i.test(app.stdout);
    appState = { packageName, installed, enabled: installed && !disabled };
  }
  return {
    model: device.props["ro.product.model"] ?? device.info.model ?? "unknown",
    gms: gms.stdout.includes("package:"),
    bluetooth: bluetooth.stdout.trim() === "1",
    app: appState,
    dataLayerSignal: /wearable|data.?layer|node.?peer/i.test(services.stdout),
  };
}

function countAssociations(output: string): number {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const associationLines = lines.filter((line) => /association|deviceprofile|mDeviceMacAddress|packageName/i.test(line));
  return associationLines.length;
}

export function registerWearTools(ctx: ToolContext): void {
  ctx.server.tool(
    "adb_wear_datalayer_preflight",
    "Run a read-only Wear OS Data Layer preflight across a connected phone and watch. Checks device roles, Google Play services, Bluetooth, optional app packages, companion association presence, and Data Layer service signals without exposing pairing identifiers.",
    {
      phonePackage: z.string().regex(PACKAGE_NAME_PATTERN).optional()
        .describe("Optional companion app package expected on the phone"),
      wearPackage: z.string().regex(PACKAGE_NAME_PATTERN).optional()
        .describe("Optional Wear app package expected on the watch"),
      phoneDevice: z.string().optional().describe("Phone device serial; auto-detected when omitted"),
      wearDevice: z.string().optional().describe("Wear device serial; auto-detected when omitted"),
    },
    async ({ phonePackage, wearPackage, phoneDevice, wearDevice }) => {
      try {
        const online = (await ctx.deviceManager.listDevices()).filter((device) => device.state === "device");
        const classified: ClassifiedDevice[] = await Promise.all(online.map(async (info) => {
          const props = await ctx.deviceManager.getDeviceProps(info.serial);
          return { info, props, wear: isWearDeviceProperties(props) };
        }));

        const phone = phoneDevice
          ? classified.find((device) => device.info.serial === phoneDevice && !device.wear)
          : classified.find((device) => !device.wear);
        const watch = wearDevice
          ? classified.find((device) => device.info.serial === wearDevice && device.wear)
          : classified.find((device) => device.wear);

        const sections: string[] = ["=== Wear Data Layer Preflight (read-only) ==="];
        if (!phone) sections.push(`○ Phone: ${phoneDevice ? "specified device is unavailable or classified as a watch" : "no connected handheld device found"}`);
        if (!watch) sections.push(`○ Watch: ${wearDevice ? "specified device is unavailable or not classified as a watch" : "no connected Wear OS device found"}`);
        if (!phone || !watch) {
          sections.push("", `Connected online devices: ${classified.length} (${classified.filter((device) => device.wear).length} watch, ${classified.filter((device) => !device.wear).length} handheld)`);
          sections.push("Connect both sides, authorize USB debugging, and rerun the preflight. No pairing state was changed.");
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        const [phoneState, watchState, associations] = await Promise.all([
          inspectSide(ctx, phone, phonePackage),
          inspectSide(ctx, watch, wearPackage),
          ctx.bridge.shell("cmd companiondevice list associations", {
            device: phone.info.serial, timeout: 10000, ignoreExitCode: true,
          }).then(async (result) => {
            if (result.exitCode === 0 && !/unknown command|not found/i.test(result.stdout + result.stderr)) return result.stdout;
            const fallback = await ctx.bridge.shell("dumpsys companiondevice", {
              device: phone.info.serial, timeout: 15000, ignoreExitCode: true,
            });
            return fallback.stdout;
          }),
        ]);

        const associationSignals = countAssociations(associations);
        const requiredAppsReady = (!phoneState.app || (phoneState.app.installed && phoneState.app.enabled))
          && (!watchState.app || (watchState.app.installed && watchState.app.enabled));
        const ready = phoneState.gms && watchState.gms && phoneState.bluetooth && watchState.bluetooth && requiredAppsReady;

        const describeSide = (role: string, state: SidePreflight) => [
          `${role}: ${state.model}`,
          `  ${state.gms ? "✓" : "✗"} Google Play services`,
          `  ${state.bluetooth ? "✓" : "✗"} Bluetooth enabled`,
          state.app
            ? `  ${state.app.installed && state.app.enabled ? "✓" : "✗"} ${state.app.packageName}: ${!state.app.installed ? "not installed" : state.app.enabled ? "installed and enabled" : "disabled"}`
            : "  ○ App package check not requested",
          `  ${state.dataLayerSignal ? "✓" : "○"} Active Data Layer service signal${state.dataLayerSignal ? " detected" : " not observed (may be idle)"}`,
        ];

        sections.push(
          "",
          ...describeSide("Phone", phoneState),
          "",
          ...describeSide("Watch", watchState),
          "",
          `${associationSignals > 0 ? "✓" : "○"} Companion association signals: ${associationSignals} (identifiers intentionally omitted)`,
          "",
          ready
            ? "=== PREFLIGHT READY ===\nCore prerequisites are present. An app-level node/message exchange is still the definitive end-to-end test."
            : "=== PREFLIGHT NEEDS ATTENTION ===\nResolve the failed prerequisites above, then rerun before testing an app-level node/message exchange.",
          "No Bluetooth, pairing, package, or service state was modified.",
        );

        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n"), 30000) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    },
  );
}
