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
import { join, resolve } from "path";
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from "fs";
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

const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/anthropics/DeepADB-plugins/main/registry.json";

function getPluginDir(ctx: ToolContext): string {
  return process.env.DA_PLUGIN_DIR ?? join(ctx.config.tempDir, "plugins");
}

function getRegistryUrl(): string {
  return process.env.DA_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

function getInstalledPlugins(pluginDir: string): Map<string, string> {
  const installed = new Map<string, string>();
  if (!existsSync(pluginDir)) return installed;

  for (const file of readdirSync(pluginDir).filter((f) => f.endsWith(".js"))) {
    // Try to read version from a companion .meta.json file
    const metaPath = join(pluginDir, file.replace(/\.js$/, ".meta.json"));
    let version = "unknown";
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        version = meta.version ?? "unknown";
      } catch { /* ignore */ }
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
        if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true });

        // Path traversal protection — ensure resolved paths stay within plugin directory
        const pluginPath = join(pluginDir, `${name}.js`);
        const metaPath = join(pluginDir, `${name}.meta.json`);
        const resolvedPluginDir = resolve(pluginDir);
        if (!resolve(pluginPath).startsWith(resolvedPluginDir) || !resolve(metaPath).startsWith(resolvedPluginDir)) {
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

        // Basic sanity check — should export a register function
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
          ctx.logger.warn(`Plugin ${name}: no SHA-256 hash in manifest — integrity not verified.`);
        }

        writeFileSync(pluginPath, code);
        writeFileSync(metaPath, JSON.stringify({
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
          manifest = await fetchJson(getRegistryUrl()) as PluginManifestEntry[];
        } catch { /* offline is fine */ }

        const registryMap = new Map(manifest.map((p) => [p.name, p.version]));

        const lines: string[] = [];
        for (const [name, version] of installed) {
          const metaPath = join(pluginDir, `${name}.meta.json`);
          let detail = `${name} v${version}`;

          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (meta.author) detail += ` by ${meta.author}`;
              if (meta.installedAt) detail += ` (installed: ${meta.installedAt.substring(0, 10)})`;
            } catch { /* ignore */ }
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
