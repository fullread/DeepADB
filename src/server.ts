/**
 * DeepADB MCP Server
 * 
 * Wires together the ADB bridge, device manager, middleware,
 * and all tool/resource/prompt modules into a single MCP server instance.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, existsSync } from "fs";
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
  const logger = new Logger(
    (process.env.DA_LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info"
  );

  // Validate configuration at startup
  const warnings = validateConfig();
  for (const warning of warnings) {
    logger.warn(warning);
  }

  // Ensure temp directory exists once, before any tool module registration
  if (!existsSync(config.tempDir)) {
    mkdirSync(config.tempDir, { recursive: true });
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

  // Register all tool modules (41 modules)
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

  // Register MCP resources and prompts
  registerResources(ctx);
  registerPrompts(ctx);

  // Load external plugins (async — scans plugin directory)
  await loadPlugins(ctx);

  logger.info("DeepADB MCP server initialized — 41 tool modules, 4 resources, 4 prompts. Ready.");

  return { server, logger, bridge, deviceManager };
}
