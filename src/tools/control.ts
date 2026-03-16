/**
 * Device Control Tools — Toggle device settings for testing.
 * 
 * Provides programmatic control over airplane mode, WiFi, mobile data,
 * location services, screen state, Android settings, and device reboot.
 * Essential for automated test workflows and device state manipulation.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg, validateShellArgs } from "../middleware/sanitize.js";

export function registerControlTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_airplane_mode",
    "Toggle airplane mode on/off. Useful for resetting cellular registration during radio testing.",
    {
      enabled: z.boolean().describe("true = enable airplane mode, false = disable"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ enabled, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const val = enabled ? "1" : "0";
        // Set the setting
        await ctx.bridge.shell(`settings put global airplane_mode_on ${val}`, { device: serial });
        // Broadcast the change so the OS actually applies it
        await ctx.bridge.shell(
          `am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${enabled}`,
          { device: serial, ignoreExitCode: true }
        );
        // Brief settle time for radios to toggle
        await new Promise((r) => setTimeout(r, 1000));
        // Verify
        const check = await ctx.bridge.shell("settings get global airplane_mode_on", { device: serial });
        const actual = check.stdout.trim() === "1" ? "ON" : "OFF";
        return { content: [{ type: "text", text: `Airplane mode: ${actual}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_wifi",
    "Enable or disable WiFi",
    {
      enabled: z.boolean().describe("true = enable WiFi, false = disable"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ enabled, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const cmd = enabled ? "svc wifi enable" : "svc wifi disable";
        await ctx.bridge.shell(cmd, { device: resolved.serial });
        return { content: [{ type: "text", text: `WiFi: ${enabled ? "enabled" : "disabled"}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_mobile_data",
    "Enable or disable mobile data",
    {
      enabled: z.boolean().describe("true = enable mobile data, false = disable"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ enabled, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const cmd = enabled ? "svc data enable" : "svc data disable";
        await ctx.bridge.shell(cmd, { device: resolved.serial });
        return { content: [{ type: "text", text: `Mobile data: ${enabled ? "enabled" : "disabled"}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_location",
    "Enable or disable location services",
    {
      mode: z.enum(["off", "sensors", "battery", "high"]).describe(
        "Location mode: off, sensors (GPS only), battery (network only), high (GPS + network)"
      ),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ mode, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        // location_mode: 0=off, 1=sensors, 2=battery, 3=high
        const modeMap: Record<string, string> = { off: "0", sensors: "1", battery: "2", high: "3" };
        await ctx.bridge.shell(
          `settings put secure location_mode ${modeMap[mode]}`,
          { device: serial }
        );
        return { content: [{ type: "text", text: `Location mode: ${mode}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_screen",
    "Control screen state: wake, sleep, toggle, or unlock (swipe up)",
    {
      action: z.enum(["wake", "sleep", "toggle", "unlock"]).describe("Screen action"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ action, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        switch (action) {
          case "wake":
            await ctx.bridge.shell("input keyevent KEYCODE_WAKEUP", { device: serial });
            break;
          case "sleep":
            await ctx.bridge.shell("input keyevent KEYCODE_SLEEP", { device: serial });
            break;
          case "toggle":
            await ctx.bridge.shell("input keyevent KEYCODE_POWER", { device: serial });
            break;
          case "unlock":
            await ctx.bridge.shell("input keyevent KEYCODE_WAKEUP", { device: serial });
            await new Promise((r) => setTimeout(r, 300));
            await ctx.bridge.shell("input swipe 540 1800 540 400 300", { device: serial, ignoreExitCode: true });
            break;
        }
        return { content: [{ type: "text", text: `Screen: ${action} sent` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_airplane_cycle",
    "Cycle airplane mode on then off after a delay. Forces cellular re-registration — useful for radio diagnostics and network testing.",
    {
      delaySeconds: z.number().min(1).max(60).optional().default(3).describe("Seconds to keep airplane mode on (1-60, default 3)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ delaySeconds, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Enable airplane mode
        await ctx.bridge.shell("settings put global airplane_mode_on 1", { device: serial });
        await ctx.bridge.shell(
          "am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true",
          { device: serial, ignoreExitCode: true }
        );

        const status = [`Airplane mode ON at ${new Date().toISOString()}`];
        status.push(`Waiting ${delaySeconds}s for radio shutdown...`);

        await new Promise((r) => setTimeout(r, delaySeconds * 1000));

        // Disable airplane mode
        await ctx.bridge.shell("settings put global airplane_mode_on 0", { device: serial });
        await ctx.bridge.shell(
          "am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false",
          { device: serial, ignoreExitCode: true }
        );

        status.push(`Airplane mode OFF at ${new Date().toISOString()}`);
        status.push("Cellular re-registration in progress. Check telephony state in ~5-10s.");

        return { content: [{ type: "text", text: status.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_settings_get",
    "Read an Android settings value from any namespace (system, secure, global)",
    {
      namespace: z.enum(["system", "secure", "global"]).describe("Settings namespace"),
      key: z.string().describe("Setting key (e.g., 'screen_brightness', 'location_mode', 'airplane_mode_on')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ namespace, key, device }) => {
      try {
        const keyErr = validateShellArg(key, "key");
        if (keyErr) return { content: [{ type: "text", text: keyErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(`settings get ${namespace} ${key}`, { device: resolved.serial });
        const value = result.stdout.trim();
        return { content: [{ type: "text", text: value === "null" ? `(not set) ${namespace}/${key}` : `${namespace}/${key} = ${value}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_settings_put",
    "Write an Android settings value to any namespace (system, secure, global)",
    {
      namespace: z.enum(["system", "secure", "global"]).describe("Settings namespace"),
      key: z.string().describe("Setting key"),
      value: z.string().describe("Value to set"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ namespace, key, value, device }) => {
      try {
        const argErr = validateShellArgs([[key, "key"], [value, "value"]]);
        if (argErr) return { content: [{ type: "text", text: argErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        await ctx.bridge.shell(`settings put ${namespace} ${key} ${value}`, { device: resolved.serial });
        // Read back to confirm
        const check = await ctx.bridge.shell(`settings get ${namespace} ${key}`, { device: resolved.serial });
        return { content: [{ type: "text", text: `${namespace}/${key} = ${check.stdout.trim()}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_reboot",
    "Reboot the device. Supports normal, recovery, and bootloader modes.",
    {
      mode: z.enum(["normal", "recovery", "bootloader"]).optional().default("normal")
        .describe("Reboot mode: normal (default), recovery, or bootloader"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ mode, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const args = mode === "normal" ? ["reboot"] : ["reboot", mode];
        const result = await ctx.bridge.exec(args, {
          device: serial,
          timeout: 30000,
          ignoreExitCode: true,
        });
        ctx.deviceManager.invalidateCache();
        return {
          content: [{
            type: "text",
            text: `Rebooting ${serial} into ${mode} mode. Device will be unavailable during restart.${result.stdout.trim() ? "\n" + result.stdout.trim() : ""}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
