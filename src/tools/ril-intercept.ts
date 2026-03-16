/**
 * RIL Message Interception — Passive radio interface layer monitoring.
 *
 * Captures and parses RIL (Radio Interface Layer) messages from the
 * Android radio logcat buffer. RIL sits between the telephony framework
 * and the baseband modem — intercepting these messages provides visibility
 * into network attach, authentication, handover, paging, and registration
 * events useful for radio diagnostics and cellular network research.
 *
 * Parsed message categories:
 *   - Registration: VOICE_REGISTRATION_STATE, DATA_REGISTRATION_STATE
 *   - Cell info: GET_CELL_INFO_LIST responses
 *   - Signal: SIGNAL_STRENGTH updates
 *   - Network: OPERATOR, QUERY_NETWORK_SELECTION_MODE
 *   - Security: AUTHENTICATION events, cipher indicators
 *   - Handover: Tracking area updates, cell reselection
 *
 * Uses spawned logcat processes (like logcat-watch) with radio buffer
 * filtering. Root access optional but recommended for kernel-level
 * modem messages via dmesg.
 */

import { z } from "zod";
import { ChildProcess } from "child_process";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { registerCleanup } from "../middleware/cleanup.js";

interface RilMessage {
  timestamp: string;
  tag: string;
  priority: string;
  raw: string;
  category: string;
}

interface RilSession {
  process: ChildProcess;
  buffer: RilMessage[];
  rawBuffer: string[];
  readCursor: number;
  maxMessages: number;
  startedAt: number;
  device: string;
  includeKernel: boolean;
}

/** Active RIL capture sessions by ID. */
const sessions = new Map<string, RilSession>();
let sessionCounter = 0;
const MAX_RIL_SESSIONS = 5;

/** RIL message category patterns. */
const RIL_CATEGORIES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /VOICE_REGISTRATION_STATE|DATA_REGISTRATION_STATE|REGISTRATION_FAILED/i, category: "registration" },
  { pattern: /CELL_INFO|CellInfo|mCellInfo/i, category: "cell_info" },
  { pattern: /SIGNAL_STRENGTH|SignalStrength/i, category: "signal" },
  { pattern: /OPERATOR|COPS|operator/i, category: "network" },
  { pattern: /AUTH|CPIN|SIM_STATUS|IMSI/i, category: "security" },
  { pattern: /HANDOVER|TAU|TRACKING_AREA|RESELECT/i, category: "handover" },
  { pattern: /SETUP_DATA_CALL|DEACTIVATE_DATA|DATA_CALL_LIST/i, category: "data" },
  { pattern: /RADIO_STATE|CFUN|RADIO_POWER/i, category: "radio_state" },
  { pattern: /SMS|CDMA_SMS|NEW_SMS/i, category: "sms" },
  { pattern: /NAS|EMM|5GMM|ATTACH|DETACH/i, category: "nas" },
];

function categorizeMessage(line: string): string {
  for (const { pattern, category } of RIL_CATEGORIES) {
    if (pattern.test(line)) return category;
  }
  return "other";
}

function parseRilLine(line: string): RilMessage | null {
  // Standard logcat format: "MM-DD HH:MM:SS.mmm PID TID PRIORITY TAG: message"
  const match = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+\d+\s+\d+\s+([VDIWEF])\s+(.+?):\s+(.*)/);
  if (!match) return null;

  return {
    timestamp: match[1],
    priority: match[2],
    tag: match[3].trim(),
    raw: match[4],
    category: categorizeMessage(match[4]),
  };
}

// Register cleanup via shared registry
function ensureCleanupRegistered(): void {
  registerCleanup("ril-intercept", () => {
    for (const [, session] of sessions) {
      try { session.process.kill(); } catch { /* ignore */ }
    }
    sessions.clear();
  });
}

export function registerRilInterceptTools(ctx: ToolContext): void {

  ensureCleanupRegistered();

  ctx.server.tool(
    "adb_ril_start",
    "Start capturing RIL (Radio Interface Layer) messages from the radio logcat buffer. Captures network registration, cell info, signal strength, authentication, handover, and NAS events. Useful for radio diagnostics and cellular network research.",
    {
      bufferSize: z.number().min(100).max(50000).optional().default(5000).describe("Max messages to keep in ring buffer (100-50000, default 5000)"),
      includeKernel: z.boolean().optional().default(false).describe("Also capture from main and kernel logcat buffers for modem framework and kernel-level radio messages"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ bufferSize, includeKernel, device }) => {
      try {
        if (sessions.size >= MAX_RIL_SESSIONS) {
          return {
            content: [{ type: "text", text: `Maximum RIL sessions reached (${MAX_RIL_SESSIONS}). Stop an existing session first.` }],
            isError: true,
          };
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const id = `ril_${++sessionCounter}`;

        // Spawn logcat with radio buffer (and main buffer if includeKernel for modem framework messages)
        const buffers = includeKernel ? "radio,main,kernel" : "radio";
        const logcatArgs = ["logcat", "-b", buffers, "-v", "time"];

        // Spawn via bridge — works in both ADB and on-device modes
        const proc = ctx.bridge.spawnStreaming(logcatArgs, serial);

        const session: RilSession = {
          process: proc,
          buffer: [],
          rawBuffer: [],
          readCursor: 0,
          maxMessages: bufferSize,
          startedAt: Date.now(),
          device: serial,
          includeKernel,
        };

        let partial = "";

        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = partial + chunk.toString();
          const lines = text.split("\n");
          partial = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const parsed = parseRilLine(trimmed);
            if (parsed) {
              session.buffer.push(parsed);
              session.rawBuffer.push(trimmed);

              // Ring buffer management
              if (session.buffer.length > session.maxMessages) {
                const overflow = session.buffer.length - session.maxMessages;
                session.buffer.splice(0, overflow);
                session.rawBuffer.splice(0, overflow);
                session.readCursor = Math.max(0, session.readCursor - overflow);
              }
            }
          }
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const msg = chunk.toString().trim();
          if (msg) ctx.logger.warn(`[${id}] radio logcat stderr: ${msg}`);
        });

        proc.on("error", (err) => {
          ctx.logger.error(`[${id}] Failed to spawn radio logcat: ${err.message}`);
          sessions.delete(id);
        });

        proc.on("exit", (code) => {
          ctx.logger.info(`[${id}] radio logcat exited (code: ${code})`);
          sessions.delete(id);
        });

        sessions.set(id, session);

        return {
          content: [{
            type: "text",
            text: `RIL capture started: ${id}\nDevice: ${serial}\nBuffer: ${bufferSize} messages\nLogcat buffers: ${includeKernel ? "radio + main + kernel" : "radio only"}\n\nCapturing: registration, cell info, signal, network, security, handover, NAS events\nUse adb_ril_poll to retrieve captured messages.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ril_poll",
    "Retrieve captured RIL messages since the last poll. Optionally filter by category (registration, cell_info, signal, network, security, handover, data, radio_state, nas).",
    {
      session: z.string().describe("Session ID from adb_ril_start (e.g., 'ril_1')"),
      category: z.string().optional().describe("Filter by category: registration, cell_info, signal, network, security, handover, data, radio_state, sms, nas, other"),
      maxMessages: z.number().min(1).max(10000).optional().default(100).describe("Max messages to return per poll (1-10000)"),
      raw: z.boolean().optional().default(false).describe("Return raw logcat lines instead of parsed messages"),
    },
    async ({ session: sessionId, category, maxMessages, raw }) => {
      try {
        const session = sessions.get(sessionId);
        if (!session) {
          const active = Array.from(sessions.keys());
          return {
            content: [{ type: "text", text: `Session "${sessionId}" not found. Active: ${active.join(", ") || "none"}` }],
            isError: true,
          };
        }

        const available = session.buffer.length - session.readCursor;
        if (available <= 0) {
          const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(0);
          // Show category distribution of existing buffer
          const counts: Record<string, number> = {};
          for (const msg of session.buffer) {
            counts[msg.category] = (counts[msg.category] ?? 0) + 1;
          }
          const dist = Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .map(([cat, n]) => `${cat}: ${n}`)
            .join(", ");

          return {
            content: [{
              type: "text",
              text: `No new messages. Running ${elapsed}s, buffer: ${session.buffer.length}/${session.maxMessages}\nCategory distribution: ${dist || "(empty)"}`,
            }],
          };
        }

        // Get new messages
        const startIdx = session.readCursor;
        let messages: Array<{ parsed: RilMessage; raw: string }> = [];
        for (let i = startIdx; i < session.buffer.length; i++) {
          messages.push({ parsed: session.buffer[i], raw: session.rawBuffer[i] });
        }

        // Filter by category
        if (category) {
          messages = messages.filter((m) => m.parsed.category === category);
        }

        // Limit
        const limited = messages.slice(0, maxMessages);

        // Advance cursor (always, regardless of filter)
        session.readCursor = session.buffer.length;

        if (limited.length === 0) {
          return {
            content: [{ type: "text", text: `${available} new message(s) but none match category "${category}".` }],
          };
        }

        let output: string;
        if (raw) {
          output = limited.map((m) => m.raw).join("\n");
        } else {
          output = limited.map((m) => {
            const p = m.parsed;
            return `[${p.timestamp}] [${p.category}] ${p.tag}: ${p.raw}`;
          }).join("\n");
        }

        const remaining = messages.length - limited.length;
        if (remaining > 0) {
          output += `\n\n--- ${remaining} more messages available, poll again ---`;
        }

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ril_stop",
    "Stop a RIL capture session. Shows a summary of captured message categories.",
    {
      session: z.string().describe("Session ID to stop (e.g., 'ril_1'), or 'all' to stop all"),
    },
    async ({ session: sessionId }) => {
      try {
        if (sessionId === "all") {
          const count = sessions.size;
          for (const [, s] of sessions) {
            try { s.process.kill(); } catch { /* ignore */ }
          }
          sessions.clear();
          return { content: [{ type: "text", text: `Stopped ${count} RIL session(s).` }] };
        }

        const session = sessions.get(sessionId);
        if (!session) {
          return { content: [{ type: "text", text: `Session "${sessionId}" not found.` }], isError: true };
        }

        const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(1);

        // Category summary
        const counts: Record<string, number> = {};
        for (const msg of session.buffer) {
          counts[msg.category] = (counts[msg.category] ?? 0) + 1;
        }
        const dist = Object.entries(counts)
          .sort(([, a], [, b]) => b - a)
          .map(([cat, n]) => `  ${cat}: ${n}`)
          .join("\n");

        try { session.process.kill(); } catch { /* ignore */ }
        sessions.delete(sessionId);

        const summary: string[] = [];
        summary.push(`Stopped ${sessionId}. Duration: ${elapsed}s, Total messages: ${session.buffer.length}`);
        if (dist) {
          summary.push(`\nMessage categories:\n${dist}`);
        }

        return { content: [{ type: "text", text: summary.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
