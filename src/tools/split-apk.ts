/**
 * Split APK Management Tools — App bundles, split APKs, and APEX modules.
 *
 * Modern Android apps often ship as App Bundles (AAB) which produce split
 * APKs on the device. This module handles installation of multiple APK
 * splits, inspection of installed splits, extraction for analysis, and
 * APEX module listing.
 *
 * Extends the core package tools with modern delivery format support.
 */

import { z } from "zod";
import { join, resolve } from "path";
import { mkdirSync, existsSync, statSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg, shellEscape } from "../middleware/sanitize.js";

export function registerSplitApkTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_install_bundle",
    "Install multiple APK splits (app bundle) on the device using `install-multiple`. Provide all split APK files — base APK plus config splits (language, density, ABI).",
    {
      apkPaths: z.array(z.string()).min(1).describe("Array of local paths to split APK files (base + config splits)"),
      device: z.string().optional().describe("Device serial"),
      replace: z.boolean().optional().default(true).describe("Replace existing app (-r)"),
      allowDowngrade: z.boolean().optional().default(false).describe("Allow version downgrade (-d)"),
    },
    async ({ apkPaths, device, replace, allowDowngrade }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const args = ["install-multiple"];
        if (replace) args.push("-r");
        if (allowDowngrade) args.push("-d");
        args.push(...apkPaths);

        const result = await ctx.bridge.exec(args, {
          device: serial,
          timeout: 180000, // 3 minutes for large bundles
        });

        const output = result.stdout.trim();
        const success = output.includes("Success");

        return {
          content: [{
            type: "text",
            text: `${success ? "✓" : "✗"} Install bundle (${apkPaths.length} splits):\n${output}`,
          }],
          isError: !success,
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_list_splits",
    "List all APK split paths installed for a package. Shows the base APK and any configuration splits (language, screen density, ABI).",
    {
      packageName: z.string().describe("Package name (e.g., 'com.example.app')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Get all APK paths for the package
        const pathResult = await ctx.bridge.shell(`pm path ${packageName}`, {
          device: serial, ignoreExitCode: true,
        });

        const paths = pathResult.stdout.split("\n")
          .map((l) => l.replace("package:", "").trim())
          .filter((l) => l.length > 0);

        if (paths.length === 0) {
          return { content: [{ type: "text", text: `Package "${packageName}" not found or has no APK paths.` }], isError: true };
        }

        // Classify splits
        const base = paths.filter((p) => p.includes("base.apk") || !p.includes("split_"));
        const splits = paths.filter((p) => p.includes("split_"));

        const sections: string[] = [];
        sections.push(`Package: ${packageName}`);
        sections.push(`Total APKs: ${paths.length} (${base.length} base + ${splits.length} splits)\n`);

        if (base.length > 0) {
          sections.push("Base APK(s):");
          for (const p of base) sections.push(`  ${p}`);
        }

        if (splits.length > 0) {
          sections.push("\nSplit APKs:");
          for (const p of splits) {
            // Classify the split type
            const filename = p.split("/").pop() ?? p;
            let splitType = "config";
            if (filename.includes("config.")) {
              const configMatch = filename.match(/config\.(.+)\.apk/);
              if (configMatch) splitType = configMatch[1];
            }
            sections.push(`  [${splitType}] ${p}`);
          }
        }

        // Get sizes
        if (paths.length > 0) {
          const sizeCmd = paths.map((p) => `stat -c '%s' '${shellEscape(p)}'`).join("; ");
          const sizeResult = await ctx.bridge.shell(sizeCmd, {
            device: serial, ignoreExitCode: true,
          });
          const sizes = sizeResult.stdout.split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
          const totalBytes = sizes.reduce((a, b) => a + b, 0);
          if (totalBytes > 0) {
            sections.push(`\nTotal size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_extract_apks",
    "Pull all APK splits for a package from the device to a local directory. Useful for analysis, backup, or transfer to another device.",
    {
      packageName: z.string().describe("Package name to extract"),
      outputDir: z.string().optional().describe("Local output directory (default: temp dir)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, outputDir, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Get all APK paths
        const pathResult = await ctx.bridge.shell(`pm path ${packageName}`, {
          device: serial, ignoreExitCode: true,
        });

        const paths = pathResult.stdout.split("\n")
          .map((l) => l.replace("package:", "").trim())
          .filter((l) => l.length > 0);

        if (paths.length === 0) {
          return { content: [{ type: "text", text: `Package "${packageName}" not found.` }], isError: true };
        }

        // Create output directory — containment check if user-supplied
        const safePkg = packageName.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const destDir = outputDir ?? join(ctx.config.tempDir, "extracted", safePkg);
        if (outputDir) {
          // User-supplied path — verify it resolves inside tempDir to prevent path traversal
          const resolvedDest = resolve(destDir);
          const resolvedTemp = resolve(ctx.config.tempDir);
          if (!resolvedDest.startsWith(resolvedTemp)) {
            return {
              content: [{ type: "text", text: `Output directory must be inside the temp directory (${ctx.config.tempDir}). Got: ${destDir}` }],
              isError: true,
            };
          }
        }
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

        // Pull each APK
        const results: string[] = [];
        results.push(`Extracting ${paths.length} APK(s) for ${packageName}...\n`);

        let totalBytes = 0;
        for (const remotePath of paths) {
          const filename = remotePath.split("/").pop() ?? "unknown.apk";
          const localPath = join(destDir, filename);

          try {
            await ctx.bridge.exec(["pull", remotePath, localPath], {
              device: serial, timeout: 60000,
            });
            const size = statSync(localPath).size;
            totalBytes += size;
            results.push(`  ✓ ${filename} (${(size / 1024).toFixed(0)} KB)`);
          } catch (err) {
            results.push(`  ✗ ${filename}: ${err instanceof Error ? err.message : err}`);
          }
        }

        results.push(`\nTotal: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
        results.push(`Saved to: ${destDir}`);

        return { content: [{ type: "text", text: results.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_apex_list",
    "List installed APEX modules on the device. APEX (Android Pony EXpress) modules deliver updatable system components. Shows module name, version, and active/staged status.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Try pm list packages --apex-only (Android 10+)
        const apexResult = await ctx.bridge.shell("pm list packages --apex-only", {
          device: serial, ignoreExitCode: true,
        });

        if (apexResult.stdout.includes("Unknown option")) {
          // Fallback for older Android or devices that don't support the flag
          const fallback = await ctx.bridge.shell("ls /apex/ 2>/dev/null", {
            device: serial, ignoreExitCode: true,
          });
          const dirs = fallback.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("total"));

          if (dirs.length === 0) {
            return { content: [{ type: "text", text: "No APEX modules found (device may not support APEX)." }] };
          }

          return {
            content: [{
              type: "text",
              text: `${dirs.length} APEX module(s) in /apex/:\n\n${dirs.join("\n")}\n\nNote: --apex-only flag not supported; showing directory listing.`,
            }],
          };
        }

        const packages = apexResult.stdout.split("\n")
          .map((l) => l.replace("package:", "").trim())
          .filter((l) => l.length > 0)
          .sort();

        if (packages.length === 0) {
          return { content: [{ type: "text", text: "No APEX modules installed." }] };
        }

        // Get version info for each APEX
        const sections: string[] = [`${packages.length} APEX module(s):\n`];

        // Batch query — get dumpsys for a few key ones
        for (const pkg of packages) {
          const infoResult = await ctx.bridge.shell(`dumpsys package ${pkg} | grep -E 'versionName|versionCode|apexModuleName' | head -3`, {
            device: serial, timeout: 5000, ignoreExitCode: true,
          });
          const info = infoResult.stdout.trim();
          const versionMatch = info.match(/versionName=(\S+)/);
          const version = versionMatch ? ` v${versionMatch[1]}` : "";
          sections.push(`${pkg}${version}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
