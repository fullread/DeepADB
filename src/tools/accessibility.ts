// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Accessibility Auditing Tools — Automated a11y checks on the UI hierarchy.
 *
 * Extends the uiautomator dump analysis to flag common accessibility issues:
 * missing content-descriptions, undersized touch targets, duplicate descriptions,
 * and elements missing focusability. Generates structured audit reports.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { captureUiDump, parseUiNodes } from "../middleware/ui-dump.js";

/** Minimum touch target size in dp (WCAG / Material Design guideline). */
const MIN_TOUCH_TARGET_DP = 48;

/** Default screen density for dp conversion (mdpi baseline). */
// S2 fix: `wm density` output may contain TWO densities — Physical and
// Override. The previous regex `/(\d+)/` captured the first digit run,
// always Physical. If the user has set an Override density, that's the
// effective value for dp conversion. Parse Override first, fall back to
// Physical, then the bare digit pattern.
function parseWmDensity(stdout: string, fallback: number): number {
  const override = stdout.match(/Override density:\s*(\d+)/);
  if (override) return parseInt(override[1], 10);
  const physical = stdout.match(/Physical density:\s*(\d+)/);
  if (physical) return parseInt(physical[1], 10);
  const digits = stdout.match(/(\d+)/);
  return digits ? parseInt(digits[1], 10) : fallback;
}

const DEFAULT_DENSITY = 160;

interface A11yElement {
  className: string;
  text: string;
  contentDesc: string;
  resourceId: string;
  clickable: boolean;
  focusable: boolean;
  enabled: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
  widthPx: number;
  heightPx: number;
}

interface A11yIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  element: string;
}

/**
 * S1 fix: delegate to the canonical `parseUiNodes` in ui-dump.ts and
 * post-process to derive A11yElement-specific fields (widthPx, heightPx).
 * Previously this duplicated the entire `<node>` regex + attr extraction
 * + bounds parsing already implemented in ui-dump. Single source of truth.
 */
function parseElements(xml: string): A11yElement[] {
  const nodes = parseUiNodes(xml, /* clickableOnly */ false);
  return nodes.map((n) => ({
    className: n.className,
    text: n.text,
    contentDesc: n.contentDesc,
    resourceId: n.resourceId,
    clickable: n.clickable,
    focusable: n.focusable,
    enabled: n.enabled,
    bounds: { left: n.bounds.left, top: n.bounds.top, right: n.bounds.right, bottom: n.bounds.bottom },
    widthPx: n.bounds.right - n.bounds.left,
    heightPx: n.bounds.bottom - n.bounds.top,
  }));
}

function elementLabel(el: A11yElement): string {
  const parts: string[] = [el.className];
  if (el.resourceId) parts.push(`id:${el.resourceId}`);
  if (el.text) parts.push(`"${el.text.substring(0, 30)}"`);
  return parts.join(" ");
}

function runAudit(elements: A11yElement[], density: number): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const dpScale = density / DEFAULT_DENSITY;
  const descriptionsSeen = new Map<string, number>();

  for (const el of elements) {
    const label = elementLabel(el);

    // Rule 1: Interactive elements must have a label (text or content-desc)
    if (el.clickable && !el.text && !el.contentDesc) {
      issues.push({
        severity: "error",
        rule: "missing-label",
        message: "Clickable element has no text or content-description. Screen readers cannot announce this element.",
        element: label,
      });
    }

    // Rule 2: ImageView/ImageButton should have content-desc
    if ((el.className.includes("Image") || el.className.includes("Icon")) && !el.contentDesc && !el.text) {
      issues.push({
        severity: "warning",
        rule: "image-no-desc",
        message: "Image element has no content-description. Decorative images should be marked not-important-for-accessibility.",
        element: label,
      });
    }

    // Rule 3: Touch target size check
    if (el.clickable && el.widthPx > 0 && el.heightPx > 0) {
      const widthDp = el.widthPx / dpScale;
      const heightDp = el.heightPx / dpScale;
      if (widthDp < MIN_TOUCH_TARGET_DP || heightDp < MIN_TOUCH_TARGET_DP) {
        issues.push({
          severity: "warning",
          rule: "small-touch-target",
          message: `Touch target is ${widthDp.toFixed(0)}x${heightDp.toFixed(0)}dp (minimum ${MIN_TOUCH_TARGET_DP}x${MIN_TOUCH_TARGET_DP}dp).`,
          element: label,
        });
      }
    }

    // Rule 4: Clickable elements should be focusable
    if (el.clickable && !el.focusable) {
      issues.push({
        severity: "warning",
        rule: "clickable-not-focusable",
        message: "Element is clickable but not focusable. Keyboard and switch navigation may not reach it.",
        element: label,
      });
    }

    // Rule 5: Duplicate content-descriptions
    if (el.contentDesc) {
      const count = (descriptionsSeen.get(el.contentDesc) ?? 0) + 1;
      descriptionsSeen.set(el.contentDesc, count);
      if (count === 2) {
        issues.push({
          severity: "warning",
          rule: "duplicate-desc",
          message: `Content-description "${el.contentDesc.substring(0, 40)}" is used by multiple elements. Screen reader users cannot distinguish them.`,
          element: label,
        });
      }
    }
  }

  return issues;
}

export function registerAccessibilityTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_a11y_audit",
    "Run an automated accessibility audit on the current screen. Checks for: missing labels on interactive elements, undersized touch targets (<48dp), images without content-descriptions, clickable elements missing focusability, and duplicate descriptions. Returns a structured report with severity and rule violations.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const xml = await captureUiDump(ctx.bridge, serial);
        if (!xml) {
          return { content: [{ type: "text", text: "Failed to capture UI hierarchy for accessibility audit." }], isError: true };
        }

        // Get screen density for dp conversion
        const densityResult = await ctx.bridge.shell("wm density", { device: serial, ignoreExitCode: true });
        const density = parseWmDensity(densityResult.stdout, DEFAULT_DENSITY);

        const elements = parseElements(xml);
        const clickable = elements.filter((el) => el.clickable);
        const issues = runAudit(elements, density);

        const errors = issues.filter((i) => i.severity === "error");
        const warnings = issues.filter((i) => i.severity === "warning");

        const sections: string[] = [];
        sections.push(`Accessibility Audit — ${elements.length} elements, ${clickable.length} interactive`);
        sections.push(`Screen density: ${density}dpi (min touch target: ${MIN_TOUCH_TARGET_DP}dp = ${Math.round(MIN_TOUCH_TARGET_DP * density / DEFAULT_DENSITY)}px)`);
        sections.push(`Result: ${errors.length} error(s), ${warnings.length} warning(s)\n`);

        if (issues.length === 0) {
          sections.push("No accessibility issues detected on this screen.");
        } else {
          if (errors.length > 0) {
            sections.push("=== Errors ===");
            for (const issue of errors) {
              sections.push(`✗ [${issue.rule}] ${issue.element}\n  ${issue.message}`);
            }
          }
          if (warnings.length > 0) {
            sections.push("\n=== Warnings ===");
            for (const issue of warnings) {
              sections.push(`○ [${issue.rule}] ${issue.element}\n  ${issue.message}`);
            }
          }
        }

        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_a11y_touch_targets",
    "List all interactive elements with their touch target dimensions in dp. Highlights elements below the 48dp minimum. Useful for quickly identifying cramped UI layouts.",
    {
      belowMinOnly: z.boolean().optional().default(false).describe("Only show elements below the 48dp minimum"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ belowMinOnly, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const xml = await captureUiDump(ctx.bridge, serial);
        if (!xml) {
          return { content: [{ type: "text", text: "Failed to capture UI hierarchy." }], isError: true };
        }

        const densityResult = await ctx.bridge.shell("wm density", { device: serial, ignoreExitCode: true });
        const density = parseWmDensity(densityResult.stdout, DEFAULT_DENSITY);
        const dpScale = density / DEFAULT_DENSITY;

        const elements = parseElements(xml);
        const clickable = elements.filter((el) => el.clickable && el.widthPx > 0 && el.heightPx > 0);

        const rows = clickable
          .map((el) => {
            const wDp = el.widthPx / dpScale;
            const hDp = el.heightPx / dpScale;
            const ok = wDp >= MIN_TOUCH_TARGET_DP && hDp >= MIN_TOUCH_TARGET_DP;
            if (belowMinOnly && ok) return null;
            const flag = ok ? "✓" : "✗";
            return `${flag} ${wDp.toFixed(0)}x${hDp.toFixed(0)}dp | ${elementLabel(el)}`;
          })
          .filter(Boolean);

        if (rows.length === 0) {
          return { content: [{ type: "text", text: belowMinOnly ? "All interactive elements meet the 48dp minimum touch target size." : "No interactive elements found on screen." }] };
        }

        const header = `Touch targets (${rows.length} elements, density: ${density}dpi, min: ${MIN_TOUCH_TARGET_DP}dp):\n`;
        return { content: [{ type: "text", text: header + rows.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_a11y_tree",
    "Dump the accessibility-focused view of the UI hierarchy. Shows only elements relevant to screen readers: their roles, labels, states, and navigation order. Filters out decorative/layout containers.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const xml = await captureUiDump(ctx.bridge, serial);
        if (!xml) {
          return { content: [{ type: "text", text: "Failed to capture UI hierarchy." }], isError: true };
        }

        const elements = parseElements(xml);

        // Filter to elements that are relevant to accessibility:
        // interactive, have labels, or are images
        const a11yRelevant = elements.filter((el) =>
          el.clickable || el.focusable || el.text || el.contentDesc ||
          el.className.includes("Image") || el.className.includes("Button") ||
          el.className.includes("EditText") || el.className.includes("Switch") ||
          el.className.includes("CheckBox") || el.className.includes("Radio")
        );

        if (a11yRelevant.length === 0) {
          return { content: [{ type: "text", text: "No accessibility-relevant elements found on screen." }] };
        }

        const lines = a11yRelevant.map((el, i) => {
          const parts: string[] = [`[${i}] ${el.className}`];
          const label = el.contentDesc || el.text;
          if (label) parts.push(`label: "${label.substring(0, 50)}"`);
          else parts.push("(no label)");

          const states: string[] = [];
          if (el.clickable) states.push("clickable");
          if (el.focusable) states.push("focusable");
          if (!el.enabled) states.push("disabled");
          if (states.length) parts.push(`[${states.join(", ")}]`);

          if (el.resourceId) parts.push(`id: ${el.resourceId}`);
          return parts.join(" | ");
        });

        return {
          content: [{
            type: "text",
            text: `Accessibility tree — ${a11yRelevant.length} elements (of ${elements.length} total):\n\n${OutputProcessor.process(lines.join("\n"))}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
