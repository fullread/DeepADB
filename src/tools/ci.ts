/**
 * CI/CD Integration Tools — Headless test execution and device readiness.
 * 
 * Designed for automated pipelines: wait for device boot, verify readiness,
 * run instrumented tests, and capture structured results.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";

export function registerCiTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_ci_wait_boot",
    "Wait for a device or emulator to fully boot. Polls sys.boot_completed and waits for the launcher to be ready. Essential for CI pipelines.",
    {
      timeoutSeconds: z.number().min(10).max(300).optional().default(120)
        .describe("Maximum time to wait for boot in seconds (default 120)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ timeoutSeconds, device }) => {
      try {
        const startTime = Date.now();
        const deadline = startTime + timeoutSeconds * 1000;

        // First wait for any device to appear
        let resolved;
        while (Date.now() < deadline) {
          try {
            ctx.deviceManager.invalidateCache();
            resolved = await ctx.deviceManager.resolveDevice(device);
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        if (!resolved) {
          return { content: [{ type: "text", text: `Timed out waiting for device after ${timeoutSeconds}s.` }], isError: true };
        }

        // Now wait for boot_completed
        const serial = resolved.serial;
        while (Date.now() < deadline) {
          const bootResult = await ctx.bridge.shell("getprop sys.boot_completed", {
            device: serial, ignoreExitCode: true,
          });
          if (bootResult.stdout.trim() === "1") {
            // Also check that the package manager is ready
            const pmResult = await ctx.bridge.shell("pm path android", {
              device: serial, ignoreExitCode: true,
            });
            if (pmResult.stdout.includes("package:")) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              return { content: [{ type: "text", text: `Device ${serial} booted and ready (${elapsed}s).` }] };
            }
          }
          await new Promise((r) => setTimeout(r, 3000));
        }

        return { content: [{ type: "text", text: `Device appeared but boot did not complete within ${timeoutSeconds}s.` }], isError: true };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ci_device_ready",
    "Comprehensive CI readiness check. Verifies: device online, booted, package manager ready, screen unlocked, network available. Returns structured pass/fail results.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

        // Boot completed
        const bootResult = await ctx.bridge.shell("getprop sys.boot_completed", { device: serial, ignoreExitCode: true });
        checks.push({ name: "Boot completed", passed: bootResult.stdout.trim() === "1", detail: bootResult.stdout.trim() || "not set" });

        // Package manager
        const pmResult = await ctx.bridge.shell("pm path android", { device: serial, ignoreExitCode: true });
        checks.push({ name: "Package manager", passed: pmResult.stdout.includes("package:"), detail: pmResult.stdout.includes("package:") ? "ready" : "not ready" });

        // Screen state
        const screenResult = await ctx.bridge.shell("dumpsys power | grep 'mWakefulness'", { device: serial, ignoreExitCode: true });
        const awake = screenResult.stdout.includes("Awake");
        checks.push({ name: "Screen awake", passed: awake, detail: awake ? "Awake" : screenResult.stdout.trim() || "unknown" });

        // Network connectivity
        const netResult = await ctx.bridge.shell("ping -c 1 -W 2 8.8.8.8", { device: serial, ignoreExitCode: true, timeout: 5000 });
        const netOk = netResult.exitCode === 0;
        checks.push({ name: "Network (internet)", passed: netOk, detail: netOk ? "reachable" : "unreachable" });

        // Disk space
        const dfResult = await ctx.bridge.shell("df /data | tail -1", { device: serial, ignoreExitCode: true });
        const dfMatch = dfResult.stdout.match(/(\d+)%/);
        const usage = dfMatch ? parseInt(dfMatch[1], 10) : 0;
        checks.push({ name: "Disk space", passed: usage < 95, detail: `${usage}% used` });

        const allPassed = checks.every((c) => c.passed);
        const output = checks.map((c) => `${c.passed ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n");

        return {
          content: [{
            type: "text",
            text: `CI Readiness: ${allPassed ? "ALL PASSED" : "ISSUES FOUND"}\n\n${output}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ci_run_tests",
    "Run Android instrumented tests (androidTest) via `am instrument` and capture results. Returns structured pass/fail output.",
    {
      testPackage: z.string().describe("Test package (e.g., 'com.example.app.test')"),
      runner: z.string().optional().default("androidx.test.runner.AndroidJUnitRunner")
        .describe("Test runner class (default: AndroidX JUnit runner)"),
      testClass: z.string().optional().describe("Specific test class to run (optional)"),
      testMethod: z.string().optional().describe("Specific test method (requires testClass)"),
      device: z.string().optional().describe("Device serial"),
      timeout: z.number().min(10000).max(600000).optional().default(300000).describe("Timeout in ms (10s-10min, default 5 min)"),
    },
    async ({ testPackage, runner, testClass, testMethod, device, timeout }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Validate all user-supplied identifiers that get interpolated into shell
        const argsToCheck: Array<[string, string]> = [[testPackage, "testPackage"], [runner, "runner"]];
        if (testClass) argsToCheck.push([testClass, "testClass"]);
        if (testMethod) argsToCheck.push([testMethod, "testMethod"]);
        for (const [val, name] of argsToCheck) {
          const err = validateShellArg(val, name);
          if (err) return { content: [{ type: "text", text: err }], isError: true };
        }

        let cmd = `am instrument -w -r`;
        if (testClass) {
          cmd += ` -e class ${testClass}`;
          if (testMethod) cmd += `#${testMethod}`;
        }
        cmd += ` ${testPackage}/${runner}`;

        const result = await ctx.bridge.shell(cmd, {
          device: serial, timeout, ignoreExitCode: true,
        });

        const output = result.stdout;

        // Parse basic test results
        const okMatch = output.match(/OK \((\d+) tests?\)/);
        const failMatch = output.match(/FAILURES!!!\s*Tests run:\s*(\d+),\s*Failures:\s*(\d+)/);
        const errorMatch = output.match(/INSTRUMENTATION_STATUS: Error=(.*)/);

        let summary: string;
        if (okMatch) {
          summary = `PASSED: ${okMatch[1]} test(s)`;
        } else if (failMatch) {
          summary = `FAILED: ${failMatch[2]} failure(s) out of ${failMatch[1]} test(s)`;
        } else if (errorMatch) {
          summary = `ERROR: ${errorMatch[1]}`;
        } else if (output.includes("INSTRUMENTATION_RESULT")) {
          summary = "Completed (see output for details)";
        } else {
          summary = "Unknown result — check raw output";
        }

        return {
          content: [{
            type: "text",
            text: `${summary}\n\n${OutputProcessor.process(output, 30000)}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
