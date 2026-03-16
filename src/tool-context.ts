/**
 * ToolContext — Unified dependency bundle for all tool modules.
 * 
 * Instead of passing (server, bridge, deviceManager) to every module,
 * we pass a single context object. This makes adding new cross-cutting
 * dependencies non-breaking.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdbBridge } from "./bridge/adb-bridge.js";
import { DeviceManager } from "./bridge/device-manager.js";
import { Logger } from "./middleware/logger.js";
import { SecurityMiddleware } from "./middleware/security.js";
import { DeepADBConfig } from "./config/config.js";

export interface ToolContext {
  server: McpServer;
  bridge: AdbBridge;
  deviceManager: DeviceManager;
  logger: Logger;
  security: SecurityMiddleware;
  config: DeepADBConfig;
}
