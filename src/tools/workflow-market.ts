// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Workflow Marketplace — Community-shared workflow definitions.
 *
 * Extends the plugin registry model to include shareable workflow JSON
 * definitions. Community-contributed test workflows, diagnostic sequences,
 * and audit procedures are hosted in a registry manifest alongside plugins.
 *
 * Workflows are downloaded as JSON files into {tempDir}/workflows/ — the
 * same directory used by the workflow orchestration engine, so installed
 * marketplace workflows are immediately available to adb_workflow_run.
 *
 * Registry: reuses DA_REGISTRY_URL or a dedicated DA_WORKFLOW_REGISTRY_URL.
 * Manifest: JSON array of { name, description, version, url, author, tags }.
 */

import { z } from "zod";
import { join } from "path";
import { readFileSync, existsSync, readdirSync} from "fs";
import { ensurePrivateDir, sanitizeFilenameComponent, writeAtomicSync, tryReadJsonOrWarn} from "../middleware/fs-utils.js";
import { createHash } from "crypto";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { fetchJson, fetchText } from "../middleware/fetch-utils.js";

interface WorkflowManifestEntry {
  name: string;
  description: string;
  version: string;
  url: string;
  author?: string;
  tags?: string[];
  sha256?: string;
  steps?: number;
}

/**
 * Workflow marketplace URL — operator must opt in.
 *
 * Fallback chain:
 *   1. DA_WORKFLOW_REGISTRY_URL (explicit)
 *   2. DA_REGISTRY_URL with registry.json → workflows.json substitution
 *   3. null (refuse with friendly "not configured" error)
 *
 * No default URL is shipped: same supply-chain rationale as registry.ts.
 */
function getRegistryUrl(): string | null {
  return process.env.DA_WORKFLOW_REGISTRY_URL
    ?? process.env.DA_REGISTRY_URL?.replace("registry.json", "workflows.json")
    ?? null;
}

/** Standard "marketplace not configured" error response. */
function notConfiguredError() {
  return {
    content: [{
      type: "text" as const,
      text: `Workflow marketplace not configured.\nSet DA_WORKFLOW_REGISTRY_URL (or DA_REGISTRY_URL) to a manifest URL you trust to enable workflow discovery and installation.\nDeepADB does not ship a default marketplace — selecting a source is an operator-side supply-chain decision. See SECURITY.md for guidance.`,
    }],
    isError: true as const,
  };
}

function getWorkflowDir(tempDir: string): string {
  return join(tempDir, "workflows");
}

function getInstalledWorkflows(dir: string): Map<string, { version: string; description: string }> {
  const installed = new Map<string, { version: string; description: string }>();
  if (!existsSync(dir)) return installed;

  // BJ7 fix: route through tryReadJsonOrWarn so a corrupt market workflow
  // surfaces via stderr (getInstalledWorkflows has no logger in scope) rather
  // than vanishing into a quietly-shrinking installed-count.
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const wf = tryReadJsonOrWarn<{ _marketplace?: { version?: string }; description?: string }>(
      join(dir, file),
      "workflow_market_installed"
    );
    if (wf) {
      const name = file.replace(".json", "");
      installed.set(name, {
        version: wf._marketplace?.version ?? "local",
        description: wf.description ?? "",
      });
    }
  }
  return installed;
}

export function registerWorkflowMarketTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_market_search",
    "Search the workflow marketplace for community-shared workflow definitions. Shows name, description, tags, author, and step count. Indicates which workflows are already installed locally.",
    {
      query: z.string().optional().describe("Filter by name, description, or tag keyword"),
      tag: z.string().optional().describe("Filter by exact tag (e.g., 'testing', 'diagnostics', 'security')"),
    },
    async ({ query, tag }) => {
      try {
        const registryUrl = getRegistryUrl();
        if (registryUrl === null) return notConfiguredError();
        let manifest: WorkflowManifestEntry[];
        try {
          manifest = await fetchJson(registryUrl) as WorkflowManifestEntry[];
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Could not fetch workflow marketplace from ${registryUrl}\n${error instanceof Error ? error.message : error}\n\nSet DA_WORKFLOW_REGISTRY_URL to a custom registry, or check your network connection.`,
            }],
            isError: true,
          };
        }

        if (!Array.isArray(manifest)) {
          return { content: [{ type: "text", text: "Invalid marketplace manifest (expected JSON array)." }], isError: true };
        }

        let filtered = manifest;
        if (query) {
          const q = query.toLowerCase();
          filtered = filtered.filter((w) =>
            w.name.toLowerCase().includes(q) ||
            w.description.toLowerCase().includes(q) ||
            (w.tags ?? []).some((t) => t.toLowerCase().includes(q))
          );
        }
        if (tag) {
          const t = tag.toLowerCase();
          filtered = filtered.filter((w) =>
            (w.tags ?? []).some((wt) => wt.toLowerCase() === t)
          );
        }

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: query || tag ? `No workflows matching "${query ?? tag}" in marketplace.` : "Marketplace is empty." }] };
        }

        const dir = getWorkflowDir(ctx.config.tempDir);
        const installed = getInstalledWorkflows(dir);

        const lines = filtered.map((w) => {
          const status = installed.has(w.name) ? " [installed]" : "";
          const tagStr = w.tags && w.tags.length > 0 ? `\n  Tags: ${w.tags.join(", ")}` : "";
          const stepsStr = w.steps ? ` (${w.steps} steps)` : "";
          return `${w.name} v${w.version}${stepsStr}${status}\n  ${w.description}${tagStr}${w.author ? `\n  Author: ${w.author}` : ""}`;
        });

        return {
          content: [{
            type: "text",
            text: `${filtered.length} workflow(s) in marketplace:\n\n${lines.join("\n\n")}\n\nRegistry: ${registryUrl}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_market_install",
    "Download and install a workflow from the marketplace. Saves to the workflows directory for immediate use with adb_workflow_run.",
    {
      name: z.string().describe("Workflow name from the marketplace"),
      force: z.boolean().optional().default(false).describe("Overwrite if a workflow with this name already exists locally"),
    },
    async ({ name, force }) => {
      try {
        const registryUrl = getRegistryUrl();
        if (registryUrl === null) return notConfiguredError();
        let manifest: WorkflowManifestEntry[];
        try {
          manifest = await fetchJson(registryUrl) as WorkflowManifestEntry[];
        } catch (error) {
          return { content: [{ type: "text", text: `Could not fetch marketplace: ${error instanceof Error ? error.message : error}` }], isError: true };
        }

        const entry = manifest.find((w) => w.name === name);
        if (!entry) {
          const available = manifest.map((w) => w.name).join(", ");
          return { content: [{ type: "text", text: `Workflow "${name}" not found in marketplace.\nAvailable: ${available || "(empty)"}` }], isError: true };
        }

        const dir = getWorkflowDir(ctx.config.tempDir);
        if (!existsSync(dir)) ensurePrivateDir(dir);

        const safeName = sanitizeFilenameComponent(name);
        const filePath = join(dir, `${safeName}.json`);

        if (existsSync(filePath) && !force) {
          return { content: [{ type: "text", text: `Workflow "${name}" already exists locally. Use force=true to overwrite.` }], isError: true };
        }

        // Download
        let rawJson: string;
        try {
          rawJson = await fetchText(entry.url);
        } catch (error) {
          return { content: [{ type: "text", text: `Failed to download workflow: ${error instanceof Error ? error.message : error}` }], isError: true };
        }

        // Integrity verification
        if (entry.sha256) {
          const actualHash = createHash("sha256").update(rawJson).digest("hex");
          if (actualHash !== entry.sha256) {
            return {
              content: [{
                type: "text",
                text: `Integrity check failed for workflow "${name}".\nExpected SHA-256: ${entry.sha256}\nActual SHA-256:   ${actualHash}`,
              }],
              isError: true,
            };
          }
        } else {
          return {
            content: [{
              type: "text",
              text: `Refusing to install workflow "${name}" without a SHA-256 integrity hash.\nThe marketplace manifest must include a "sha256" field for this entry.\nWithout an integrity hash, a compromised marketplace could deliver a malicious workflow whose shell, root_shell, or install actions execute on your device. The marketplace maintainer should add a SHA-256 hash to the manifest entry to enable installation.`,
            }],
            isError: true,
          };
        }

        // Validate it's a proper workflow
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawJson);
        } catch {
          return { content: [{ type: "text", text: `Downloaded content is not valid JSON.` }], isError: true };
        }

        if (!parsed.name || !Array.isArray(parsed.steps)) {
          return { content: [{ type: "text", text: `Downloaded JSON is not a valid workflow (missing 'name' or 'steps').` }], isError: true };
        }

        // Attach marketplace metadata
        parsed._marketplace = {
          version: entry.version,
          author: entry.author,
          sourceUrl: entry.url,
          installedAt: new Date().toISOString(),
        };

        // BJ8 fix: backup-on-overwrite. When force=true overwrites an existing
        // workflow, save the previous version to {name}.json.bak so a fat-finger
        // install doesn't permanently lose a customized local workflow.
        let backupNote = "";
        if (existsSync(filePath) && force) {
          try {
            const backupPath = filePath + ".bak";
            const existing = readFileSync(filePath, "utf-8");
            writeAtomicSync(backupPath, existing);
            backupNote = `\nBackup of previous version: ${backupPath}`;
          } catch (err) {
            backupNote = `\n(Note: backup of previous version failed — ${err instanceof Error ? err.message : err})`;
          }
        }
        writeAtomicSync(filePath, JSON.stringify(parsed, null, 2));

        const stepCount = Array.isArray(parsed.steps) ? (parsed.steps as unknown[]).length : "?";
        return {
          content: [{
            type: "text",
            text: `Workflow "${name}" v${entry.version} installed (${stepCount} steps).\nSaved: ${filePath}${backupNote}\nRun with: adb_workflow_run workflow="${safeName}"`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_market_export",
    "Export a local workflow with marketplace metadata for sharing. Produces a JSON file with name, description, version, author, and tags suitable for submission to the marketplace registry.",
    {
      workflow: z.string().describe("Name of the local workflow to export (from adb_workflow_list)"),
      author: z.string().optional().describe("Author name to include in metadata"),
      version: z.string().optional().default("1.0.0").describe("Version string (semver-style, e.g., '1.2.3'). Defaults to '1.0.0' if omitted. Increment when publishing an updated workflow so registry consumers can detect changes."),
      tags: z.array(z.string()).optional().describe("Tags for discovery (e.g., ['testing', 'diagnostics'])"),
    },
    async ({ workflow, author, version, tags }) => {
      try {
        const dir = getWorkflowDir(ctx.config.tempDir);
        const safeName = sanitizeFilenameComponent(workflow);
        const filePath = join(dir, `${safeName}.json`);

        if (!existsSync(filePath)) {
          return { content: [{ type: "text", text: `Workflow "${workflow}" not found. Use adb_workflow_list to see available workflows.` }], isError: true };
        }

        const wf = JSON.parse(readFileSync(filePath, "utf-8"));

        // Build export package
        const exportPkg = {
          ...wf,
          _marketplace: {
            version,
            author: author ?? "unknown",
            tags: tags ?? [],
            exportedAt: new Date().toISOString(),
          },
        };

        const exportJson = JSON.stringify(exportPkg, null, 2);
        const sha256 = createHash("sha256").update(exportJson).digest("hex");
        const exportPath = join(dir, `${safeName}.export.json`);
        writeAtomicSync(exportPath, exportJson);

        const stepCount = Array.isArray(wf.steps) ? wf.steps.length : "?";

        const sections: string[] = [];
        sections.push(`Workflow exported for marketplace sharing:`);
        sections.push(`  Name: ${wf.name ?? safeName}`);
        sections.push(`  Description: ${wf.description ?? "(none)"}`);
        sections.push(`  Version: ${version}`);
        sections.push(`  Steps: ${stepCount}`);
        sections.push(`  Author: ${author ?? "unknown"}`);
        if (tags && tags.length > 0) sections.push(`  Tags: ${tags.join(", ")}`);
        sections.push(`  SHA-256: ${sha256}`);
        sections.push(`  Exported to: ${exportPath}`);
        sections.push(`\nRegistry manifest entry:`);
        sections.push(JSON.stringify({
          name: safeName,
          description: wf.description ?? "",
          version,
          url: "<upload-url>",
          author: author ?? "unknown",
          tags: tags ?? [],
          sha256,
          steps: stepCount,
        }, null, 2));

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
