// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Screen Recording Tools — Start/stop video capture on the device.
 * 
 * Uses `adb shell screenrecord` with a background process pattern.
 * The recording runs on-device; stop pulls the mp4 locally.
 */

import { z } from "zod";
import { join } from "path";
import { statSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellQuote } from "../middleware/sanitize.js";

interface RecordingSession {
  device: string;
  remotePath: string;
  startedAt: number;
  maxDuration: number;
}

/** Only one recording per device at a time. Key = device serial. */
const recordings = new Map<string, RecordingSession>();

export function registerScreenRecordTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_screenrecord_start",
    "Start recording the device screen. Recording runs on-device. Use adb_screenrecord_stop to finish and pull the video file.",
    {
      maxDuration: z.number().min(1).max(180).optional().default(60)
        .describe("Maximum recording duration in seconds (1-180, default 60)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ maxDuration, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        if (recordings.has(serial)) {
          return { content: [{ type: "text", text: `Recording already in progress on ${serial}. Stop it first with adb_screenrecord_stop.` }], isError: true };
        }

        const filename = `screenrecord_${Date.now()}.mp4`;
        const remotePath = `/sdcard/${filename}`;

        // Start screenrecord in background via shell nohup
        // screenrecord auto-stops at --time-limit
        await ctx.bridge.shell(
          `nohup screenrecord --time-limit ${maxDuration} ${shellQuote(remotePath)} > /dev/null 2>&1 &`,
          { device: serial, ignoreExitCode: true }
        );

        recordings.set(serial, {
          device: serial,
          remotePath,
          startedAt: Date.now(),
          maxDuration,
        });

        return {
          content: [{
            type: "text",
            text: `Recording started on ${serial}\nMax duration: ${maxDuration}s\nDevice path: ${remotePath}\nUse adb_screenrecord_stop to finish and pull the video.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_screenrecord_stop",
    "Stop an active screen recording and pull the video file locally. If the recording has already finished (hit time limit), this just pulls the file.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      let resolvedSerial: string | undefined;
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        resolvedSerial = resolved.serial;
        const serial = resolved.serial;
        const session = recordings.get(serial);

        if (!session) {
          return { content: [{ type: "text", text: `No active recording on ${serial}.` }], isError: true };
        }

        // Kill the screenrecord process writing to our specific file.
        // Uses pgrep (by binary name) + /proc/cmdline grep to avoid the pkill -f
        // self-match bug: on-device, pkill -f runs through su -c whose cmdline
        // contains the pattern, causing pkill to kill itself instead of screenrecord.
        const recordFilename = session.remotePath.split("/").pop() ?? "";
        await ctx.bridge.shell(
          `pgrep screenrecord | while read p; do grep -q '${recordFilename}' /proc/$p/cmdline 2>/dev/null && kill $p; done 2>/dev/null; true`,
          { device: serial, ignoreExitCode: true, timeout: 5000 }
        );

        // Brief wait for file to finalize
        await new Promise((r) => setTimeout(r, 1500));

        // Pull the file locally
        const localFilename = session.remotePath.split("/").pop() ?? "recording.mp4";
        const localPath = join(ctx.config.tempDir, localFilename);

        // AX6 fix: scale the pull timeout with recording duration. A 3-minute
        // recording at high bitrate can produce a 20-50 MB file; over slow USB 2.0
        // or wireless ADB the pull alone can exceed the previous hardcoded 60s.
        // Formula: 30s base + 2s per second of recorded duration (handles ~500 KB/s
        // pull throughput conservatively; healthy USB 3.0 will finish much faster).
        const recordedSec = Math.max(1, (Date.now() - session.startedAt) / 1000);
        const pullTimeoutMs = Math.min(600000, 30000 + Math.ceil(recordedSec * 2000));
        await ctx.bridge.exec(["pull", session.remotePath, localPath], {
          device: serial, timeout: pullTimeoutMs,
        });

        // Clean up device file
        await ctx.bridge.shell(`rm ${shellQuote(session.remotePath)}`, {
          device: serial, ignoreExitCode: true,
        });

        const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(1);
        recordings.delete(serial);

        // AX5 fix: detect empty-file pull. screenrecord requires hardware H.264
        // encoder; on some emulators and virtualized environments the binary
        // exits silently with a zero-byte output. Previously the tool reported
        // "Recording saved" with no hint the file was empty. Now we check
        // size and surface the failure explicitly.
        let fileSize = 0;
        try {
          fileSize = statSync(localPath).size;
        } catch { /* file missing → treat as 0 */ }
        if (fileSize === 0) {
          return {
            content: [{
              type: "text",
              text: `Recording produced an empty file at ${localPath}. This usually means the device's screenrecord binary failed silently — common on emulators without hardware H.264 encoders, or on devices in restricted modes. Try: (1) recording on a physical device, (2) lowering bitrate, (3) checking dmesg for screenrecord errors. Duration: ~${elapsed}s`,
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: `Recording saved: ${localPath}\nDuration: ~${elapsed}s\nFile size: ${(fileSize / 1024).toFixed(1)} KB`,
          }],
        };
      } catch (error) {
        // Clean up session state even on error
        if (resolvedSerial) {
          recordings.delete(resolvedSerial);
        }
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
