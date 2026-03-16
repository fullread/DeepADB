/**
 * Package Tools — App installation, management, and permissions.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg, validateShellArgs } from "../middleware/sanitize.js";

export function registerPackageTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_install",
    "Install an APK on the device. Provide the full local path to the APK file.",
    {
      apkPath: z.string().describe("Local filesystem path to the APK file"),
      device: z.string().optional().describe("Device serial"),
      replace: z.boolean().optional().default(true).describe("Replace existing app (-r flag)"),
      downgrade: z.boolean().optional().default(false).describe("Allow version downgrade (-d flag)"),
    },
    async ({ apkPath, device, replace, downgrade }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const args = ["install"];
        if (replace) args.push("-r");
        if (downgrade) args.push("-d");
        args.push(apkPath);
        const result = await ctx.bridge.exec(args, { device: resolved.serial, timeout: 120000 });
        return { content: [{ type: "text", text: OutputProcessor.process(result.stdout) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_uninstall",
    "Uninstall a package from the device",
    {
      packageName: z.string().describe("Package name (e.g., 'com.example.app')"),
      device: z.string().optional().describe("Device serial"),
      keepData: z.boolean().optional().default(false).describe("Keep app data and cache (-k flag)"),
    },
    async ({ packageName, device, keepData }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const args = ["uninstall"];
        if (keepData) args.push("-k");
        args.push(packageName);
        const result = await ctx.bridge.exec(args, { device: resolved.serial });
        return { content: [{ type: "text", text: result.stdout.trim() || "Success" }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_list_packages",
    "List installed packages. Supports filtering by name.",
    {
      filter: z.string().optional().describe("Filter packages containing this string"),
      device: z.string().optional().describe("Device serial"),
      type: z.enum(["all", "system", "third-party"]).optional().default("all")
        .describe("Show all, system-only, or third-party-only packages"),
    },
    async ({ filter, device, type }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        let cmd = "pm list packages";
        if (type === "system") cmd += " -s";
        else if (type === "third-party") cmd += " -3";
        if (filter) {
          const err = validateShellArg(filter, "filter");
          if (err) return { content: [{ type: "text", text: err }], isError: true };
          cmd += ` ${filter}`;
        }
        const result = await ctx.bridge.shell(cmd, { device: resolved.serial });
        const packages = result.stdout
          .split("\n")
          .map((l) => l.replace("package:", "").trim())
          .filter((l) => l.length > 0)
          .sort();
        return {
          content: [{ type: "text", text: `${packages.length} packages:\n${packages.join("\n")}` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_package_info",
    "Get detailed info about an installed package (version, permissions, paths)",
    {
      packageName: z.string().describe("Package name"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(`dumpsys package ${packageName}`, { device: resolved.serial });
        return { content: [{ type: "text", text: OutputProcessor.process(result.stdout) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_clear_data",
    "Clear all data for a package (equivalent to clearing storage in settings)",
    {
      packageName: z.string().describe("Package name"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(`pm clear ${packageName}`, { device: resolved.serial });
        return { content: [{ type: "text", text: result.stdout.trim() }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_grant_permission",
    "Grant a runtime permission to a package",
    {
      packageName: z.string().describe("Package name"),
      permission: z.string().describe("Full permission string (e.g., 'android.permission.READ_PHONE_STATE')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, permission, device }) => {
      try {
        const argErr = validateShellArgs([[packageName, "packageName"], [permission, "permission"]]);
        if (argErr) return { content: [{ type: "text", text: argErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(
          `pm grant ${packageName} ${permission}`,
          { device: resolved.serial, ignoreExitCode: true }
        );
        const output = result.stdout.trim() || "Permission granted.";
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_force_stop",
    "Force-stop an app immediately. The most common debugging action.",
    {
      packageName: z.string().describe("Package name (e.g., 'com.example.app')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        await ctx.bridge.shell(`am force-stop ${packageName}`, { device: resolved.serial });
        return { content: [{ type: "text", text: `Force-stopped: ${packageName}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_start_app",
    "Launch an app by package name (resolves and starts the default launcher activity)",
    {
      packageName: z.string().describe("Package name (e.g., 'com.example.app')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const result = await ctx.bridge.shell(
          `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
          { device: resolved.serial, ignoreExitCode: true }
        );
        const output = result.stdout.trim();
        if (output.includes("No activities found")) {
          return { content: [{ type: "text", text: `No launcher activity found for ${packageName}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Launched: ${packageName}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_restart_app",
    "Force-stop then re-launch an app. The most frequent debugging workflow in a single call.",
    {
      packageName: z.string().describe("Package name (e.g., 'com.example.app')"),
      device: z.string().optional().describe("Device serial"),
      delayMs: z.number().min(0).max(10000).optional().default(500).describe("Delay between stop and start in ms (0-10000, default 500)"),
    },
    async ({ packageName, device, delayMs }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        // Force stop
        await ctx.bridge.shell(`am force-stop ${packageName}`, { device: serial });
        // Brief settle
        await new Promise((r) => setTimeout(r, delayMs));
        // Re-launch
        const result = await ctx.bridge.shell(
          `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
          { device: serial, ignoreExitCode: true }
        );
        if (result.stdout.includes("No activities found")) {
          return { content: [{ type: "text", text: `Stopped ${packageName} but no launcher activity found to restart.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Restarted: ${packageName}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_resolve_intents",
    "Discover all activities, services, and receivers registered by a package with their intent filters",
    {
      packageName: z.string().describe("Package name to query"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };
        const resolved = await ctx.deviceManager.resolveDevice(device);
        // Get the full package dump and extract resolver sections
        const result = await ctx.bridge.shell(`dumpsys package ${packageName}`, {
          device: resolved.serial, timeout: 15000,
        });
        const dump = result.stdout;

        // Extract Activity, Service, and Receiver resolver entries
        const sections: string[] = [];
        for (const sectionName of ["Activity Resolver Table", "Service Resolver Table", "Receiver Resolver Table"]) {
          const startIdx = dump.indexOf(sectionName);
          if (startIdx === -1) continue;
          // Find next resolver table or end of relevant section
          const endMarkers = ["Resolver Table", "Permissions:", "Registered ContentProviders:", "ContentProvider Authorities:"];
          let endIdx = dump.length;
          for (const marker of endMarkers) {
            const idx = dump.indexOf(marker, startIdx + sectionName.length + 1);
            if (idx !== -1 && idx < endIdx) endIdx = idx;
          }
          const section = dump.substring(startIdx, endIdx).trim();
          if (section) sections.push(section);
        }

        if (sections.length === 0) {
          return { content: [{ type: "text", text: `No resolver entries found for ${packageName}` }] };
        }
        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
