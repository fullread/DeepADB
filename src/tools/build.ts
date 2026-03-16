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
      args: z.string().optional().describe("Additional Gradle arguments"),
    },
    async ({ projectPath, task, args }) => {
      try {
        const gradle = getGradleWrapper(projectPath);
        const gradleArgs = [task];
        if (args) gradleArgs.push(...args.split(" "));
        return new Promise((resolve) => {
          execFile(gradle, gradleArgs, {
            cwd: projectPath,
            timeout: 300000,
            maxBuffer: 1024 * 1024 * 10,
            windowsHide: true,
          }, (error, stdout, stderr) => {
            let output = stdout?.toString() ?? "";
            if (stderr) output += `\n--- STDERR ---\n${stderr.toString()}`;
            if (error && error.killed) output += "\n--- BUILD TIMED OUT (5 min limit) ---";
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
    },
    async ({ projectPath, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const gradle = getGradleWrapper(projectPath);
        return new Promise((resolve) => {
          execFile(gradle, ["installDebug"], {
            cwd: projectPath,
            timeout: 300000,
            maxBuffer: 1024 * 1024 * 10,
            windowsHide: true,
            env: { ...process.env, ANDROID_SERIAL: resolved.serial },
          }, (error, stdout, stderr) => {
            let output = stdout?.toString() ?? "";
            if (stderr) output += `\n--- STDERR ---\n${stderr.toString()}`;
            if (error && !error.killed) {
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
