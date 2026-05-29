// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
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

/**
 * AV3 fix: optional per-resource TTL cache. Off by default (TTL=0 → no
 * caching, every read fetches fresh). Enable via DA_RESOURCE_CACHE_TTL_MS
 * for high-frequency polling scenarios where slightly-stale data is
 * acceptable. Bounded ~30s ceiling so stale data can't linger forever
 * even if an operator sets a huge value.
 *
 * Key format: `${resourceName}:${serial}` keeps per-serial isolation.
 * The cache is per-process (in-memory), cleared on server restart.
 */
const RESOURCE_CACHE_TTL_MS = (() => {
  const raw = parseInt(process.env.DA_RESOURCE_CACHE_TTL_MS ?? "0", 10);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(raw, 30_000);
})();
const resourceCache = new Map<string, { value: string; expires: number }>();

function withCache(key: string, compute: () => Promise<string>): Promise<string> {
  if (RESOURCE_CACHE_TTL_MS === 0) return compute();
  const hit = resourceCache.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return Promise.resolve(hit.value);
  return compute().then((value) => {
    resourceCache.set(key, { value, expires: now + RESOURCE_CACHE_TTL_MS });
    // Opportunistic GC: drop a few expired entries on each insert. Bounded
    // cost since we only check up to 20 entries.
    let checked = 0;
    for (const [k, v] of resourceCache) {
      if (v.expires <= now) resourceCache.delete(k);
      if (++checked >= 20) break;
    }
    return value;
  });
}

export function registerResources(ctx: ToolContext): void {

  // Dynamic resource: device info by serial
  ctx.server.resource(
    "device-info",
    new ResourceTemplate("device://info/{serial}", { list: undefined }),
    { description: "Device properties (model, OS version, build, ABI)" },
    async (uri, { serial }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(serial as string || undefined);
        const info = await withCache(`device-info:${resolved.serial}`, async () => {
          const props = await ctx.deviceManager.getDeviceProps(resolved.serial);
          return [
            `Model: ${props["ro.product.model"] ?? "unknown"}`,
            `Manufacturer: ${props["ro.product.manufacturer"] ?? "unknown"}`,
            `Android: ${props["ro.build.version.release"] ?? "unknown"} (SDK ${props["ro.build.version.sdk"] ?? "?"})`,
            `Build: ${props["ro.build.display.id"] ?? "unknown"}`,
            `Security Patch: ${props["ro.build.version.security_patch"] ?? "unknown"}`,
            `ABI: ${props["ro.product.cpu.abi"] ?? "unknown"}`,
            `Serial: ${resolved.serial}`,
          ].join("\n");
        });

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
        const parsed = await withCache(`device-battery:${resolved.serial}`, async () => {
          const result = await ctx.bridge.shell("dumpsys battery", { device: resolved.serial });
          return OutputProcessor.parseBattery(result.stdout);
        });
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
        const text = await withCache(`device-telephony:${resolved.serial}`, async () => {
          const result = await ctx.bridge.shell("dumpsys telephony.registry", {
            device: resolved.serial, timeout: 15000,
          });
          return OutputProcessor.process(result.stdout, 20000);
        });
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
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
