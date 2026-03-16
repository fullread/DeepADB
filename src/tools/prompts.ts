/**
 * MCP Prompts — Pre-built workflow templates for common Android debugging tasks.
 * 
 * Prompts are exposed to MCP clients as reusable, parameterized templates
 * that guide multi-step tool usage sequences.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";

export function registerPrompts(ctx: ToolContext): void {

  ctx.server.prompt(
    "debug-crash",
    "Guided workflow: Capture crash information for debugging. Clears logcat, waits for reproduction, then captures crash buffer and device state.",
    { packageName: z.string().describe("Package name to monitor for crashes") },
    ({ packageName }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `I need to debug a crash in ${packageName}. Please follow this workflow:`,
            ``,
            `1. Clear the logcat buffers using adb_logcat_clear`,
            `2. Force-stop and restart ${packageName} using adb_restart_app`,
            `3. Ask me to reproduce the crash, then wait for my confirmation`,
            `4. After I confirm, capture the crash buffer using adb_logcat_crash with 200 lines`,
            `5. Capture the main logcat filtered to ${packageName} using adb_logcat with tag="${packageName}" and 300 lines`,
            `6. Get the device info using adb_device_info for context`,
            `7. Analyze the crash logs and provide a diagnosis`,
          ].join("\n"),
        },
      }],
    })
  );

  ctx.server.prompt(
    "deploy-and-test",
    "Guided workflow: Build, install, launch, and start monitoring an app in one sequence.",
    {
      projectPath: z.string().describe("Path to the Android project root"),
      packageName: z.string().describe("Package name of the app"),
    },
    ({ projectPath, packageName }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Deploy and test ${packageName} from ${projectPath}. Follow this workflow:`,
            ``,
            `1. Build and install the debug APK using adb_build_and_install with projectPath="${projectPath}"`,
            `2. Clear logcat buffers using adb_logcat_clear`,
            `3. Start a background logcat watcher using adb_logcat_start with tag="${packageName}"`,
            `4. Launch the app using adb_start_app with packageName="${packageName}"`,
            `5. Wait 3 seconds, then take a screenshot using adb_screencap`,
            `6. Poll the logcat watcher using adb_logcat_poll to show initial log output`,
            `7. Report the deployment status and any startup issues found in the logs`,
          ].join("\n"),
        },
      }],
    })
  );

  ctx.server.prompt(
    "telephony-snapshot",
    "Guided workflow: Capture comprehensive telephony and cellular state for radio diagnostics.",
    {},
    () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Capture a comprehensive telephony snapshot for cellular security analysis:`,
            ``,
            `1. Get full telephony state using adb_telephony`,
            `2. Get network connectivity info using adb_network`,
            `3. Read the SIM operator using adb_getprop with key="gsm.sim.operator.alpha"`,
            `4. Read the network operator using adb_getprop with key="gsm.operator.alpha"`,
            `5. Read the network type using adb_getprop with key="gsm.network.type"`,
            `6. Summarize the cellular state: operator, registration, signal strength, cell IDs, and any anomalies`,
          ].join("\n"),
        },
      }],
    })
  );

  ctx.server.prompt(
    "airplane-cycle-test",
    "Guided workflow: Test cellular re-registration by cycling airplane mode while monitoring logs.",
    {
      packageName: z.string().optional().describe("Optional package to monitor during the test"),
    },
    ({ packageName }) => {
      const tagFilter = packageName ? ` with tag="${packageName}"` : "";
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Test cellular re-registration with airplane mode cycling:`,
              ``,
              `1. Start a background logcat watcher using adb_logcat_start${tagFilter}`,
              `2. Get baseline telephony state using adb_telephony`,
              `3. Cycle airplane mode using adb_airplane_cycle with delaySeconds=5`,
              `4. Wait 10 seconds for cellular re-registration`,
              `5. Get post-cycle telephony state using adb_telephony`,
              `6. Poll the logcat watcher using adb_logcat_poll`,
              `7. Compare pre and post telephony state — report any changes in cell ID, operator, signal strength, or registration status`,
              `8. Stop the logcat watcher using adb_logcat_stop`,
            ].join("\n"),
          },
        }],
      };
    }
  );
}
