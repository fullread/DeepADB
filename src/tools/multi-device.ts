/**
 * Multi-Device Orchestration Tools — Run commands across multiple devices simultaneously.
 * 
 * Useful for comparative testing across different Android versions and device models,
 * fleet management, or parallel deployment.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

export function registerMultiDeviceTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_multi_shell",
    "Execute a shell command on multiple (or all) connected devices in parallel. Returns results grouped by device.",
    {
      command: z.string().describe("Shell command to execute on each device"),
      devices: z.array(z.string()).optional().describe("Device serials to target (omit for all online devices)"),
      timeout: z.number().min(1000).max(600000).optional().describe("Timeout per device in milliseconds (1s-10min)"),
    },
    async ({ command, devices, timeout }) => {
      try {
        // Security check — same as adb_shell
        const blocked = ctx.security.checkCommand(command);
        if (blocked) {
          return { content: [{ type: "text", text: blocked }], isError: true };
        }

        const allDevices = await ctx.deviceManager.listDevices();
        const online = allDevices.filter((d) => d.state === "device");
        const targets = devices
          ? online.filter((d) => devices.includes(d.serial))
          : online;

        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No matching online devices found." }], isError: true };
        }

        const results = await Promise.allSettled(
          targets.map(async (d) => {
            const result = await ctx.bridge.shell(command, {
              device: d.serial, timeout, ignoreExitCode: true,
            });
            return { serial: d.serial, model: d.model, result };
          })
        );

        const output = results.map((r, i) => {
          const device = targets[i];
          const label = device.model ? `${device.serial} (${device.model})` : device.serial;
          if (r.status === "fulfilled") {
            const out = r.value.result.stdout.trim() || "(no output)";
            return `=== ${label} ===\n${out}`;
          }
          const reason = (r as PromiseRejectedResult).reason;
          return `=== ${label} ===\nError: ${reason instanceof Error ? reason.message : reason}`;
        }).join("\n\n");

        return { content: [{ type: "text", text: `Ran on ${targets.length} device(s):\n\n${OutputProcessor.process(output)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_multi_install",
    "Install an APK on multiple (or all) connected devices in parallel.",
    {
      apkPath: z.string().describe("Local filesystem path to the APK file"),
      devices: z.array(z.string()).optional().describe("Device serials (omit for all online devices)"),
      replace: z.boolean().optional().default(true).describe("Replace existing app (-r)"),
    },
    async ({ apkPath, devices, replace }) => {
      try {
        const allDevices = await ctx.deviceManager.listDevices();
        const online = allDevices.filter((d) => d.state === "device");
        const targets = devices
          ? online.filter((d) => devices.includes(d.serial))
          : online;

        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No matching online devices found." }], isError: true };
        }

        const args = ["install"];
        if (replace) args.push("-r");
        args.push(apkPath);

        const results = await Promise.allSettled(
          targets.map(async (d) => {
            const result = await ctx.bridge.exec(args, { device: d.serial, timeout: 120000 });
            return { serial: d.serial, model: d.model, stdout: result.stdout.trim() };
          })
        );

        const output = results.map((r, i) => {
          const device = targets[i];
          const label = device.model ? `${device.serial} (${device.model})` : device.serial;
          if (r.status === "fulfilled") {
            return `${label}: ${r.value.stdout || "Success"}`;
          }
          const reason = (r as PromiseRejectedResult).reason;
          return `${label}: FAILED — ${reason instanceof Error ? reason.message : reason}`;
        }).join("\n");

        return { content: [{ type: "text", text: `Install results (${targets.length} devices):\n\n${output}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_multi_compare",
    "Run a command on all devices and compare outputs side by side. Highlights differences across devices.",
    {
      command: z.string().describe("Shell command to compare across devices"),
      devices: z.array(z.string()).optional().describe("Device serials (omit for all online devices)"),
    },
    async ({ command, devices }) => {
      try {
        // Security check — same as adb_shell and adb_multi_shell
        const blocked = ctx.security.checkCommand(command);
        if (blocked) {
          return { content: [{ type: "text", text: blocked }], isError: true };
        }

        const allDevices = await ctx.deviceManager.listDevices();
        const online = allDevices.filter((d) => d.state === "device");
        const targets = devices
          ? online.filter((d) => devices.includes(d.serial))
          : online;

        if (targets.length < 2) {
          return { content: [{ type: "text", text: "Need at least 2 online devices to compare." }], isError: true };
        }

        const results = await Promise.allSettled(
          targets.map(async (d) => {
            const result = await ctx.bridge.shell(command, {
              device: d.serial, ignoreExitCode: true,
            });
            return { serial: d.serial, model: d.model, output: result.stdout.trim() };
          })
        );

        const succeeded = results
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<{ serial: string; model?: string; output: string }>).value);

        if (succeeded.length < 2) {
          return { content: [{ type: "text", text: "Fewer than 2 devices returned results." }], isError: true };
        }

        // Check if all outputs are identical
        const allSame = succeeded.every((r) => r.output === succeeded[0].output);

        let output: string;
        if (allSame) {
          output = `All ${succeeded.length} devices returned identical output:\n\n${succeeded[0].output}`;
        } else {
          output = `DIFFERENCES DETECTED across ${succeeded.length} devices:\n\n`;
          output += succeeded.map((r) => {
            const label = r.model ? `${r.serial} (${r.model})` : r.serial;
            return `=== ${label} ===\n${r.output || "(empty)"}`;
          }).join("\n\n");
        }

        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
