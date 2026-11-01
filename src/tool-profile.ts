// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Startup-only capability profiles. These do not sandbox trusted plugin code. */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";

export type ToolProfile = "full" | "inspect";
const INSPECT_TOOLS: ReadonlySet<string> = new Set(["adb_devices", "adb_device_info", "adb_getprop"]);

export function readToolProfile(): ToolProfile {
  const value = process.env.DA_TOOL_PROFILE ?? "full";
  if (value !== "full" && value !== "inspect") {
    throw new Error("DA_TOOL_PROFILE must be 'full' or 'inspect'");
  }
  // GraphQL calls the bridge directly rather than the MCP tool handlers.
  if (value !== "full" && process.env.DA_GRAPHQL_PORT) {
    throw new Error("DA_GRAPHQL_PORT is unavailable with the inspect tool profile");
  }
  return value;
}

/** Guard registration and execution, not just tools/list. Full mode is unchanged. */
export function withToolProfile(server: McpServer, profile: ToolProfile): McpServer {
  if (profile === "full") return server;
  const assertAllowed = (name: string): void => {
    if (!INSPECT_TOOLS.has(name)) throw new Error(`Tool '${name}' is excluded by the inspect profile`);
  };
  return new Proxy(server, {
    get(target, key) {
      if (key === "registerTool") return (name: string, definition: unknown, handler: (...args: unknown[]) => unknown) => {
        assertAllowed(name);
        let currentName = name;
        const handle: RegisteredTool = Reflect.apply(target.registerTool, target, [name, definition, (...args: unknown[]) => {
          assertAllowed(currentName);
          return handler(...args);
        }]);
        const update = handle.update.bind(handle);
        handle.update = changes => {
          const nextName = changes.name ?? currentName;
          assertAllowed(nextName);
          const callback = changes.callback;
          update({ ...changes, ...(callback ? { callback: (...args: Parameters<typeof callback>) => {
            assertAllowed(currentName);
            return callback(...args);
          } } : {}) });
          currentName = nextName;
        };
        return handle;
      };
      if (key === "registerResource" || key === "registerPrompt") return () => {
        throw new Error("Resources and prompts are unavailable with the inspect tool profile");
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
