// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Build Tools — Gradle build, install, and run integration.
 */

import { z } from "zod";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { platform } from "os";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

function getGradleWrapper(projectPath: string): string {
  const isWindows = platform() === "win32";
  const wrapper = isWindows ? "gradlew.bat" : "gradlew";
  const fullPath = join(projectPath, wrapper);
  return existsSync(fullPath) ? fullPath : wrapper;
}

export function registerBuildTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_gradle",
    "Run a Gradle task in an Android project directory",
    {
      projectPath: z.string().describe("Path to the Android project root (containing gradlew)"),
      task: z.string().describe("Gradle task (e.g., 'assembleDebug', 'installDebug', 'clean')"),
      args: z.array(z.string()).optional().describe("Additional Gradle arguments as an array of strings (e.g., ['-Pversion=1.0', '--info']). Use an array — not a space-separated string — so arguments containing quoted values are preserved as single tokens."),
      timeout: z.number().int().min(30000).max(1800000).optional().default(300000)
        .describe("Build timeout in milliseconds (30s-30min, default 5min). V5 fix: large multi-module Android projects (60+ modules) routinely exceed the default; raise this for clean builds of bigger projects."),
    },
    async ({ projectPath, task, args, timeout }) => {
      try {
        // V1 fix: preflight existsSync on projectPath. A non-existent path was
        // previously passed to execFile as cwd, producing a low-level ENOENT
        // from the OS that obscured the operator's actual mistake (wrong path).
        // Clear error surfaces immediately, before any subprocess work.
        if (!existsSync(projectPath)) {
          return { content: [{ type: "text", text: `Project path does not exist: ${projectPath}` }], isError: true };
        }
        const gradle = getGradleWrapper(projectPath);
        const gradleArgs = [task];
        if (args) gradleArgs.push(...args);
        return new Promise((resolve) => {
          execFile(gradle, gradleArgs, {
            cwd: projectPath,
            timeout,
            maxBuffer: 1024 * 1024 * 10,
            windowsHide: true,
          }, (error, stdout, stderr) => {
            let output = stdout?.toString() ?? "";
            if (stderr) output += `\n--- STDERR ---\n${stderr.toString()}`;
            if (error && error.killed) output += `\n--- BUILD TIMED OUT (${Math.round(timeout/1000)}s limit) ---`;
            resolve({ content: [{ type: "text", text: OutputProcessor.process(output) }] });
          });
        });
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_build_and_install",
    "Build a debug APK and install it on the connected device (convenience wrapper)",
    {
      projectPath: z.string().describe("Path to the Android project root"),
      device: z.string().optional().describe("Device serial"),
      timeout: z.number().int().min(30000).max(1800000).optional().default(300000)
        .describe("Build+install timeout in milliseconds (30s-30min, default 5min). V5 fix."),
    },
    async ({ projectPath, device, timeout }) => {
      try {
        // V1 fix (matches above): preflight existsSync on projectPath.
        if (!existsSync(projectPath)) {
          return { content: [{ type: "text", text: `Project path does not exist: ${projectPath}` }], isError: true };
        }
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const gradle = getGradleWrapper(projectPath);
        return new Promise((resolve) => {
          execFile(gradle, ["installDebug"], {
            cwd: projectPath,
            timeout,
            maxBuffer: 1024 * 1024 * 10,
            windowsHide: true,
            env: { ...process.env, ANDROID_SERIAL: resolved.serial },
          }, (error, stdout, stderr) => {
            let output = stdout?.toString() ?? "";
            if (stderr) output += `\n--- STDERR ---\n${stderr.toString()}`;
            if (error && error.killed) {
              // V4 fix: surface timeout marker (matches gradle V5 tool). Previously
              // a killed build_and_install fell through with no diagnostic.
              output += `\n--- BUILD AND INSTALL TIMED OUT (${Math.round(timeout/1000)}s limit) ---`;
            } else if (error && !error.killed) {
              output += `\n--- BUILD FAILED ---`;
            } else if (!error) {
              output += `\n--- BUILD AND INSTALL SUCCESSFUL (device: ${resolved.serial}) ---`;
            }
            resolve({ content: [{ type: "text", text: OutputProcessor.process(output) }] });
          });
        });
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
