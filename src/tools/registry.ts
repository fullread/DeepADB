// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Plugin Registry Tools — Discover, install, and manage community plugins.
 *
 * Fetches a plugin manifest from a configurable registry URL, downloads
 * plugin files, and installs them into the DA_PLUGIN_DIR for loading
 * on next server restart.
 *
 * Registry URL: DA_REGISTRY_URL env var, or default GitHub-hosted manifest.
 * Manifest format: JSON array of { name, description, version, url, author }.
 */

import { z } from "zod";
import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { ensurePrivateDir, isWithinDir, writeAtomicSync, tryReadJsonOrWarn} from "../middleware/fs-utils.js";
import { createHash } from "crypto";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { fetchJson, fetchText } from "../middleware/fetch-utils.js";

interface PluginManifestEntry {
  name: string;
  description: string;
  version: string;
  url: string;
  author?: string;
  sha256?: string;
}

function getPluginDir(ctx: ToolContext): string {
  return process.env.DA_PLUGIN_DIR ?? join(ctx.config.tempDir, "plugins");
}

/**
 * Registry URL — operator must opt in by setting DA_REGISTRY_URL.
 *
 * No default URL is shipped: a default would either commit DeepADB to
 * hosting a public registry (a maintenance/supply-chain liability) or
 * point at a namespace it does not control. Soft fail-closed: registry
 * tools register normally, but every operation returns a friendly
 * "registry not configured" error until the operator sets the env var
 * to a manifest URL they trust.
 */
function getRegistryUrl(): string | null {
  return process.env.DA_REGISTRY_URL ?? null;
}

/** Standard "registry not configured" error response. Reused at every call site. */
function notConfiguredError() {
  return {
    content: [{
      type: "text" as const,
      text: `Plugin registry not configured.\nSet DA_REGISTRY_URL to a manifest URL you trust to enable plugin discovery and installation.\nDeepADB does not ship a default registry — selecting a source is an operator-side supply-chain decision. See SECURITY.md for guidance.`,
    }],
    isError: true as const,
  };
}

function getInstalledPlugins(pluginDir: string): Map<string, string> {
  const installed = new Map<string, string>();
  if (!existsSync(pluginDir)) return installed;

  for (const file of readdirSync(pluginDir).filter((f) => f.endsWith(".js"))) {
    // Try to read version from a companion .meta.json file
    const metaPath = join(pluginDir, file.replace(/\.js$/, ".meta.json"));
    let version = "unknown";
    if (existsSync(metaPath)) {
      // BN7 fix (site 1): tryReadJsonOrWarn surfaces corrupt .meta.json files
      // via stderr; without it the version silently stayed "unknown" with no
      // diagnostic for the operator.
      const meta = tryReadJsonOrWarn<{ version?: string }>(metaPath, "registry_installed_meta");
      if (meta?.version) version = meta.version;
    }
    installed.set(file.replace(/\.js$/, ""), version);
  }
  return installed;
}

export function registerRegistryTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_registry_search",
    "Search the community plugin registry for available plugins. Shows name, description, version, and author. Fetches the latest manifest from the configured registry URL.",
    {
      query: z.string().optional().describe("Filter plugins by name or description keyword"),
    },
    async ({ query }) => {
      try {
        const registryUrl = getRegistryUrl();
        if (registryUrl === null) return notConfiguredError();
        let manifest: PluginManifestEntry[];
        try {
          manifest = await fetchJson(registryUrl) as PluginManifestEntry[];
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Could not fetch plugin registry from ${registryUrl}\n${error instanceof Error ? error.message : error}\n\nSet DA_REGISTRY_URL to a custom registry, or check your network connection.`,
            }],
            isError: true,
          };
        }

        if (!Array.isArray(manifest)) {
          return { content: [{ type: "text", text: "Invalid registry manifest (expected JSON array)." }], isError: true };
        }

        let filtered = manifest;
        if (query) {
          const q = query.toLowerCase();
          filtered = manifest.filter((p) =>
            p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
          );
        }

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: query ? `No plugins matching "${query}" in registry.` : "Registry is empty." }] };
        }

        const pluginDir = getPluginDir(ctx);
        const installed = getInstalledPlugins(pluginDir);

        const lines = filtered.map((p) => {
          const status = installed.has(p.name)
            ? (installed.get(p.name) === p.version ? " [installed]" : ` [installed: ${installed.get(p.name)}, update: ${p.version}]`)
            : "";
          return `${p.name} v${p.version}${status}\n  ${p.description}${p.author ? `\n  Author: ${p.author}` : ""}`;
        });

        return {
          content: [{
            type: "text",
            text: `${filtered.length} plugin(s) in registry:\n\n${lines.join("\n\n")}\n\nRegistry: ${registryUrl}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_registry_install",
    "Install a plugin from the community registry by name. Downloads the plugin JavaScript file into the plugins directory. Restart DeepADB to load it.",
    {
      name: z.string().describe("Plugin name from the registry"),
      force: z.boolean().optional().default(false).describe("Overwrite if already installed"),
    },
    async ({ name, force }) => {
      try {
        const registryUrl = getRegistryUrl();
        if (registryUrl === null) return notConfiguredError();
        let manifest: PluginManifestEntry[];
        try {
          manifest = await fetchJson(registryUrl) as PluginManifestEntry[];
        } catch (error) {
          return {
            content: [{ type: "text", text: `Could not fetch registry: ${error instanceof Error ? error.message : error}` }],
            isError: true,
          };
        }

        const plugin = manifest.find((p) => p.name === name);
        if (!plugin) {
          const available = manifest.map((p) => p.name).join(", ");
          return { content: [{ type: "text", text: `Plugin "${name}" not found in registry.\nAvailable: ${available || "(empty)"}` }], isError: true };
        }

        const pluginDir = getPluginDir(ctx);
        if (!existsSync(pluginDir)) ensurePrivateDir(pluginDir);

        // Path traversal protection — ensure resolved paths stay within
        // plugin directory. Uses path-separator boundary so a manifest name
        // like "../plugins_evil/foo" is correctly rejected (the previous
        // bare-startsWith check passed it because the absolute path
        // string-prefix-matched the pluginDir prefix).
        const pluginPath = join(pluginDir, `${name}.js`);
        const metaPath = join(pluginDir, `${name}.meta.json`);
        if (!isWithinDir(pluginPath, pluginDir) || !isWithinDir(metaPath, pluginDir)) {
          return { content: [{ type: "text", text: `Invalid plugin name: "${name}" resolves outside the plugin directory.` }], isError: true };
        }

        if (existsSync(pluginPath) && !force) {
          return { content: [{ type: "text", text: `Plugin "${name}" is already installed. Use force=true to overwrite.` }], isError: true };
        }

        // Download the plugin
        ctx.logger.info(`Downloading plugin: ${plugin.url}`);
        let code: string;
        try {
          code = await fetchText(plugin.url);
        } catch (error) {
          return { content: [{ type: "text", text: `Failed to download plugin: ${error instanceof Error ? error.message : error}` }], isError: true };
        }

        // Basic sanity check — should export a register function.
        // BN8 note: `code.includes("register")` is a HEURISTIC, not a real
        // export check. A plugin's source could contain "register" in a
        // comment or string literal while not actually exporting register().
        // Conversely, it could export register as a property of an object
        // and this check would miss it. Acceptable as a two-layer defense:
        //   Layer 1 (here, install-time): heuristic warning surface, soft.
        //   Layer 2 (plugins.ts AQ3, load-time): real per-plugin try/catch
        //     around the dynamic import and `typeof mod.register === "function"`
        //     check — that's the authoritative validation.
        // The install-time check exists to flag obvious misshapenness early,
        // before the operator wastes time hunting load-time failures.
        if (!code.includes("register")) {
          ctx.logger.warn(`Plugin ${name} may not export a register() function.`);
        }

        // Integrity verification — if the manifest provides a SHA-256 hash, verify it
        if (plugin.sha256) {
          const actualHash = createHash("sha256").update(code).digest("hex");
          if (actualHash !== plugin.sha256) {
            return {
              content: [{
                type: "text",
                text: `Integrity check failed for plugin "${name}".\nExpected SHA-256: ${plugin.sha256}\nActual SHA-256:   ${actualHash}\nThe downloaded file does not match the registry manifest. This could indicate tampering or a corrupted download.`,
              }],
              isError: true,
            };
          }
          ctx.logger.info(`Plugin ${name}: SHA-256 integrity verified.`);
        } else {
          return {
            content: [{
              type: "text",
              text: `Refusing to install plugin "${name}" without a SHA-256 integrity hash.\nThe registry manifest must include a "sha256" field for this entry.\nWithout an integrity hash, a compromised registry could deliver arbitrary code that runs in the DeepADB server process. The registry maintainer should add a SHA-256 hash to the manifest entry to enable installation.`,
            }],
            isError: true,
          };
        }

        writeAtomicSync(pluginPath, code);
        writeAtomicSync(metaPath, JSON.stringify({
          name: plugin.name,
          version: plugin.version,
          author: plugin.author,
          installedAt: new Date().toISOString(),
          sourceUrl: plugin.url,
        }, null, 2));

        return {
          content: [{
            type: "text",
            text: `Plugin "${name}" v${plugin.version} installed to ${pluginPath}\nRestart DeepADB to load the plugin.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_registry_installed",
    "List all locally installed plugins with their versions and metadata. Shows which plugins have updates available in the registry.",
    {},
    async () => {
      try {
        const pluginDir = getPluginDir(ctx);
        const installed = getInstalledPlugins(pluginDir);

        if (installed.size === 0) {
          return { content: [{ type: "text", text: `No plugins installed.\nPlugin directory: ${pluginDir}\nUse adb_registry_search to find available plugins.` }] };
        }

        // Try to fetch registry to check for updates
        let manifest: PluginManifestEntry[] = [];
        try {
          const updateUrl = getRegistryUrl();
          if (updateUrl === null) return notConfiguredError();
          manifest = await fetchJson(updateUrl) as PluginManifestEntry[];
        } catch { /* offline is fine */ }

        const registryMap = new Map(manifest.map((p) => [p.name, p.version]));

        const lines: string[] = [];
        for (const [name, version] of installed) {
          const metaPath = join(pluginDir, `${name}.meta.json`);
          let detail = `${name} v${version}`;

          if (existsSync(metaPath)) {
            // BN7 fix (site 2): tryReadJsonOrWarn surfaces corruption to the
            // operator via ctx.logger.warn instead of dropping plugin details
            // without a hint why.
            const meta = tryReadJsonOrWarn<{ author?: string; installedAt?: string }>(
              metaPath,
              "registry_status_meta",
              ctx.logger
            );
            if (meta?.author) detail += ` by ${meta.author}`;
            if (meta?.installedAt) detail += ` (installed: ${meta.installedAt.substring(0, 10)})`;
          }

          const registryVersion = registryMap.get(name);
          if (registryVersion && registryVersion !== version) {
            detail += ` → update available: v${registryVersion}`;
          }

          lines.push(detail);
        }

        return {
          content: [{
            type: "text",
            text: `${installed.size} installed plugin(s):\n\n${lines.join("\n")}\n\nPlugin directory: ${pluginDir}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
