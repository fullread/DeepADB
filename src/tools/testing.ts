/**
 * Test Session Tools — Structured test workflow organization.
 * 
 * Captures numbered test steps with screenshots and logcat into
 * organized directories for reproducibility and documentation.
 */

import { z } from "zod";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { isOnDevice } from "../config/config.js";
import { shellEscape } from "../middleware/sanitize.js";

interface TestSession {
  name: string;
  directory: string;
  device: string;
  stepCount: number;
  startedAt: number;
  steps: Array<{ number: number; description: string; timestamp: string }>;
  lastLogcatTimestamp: number;
}

/** Active test session. Only one at a time. */
let activeSession: TestSession | null = null;

export function registerTestingTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_test_session_start",
    "Start a structured test session. Creates a named directory for organizing numbered screenshots and logcat captures.",
    {
      name: z.string().describe("Test session name (e.g., 'login_flow', 'threat_detection')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ name, device }) => {
      try {
        if (activeSession) {
          return {
            content: [{ type: "text", text: `Session '${activeSession.name}' is already active. Stop it first with adb_test_session_end.` }],
            isError: true,
          };
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const dirName = `${safeName}_${timestamp}`;
        const directory = join(ctx.config.tempDir, "tests", dirName);

        mkdirSync(directory, { recursive: true });

        // Clear logcat so our captures start fresh
        await ctx.bridge.shell("logcat -c", { device: resolved.serial, ignoreExitCode: true });

        activeSession = {
          name,
          directory,
          device: resolved.serial,
          stepCount: 0,
          startedAt: Date.now(),
          steps: [],
          lastLogcatTimestamp: Date.now(),
        };

        // Write session manifest header
        const manifest = `# Test Session: ${name}\n`
          + `Started: ${new Date().toISOString()}\n`
          + `Device: ${resolved.serial}\n\n`
          + `## Steps\n\n`;
        writeFileSync(join(directory, "steps.md"), manifest);

        return {
          content: [{
            type: "text",
            text: `Test session started: ${name}\nDirectory: ${directory}\nDevice: ${resolved.serial}\nLogcat cleared. Use adb_test_step to capture numbered steps.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_test_step",
    "Capture a numbered test step: takes a screenshot and captures logcat since the last step. Saves both to the session directory.",
    {
      description: z.string().describe("Description of what this step tests or verifies"),
      captureScreenshot: z.boolean().optional().default(true).describe("Take a screenshot for this step"),
      captureLogcat: z.boolean().optional().default(true).describe("Capture logcat since last step"),
    },
    async ({ description, captureScreenshot, captureLogcat }) => {
      if (!activeSession) {
        return { content: [{ type: "text", text: "No active test session. Start one with adb_test_session_start." }], isError: true };
      }
      try {
        const session = activeSession;
        session.stepCount++;
        const stepNum = String(session.stepCount).padStart(3, "0");
        const stepPrefix = `${stepNum}_${description.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40)}`;
        const results: string[] = [`Step ${stepNum}: ${description}`];

        // Screenshot
        if (captureScreenshot) {
          const screenshotFile = `${stepPrefix}.png`;
          const remoteDir = isOnDevice() ? "/data/local/tmp" : "/sdcard";
          const remotePath = `${remoteDir}/DA_test_${stepNum}.png`;
          const localPath = join(session.directory, screenshotFile);
          try {
            await ctx.bridge.shell(`screencap -p '${shellEscape(remotePath)}'`, { device: session.device, timeout: 15000 });
            await ctx.bridge.exec(["pull", remotePath, localPath], { device: session.device, timeout: 30000 });
          } finally {
            await ctx.bridge.shell(`rm '${shellEscape(remotePath)}'`, { device: session.device, ignoreExitCode: true }).catch(() => {});
          }
          results.push(`Screenshot: ${screenshotFile}`);
        }

        // Logcat since last step
        if (captureLogcat) {
          const logcatFile = `${stepPrefix}_logcat.txt`;
          const localPath = join(session.directory, logcatFile);
          const logResult = await ctx.bridge.shell("logcat -d -t 500", {
            device: session.device, timeout: 10000, ignoreExitCode: true,
          });
          writeFileSync(localPath, logResult.stdout);
          // Clear for next step
          await ctx.bridge.shell("logcat -c", { device: session.device, ignoreExitCode: true });
          const lineCount = logResult.stdout.split("\n").filter((l) => l.trim()).length;
          results.push(`Logcat: ${logcatFile} (${lineCount} lines)`);
        }

        // Update manifest
        const stepEntry = `### Step ${stepNum}: ${description}\n`
          + `Timestamp: ${new Date().toISOString()}\n`
          + results.slice(1).map((r) => `- ${r}`).join("\n") + "\n\n";

        const manifestPath = join(session.directory, "steps.md");
        writeFileSync(manifestPath, stepEntry, { flag: "a" });

        session.steps.push({
          number: session.stepCount,
          description,
          timestamp: new Date().toISOString(),
        });
        session.lastLogcatTimestamp = Date.now();

        return { content: [{ type: "text", text: results.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_test_session_end",
    "End the active test session. Writes a summary manifest and returns the session directory path.",
    {},
    async () => {
      if (!activeSession) {
        return { content: [{ type: "text", text: "No active test session." }], isError: true };
      }
      try {
        const session = activeSession;
        const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(1);

        // Write summary footer to manifest
        const summary = `---\n\n## Summary\n`
          + `Total steps: ${session.stepCount}\n`
          + `Duration: ${elapsed}s\n`
          + `Ended: ${new Date().toISOString()}\n`;

        const manifestPath = join(session.directory, "steps.md");
        writeFileSync(manifestPath, summary, { flag: "a" });

        const result = `Test session '${session.name}' ended.\nSteps captured: ${session.stepCount}\nDuration: ${elapsed}s\nDirectory: ${session.directory}`;

        activeSession = null;
        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
