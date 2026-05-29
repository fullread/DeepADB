// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Port Forwarding Tools — TCP port mapping between host and device.
 * Wraps adb forward and adb reverse for network debugging.
 */

import { z } from "zod";
import { randomBytes } from "crypto";
import { createServer } from "net";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { registerCleanup } from "../middleware/cleanup.js";

/**
 * AF4 fix: track every forward/reverse we create so we can clean them up on
 * server exit. `adb forward` and `adb reverse` persist until explicitly
 * removed or until device disconnect; previously there was no auto-cleanup,
 * leaving orphans that survive across DeepADB restarts (visible to other
 * tools, occupies ports). Tracking is per-process — restarting the server
 * loses the in-memory list, but the running adb server retains the entries
 * until manual cleanup or device unplug, so this fix only helps for graceful
 * exits. That's fine: ungraceful exits are exactly when orphans were already
 * accepted, and graceful exits are exactly when cleanup is reasonable.
 */
interface TrackedForward {
  device: string;
  spec: string;
  kind: "forward" | "reverse";
}
const trackedForwards = new Set<TrackedForward>();
let forwardCleanupRegistered = false;
function ensureForwardCleanupRegistered(ctx: ToolContext): void {
  if (forwardCleanupRegistered) return;
  registerCleanup("forwarding", async () => {
    for (const fwd of trackedForwards) {
      try {
        const args = fwd.kind === "forward"
          ? ["forward", "--remove", fwd.spec]
          : ["reverse", "--remove", fwd.spec];
        await ctx.bridge.exec(args, { device: fwd.device, ignoreExitCode: true, timeout: 3000 });
      } catch { /* best-effort on shutdown */ }
    }
    trackedForwards.clear();
  });
  forwardCleanupRegistered = true;
}

/**
 * AF2 fix: format regex for adb forward / reverse specs.
 *
 * Accepted forms (all from adb documentation):
 *   tcp:<port>             — TCP port (1-65535 enforced by separate parse)
 *   localabstract:<name>   — Linux abstract socket namespace
 *   localreserved:<name>   — Linux reserved socket namespace
 *   localfilesystem:<path> — Filesystem socket
 *   dev:<path>             — Character device
 *   jdwp:<pid>             — Java debug wire protocol (pid)
 *
 * Body characters intentionally restricted to [A-Za-z0-9_./-] so an operator
 * cannot smuggle shell metacharacters via a forward spec. ADB itself will
 * range-check the numeric values; this regex is a defense-in-depth at the
 * tool boundary.
 */
const FORWARD_SPEC_RE = /^(tcp:\d{1,5}|localabstract:[A-Za-z0-9_./-]+|localreserved:[A-Za-z0-9_./-]+|localfilesystem:[A-Za-z0-9_./-]+|dev:[A-Za-z0-9_./-]+|jdwp:\d+)$/;

/**
 * Managed tunnel record. The adb_tunnel_* tool family layers on top of the
 * low-level adb_forward / adb_reverse primitives by giving each tunnel a
 * stable opaque ID that the close tool can reference. Tunnels are also
 * pushed into AF4's trackedForwards set so the existing shutdown cleanup
 * path handles them — no second cleanup mechanism.
 */
interface Tunnel {
  id: string;
  device: string;
  direction: "forward" | "reverse";
  hostSpec: string;
  deviceSpec: string;
  createdAt: number;
}
const tunnels = new Map<string, Tunnel>();

/**
 * Generate an opaque tunnel ID. Format: tun_XXXXXX (6 hex chars from
 * randomBytes, ~16M space, collision-free within any realistic session).
 * Opaque so operators don't try to parse it; metadata is surfaced by
 * adb_tunnel_list.
 */
function generateTunnelId(): string {
  return "tun_" + randomBytes(3).toString("hex");
}

/**
 * Find a free TCP port on the host. Uses net.createServer().listen(0)
 * which asks the OS to bind any available port, then immediately closes
 * the listener and returns the port the OS picked. The window between
 * close and the caller's subsequent bind is a TOCTOU race in theory but
 * in practice the kernel doesn't immediately re-hand-out a just-released
 * port, so this is the standard cross-platform free-port-pick idiom.
 * Returns 0 if the helper itself fails (caller should treat as error).
 */
function pickFreeHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Failed to obtain port from server.address()")));
      }
    });
  });
}

export function registerForwardingTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_forward",
    "Forward a local port to a port on the device (host → device). Use for connecting to services running on the device.",
    {
      local: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>").describe("Local (host) spec, e.g., 'tcp:8080'. AF2 fix: format-validated."),
      remote: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>").describe("Remote (device) spec, e.g., 'tcp:8080' or 'localabstract:app_socket'. AF2 fix: format-validated."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ local, remote, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        ensureForwardCleanupRegistered(ctx);
        const result = await ctx.bridge.exec(["forward", local, remote], { device: resolved.serial });
        trackedForwards.add({ device: resolved.serial, spec: local, kind: "forward" });
        return { content: [{ type: "text", text: result.stdout.trim() || `Forwarding ${local} → ${remote}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_reverse",
    "Reverse-forward a device port to a port on the host (device → host). Use for letting device apps reach services on your machine.",
    {
      remote: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>").describe("Remote (device) spec, e.g., 'tcp:3000'. AF2 fix: format-validated."),
      local: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>").describe("Local (host) spec, e.g., 'tcp:3000'. AF2 fix: format-validated."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ remote, local, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        ensureForwardCleanupRegistered(ctx);
        const result = await ctx.bridge.exec(["reverse", remote, local], { device: resolved.serial });
        trackedForwards.add({ device: resolved.serial, spec: remote, kind: "reverse" });
        return { content: [{ type: "text", text: result.stdout.trim() || `Reverse forwarding ${remote} → ${local}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_forward_list",
    "List all active port forwards and reverse forwards",
    { device: z.string().optional().describe("Device serial (omit for all devices)") },
    async ({ device }) => {
      try {
        const resolved = device ? await ctx.deviceManager.resolveDevice(device) : null;

        // Get forward list
        const fwdResult = await ctx.bridge.exec(["forward", "--list"], {
          device: resolved?.serial, ignoreExitCode: true,
        });

        // Get reverse list
        let revOutput = "";
        if (resolved) {
          const revResult = await ctx.bridge.exec(["reverse", "--list"], {
            device: resolved.serial, ignoreExitCode: true,
          });
          revOutput = revResult.stdout.trim();
        }

        let output = "=== Forward (host → device) ===\n";
        output += fwdResult.stdout.trim() || "(none)";
        if (resolved) {
          output += "\n\n=== Reverse (device → host) ===\n";
          output += revOutput || "(none)";
        } else {
          output += "\n\n=== Reverse (device → host) ===\n";
          output += "(specify 'device' to list reverse forwards — they are per-device)";
        }
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_forward_remove",
    "Remove a port forward (host → device), or all forwards. Use after testing to clean up.",
    {
      local: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>").optional().describe("Local spec to remove (e.g., 'tcp:8080'). Omit to remove all forwards. AF2 fix: format-validated."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ local, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        if (local) {
          await ctx.bridge.exec(["forward", "--remove", local], { device: resolved.serial });
          return { content: [{ type: "text", text: `Removed forward: ${local}` }] };
        }
        await ctx.bridge.exec(["forward", "--remove-all"], { device: resolved.serial });
        return { content: [{ type: "text", text: "All forwards removed." }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_reverse_remove",
    "Remove a reverse forward (device → host), or all reverse forwards. Use after testing to clean up.",
    {
      remote: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>").optional().describe("Remote spec to remove (e.g., 'tcp:3000'). Omit to remove all reverse forwards. AF2 fix: format-validated."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ remote, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        if (remote) {
          await ctx.bridge.exec(["reverse", "--remove", remote], { device: resolved.serial });
          return { content: [{ type: "text", text: `Removed reverse forward: ${remote}` }] };
        }
        await ctx.bridge.exec(["reverse", "--remove-all"], { device: resolved.serial });
        return { content: [{ type: "text", text: "All reverse forwards removed." }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // Tunnel automation (adb_tunnel_open / list / close)
  //
  // High-level wrappers over adb_forward / adb_reverse. Each open
  // returns an opaque `tun_XXXXXX` ID that close can reference, so
  // operators don't have to remember the spec they passed to forward.
  // Hooks into the existing AF4 cleanup path (trackedForwards Set)
  // so server shutdown removes managed tunnels automatically.
  // ═══════════════════════════════════════════════════════════════════

  ctx.server.tool(
    "adb_tunnel_open",
    "Open a managed tunnel between host and device. Higher-level convenience wrapper over adb_forward / adb_reverse: auto-picks a free host port when one isn't specified (forward only), returns an opaque tunnel ID for later close, and registers cleanup so the tunnel is removed on server exit. Direction 'forward' = host port forwards TO device service; 'reverse' = device port forwards TO host service.",
    {
      direction: z.enum(["forward", "reverse"])
        .describe("'forward' (host → device) or 'reverse' (device → host)"),
      deviceSpec: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>")
        .describe("Device-side spec, e.g., 'tcp:3000' or 'localabstract:app_socket'"),
      hostSpec: z.string().regex(FORWARD_SPEC_RE, "Spec must be one of tcp:<port>, localabstract:<name>, localreserved:<name>, localfilesystem:<path>, dev:<path>, jdwp:<pid>").optional()
        .describe("Host-side spec, e.g., 'tcp:8080'. For 'forward' direction: omit to auto-pick a free host port. For 'reverse' direction: required (can't auto-pick device-side ports without an extra probe call)."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ direction, deviceSpec, hostSpec, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        ensureForwardCleanupRegistered(ctx);

        // Resolve hostSpec: auto-pick free port for forward + omitted; require for reverse.
        let effectiveHostSpec = hostSpec;
        if (!effectiveHostSpec) {
          if (direction === "reverse") {
            return { content: [{ type: "text", text: "hostSpec is required for direction='reverse'. Auto-pick is supported only for 'forward' (host-side port). For reverse, specify the host endpoint explicitly (e.g., hostSpec: 'tcp:3000')." }], isError: true };
          }
          const port = await pickFreeHostPort();
          effectiveHostSpec = "tcp:" + port;
        }

        // Build adb args. For forward: adb forward LOCAL REMOTE. For reverse: adb reverse REMOTE LOCAL.
        // The order in the adb CLI is "device side first" for reverse, "host side first" for forward.
        const args = direction === "forward"
          ? ["forward", effectiveHostSpec, deviceSpec]
          : ["reverse", deviceSpec, effectiveHostSpec];
        await ctx.bridge.exec(args, { device: resolved.serial });

        // Register for AF4 cleanup-on-exit. trackedForwards.spec is the
        // arg passed to --remove, which for forward is the host spec and
        // for reverse is the device spec.
        const removeSpec = direction === "forward" ? effectiveHostSpec : deviceSpec;
        trackedForwards.add({ device: resolved.serial, spec: removeSpec, kind: direction });

        // Generate ID + store metadata for ID-based close + list.
        const id = generateTunnelId();
        tunnels.set(id, {
          id,
          device: resolved.serial,
          direction,
          hostSpec: effectiveHostSpec,
          deviceSpec,
          createdAt: Date.now(),
        });

        const lines = [
          `Tunnel opened: ${id}`,
          `  device: ${resolved.serial}`,
          `  direction: ${direction}`,
          `  host: ${effectiveHostSpec}${hostSpec ? "" : " (auto-picked)"}`,
          `  device: ${deviceSpec}`,
          "",
          `Use adb_tunnel_close with id=${id} to remove. Tunnel will also be auto-removed on server shutdown.`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_tunnel_list",
    "List all active managed tunnels (opened via adb_tunnel_open). Shows tunnel ID, device, direction, and both endpoints. Note: this only surfaces tunnels created via adb_tunnel_open — tunnels created via the low-level adb_forward / adb_reverse won't appear here. For those, use adb_forward_list.",
    {
      device: z.string().optional().describe("Filter to a specific device serial (default: all devices)"),
    },
    async ({ device }) => {
      try {
        // device param is a filter — don't resolveDevice (it'd require a connected device).
        const filtered = device
          ? [...tunnels.values()].filter((t) => t.device === device)
          : [...tunnels.values()];

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: device
            ? `No managed tunnels open for device ${device}. (Use adb_forward_list for tunnels not created via adb_tunnel_open.)`
            : "No managed tunnels open. (Use adb_forward_list for tunnels not created via adb_tunnel_open.)" }] };
        }

        // Sort by createdAt for stable, predictable output.
        filtered.sort((a, b) => a.createdAt - b.createdAt);

        const lines = [`${filtered.length} managed tunnel(s):`, ""];
        for (const t of filtered) {
          const ageSec = Math.round((Date.now() - t.createdAt) / 1000);
          lines.push(`  ${t.id}  [${t.direction}]  device=${t.device}`);
          lines.push(`    host:   ${t.hostSpec}`);
          lines.push(`    device: ${t.deviceSpec}`);
          lines.push(`    age:    ${ageSec}s`);
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n").trimEnd() }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_tunnel_close",
    "Close a managed tunnel by ID, or all managed tunnels at once. The corresponding adb forward/reverse entry is removed and the tunnel is dropped from the cleanup registry. Use adb_tunnel_list to see active tunnel IDs.",
    {
      id: z.string().describe("Tunnel ID (tun_XXXXXX) returned by adb_tunnel_open, or the literal string 'all' to close every managed tunnel."),
    },
    async ({ id }) => {
      try {
        if (id === "all") {
          if (tunnels.size === 0) {
            return { content: [{ type: "text", text: "No managed tunnels to close." }] };
          }
          const all = [...tunnels.values()];
          let closed = 0;
          const failures: string[] = [];
          for (const t of all) {
            try {
              const args = t.direction === "forward"
                ? ["forward", "--remove", t.hostSpec]
                : ["reverse", "--remove", t.deviceSpec];
              await ctx.bridge.exec(args, { device: t.device, ignoreExitCode: true, timeout: 5000 });
              // Drop from both maps.
              tunnels.delete(t.id);
              for (const fwd of trackedForwards) {
                if (fwd.device === t.device && fwd.kind === t.direction &&
                    fwd.spec === (t.direction === "forward" ? t.hostSpec : t.deviceSpec)) {
                  trackedForwards.delete(fwd);
                  break;
                }
              }
              closed++;
            } catch (err) {
              failures.push(`${t.id}: ${err instanceof Error ? err.message : err}`);
            }
          }
          const lines = [`Closed ${closed} of ${all.length} managed tunnel(s).`];
          if (failures.length > 0) {
            lines.push("");
            lines.push("Failures:");
            for (const f of failures) lines.push("  " + f);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Single-ID close.
        const t = tunnels.get(id);
        if (!t) {
          return { content: [{ type: "text", text: `No managed tunnel with id='${id}'. Use adb_tunnel_list to see active tunnels.` }], isError: true };
        }
        const args = t.direction === "forward"
          ? ["forward", "--remove", t.hostSpec]
          : ["reverse", "--remove", t.deviceSpec];
        await ctx.bridge.exec(args, { device: t.device, ignoreExitCode: true, timeout: 5000 });
        tunnels.delete(t.id);
        // Drop from trackedForwards too — match by device + kind + spec.
        for (const fwd of trackedForwards) {
          if (fwd.device === t.device && fwd.kind === t.direction &&
              fwd.spec === (t.direction === "forward" ? t.hostSpec : t.deviceSpec)) {
            trackedForwards.delete(fwd);
            break;
          }
        }
        return { content: [{ type: "text", text: `Tunnel ${id} closed (${t.direction}, host=${t.hostSpec}, device=${t.deviceSpec}).` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

}
