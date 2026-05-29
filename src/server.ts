// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * DeepADB MCP Server
 * 
 * Wires together the ADB bridge, device manager, middleware,
 * and all tool/resource/prompt modules into a single MCP server instance.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "fs";
import { ensurePrivateDir } from "./middleware/fs-utils.js";
import { AdbBridge } from "./bridge/adb-bridge.js";
import { LocalBridge } from "./bridge/local-bridge.js";
import { DeviceManager } from "./bridge/device-manager.js";
import { Logger } from "./middleware/logger.js";
import { SecurityMiddleware } from "./middleware/security.js";
import { config, validateConfig, isOnDevice, VERSION } from "./config/config.js";
import { ToolContext } from "./tool-context.js";

// Tool module registrations
import { registerDeviceTools } from "./tools/device.js";
import { registerShellTools } from "./tools/shell.js";
import { registerPackageTools } from "./tools/packages.js";
import { registerFileTools } from "./tools/files.js";
import { registerLogTools } from "./tools/logs.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerUiTools } from "./tools/ui.js";
import { registerBuildTools } from "./tools/build.js";
import { registerHealthTools } from "./tools/health.js";
import { registerWirelessTools } from "./tools/wireless.js";
import { registerControlTools } from "./tools/control.js";
import { registerLogcatWatchTools } from "./tools/logcat-watch.js";
import { registerForwardingTools } from "./tools/forwarding.js";
import { registerScreenRecordTools } from "./tools/screen-record.js";
import { registerEmulatorTools } from "./tools/emulator.js";
import { registerQemuTools } from "./tools/qemu.js";
import { registerTestingTools } from "./tools/testing.js";
import { registerMultiDeviceTools } from "./tools/multi-device.js";
import { registerSnapshotTools } from "./tools/snapshot.js";
import { registerNetworkCaptureTools } from "./tools/network-capture.js";
import { registerCiTools } from "./tools/ci.js";
import { registerPluginTools, loadPlugins } from "./tools/plugins.js";
import { registerBasebandTools } from "./tools/baseband.js";
import { registerAccessibilityTools } from "./tools/accessibility.js";
import { registerRegressionTools } from "./tools/regression.js";
import { registerDeviceFarmTools } from "./tools/device-farm.js";
import { registerRegistryTools } from "./tools/registry.js";
import { registerAtCommandTools } from "./tools/at-commands.js";
import { registerScreenshotDiffTools } from "./tools/screenshot-diff.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerSplitApkTools } from "./tools/split-apk.js";
import { registerMirroringTools } from "./tools/mirroring.js";
import { registerTestGenTools } from "./tools/test-gen.js";
import { registerOtaMonitorTools } from "./tools/ota-monitor.js";
import { registerRilInterceptTools } from "./tools/ril-intercept.js";
import { registerDeviceProfileTools } from "./tools/device-profiles.js";
import { registerFirmwareAnalysisTools } from "./tools/firmware-analysis.js";
import { registerWorkflowMarketTools } from "./tools/workflow-market.js";
import { registerSelinuxAuditTools } from "./tools/selinux-audit.js";
import { registerThermalPowerTools } from "./tools/thermal-power.js";
import { registerNetworkDiscoveryTools } from "./tools/network-discovery.js";
import { registerSensorTools } from "./tools/sensors.js";
import { registerWirelessFirmwareTools } from "./tools/wireless-firmware.js";
import { registerInputGestureTools } from "./tools/input-gestures.js";
import { registerResultHandleTools } from "./tools/result-handles.js";
import { startupSweep as resultHandleStartupSweep } from "./middleware/result-handle.js";

// Resource and prompt registrations
import { registerResources } from "./tools/resources.js";
import { registerPrompts } from "./tools/prompts.js";

export interface CreateServerResult {
  server: McpServer;
  logger: Logger;
  bridge: AdbBridge;
  deviceManager: DeviceManager;
}

export async function createServer(): Promise<CreateServerResult> {
  // BM1 fix (M2+Q1): validate DA_LOG_LEVEL against the enum at runtime instead
  // of using an unchecked `as` cast. The bare cast silently accepts any string
  // (e.g., DA_LOG_LEVEL=verbose) and was passed to Logger which then disabled
  // all logging because the value didn't match any threshold. Fail-open to
  // "info" with a stderr warning when the env var is set but invalid.
  const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
  type LogLevel = (typeof VALID_LOG_LEVELS)[number];
  const rawLevel = process.env.DA_LOG_LEVEL;
  let logLevel: LogLevel = "info";
  if (rawLevel !== undefined) {
    if ((VALID_LOG_LEVELS as readonly string[]).includes(rawLevel)) {
      logLevel = rawLevel as LogLevel;
    } else {
      console.error(
        `[DeepADB] Invalid DA_LOG_LEVEL=${JSON.stringify(rawLevel)}. ` +
        `Valid values: ${VALID_LOG_LEVELS.join(", ")}. Falling back to "info".`
      );
    }
  }
  const logger = new Logger(logLevel);

  // Validate configuration at startup
  const warnings = validateConfig();
  for (const warning of warnings) {
    logger.warn(warning);
  }

  // Ensure temp directory exists once, before any tool module registration
  if (!existsSync(config.tempDir)) {
    ensurePrivateDir(config.tempDir);
  }

  const bridge = isOnDevice() ? new LocalBridge(logger) : new AdbBridge(logger);
  if (bridge instanceof LocalBridge) {
    logger.info("On-device mode detected — using LocalBridge (direct execution, no ADB)");
  }
  const deviceManager = new DeviceManager(bridge);
  const security = new SecurityMiddleware(logger);

  const server = new McpServer({
    name: "deepadb",
    version: VERSION,
  });

  // Build unified tool context
  const ctx: ToolContext = { server, bridge, deviceManager, logger, security, config };

  // Register all tool modules (45 modules)
  registerDeviceTools(ctx);
  registerShellTools(ctx);
  registerPackageTools(ctx);
  registerFileTools(ctx);
  registerLogTools(ctx);
  registerDiagnosticTools(ctx);
  registerUiTools(ctx);
  registerBuildTools(ctx);
  registerHealthTools(ctx);
  registerWirelessTools(ctx);
  registerControlTools(ctx);
  registerLogcatWatchTools(ctx);
  registerForwardingTools(ctx);
  registerScreenRecordTools(ctx);
  registerEmulatorTools(ctx);
  registerQemuTools(ctx);
  registerTestingTools(ctx);
  registerMultiDeviceTools(ctx);
  registerSnapshotTools(ctx);
  registerNetworkCaptureTools(ctx);
  registerCiTools(ctx);
  registerPluginTools(ctx);
  registerBasebandTools(ctx);
  registerAccessibilityTools(ctx);
  registerRegressionTools(ctx);
  registerDeviceFarmTools(ctx);
  registerRegistryTools(ctx);
  registerAtCommandTools(ctx);
  registerScreenshotDiffTools(ctx);
  registerWorkflowTools(ctx);
  registerSplitApkTools(ctx);
  registerMirroringTools(ctx);
  registerTestGenTools(ctx);
  registerOtaMonitorTools(ctx);
  registerRilInterceptTools(ctx);
  registerDeviceProfileTools(ctx);
  registerFirmwareAnalysisTools(ctx);
  registerWorkflowMarketTools(ctx);
  registerSelinuxAuditTools(ctx);
  registerThermalPowerTools(ctx);
  registerNetworkDiscoveryTools(ctx);
  registerSensorTools(ctx);
  registerWirelessFirmwareTools(ctx);
  registerInputGestureTools(ctx);
  registerResultHandleTools(ctx);

  // Register MCP resources and prompts
  registerResources(ctx);
  registerPrompts(ctx);

  // Load external plugins (async — scans plugin directory)
  await loadPlugins(ctx);

  // Sweep any handles left over from prior sessions: enforce TTL + size caps
  // against the on-disk store. Reports only if there was something to clean.
  const sweepResult = resultHandleStartupSweep();
  if (sweepResult.evicted > 0 || sweepResult.kept > 0) {
    logger.info(`Result-handle store: ${sweepResult.kept} active, ${sweepResult.evicted} evicted at startup.`);
  }

  logger.info("DeepADB MCP server initialized — 45 tool modules, 5 resources, 4 prompts. Ready.");

  return { server, logger, bridge, deviceManager };
}
