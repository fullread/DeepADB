/**
 * Device Farm Integration Tools — Cloud-based test execution via Firebase Test Lab.
 *
 * Wraps the `gcloud firebase test android` CLI for running tests at scale.
 * Requires: Google Cloud SDK with `gcloud` on PATH, authenticated project.
 * Falls back to helpful setup instructions if gcloud is unavailable.
 */

import { z } from "zod";
import { execFile } from "child_process";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

function execAsync(
  cmd: string,
  args: string[],
  timeout: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 * 5, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

async function checkGcloud(): Promise<string | null> {
  try {
    const result = await execAsync("gcloud", ["--version"], 10000);
    if (result.exitCode === 0) return null;
    return "gcloud CLI returned an error. Verify installation with `gcloud --version`.";
  } catch {
    return "gcloud CLI not found. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install\nThen run: gcloud auth login && gcloud config set project YOUR_PROJECT_ID";
  }
}

export function registerDeviceFarmTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_farm_run",
    "Run tests on Firebase Test Lab. Uploads an APK and test APK, executes instrumented tests across specified device models and API levels. Requires gcloud CLI authenticated with a Firebase project.",
    {
      appApk: z.string().describe("Path to the app APK file"),
      testApk: z.string().describe("Path to the test/instrumentation APK file"),
      devices: z.array(z.string()).optional()
        .describe("Device specs as 'model=DEVICE,version=API' (e.g., 'model=bluejay,version=33'). Omit for default device."),
      testTargets: z.string().optional().describe("Specific test class or method (e.g., 'class com.example.MyTest')"),
      timeout: z.string().optional().default("300s").describe("Test timeout (e.g., '300s', '10m')"),
      resultsBucket: z.string().optional().describe("GCS bucket for results (omit for default)"),
    },
    async ({ appApk, testApk, devices, testTargets, timeout, resultsBucket }) => {
      try {
        const gcloudError = await checkGcloud();
        if (gcloudError) {
          return { content: [{ type: "text", text: gcloudError }], isError: true };
        }

        const args = ["firebase", "test", "android", "run",
          "--type", "instrumentation",
          "--app", appApk,
          "--test", testApk,
          "--timeout", timeout,
          "--format", "text",
        ];

        if (devices && devices.length > 0) {
          for (const spec of devices) {
            args.push("--device", spec);
          }
        }
        if (testTargets) {
          args.push("--test-targets", testTargets);
        }
        if (resultsBucket) {
          args.push("--results-bucket", resultsBucket);
        }

        ctx.logger.info(`Firebase Test Lab: gcloud ${args.join(" ")}`);

        const result = await execAsync("gcloud", args, 600000); // 10 min max
        let output = result.stdout;
        if (result.stderr) output += `\n--- STDERR ---\n${result.stderr}`;
        if (result.exitCode !== 0) output += `\n--- Exit code: ${result.exitCode} ---`;

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_farm_results",
    "Retrieve results from the most recent Firebase Test Lab run, or a specific test matrix ID. Shows pass/fail status, device results, and links to logs and artifacts.",
    {
      matrixId: z.string().optional().describe("Test matrix ID (from adb_farm_run output). Omit to list recent matrices."),
    },
    async ({ matrixId }) => {
      try {
        const gcloudError = await checkGcloud();
        if (gcloudError) {
          return { content: [{ type: "text", text: gcloudError }], isError: true };
        }

        if (matrixId) {
          const result = await execAsync("gcloud", [
            "firebase", "test", "android", "describe", matrixId,
            "--format", "text",
          ], 30000);

          let output = result.stdout;
          if (result.stderr) output += `\n--- STDERR ---\n${result.stderr}`;
          return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
        }

        // List recent test matrices
        const result = await execAsync("gcloud", [
          "firebase", "test", "android", "list",
          "--format", "table(testMatrixId,state,testExecutions.state,testExecutions.environment.androidDevice.androidModelId)",
          "--limit", "10",
          "--sort-by", "~createTime",
        ], 30000);

        let output = "=== Recent Test Matrices ===\n";
        output += result.stdout || "(none found)";
        if (result.stderr && !result.stdout) output += `\n${result.stderr}`;

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_farm_matrix",
    "List available device models and API levels on Firebase Test Lab. Use to plan test matrices.",
    {
      type: z.enum(["models", "versions"]).optional().default("models")
        .describe("List available device models or Android API versions"),
    },
    async ({ type }) => {
      try {
        const gcloudError = await checkGcloud();
        if (gcloudError) {
          return { content: [{ type: "text", text: gcloudError }], isError: true };
        }

        const subcommand = type === "versions" ? "versions" : "models";
        const formatFlag = type === "versions"
          ? "table(versionId,apiLevel,codeName,releaseDate.date())"
          : "table(modelId,name,manufacturer,supportedVersionIds)";

        const result = await execAsync("gcloud", [
          "firebase", "test", "android", subcommand, "list",
          "--format", formatFlag,
        ], 30000);

        let output = `=== Available ${type === "versions" ? "Android Versions" : "Device Models"} ===\n`;
        output += result.stdout || "(none found)";

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
