/**
 * Automated Test Generation — Generate workflow JSON from live UI and intent analysis.
 *
 * Analyzes the current screen's UI hierarchy and a package's registered
 * intents to auto-generate repeatable test workflows compatible with
 * the workflow orchestration engine (adb_workflow_run).
 *
 * Combines UI dump analysis (interactive elements, navigation targets)
 * with intent resolution (activities, services, receivers) to produce
 * comprehensive test coverage without manual workflow authoring.
 */

import { z } from "zod";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";
import { captureUiDump, getAttr } from "../middleware/ui-dump.js";

interface UiTarget {
  resourceId: string;
  text: string;
  contentDesc: string;
  className: string;
  centerX: number;
  centerY: number;
}

function parseClickableElements(xml: string): UiTarget[] {
  const elements: UiTarget[] = [];
  const nodeRegex = /<node\s+([^>]+)\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1];

    if (getAttr(attrs, "clickable") !== "true") continue;
    if (getAttr(attrs, "enabled") === "false") continue;

    const boundsStr = getAttr(attrs, "bounds");
    const boundsMatch = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!boundsMatch) continue;

    const left = parseInt(boundsMatch[1], 10);
    const top = parseInt(boundsMatch[2], 10);
    const right = parseInt(boundsMatch[3], 10);
    const bottom = parseInt(boundsMatch[4], 10);

    elements.push({
      resourceId: getAttr(attrs, "resource-id"),
      text: getAttr(attrs, "text"),
      contentDesc: getAttr(attrs, "content-desc"),
      className: getAttr(attrs, "class").replace("android.widget.", "").replace("android.view.", ""),
      centerX: Math.round((left + right) / 2),
      centerY: Math.round((top + bottom) / 2),
    });
  }
  return elements;
}

function getWorkflowDir(tempDir: string): string {
  return join(tempDir, "workflows");
}

export function registerTestGenTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_test_gen_from_ui",
    "Analyze the current screen and generate a test workflow that taps each interactive element, takes screenshots, and verifies the app doesn't crash. Produces a workflow JSON compatible with adb_workflow_run.",
    {
      packageName: z.string().describe("Package name to monitor during test (used for logcat filtering and crash detection)"),
      device: z.string().optional().describe("Device serial"),
      screenshotAfterEach: z.boolean().optional().default(true).describe("Take a screenshot after each tap"),
      returnToStart: z.boolean().optional().default(true).describe("Press Back after each tap to return to the starting screen"),
    },
    async ({ packageName, device, screenshotAfterEach, returnToStart }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Capture UI hierarchy
        const xml = await captureUiDump(ctx.bridge, serial);
        if (!xml) {
          return { content: [{ type: "text", text: "Failed to capture UI hierarchy." }], isError: true };
        }

        const targets = parseClickableElements(xml);
        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No interactive elements found on the current screen." }], isError: true };
        }

        // Generate workflow
        const steps: Array<Record<string, unknown>> = [];

        // Clear logcat first
        steps.push({ name: "clear_logcat", action: "shell", command: "logcat -c" });
        steps.push({ name: "initial_screenshot", action: "screenshot" });

        for (let i = 0; i < targets.length; i++) {
          const el = targets[i];
          const label = el.text || el.contentDesc || el.resourceId || `element_${i}`;
          const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 30);

          // Tap the element
          steps.push({
            name: `tap_${safeLabel}`,
            action: "shell",
            command: `input tap ${el.centerX} ${el.centerY}`,
          });

          // Wait for UI to settle
          steps.push({ name: `wait_${safeLabel}`, action: "sleep", ms: 1000 });

          // Screenshot after tap
          if (screenshotAfterEach) {
            steps.push({ name: `screenshot_${safeLabel}`, action: "screenshot" });
          }

          // Check for crash
          steps.push({
            name: `crash_check_${safeLabel}`,
            action: "shell",
            command: `logcat -d -b crash -t 5 | grep -Fc "${packageName}" || echo 0`,
            capture: `crash_${i}`,
          });

          // Press Back to return
          if (returnToStart) {
            steps.push({
              name: `back_${safeLabel}`,
              action: "shell",
              command: "input keyevent KEYCODE_BACK",
            });
            steps.push({ name: `settle_${safeLabel}`, action: "sleep", ms: 500 });
          }
        }

        // Final logcat capture
        steps.push({
          name: "final_logcat",
          action: "logcat",
          tag: packageName,
          lines: 200,
          capture: "app_logs",
        });

        const workflow = {
          name: `ui_test_${packageName.split(".").pop()}`,
          description: `Auto-generated UI test: ${targets.length} interactive elements on current screen`,
          variables: { pkg: packageName },
          steps,
        };

        const workflowJson = JSON.stringify(workflow, null, 2);

        // Build summary of what was found
        const summary: string[] = [];
        summary.push(`Generated test workflow for ${targets.length} interactive elements:\n`);
        for (let i = 0; i < targets.length; i++) {
          const el = targets[i];
          const label = el.text || el.contentDesc || el.resourceId || `(unlabeled ${el.className})`;
          summary.push(`  [${i + 1}] ${label} (${el.className}) at ${el.centerX},${el.centerY}`);
        }
        summary.push(`\nWorkflow: ${steps.length} steps`);
        summary.push(`\nTo execute: use adb_workflow_run with the JSON below, or save with adb_test_gen_save.`);
        summary.push(`\n${workflowJson}`);

        return { content: [{ type: "text", text: OutputProcessor.process(summary.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_test_gen_from_intents",
    "Analyze a package's registered activities and intent filters to generate a test workflow that launches each exported activity and verifies it renders. Produces workflow JSON compatible with adb_workflow_run.",
    {
      packageName: z.string().describe("Package name to analyze"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Get package dump to find activities
        const dumpResult = await ctx.bridge.shell(`dumpsys package ${packageName} | grep -E 'Activity|android.intent.action'`, {
          device: serial, timeout: 15000, ignoreExitCode: true,
        });

        // Extract activity component names — full regex escape (not just dots)
        const escapedPkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const activityRegex = new RegExp(`(${escapedPkg}[/.]\\S+)`, "g");
        const rawMatches = dumpResult.stdout.match(activityRegex) ?? [];
        const activities = [...new Set(rawMatches)]
          .filter((a) => !a.includes("$") && !a.includes("Resolver"))
          .slice(0, 20); // Cap at 20 activities

        if (activities.length === 0) {
          return { content: [{ type: "text", text: `No activities found for ${packageName}.` }], isError: true };
        }

        // Generate workflow
        const steps: Array<Record<string, unknown>> = [];
        steps.push({ name: "clear_logcat", action: "shell", command: "logcat -c" });

        for (let i = 0; i < activities.length; i++) {
          const activity = activities[i];
          const shortName = activity.split("/").pop() ?? activity.split(".").pop() ?? `activity_${i}`;
          const safeName = shortName.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 30);

          // Launch the activity
          steps.push({
            name: `launch_${safeName}`,
            action: "shell",
            command: `am start -n ${activity}`,
          });
          steps.push({ name: `wait_${safeName}`, action: "sleep", ms: 1500 });
          steps.push({ name: `screenshot_${safeName}`, action: "screenshot" });

          // Crash check
          steps.push({
            name: `crash_check_${safeName}`,
            action: "shell",
            command: `logcat -d -b crash -t 5 | grep -Fc "{{pkg}}" || echo 0`,
            capture: `crash_${i}`,
          });

          // Return to launcher
          steps.push({
            name: `back_${safeName}`,
            action: "shell",
            command: "input keyevent KEYCODE_HOME",
          });
          steps.push({ name: `settle_${safeName}`, action: "sleep", ms: 500 });
        }

        steps.push({
          name: "final_logcat",
          action: "logcat",
          tag: packageName,
          lines: 300,
          capture: "app_logs",
        });

        const workflow = {
          name: `intent_test_${packageName.split(".").pop()}`,
          description: `Auto-generated intent test: ${activities.length} activities for ${packageName}`,
          variables: { pkg: packageName },
          steps,
        };

        const workflowJson = JSON.stringify(workflow, null, 2);

        const summary: string[] = [];
        summary.push(`Generated intent test workflow for ${activities.length} activities:\n`);
        for (let i = 0; i < activities.length; i++) {
          summary.push(`  [${i + 1}] ${activities[i]}`);
        }
        summary.push(`\nWorkflow: ${steps.length} steps`);
        summary.push(`\n${workflowJson}`);

        return { content: [{ type: "text", text: OutputProcessor.process(summary.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_test_gen_save",
    "Save a generated workflow JSON to the workflows directory for later execution with adb_workflow_run.",
    {
      name: z.string().describe("Workflow name (used as filename)"),
      workflow: z.string().describe("Workflow JSON string to save"),
    },
    async ({ name, workflow }) => {
      try {
        // Validate the JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(workflow);
        } catch (err) {
          return { content: [{ type: "text", text: `Invalid JSON: ${err instanceof Error ? err.message : err}` }], isError: true };
        }

        if (!parsed || typeof parsed !== "object" || !("name" in (parsed as Record<string, unknown>))) {
          return { content: [{ type: "text", text: "Invalid workflow: must be a JSON object with a 'name' field." }], isError: true };
        }

        const dir = getWorkflowDir(ctx.config.tempDir);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = join(dir, `${safeName}.json`);
        writeFileSync(filePath, JSON.stringify(parsed, null, 2));

        return { content: [{ type: "text", text: `Workflow saved: ${filePath}\nRun with: adb_workflow_run workflow="${safeName}"` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
