/**
 * Device Tools — Device discovery, status, and properties.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";

export function registerDeviceTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_devices",
    "List all connected Android devices with their state, model, and product info",
    {},
    async () => {
      try {
        const devices = await ctx.deviceManager.listDevices();
        if (devices.length === 0) {
          return { content: [{ type: "text", text: "No devices connected." }] };
        }
        const output = devices
          .map((d) => {
            const parts = [`${d.serial} (${d.state})`];
            if (d.model) parts.push(`model: ${d.model}`);
            if (d.product) parts.push(`product: ${d.product}`);
            return parts.join(" | ");
          })
          .join("\n");
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_device_info",
    "Get detailed properties for a connected device (model, OS version, build, etc.)",
    { device: z.string().optional().describe("Device serial (auto-selects if only one connected)") },
    async ({ device }) => {
      try {
        const props = await ctx.deviceManager.getDeviceProps(device);
        const keyProps = [
          `Model: ${props["ro.product.model"] ?? "unknown"}`,
          `Manufacturer: ${props["ro.product.manufacturer"] ?? "unknown"}`,
          `Android Version: ${props["ro.build.version.release"] ?? "unknown"}`,
          `SDK Level: ${props["ro.build.version.sdk"] ?? "unknown"}`,
          `Build: ${props["ro.build.display.id"] ?? "unknown"}`,
          `Security Patch: ${props["ro.build.version.security_patch"] ?? "unknown"}`,
          `Serial: ${props["ro.serialno"] ?? "unknown"}`,
          `ABI: ${props["ro.product.cpu.abi"] ?? "unknown"}`,
          `Fingerprint: ${props["ro.build.fingerprint"] ?? "unknown"}`,
        ];
        return { content: [{ type: "text", text: keyProps.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_getprop",
    "Get a specific Android system property, or all properties if no key given",
    {
      key: z.string().optional().describe("Property key (e.g., 'ro.build.version.sdk'). Omit for all."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ key, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        if (key) {
          const keyErr = validateShellArg(key, "key");
          if (keyErr) return { content: [{ type: "text", text: keyErr }], isError: true };
          const result = await ctx.bridge.shell(`getprop ${key}`, { device: resolved.serial });
          const value = result.stdout.trim();
          return { content: [{ type: "text", text: value || `(empty — property '${key}' may not exist)` }] };
        }
        const result = await ctx.bridge.shell("getprop", { device: resolved.serial });
        return { content: [{ type: "text", text: OutputProcessor.process(result.stdout) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
