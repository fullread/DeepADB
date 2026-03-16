/**
 * Device Mirroring Tools — Live screen mirroring via scrcpy.
 *
 * Provides start/stop control over scrcpy mirroring sessions.
 * Scrcpy must be installed separately and available on PATH.
 * Supports headless (no-display) mode for recording-only workflows,
 * windowed mode for visual feedback, and configurable bitrate/resolution.
 *
 * Multi-device: sessions are tracked per device serial, allowing
 * simultaneous mirroring of multiple connected devices.
 */

import { z } from "zod";
import { spawn, ChildProcess, execFile } from "child_process";
import { platform } from "os";
import { existsSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { registerCleanup } from "../middleware/cleanup.js";

interface MirrorSession {
  process: ChildProcess;
  device: string;
  startedAt: number;
  options: { headless: boolean; maxFps: number; bitrate: string; maxSize: number };
}

/** Active mirror sessions by device serial. */
const sessions = new Map<string, MirrorSession>();

/** Locate scrcpy binary. */
function findScrcpy(): string | null {
  const isWindows = platform() === "win32";
  const binary = isWindows ? "scrcpy.exe" : "scrcpy";

  // Check common install locations
  const candidates: string[] = [];
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    if (localAppData) {
      candidates.push(`${localAppData}\\scrcpy\\${binary}`);
    }
    candidates.push(`C:\\scrcpy\\${binary}`);
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    candidates.push(`${programFiles}\\scrcpy\\${binary}`);
  } else {
    candidates.push("/usr/local/bin/scrcpy");
    candidates.push("/usr/bin/scrcpy");
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  // Fall back to PATH
  return binary;
}

function checkScrcpyVersion(scrcpyPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(scrcpyPath, ["--version"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout?.toString().trim() ?? null);
    });
  });
}

// Register cleanup via shared registry
function ensureCleanupRegistered(): void {
  registerCleanup("mirroring", () => {
    for (const [, session] of sessions) {
      try { session.process.kill(); } catch { /* ignore */ }
    }
    sessions.clear();
  });
}

export function registerMirroringTools(ctx: ToolContext): void {

  ensureCleanupRegistered();

  ctx.server.tool(
    "adb_mirror_start",
    "Start live screen mirroring for a device using scrcpy. Requires scrcpy installed and on PATH. Supports windowed (visual) and headless (no display) modes. One session per device.",
    {
      device: z.string().optional().describe("Device serial"),
      headless: z.boolean().optional().default(false).describe("No-display mode — useful with recording. Omits the scrcpy window."),
      maxFps: z.number().min(1).max(120).optional().default(30).describe("Maximum frame rate (1-120, default 30)"),
      bitrate: z.string().optional().default("4M").describe("Video bitrate (e.g., '4M', '8M', '2M')"),
      maxSize: z.number().min(0).max(4096).optional().default(0).describe("Max dimension in pixels (0 = no limit, max 4096)"),
      record: z.string().optional().describe("Record to a local file path (e.g., 'mirror.mp4')"),
      stayAwake: z.boolean().optional().default(true).describe("Keep device awake while mirroring"),
      turnScreenOff: z.boolean().optional().default(false).describe("Turn device screen off during mirroring (saves battery)"),
    },
    async ({ device, headless, maxFps, bitrate, maxSize, record, stayAwake, turnScreenOff }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        if (sessions.has(serial)) {
          return {
            content: [{ type: "text", text: `Mirror session already active for ${serial}. Stop it first with adb_mirror_stop.` }],
            isError: true,
          };
        }

        const scrcpyPath = findScrcpy();
        if (!scrcpyPath) {
          return {
            content: [{ type: "text", text: "scrcpy not found. Install from: https://github.com/Genymobile/scrcpy\nOn Windows: scoop install scrcpy, or download the release ZIP.\nOn Linux: apt install scrcpy or snap install scrcpy." }],
            isError: true,
          };
        }

        // Verify scrcpy works
        const version = await checkScrcpyVersion(scrcpyPath);
        if (!version) {
          return {
            content: [{ type: "text", text: `scrcpy found at ${scrcpyPath} but failed to run. Check installation.` }],
            isError: true,
          };
        }

        // Build scrcpy args
        const args: string[] = ["-s", serial];

        if (headless) args.push("--no-display");
        if (maxFps > 0) args.push("--max-fps", String(maxFps));
        if (bitrate) args.push("--video-bit-rate", bitrate);
        if (maxSize > 0) args.push("--max-size", String(maxSize));
        if (record) args.push("--record", record);
        if (stayAwake) args.push("--stay-awake");
        if (turnScreenOff) args.push("--turn-screen-off");

        const proc = spawn(scrcpyPath, args, {
          windowsHide: false, // scrcpy needs a window unless headless
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });

        const session: MirrorSession = {
          process: proc,
          device: serial,
          startedAt: Date.now(),
          options: { headless, maxFps, bitrate, maxSize },
        };

        let stderrOutput = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrOutput += chunk.toString();
        });

        proc.on("error", (err) => {
          ctx.logger.error(`[mirror:${serial}] Spawn error: ${err.message}`);
          sessions.delete(serial);
        });

        proc.on("exit", (code) => {
          ctx.logger.info(`[mirror:${serial}] scrcpy exited (code: ${code})`);
          sessions.delete(serial);
        });

        // Brief wait to check for immediate failure
        await new Promise((r) => setTimeout(r, 2000));

        if (proc.exitCode !== null) {
          const errorMsg = stderrOutput.trim().split("\n").slice(0, 5).join("\n");
          // Don't add to sessions if already exited
          return {
            content: [{ type: "text", text: `scrcpy failed to start for ${serial}.${errorMsg ? "\n" + errorMsg : ""}` }],
            isError: true,
          };
        }

        sessions.set(serial, session);

        const modeDesc = headless ? "headless (no display)" : "windowed";
        const recordDesc = record ? `\nRecording to: ${record}` : "";

        return {
          content: [{
            type: "text",
            text: `Mirror started: ${serial} (${modeDesc})\nscrcpy ${version}\nFPS: ${maxFps}, Bitrate: ${bitrate}${maxSize > 0 ? `, Max size: ${maxSize}px` : ""}${recordDesc}\nUse adb_mirror_stop to end the session.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_mirror_stop",
    "Stop an active scrcpy mirroring session for a device.",
    {
      device: z.string().optional().describe("Device serial (stops that device's session). Omit to stop all."),
    },
    async ({ device }) => {
      try {
        if (!device) {
          // Stop all
          const count = sessions.size;
          if (count === 0) {
            return { content: [{ type: "text", text: "No active mirror sessions." }] };
          }
          for (const [serial, session] of sessions) {
            try { session.process.kill(); } catch { /* ignore */ }
            ctx.logger.info(`[mirror:${serial}] Stopped.`);
          }
          sessions.clear();
          return { content: [{ type: "text", text: `Stopped ${count} mirror session(s).` }] };
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const session = sessions.get(serial);

        if (!session) {
          return { content: [{ type: "text", text: `No active mirror session for ${serial}.` }], isError: true };
        }

        const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(1);
        try { session.process.kill(); } catch { /* ignore */ }
        sessions.delete(serial);

        return { content: [{ type: "text", text: `Mirror stopped: ${serial} (ran for ${elapsed}s).` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_mirror_status",
    "Check scrcpy availability and list active mirroring sessions.",
    {},
    async () => {
      try {
        const scrcpyPath = findScrcpy();
        const sections: string[] = [];

        if (!scrcpyPath) {
          sections.push("scrcpy: NOT FOUND");
          sections.push("Install from: https://github.com/Genymobile/scrcpy");
        } else {
          const version = await checkScrcpyVersion(scrcpyPath);
          if (version) {
            sections.push(`scrcpy: ${version}`);
            sections.push(`Path: ${scrcpyPath}`);
          } else {
            sections.push(`scrcpy: found at ${scrcpyPath} but failed to execute`);
          }
        }

        sections.push("");
        if (sessions.size === 0) {
          sections.push("Active sessions: none");
        } else {
          sections.push(`Active sessions: ${sessions.size}`);
          for (const [serial, session] of sessions) {
            const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(0);
            const mode = session.options.headless ? "headless" : "windowed";
            sections.push(`  ${serial}: ${mode}, ${session.options.maxFps}fps, ${session.options.bitrate}, running ${elapsed}s`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
