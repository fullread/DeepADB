/**
 * Emulator Management Tools — AVD lifecycle management.
 * 
 * Manages Android Virtual Devices: list available AVDs, start/stop emulators.
 * Requires the Android SDK `emulator` binary to be on PATH or in the SDK directory.
 */

import { z } from "zod";
import { execFile, spawn, ChildProcess } from "child_process";
import { platform } from "os";
import { existsSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { isOnDevice } from "../config/config.js";
import { registerCleanup } from "../middleware/cleanup.js";

/** Track spawned emulator processes for cleanup. Key = AVD name. */
const emulatorProcesses = new Map<string, ChildProcess>();

// Register cleanup via shared registry to kill orphaned emulators on server exit
function ensureCleanupRegistered(): void {
  registerCleanup("emulator", () => {
    for (const [, proc] of emulatorProcesses) {
      try { proc.kill(); } catch { /* ignore */ }
    }
    emulatorProcesses.clear();
  });
}

function getEmulatorPath(): string {
  const isWindows = platform() === "win32";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  if (isWindows && localAppData) {
    const sdkPath = `${localAppData}\\Android\\Sdk\\emulator\\emulator.exe`;
    if (existsSync(sdkPath)) return sdkPath;
  }
  // Check ANDROID_HOME / ANDROID_SDK_ROOT
  const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdkRoot) {
    const sep = isWindows ? "\\" : "/";
    const ext = isWindows ? ".exe" : "";
    const sdkPath = `${sdkRoot}${sep}emulator${sep}emulator${ext}`;
    if (existsSync(sdkPath)) return sdkPath;
  }
  return "emulator";
}

export function registerEmulatorTools(ctx: ToolContext): void {

  ensureCleanupRegistered();

  ctx.server.tool(
    "adb_avd_list",
    "List all available Android Virtual Devices (AVDs) that can be started.",
    {},
    async () => {
      try {
        // On-device mode: SDK emulator binary is not available (it's compiled for
        // desktop x86_64). Check for KVM and QEMU as an alternative virtualization path.
        if (isOnDevice()) {
          const sections: string[] = [];
          sections.push("On-device mode: Android SDK emulator (AVD) is not available.");
          sections.push("The SDK emulator binary is compiled for desktop platforms (x86_64 Linux/macOS/Windows).\n");

          // Check for KVM support
          const kvmAvailable = existsSync("/dev/kvm");
          sections.push(`Hardware virtualization (KVM): ${kvmAvailable ? "✓ /dev/kvm available" : "✗ /dev/kvm not found"}`);

          // Check if QEMU is installed in Termux
          let qemuInstalled = false;
          try {
            const qemuCheck = await ctx.bridge.shell("which qemu-system-aarch64 2>/dev/null || which qemu-system-x86_64 2>/dev/null", {
              ignoreExitCode: true, timeout: 5000,
            });
            qemuInstalled = qemuCheck.stdout.trim().length > 0;
          } catch { /* not installed */ }

          sections.push(`QEMU: ${qemuInstalled ? "✓ installed" : "✗ not installed"}`);

          if (kvmAvailable && !qemuInstalled) {
            sections.push("\nQEMU with KVM is supported on this device for near-native emulation.");
            sections.push("Setup: adb_qemu_setup install=true");
            sections.push("Then: adb_qemu_images, adb_qemu_start, adb_qemu_stop, adb_qemu_status");
          } else if (kvmAvailable && qemuInstalled) {
            sections.push("\n✓ QEMU with KVM is available for on-device virtualization.");
            sections.push("Use: adb_qemu_images, adb_qemu_start, adb_qemu_stop, adb_qemu_status");
          } else {
            sections.push("\nWithout KVM, emulation would be software-only and very slow.");
          }

          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        const emulatorPath = getEmulatorPath();
        return new Promise((resolve) => {
          execFile(emulatorPath, ["-list-avds"], {
            timeout: 15000, windowsHide: true,
          }, (error, stdout, stderr) => {
            if (error && !stdout) {
              resolve({
                content: [{ type: "text", text: `Failed to list AVDs: ${error.message}\nIs the Android SDK emulator installed and on PATH?` }],
                isError: true,
              });
              return;
            }
            const avds = (stdout?.toString() ?? "").trim().split("\n").filter((l) => l.trim().length > 0);
            if (avds.length === 0) {
              resolve({ content: [{ type: "text", text: "No AVDs found. Create one with Android Studio's AVD Manager or `avdmanager`." }] });
              return;
            }

            // Also show any currently running emulators
            const running = Array.from(emulatorProcesses.keys());
            let output = `${avds.length} AVD(s) available:\n${avds.join("\n")}`;
            if (running.length > 0) {
              output += `\n\nCurrently running: ${running.join(", ")}`;
            }
            resolve({ content: [{ type: "text", text: output }] });
          });
        });
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_emulator_start",
    "Launch an Android Virtual Device (AVD) emulator. Returns once the emulator process has started.",
    {
      avdName: z.string().describe("AVD name (from adb_avd_list)"),
      headless: z.boolean().optional().default(false).describe("Run without GUI window (-no-window)"),
      coldBoot: z.boolean().optional().default(false).describe("Force cold boot (-no-snapshot-load)"),
      gpuMode: z.enum(["auto", "host", "swiftshader_indirect", "off"]).optional().default("auto")
        .describe("GPU acceleration mode"),
    },
    async ({ avdName, headless, coldBoot, gpuMode }) => {
      try {
        if (isOnDevice()) {
          return {
            content: [{
              type: "text",
              text: "On-device mode: AVD emulator is not available.\n" +
                "The Android SDK emulator requires a desktop host (x86_64 Linux/macOS/Windows).\n\n" +
                "Use the QEMU tools for on-device virtualization:\n" +
                "  adb_qemu_setup — install QEMU and verify KVM\n" +
                "  adb_qemu_images — create/manage disk images\n" +
                "  adb_qemu_start — boot a VM with KVM acceleration\n" +
                "  adb_qemu_status — view running VMs",
            }],
            isError: true,
          };
        }

        if (emulatorProcesses.has(avdName)) {
          return { content: [{ type: "text", text: `Emulator '${avdName}' is already running.` }], isError: true };
        }

        const emulatorPath = getEmulatorPath();
        const args = ["-avd", avdName, `-gpu`, gpuMode];
        if (headless) args.push("-no-window");
        if (coldBoot) args.push("-no-snapshot-load");

        const proc = spawn(emulatorPath, args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });

        emulatorProcesses.set(avdName, proc);

        let stderrOutput = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrOutput += chunk.toString();
        });

        proc.on("error", (err) => {
          ctx.logger.error(`[emulator:${avdName}] Spawn error: ${err.message}`);
          emulatorProcesses.delete(avdName);
        });

        proc.on("exit", (code) => {
          ctx.logger.info(`[emulator:${avdName}] Exited (code: ${code})`);
          emulatorProcesses.delete(avdName);
        });

        // Wait briefly for startup errors
        await new Promise((r) => setTimeout(r, 3000));

        // Check if process died immediately
        if (!emulatorProcesses.has(avdName)) {
          const errorMsg = stderrOutput.trim().split("\n").slice(0, 5).join("\n");
          return {
            content: [{ type: "text", text: `Emulator '${avdName}' failed to start.${errorMsg ? "\n" + errorMsg : ""}` }],
            isError: true,
          };
        }

        ctx.deviceManager.invalidateCache();

        return {
          content: [{
            type: "text",
            text: `Emulator '${avdName}' starting...${headless ? " (headless)" : ""}\nUse adb_devices to check when it comes online.\nUse adb_emulator_stop to shut it down.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_emulator_stop",
    "Stop a running emulator. Uses 'adb emu kill' for graceful shutdown.",
    {
      avdName: z.string().optional().describe("AVD name to stop. If omitted, lists running emulators."),
      device: z.string().optional().describe("Emulator device serial (e.g., 'emulator-5554') — alternative to avdName"),
    },
    async ({ avdName, device }) => {
      try {
        // If device serial is provided, kill via ADB directly
        if (device) {
          await ctx.bridge.exec(["emu", "kill"], { device, timeout: 10000, ignoreExitCode: true });
          ctx.deviceManager.invalidateCache();
          return { content: [{ type: "text", text: `Emulator ${device} shutdown initiated.` }] };
        }

        // If AVD name is provided, find and kill it
        if (avdName) {
          const proc = emulatorProcesses.get(avdName);
          if (proc) {
            try { proc.kill(); } catch { /* ignore */ }
            emulatorProcesses.delete(avdName);
          }
          ctx.deviceManager.invalidateCache();
          return { content: [{ type: "text", text: `Emulator '${avdName}' stop signal sent.` }] };
        }

        // No args — list running emulators
        const running = Array.from(emulatorProcesses.keys());
        if (running.length === 0) {
          return { content: [{ type: "text", text: "No emulators tracked by DeepADB. Use device serial to stop externally-launched emulators." }] };
        }
        return { content: [{ type: "text", text: `Running emulators: ${running.join(", ")}\nProvide avdName or device serial to stop.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
