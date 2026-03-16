/**
 * MCP Resources — Read-only device state surfaces.
 * 
 * Exposes device information as MCP Resources that clients can
 * read on demand. Semantically better than tools for "give me
 * current state" operations.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

export function registerResources(ctx: ToolContext): void {

  // Dynamic resource: device info by serial
  ctx.server.resource(
    "device-info",
    new ResourceTemplate("device://info/{serial}", { list: undefined }),
    { description: "Device properties (model, OS version, build, ABI)" },
    async (uri, { serial }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(serial as string || undefined);
        const props = await ctx.deviceManager.getDeviceProps(resolved.serial);
        const info = [
          `Model: ${props["ro.product.model"] ?? "unknown"}`,
          `Manufacturer: ${props["ro.product.manufacturer"] ?? "unknown"}`,
          `Android: ${props["ro.build.version.release"] ?? "unknown"} (SDK ${props["ro.build.version.sdk"] ?? "?"})`,
          `Build: ${props["ro.build.display.id"] ?? "unknown"}`,
          `Security Patch: ${props["ro.build.version.security_patch"] ?? "unknown"}`,
          `ABI: ${props["ro.product.cpu.abi"] ?? "unknown"}`,
          `Serial: ${resolved.serial}`,
        ].join("\n");

        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: info }] };
      } catch (error) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: OutputProcessor.formatError(error) }] };
      }
    }
  );

  // Dynamic resource: battery status by serial
  ctx.server.resource(
    "device-battery",
    new ResourceTemplate("device://battery/{serial}", { list: undefined }),
    { description: "Battery status, level, temperature, and charging info" },
    async (uri, { serial }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(serial as string || undefined);
        const result = await ctx.bridge.shell("dumpsys battery", { device: resolved.serial });
        const parsed = OutputProcessor.parseBattery(result.stdout);
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: parsed }] };
      } catch (error) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: OutputProcessor.formatError(error) }] };
      }
    }
  );

  // Dynamic resource: telephony state by serial
  ctx.server.resource(
    "device-telephony",
    new ResourceTemplate("device://telephony/{serial}", { list: undefined }),
    { description: "Telephony state: cell info, signal strength, network registration" },
    async (uri, { serial }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(serial as string || undefined);
        const result = await ctx.bridge.shell("dumpsys telephony.registry", {
          device: resolved.serial, timeout: 15000,
        });
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: OutputProcessor.process(result.stdout, 20000) }] };
      } catch (error) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: OutputProcessor.formatError(error) }] };
      }
    }
  );

  // Static resource: list connected devices
  ctx.server.resource(
    "devices-list",
    "device://list",
    { description: "List of all connected Android devices" },
    async (uri) => {
      try {
        const devices = await ctx.deviceManager.listDevices();
        const text = devices.length === 0
          ? "No devices connected."
          : devices.map((d) => {
              const parts = [`${d.serial} (${d.state})`];
              if (d.model) parts.push(`model: ${d.model}`);
              if (d.product) parts.push(`product: ${d.product}`);
              return parts.join(" | ");
            }).join("\n");
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
      } catch (error) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: OutputProcessor.formatError(error) }] };
      }
    }
  );
}
