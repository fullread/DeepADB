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

import { join } from "path";
import { readdirSync, existsSync } from "fs";
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

  for (const file of files) {
    const pluginPath = join(pluginDir, file);
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
