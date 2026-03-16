/**
 * Logcat Watch Tools — Background logcat accumulator with poll-based retrieval.
 * 
 * Unlike the snapshot-based adb_logcat tool, this starts a persistent logcat
 * process in the background and accumulates lines into a ring buffer. Each
 * poll returns only new lines since the last poll, giving a tail -f experience
 * across multiple tool invocations.
 */

import { z } from "zod";
import { ChildProcess } from "child_process";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { registerCleanup } from "../middleware/cleanup.js";

interface WatchSession {
  process: ChildProcess;
  buffer: string[];
  readCursor: number; // Index of next unread line
  maxLines: number;
  startedAt: number;
  tag?: string;
  device: string;
}

/** Global map of active watch sessions by ID. */
const sessions = new Map<string, WatchSession>();
let sessionCounter = 0;

/** Maximum concurrent watcher sessions to prevent resource exhaustion. */
const MAX_WATCH_SESSIONS = 10;

/**
 * Kill all active watcher sessions. Called on process exit to prevent
 * orphaned adb logcat processes — critical on Windows where child
 * processes can persist after parent exits.
 */
function cleanupAllSessions(): void {
  for (const [id, session] of sessions) {
    try {
      session.process.kill();
    } catch {
      // Process may already be dead — ignore
    }
    sessions.delete(id);
  }
}

// Register cleanup via shared registry (runs on exit/SIGINT/SIGTERM)
function ensureCleanupRegistered(): void {
  registerCleanup("logcat-watch", cleanupAllSessions);
}

export function registerLogcatWatchTools(ctx: ToolContext): void {

  // Ensure orphaned processes get cleaned up on server exit
  ensureCleanupRegistered();

  ctx.server.tool(
    "adb_logcat_start",
    "Start a background logcat watcher. Lines accumulate in a ring buffer. Use adb_logcat_poll to retrieve new entries.",
    {
      tag: z.string().optional().describe("Filter by tag (e.g., 'MyApp')"),
      priority: z.enum(["V", "D", "I", "W", "E", "F"]).optional().describe("Minimum priority level"),
      bufferSize: z.number().min(100).max(50000).optional().default(2000).describe("Max lines to keep in ring buffer (100-50000, default 2000)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ tag, priority, bufferSize, device }) => {
      try {
        if (sessions.size >= MAX_WATCH_SESSIONS) {
          return {
            content: [{ type: "text", text: `Maximum concurrent watcher sessions reached (${MAX_WATCH_SESSIONS}). Stop an existing session with adb_logcat_stop before starting a new one.` }],
            isError: true,
          };
        }
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const id = `watch_${++sessionCounter}`;

        // Build logcat args — bridge.spawnStreaming() handles the ADB/local dispatch
        const logcatArgs: string[] = ["logcat"];

        // Tag/priority filter
        if (tag && priority) {
          logcatArgs.push("-s", `${tag}:${priority}`);
        } else if (tag) {
          logcatArgs.push("-s", `${tag}:V`);
        } else if (priority) {
          logcatArgs.push(`*:${priority}`);
        }

        // Spawn persistent logcat process via bridge (works in both ADB and on-device modes)
        const proc = ctx.bridge.spawnStreaming(logcatArgs, resolved.serial);

        const session: WatchSession = {
          process: proc,
          buffer: [],
          readCursor: 0,
          maxLines: bufferSize,
          startedAt: Date.now(),
          tag,
          device: resolved.serial,
        };

        let partial = "";

        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = partial + chunk.toString();
          const lines = text.split("\n");
          // Last element might be a partial line
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) {
              session.buffer.push(line);
              // Ring buffer: drop oldest when full
              if (session.buffer.length > session.maxLines) {
                const overflow = session.buffer.length - session.maxLines;
                session.buffer.splice(0, overflow);
                // Adjust cursor if it pointed into dropped lines
                session.readCursor = Math.max(0, session.readCursor - overflow);
              }
            }
          }
        });

        // Log stderr so we can diagnose why a watcher silently stops
        proc.stderr?.on("data", (chunk: Buffer) => {
          const msg = chunk.toString().trim();
          if (msg) {
            ctx.logger.warn(`[${id}] logcat stderr: ${msg}`);
          }
        });

        // Catch spawn-level failures (ENOENT if ADB binary missing, EACCES, etc.)
        // Without this handler, the error becomes an uncaught exception that crashes the server.
        proc.on("error", (err) => {
          ctx.logger.error(`[${id}] Failed to spawn logcat process: ${err.message}`);
          sessions.delete(id);
        });

        proc.on("exit", (code) => {
          ctx.logger.info(`[${id}] logcat process exited (code: ${code})`);
          sessions.delete(id);
        });

        sessions.set(id, session);

        const filterDesc = tag ? ` (tag: ${tag}${priority ? `:${priority}` : ""})` : "";
        return {
          content: [{
            type: "text",
            text: `Logcat watcher started: ${id}${filterDesc}\nDevice: ${resolved.serial}\nBuffer: ${bufferSize} lines\nUse adb_logcat_poll with session="${id}" to retrieve new entries.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_logcat_poll",
    "Retrieve new logcat lines since the last poll from a running watcher session.",
    {
      session: z.string().describe("Session ID from adb_logcat_start (e.g., 'watch_1')"),
      maxLines: z.number().min(1).max(10000).optional().default(200).describe("Max lines to return per poll (1-10000)"),
    },
    async ({ session: sessionId, maxLines }) => {
      try {
        const session = sessions.get(sessionId);
        if (!session) {
          const active = Array.from(sessions.keys());
          return {
            content: [{
              type: "text",
              text: `Session "${sessionId}" not found. Active sessions: ${active.join(", ") || "none"}`,
            }],
            isError: true,
          };
        }

        const available = session.buffer.length - session.readCursor;
        if (available <= 0) {
          const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(0);
          return {
            content: [{
              type: "text",
              text: `No new lines. Watcher running for ${elapsed}s, buffer: ${session.buffer.length}/${session.maxLines} lines.`,
            }],
          };
        }

        const startIdx = session.readCursor;
        const endIdx = Math.min(session.buffer.length, startIdx + maxLines);
        const lines = session.buffer.slice(startIdx, endIdx);
        session.readCursor = endIdx;

        const remaining = session.buffer.length - endIdx;
        let text = lines.join("\n");
        if (remaining > 0) {
          text += `\n\n--- ${remaining} more lines available, poll again to continue ---`;
        }

        return { content: [{ type: "text", text: OutputProcessor.process(text) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_logcat_stop",
    "Stop a running logcat watcher session",
    {
      session: z.string().describe("Session ID to stop (e.g., 'watch_1'), or 'all' to stop all"),
    },
    async ({ session: sessionId }) => {
      try {
        if (sessionId === "all") {
          const count = sessions.size;
          cleanupAllSessions();
          return { content: [{ type: "text", text: `Stopped ${count} watcher session(s).` }] };
        }

        const session = sessions.get(sessionId);
        if (!session) {
          return { content: [{ type: "text", text: `Session "${sessionId}" not found.` }], isError: true };
        }
        const lineCount = session.buffer.length;
        session.process.kill();
        sessions.delete(sessionId);
        return { content: [{ type: "text", text: `Stopped ${sessionId}. Captured ${lineCount} total lines.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_logcat_sessions",
    "List all active logcat watcher sessions",
    {},
    async () => {
      try {
        if (sessions.size === 0) {
          return { content: [{ type: "text", text: "No active watcher sessions." }] };
        }
        const lines: string[] = [];
        for (const [id, s] of sessions) {
          const elapsed = ((Date.now() - s.startedAt) / 1000).toFixed(0);
          const unread = s.buffer.length - s.readCursor;
          lines.push(
            `${id}: device=${s.device}, tag=${s.tag ?? "(all)"}, ` +
            `buffer=${s.buffer.length}/${s.maxLines}, unread=${unread}, running=${elapsed}s`
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
