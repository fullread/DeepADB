// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Workflow Orchestration Engine — Declarative multi-step tool sequences.
 *
 * Executes JSON-defined workflows that chain device operations into
 * repeatable, parameterized sequences with variable capture, conditional
 * steps, and loop support. Workflows run entirely server-side through
 * direct bridge calls.
 *
 * Supported step actions: shell, root_shell, install, screenshot,
 * logcat, getprop, sleep. Each action maps directly to ADB bridge
 * operations — no MCP tool re-invocation overhead.
 *
 * Workflow files are stored in {tempDir}/workflows/.
 *
 * Example workflow JSON:
 * {
 *   "name": "restart-and-verify",
 *   "description": "Restart an app and verify it launched correctly",
 *   "variables": { "pkg": "com.example.app" },
 *   "steps": [
 *     { "name": "stop", "action": "shell", "command": "am force-stop {{pkg}}" },
 *     { "name": "pause", "action": "sleep", "ms": 1000 },
 *     { "name": "start", "action": "shell", "command": "monkey -p {{pkg}} -c android.intent.category.LAUNCHER 1" },
 *     { "name": "wait", "action": "sleep", "ms": 2000 },
 *     { "name": "check", "action": "shell", "command": "dumpsys activity activities | grep mResumedActivity", "capture": "activity" },
 *     { "name": "screenshot", "action": "screenshot" }
 *   ]
 * }
 */

import { z } from "zod";
import { join } from "path";
import { readFileSync, existsSync, readdirSync } from "fs";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg, shellQuote } from "../middleware/sanitize.js";
import { sanitizeFilenameComponent } from "../middleware/fs-utils.js";

interface WorkflowStep {
  name: string;
  action: "shell" | "root_shell" | "install" | "screenshot" | "logcat" | "getprop" | "sleep";
  command?: string;      // For shell/root_shell
  key?: string;          // For getprop
  apkPath?: string;      // For install
  lines?: number;        // For logcat
  tag?: string;          // For logcat
  ms?: number;           // For sleep
  capture?: string;      // Variable name to store result
  if?: string;           // Conditional: "{{var}} == value" / "{{var}} != value" / "{{var}} contains value"
  repeat?: number;       // Repeat this step N times
}

interface WorkflowDefinition {
  name: string;
  description?: string;
  variables?: Record<string, string>;
  steps: WorkflowStep[];
}

function getWorkflowDir(tempDir: string): string {
  return join(tempDir, "workflows");
}

/** Maximum iterations per step to prevent runaway loops. */
const MAX_REPEAT = 100;

/** Maximum steps per workflow to prevent resource exhaustion. */
const MAX_STEPS = 200;

/** Maximum sleep duration per step in ms (5 minutes). */
const MAX_SLEEP_MS = 300_000;

/** Substitute {{variable}} references in a string. */
/**
 * AH2 trust model: `{{key}}` substitution is a raw textual replacement — no
 * shell escaping, no validation. This is by design; many legitimate workflow
 * commands embed variables that are not meant to be argv values (e.g., the
 * variable IS a glob, or expands to multiple words).
 *
 * Two sources feed `vars` (see workflow runner around L199):
 *   1. `def.variables` + invocation-time `variables` — operator-controlled.
 *      If the operator writes a workflow that interpolates an unsafe value
 *      into a shell command, that is the operator's choice; the runner does
 *      not second-guess.
 *   2. `vars[step.capture] = result` (around L334) — DEVICE-CONTROLLED.
 *      Captured stdout from a previous step. A compromised or manipulated
 *      device can inject shell metacharacters here.
 *
 * Per-call-site safety:
 *   - `evaluateCondition` (L82): used for ==/!=/contains. No shell. Safe.
 *   - detail-string sites (L219, L220): display only. Safe.
 *   - `case "install"` (L277): argv-style `bridge.exec([..., apk])`. Safe
 *     even with metachars in apk.
 *   - `case "logcat"` tag (L300): validateShellArg AFTER substitution. Safe.
 *   - `case "getprop"` key (L314): validateShellArg AFTER substitution. Safe.
 *   - `case "shell"` (L253) and `case "root_shell"` (L265): substituted
 *     string passed to `bridge.shell()` / `bridge.rootShell()` without
 *     per-variable shell-arg validation. The security middleware's
 *     blocklist/allowlist provides a backstop (see `ctx.security.checkCommand`
 *     immediately following each substitution), but it is pattern-based and
 *     not a substitute for argument escaping.
 *
 * If you need a stronger model (e.g., when devices are untrusted), add per-
 * step provenance tracking: tag every `vars` entry with its source, and
 * shell-escape any value tagged DEVICE before it reaches a `case "shell"` or
 * `case "root_shell"` step. The conservative knee-jerk fix — escaping every
 * substituted value unconditionally — breaks legitimate uses where the
 * workflow author WANTS shell behaviour in the variable.
 */
function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/** Evaluate a simple conditional expression. */
function evaluateCondition(expr: string, vars: Record<string, string>): boolean {
  const resolved = substituteVars(expr, vars);

  // "value == value"
  const eqMatch = resolved.match(/^(.+?)\s*==\s*(.+)$/);
  if (eqMatch) return eqMatch[1].trim() === eqMatch[2].trim();

  // "value != value"
  const neqMatch = resolved.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neqMatch) return neqMatch[1].trim() !== neqMatch[2].trim();

  // "value contains value"
  const containsMatch = resolved.match(/^(.+?)\s+contains\s+(.+)$/);
  if (containsMatch) return containsMatch[1].trim().includes(containsMatch[2].trim());

  // Non-empty string is truthy
  return resolved.trim().length > 0;
}

/** Validate a workflow definition and return errors. */
function validateWorkflow(def: unknown): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== "object") {
    errors.push("Workflow must be a JSON object.");
    return errors;
  }

  const w = def as Record<string, unknown>;
  if (!w.name || typeof w.name !== "string") errors.push("Missing or invalid 'name' field.");
  if (!Array.isArray(w.steps)) {
    errors.push("Missing or invalid 'steps' array.");
    return errors;
  }

  // BK9 fix: warn on `{{var}}` references not declared in `workflow.variables`.
  // substituteVars falls back to the literal `{{key}}` (useful for debugging),
  // but if the operator typo'd a variable name, the literal then propagates
  // through a shell step as part of the command string. Catching this at
  // validate-time surfaces the typo before any shell call.
  const declaredVars = new Set<string>();
  if (w.variables && typeof w.variables === "object") {
    for (const k of Object.keys(w.variables as object)) declaredVars.add(k);
  }
  const stepStrings: string[] = [];
  for (const stepRaw of w.steps as unknown[]) {
    if (!stepRaw || typeof stepRaw !== "object") continue;
    const s = stepRaw as Record<string, unknown>;
    for (const field of ["command", "key", "apkPath", "tag", "match"]) {
      if (typeof s[field] === "string") stepStrings.push(s[field] as string);
    }
  }
  const referencedVars = new Set<string>();
  for (const str of stepStrings) {
    const matches = str.matchAll(/\{\{(\w+)\}\}/g);
    for (const m of matches) referencedVars.add(m[1]);
  }
  for (const ref of referencedVars) {
    if (!declaredVars.has(ref)) {
      errors.push(`Variable '${ref}' is referenced in a step but not declared in workflow.variables. Add { variables: { ${ref}: "..." } } to the workflow.`);
    }
  }

  if ((w.steps as unknown[]).length > MAX_STEPS) {
    errors.push(`Too many steps: ${(w.steps as unknown[]).length} (maximum ${MAX_STEPS}).`);
    return errors;
  }

  const validActions = ["shell", "root_shell", "install", "screenshot", "logcat", "getprop", "sleep"];
  for (let i = 0; i < (w.steps as unknown[]).length; i++) {
    const step = (w.steps as unknown[])[i] as Record<string, unknown>;
    if (!step || typeof step !== "object") {
      errors.push(`Step ${i}: not an object.`);
      continue;
    }
    if (!step.name || typeof step.name !== "string") errors.push(`Step ${i}: missing 'name'.`);
    if (!step.action || typeof step.action !== "string") {
      errors.push(`Step ${i}: missing 'action'.`);
    } else if (!validActions.includes(step.action as string)) {
      errors.push(`Step ${i}: unknown action '${step.action}'. Valid: ${validActions.join(", ")}`);
    }

    const action = step.action as string;
    if ((action === "shell" || action === "root_shell") && (!step.command || typeof step.command !== "string")) {
      errors.push(`Step ${i} (${action}): requires 'command' string.`);
    }
    if (action === "install" && (!step.apkPath || typeof step.apkPath !== "string")) {
      errors.push(`Step ${i} (install): requires 'apkPath' string.`);
    }
    if (action === "getprop" && (!step.key || typeof step.key !== "string")) {
      errors.push(`Step ${i} (getprop): requires 'key' string.`);
    }
    if (action === "sleep" && (step.ms === undefined || typeof step.ms !== "number")) {
      errors.push(`Step ${i} (sleep): requires 'ms' number.`);
    }
    if (action === "sleep" && typeof step.ms === "number" && step.ms > MAX_SLEEP_MS) {
      errors.push(`Step ${i} (sleep): ms=${step.ms} exceeds maximum of ${MAX_SLEEP_MS}ms (${MAX_SLEEP_MS / 1000}s).`);
    }
    if (typeof step.repeat === "number" && step.repeat > MAX_REPEAT) {
      errors.push(`Step ${i}: repeat=${step.repeat} exceeds maximum of ${MAX_REPEAT}.`);
    }
  }

  return errors;
}

export function registerWorkflowTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_workflow_run",
    "Execute a workflow — a JSON-defined sequence of device operations with variable substitution, conditional steps, and loop support. Supported actions: shell, root_shell, install, screenshot, logcat, getprop, sleep. Pass the workflow as a JSON string or provide a saved workflow name.",
    {
      workflow: z.string().describe("Workflow JSON string, or the name of a saved workflow file"),
      variables: z.record(z.string(), z.string()).optional().describe("Override workflow variables (merged with defaults)"),
      device: z.string().optional().describe("Device serial"),
      dryRun: z.boolean().optional().default(false).describe("Validate and show execution plan without running"),
    },
    async ({ workflow, variables, device, dryRun }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Parse workflow — either inline JSON or saved file name
        let def: WorkflowDefinition;
        try {
          if (workflow.trimStart().startsWith("{")) {
            def = JSON.parse(workflow);
          } else {
            const dir = getWorkflowDir(ctx.config.tempDir);
            const safeName = sanitizeFilenameComponent(workflow);
            const filePath = join(dir, `${safeName}.json`);
            if (!existsSync(filePath)) {
              return { content: [{ type: "text", text: `Workflow "${workflow}" not found. Use adb_workflow_list to see available workflows.` }], isError: true };
            }
            def = JSON.parse(readFileSync(filePath, "utf-8"));
          }
        } catch (err) {
          return { content: [{ type: "text", text: `Invalid workflow JSON: ${err instanceof Error ? err.message : err}` }], isError: true };
        }

        // Validate
        const errors = validateWorkflow(def);
        if (errors.length > 0) {
          return { content: [{ type: "text", text: `Workflow validation failed:\n${errors.join("\n")}` }], isError: true };
        }

        // Merge variables
        const vars: Record<string, string> = { ...(def.variables ?? {}), ...(variables ?? {}) };

        const output: string[] = [];
        output.push(`=== Workflow: ${def.name} ===`);
        if (def.description) output.push(def.description);
        output.push(`Device: ${serial}`);
        output.push(`Steps: ${def.steps.length}`);
        if (Object.keys(vars).length > 0) {
          output.push(`Variables: ${Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join(", ")}`);
        }
        output.push("");

        if (dryRun) {
          output.push("--- DRY RUN (no commands executed) ---\n");
          for (let i = 0; i < def.steps.length; i++) {
            const step = def.steps[i];
            const condStr = step.if ? ` [if: ${step.if}]` : "";
            const repeatStr = step.repeat ? ` [repeat: ${step.repeat}]` : "";
            const captureStr = step.capture ? ` → $${step.capture}` : "";
            let detail = step.action;
            if (step.command) detail += `: ${substituteVars(step.command, vars)}`;
            if (step.key) detail += `: ${substituteVars(step.key, vars)}`;
            if (step.ms) detail += `: ${step.ms}ms`;
            output.push(`  [${i + 1}] ${step.name} — ${detail}${condStr}${repeatStr}${captureStr}`);
          }
          return { content: [{ type: "text", text: output.join("\n") }] };
        }

        // Execute
        const startTime = Date.now();
        let stepsRun = 0;
        let stepsFailed = 0;

        for (let i = 0; i < def.steps.length; i++) {
          const step = def.steps[i];
          const iterations = Math.min(step.repeat ?? 1, MAX_REPEAT);

          // Conditional check
          if (step.if) {
            if (!evaluateCondition(step.if, vars)) {
              output.push(`[${i + 1}] ${step.name} — SKIPPED (condition false: ${step.if})`);
              continue;
            }
          }

          for (let iter = 0; iter < iterations; iter++) {
            const iterLabel = iterations > 1 ? ` (${iter + 1}/${iterations})` : "";
            stepsRun++;

            try {
              let result = "";

              switch (step.action) {
                case "shell": {
                  const cmd = substituteVars(step.command!, vars);
                  const blocked = ctx.security.checkCommand(cmd, serial);
                  if (blocked) {
                    output.push(`[${i + 1}] ${step.name}${iterLabel} — BLOCKED: ${blocked}`);
                    stepsFailed++;
                    continue;
                  }
                  const r = await ctx.bridge.shell(cmd, { device: serial, ignoreExitCode: true });
                  result = r.stdout.trim();
                  break;
                }
                case "root_shell": {
                  const cmd = substituteVars(step.command!, vars);
                  const blocked = ctx.security.checkCommand(`su: ${cmd}`, serial);
                  if (blocked) {
                    output.push(`[${i + 1}] ${step.name}${iterLabel} — BLOCKED: ${blocked}`);
                    stepsFailed++;
                    continue;
                  }
                  const r = await ctx.bridge.rootShell(cmd, { device: serial, ignoreExitCode: true });
                  result = r.stdout.trim();
                  break;
                }
                case "install": {
                  const apk = substituteVars(step.apkPath!, vars);
                  const r = await ctx.bridge.exec(["install", "-r", apk], { device: serial, timeout: 120000 });
                  result = r.stdout.trim();
                  break;
                }
                case "screenshot": {
                  const fname = `workflow_${Date.now()}.png`;
                  const remoteDir = "/data/local/tmp";
                  const remotePath = `${remoteDir}/${fname}`;
                  const localPath = join(ctx.config.tempDir, fname);
                  try {
                    await ctx.bridge.shell(`screencap -p ${shellQuote(remotePath)}`, { device: serial, timeout: 15000 });
                    await ctx.bridge.exec(["pull", remotePath, localPath], { device: serial, timeout: 30000 });
                  } finally {
                    await ctx.bridge.shell(`rm ${shellQuote(remotePath)}`, { device: serial, ignoreExitCode: true }).catch(() => {});
                  }
                  result = localPath;
                  break;
                }
                case "logcat": {
                  const lines = step.lines ?? 100;
                  let cmd = `logcat -d -t ${lines}`;
                  if (step.tag) {
                    const resolvedTag = substituteVars(step.tag, vars);
                    const tagErr = validateShellArg(resolvedTag, "tag");
                    if (tagErr) {
                      output.push(`[${i + 1}] ${step.name}${iterLabel} — BLOCKED: ${tagErr}`);
                      stepsFailed++;
                      continue;
                    }
                    cmd += ` -s ${resolvedTag}:V`;
                  }
                  const r = await ctx.bridge.shell(cmd, { device: serial, timeout: 10000, ignoreExitCode: true });
                  result = r.stdout.trim();
                  break;
                }
                case "getprop": {
                  const key = substituteVars(step.key!, vars);
                  const keyErr = validateShellArg(key, "key");
                  if (keyErr) {
                    output.push(`[${i + 1}] ${step.name}${iterLabel} — BLOCKED: ${keyErr}`);
                    stepsFailed++;
                    continue;
                  }
                  const r = await ctx.bridge.shell(`getprop ${shellQuote(key)}`, { device: serial });
                  result = r.stdout.trim();
                  break;
                }
                case "sleep": {
                  await new Promise((r) => setTimeout(r, step.ms!));
                  result = `(waited ${step.ms}ms)`;
                  break;
                }
              }

              // Capture result into variable
              if (step.capture) {
                vars[step.capture] = result;
              }

              // Truncate long results for output
              const displayResult = result.length > 200 ? result.substring(0, 200) + "..." : result;
              output.push(`[${i + 1}] ${step.name}${iterLabel} — OK${displayResult ? ": " + displayResult : ""}`);

            } catch (err) {
              stepsFailed++;
              output.push(`[${i + 1}] ${step.name}${iterLabel} — ERROR: ${err instanceof Error ? err.message : err}`);
            }
          }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        output.push("");
        output.push(`=== Workflow complete: ${stepsRun} steps run, ${stepsFailed} failed, ${elapsed}s ===`);

        return { content: [{ type: "text", text: OutputProcessor.process(output.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_workflow_validate",
    "Validate a workflow JSON definition without executing it. Reports structural errors and shows the execution plan.",
    {
      workflow: z.string().describe("Workflow JSON string to validate"),
    },
    async ({ workflow }) => {
      try {
        let def: unknown;
        try {
          def = JSON.parse(workflow);
        } catch (err) {
          return { content: [{ type: "text", text: `Invalid JSON: ${err instanceof Error ? err.message : err}` }], isError: true };
        }

        const errors = validateWorkflow(def);
        if (errors.length > 0) {
          return { content: [{ type: "text", text: `Validation FAILED:\n${errors.join("\n")}` }], isError: true };
        }

        const w = def as WorkflowDefinition;
        const lines = [`Validation PASSED: ${w.name}`];
        if (w.description) lines.push(w.description);
        lines.push(`Steps: ${w.steps.length}`);
        if (w.variables) {
          lines.push(`Variables: ${Object.keys(w.variables).join(", ")}`);
        }
        lines.push("");
        for (let i = 0; i < w.steps.length; i++) {
          const s = w.steps[i];
          lines.push(`  [${i + 1}] ${s.name} — ${s.action}${s.capture ? ` → $${s.capture}` : ""}${s.if ? ` [if]` : ""}${s.repeat ? ` [×${s.repeat}]` : ""}`);
        }

        // Offer to save
        lines.push(`\nUse adb_workflow_run with this JSON to execute, or save to a file in ${getWorkflowDir(ctx.config.tempDir)}.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_workflow_list",
    "List saved workflow files in the workflows directory.",
    {},
    async () => {
      try {
        const dir = getWorkflowDir(ctx.config.tempDir);
        if (!existsSync(dir)) {
          return { content: [{ type: "text", text: `No workflows directory. Save .json files to: ${dir}` }] };
        }

        const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
        if (files.length === 0) {
          return { content: [{ type: "text", text: `No workflow files found in ${dir}` }] };
        }

        const lines: string[] = [`${files.length} workflow(s):\n`];
        for (const file of files) {
          try {
            const def: WorkflowDefinition = JSON.parse(readFileSync(join(dir, file), "utf-8"));
            const name = file.replace(".json", "");
            lines.push(`${name} — ${def.description ?? "(no description)"} (${def.steps.length} steps)`);
          } catch {
            lines.push(`${file} — (invalid JSON)`);
          }
        }

        lines.push(`\nDirectory: ${dir}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
