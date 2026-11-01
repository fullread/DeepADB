// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * ToolContext — Unified dependency bundle for all tool modules.
 * 
 * Instead of passing (server, bridge, deviceManager) to every module,
 * we pass a single context object. This makes adding new cross-cutting
 * dependencies non-breaking.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { AdbBridge } from "./bridge/adb-bridge.js";
import { DeviceManager } from "./bridge/device-manager.js";
import { Logger } from "./middleware/logger.js";
import { SecurityMiddleware } from "./middleware/security.js";
import { DeepADBConfig } from "./config/config.js";
import type { PluginServer } from "./plugin-compat.js";

export interface BuiltinToolContext {
  server: McpServer;
  bridge: AdbBridge;
  deviceManager: DeviceManager;
  logger: Logger;
  security: SecurityMiddleware;
  config: DeepADBConfig;
}

/** Preserve the original exported ToolContext contract for typed plugins. */
export interface ToolContext extends BuiltinToolContext {
  server: PluginServer;
}

export type PluginToolContext = ToolContext;

/** Explicit v2 API view for new plugins using context.mcpReq and native handles. */
export type NativePluginToolContext = BuiltinToolContext;
