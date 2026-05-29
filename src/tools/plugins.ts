// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Plugin Architecture — Dynamic tool module loading.
 * 
 * Allows external tool modules to be loaded at runtime from a plugins directory.
 * Each plugin is a JavaScript module that exports a register function accepting ToolContext.
 * 
 * Plugin directory: DA_PLUGIN_DIR env var, or {tempDir}/plugins
 * 
 * Plugin format:
 *   // my-plugin.js
 *   export function register(ctx) {
 *     ctx.server.tool("my_custom_tool", "description", { ... }, async (args) => { ... });
 *   }
 */

import { join, resolve as resolvePath } from "path";
import { readdirSync, existsSync, realpathSync } from "fs";
import { pathToFileURL } from "url";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

interface LoadedPlugin {
  name: string;
  path: string;
  loadedAt: number;
}

/** Track loaded plugins */
const loadedPlugins: LoadedPlugin[] = [];

/**
 * Scan the plugins directory and load any .js modules that export a register function.
 * Called once at startup.
 *
 * V1 trust model: this function performs **no signature or hash verification**
 * on plugin files. Any `.js` file in DA_PLUGIN_DIR (or `{tempDir}/plugins/`)
 * is loaded via dynamic `import()` and gains full Node.js privileges in the
 * server process — equivalent to arbitrary code execution.
 *
 * This is by design under the single-operator threat model: the operator
 * controls the plugin directory and is responsible for what they put there.
 * Operators who install plugins via `adb_registry_install` get SHA-256
 * download verification (see `registry.ts` for the install-time check) —
 * tampering after install is the operator's local-disk-integrity problem,
 * not this loader's.
 *
 * If you ever need a stronger model (multi-user host, untrusted operator,
 * supply-chain assumption-of-breach), add at minimum: (a) an Ed25519
 * signature verified against an operator-pinned public key, (b) refusing
 * to load files whose mtime is newer than a recorded manifest, and (c)
 * a startup warning if the plugin directory has world-writable permissions.
 */
export async function loadPlugins(ctx: ToolContext): Promise<void> {
  const pluginDir = process.env.DA_PLUGIN_DIR ?? join(ctx.config.tempDir, "plugins");

  if (!existsSync(pluginDir)) {
    ctx.logger.debug(`Plugin directory not found: ${pluginDir} (no plugins to load)`);
    return;
  }

  const files = readdirSync(pluginDir).filter((f) => f.endsWith(".js"));
  if (files.length === 0) {
    ctx.logger.debug("Plugin directory exists but contains no .js files.");
    return;
  }

  // AQ4 fix: realpath the plugin directory once so we can compare each plugin's
  // resolved path against it. This catches symlinks that point outside the
  // plugin directory — e.g., a malicious actor creating a symlink to
  // /tmp/hostile.js inside the plugin dir would otherwise be loaded as a
  // trusted plugin. Under the documented single-operator threat model this
  // is paranoid, but the threat model is layered (a compromised tempdir on
  // a shared machine is exactly this scenario) and the cost is one realpath
  // per plugin at startup.
  const pluginDirReal = resolvePath(realpathSync(pluginDir));
  for (const file of files) {
    const pluginPath = join(pluginDir, file);
    let pluginPathReal: string;
    try {
      pluginPathReal = resolvePath(realpathSync(pluginPath));
    } catch (err) {
      ctx.logger.warn(`Plugin ${file} could not be realpath-resolved: ${err instanceof Error ? err.message : err} — skipped.`);
      continue;
    }
    // The resolved plugin must live directly under the resolved plugin dir.
    // The +path.sep guard prevents prefix-confusion (e.g., /plugins-evil/x.js
    // matching /plugins/).
    const sep = process.platform === "win32" ? "\\" : "/";
    if (!pluginPathReal.startsWith(pluginDirReal + sep)) {
      ctx.logger.warn(`Plugin ${file} resolves outside the plugin directory (${pluginPathReal} vs ${pluginDirReal}) — skipped. If this was intentional, place the actual file in the plugin directory rather than symlinking.`);
      continue;
    }
    try {
      const moduleUrl = pathToFileURL(pluginPath).href;
      const mod = await import(moduleUrl);

      if (typeof mod.register === "function") {
        mod.register(ctx);
        loadedPlugins.push({
          name: file.replace(/\.js$/, ""),
          path: pluginPath,
          loadedAt: Date.now(),
        });
        ctx.logger.info(`Plugin loaded: ${file}`);
      } else {
        ctx.logger.warn(`Plugin ${file} has no register() export — skipped.`);
      }
    } catch (error) {
      ctx.logger.error(`Failed to load plugin ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (loadedPlugins.length > 0) {
    ctx.logger.info(`${loadedPlugins.length} plugin(s) loaded from ${pluginDir}`);
  }
}

export function registerPluginTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_plugin_list",
    "List all loaded plugins and the plugin directory path.",
    {},
    async () => {
      try {
        const pluginDir = process.env.DA_PLUGIN_DIR ?? join(ctx.config.tempDir, "plugins");

        if (loadedPlugins.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No plugins loaded.\nPlugin directory: ${pluginDir}\n\nTo create a plugin, add a .js file to the plugin directory that exports a register(ctx) function.`,
            }],
          };
        }

        const output = loadedPlugins.map((p) => {
          const ago = ((Date.now() - p.loadedAt) / 1000).toFixed(0);
          return `${p.name} — loaded ${ago}s ago\n  Path: ${p.path}`;
        }).join("\n\n");

        return {
          content: [{
            type: "text",
            text: `${loadedPlugins.length} plugin(s) loaded:\n\n${output}\n\nPlugin directory: ${pluginDir}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_plugin_info",
    "Show information about the plugin system: directory, how to create plugins, and loaded plugin count.",
    {},
    async () => {
      try {
        const pluginDir = process.env.DA_PLUGIN_DIR ?? join(ctx.config.tempDir, "plugins");
        const info = [
          `Plugin System — DeepADB`,
          ``,
          `Directory: ${pluginDir}`,
          `Loaded: ${loadedPlugins.length} plugin(s)`,
          ``,
          `Creating a plugin:`,
          `1. Create a .js file in the plugin directory`,
          `2. Export a register(ctx) function that receives ToolContext`,
          `3. Use ctx.server.tool() to register custom tools`,
          `4. Restart DeepADB to load the plugin`,
          ``,
          `Example (my-plugin.js):`,
          `  export function register(ctx) {`,
          `    ctx.server.tool("my_tool", "My custom tool", {}, async () => {`,
          `      return { content: [{ type: "text", text: "Hello from plugin!" }] };`,
          `    });`,
          `  }`,
        ];
        return { content: [{ type: "text", text: info.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
