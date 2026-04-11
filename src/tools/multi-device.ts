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

  /**
   * Predefined comparative test profiles.
   * Each profile is a set of shell commands with labels, grouped by category.
   * Commands must be safe, read-only operations suitable for automated execution.
   */
  const TEST_PROFILES: Record<string, { description: string; checks: { label: string; command: string }[] }> = {
    firmware: {
      description: "Compare firmware components across devices",
      checks: [
        { label: "Baseband version", command: "getprop gsm.version.baseband" },
        { label: "Bootloader", command: "getprop ro.bootloader" },
        { label: "Kernel version", command: "uname -r" },
        { label: "Security patch", command: "getprop ro.build.version.security_patch" },
        { label: "Android version", command: "getprop ro.build.version.release" },
        { label: "Build fingerprint", command: "getprop ro.build.fingerprint" },
        { label: "Build ID", command: "getprop ro.build.id" },
        { label: "Vendor security patch", command: "getprop ro.vendor.build.security_patch" },
      ],
    },
    security: {
      description: "Compare security configuration across devices",
      checks: [
        { label: "SELinux mode", command: "getenforce" },
        { label: "Verified boot state", command: "getprop ro.boot.verifiedbootstate" },
        { label: "Flash lock", command: "getprop ro.boot.flash.locked" },
        { label: "Secure boot", command: "getprop ro.boot.secure_boot" },
        { label: "Security patch", command: "getprop ro.build.version.security_patch" },
        { label: "Encryption state", command: "getprop ro.crypto.state" },
        { label: "DM-verity mode", command: "getprop ro.boot.veritymode" },
        { label: "Build type", command: "getprop ro.build.type" },
      ],
    },
    network: {
      description: "Compare network and radio state across devices",
      checks: [
        { label: "Network type", command: "getprop gsm.network.type" },
        { label: "Operator", command: "getprop gsm.operator.alpha" },
        { label: "SIM state", command: "getprop gsm.sim.state" },
        { label: "WiFi interface", command: "getprop wifi.interface" },
        { label: "Radio technology", command: "getprop ro.telephony.default_network" },
        { label: "Multisim config", command: "getprop persist.radio.multisim.config" },
      ],
    },
    identity: {
      description: "Compare device identity and hardware across devices",
      checks: [
        { label: "Model", command: "getprop ro.product.model" },
        { label: "Device codename", command: "getprop ro.product.device" },
        { label: "Chipset", command: "getprop ro.hardware.chipname" },
        { label: "Platform", command: "getprop ro.board.platform" },
        { label: "SOC model", command: "getprop ro.soc.model" },
        { label: "SDK version", command: "getprop ro.build.version.sdk" },
        { label: "Architecture", command: "getprop ro.product.cpu.abi" },
        { label: "RAM", command: "cat /proc/meminfo | head -1" },
      ],
    },
  };

  ctx.server.tool(
    "adb_multi_test",
    "Run a comparative test workflow across all connected devices (host + QEMU guests). Executes a predefined diagnostic profile or custom command list on every device in parallel, compares results per-check, and reports matches and differences. Profiles: 'firmware' (baseband, bootloader, kernel, security patch), 'security' (SELinux, verified boot, encryption), 'network' (radio, WiFi, SIM), 'identity' (model, chipset, architecture), 'full' (all profiles). Custom commands also supported.",
    {
      profile: z.enum(["firmware", "security", "network", "identity", "full"]).optional()
        .describe("Predefined test profile to run. 'full' runs all profiles."),
      commands: z.array(z.object({
        label: z.string().describe("Human-readable label for this check"),
        command: z.string().describe("Shell command to execute"),
      })).max(50).optional()
        .describe("Custom checks to run (max 50). Each has a label and command."),
      devices: z.array(z.string()).optional()
        .describe("Device serials to target (omit for all online devices)"),
      timeout: z.number().min(1000).max(60000).optional().default(10000)
        .describe("Timeout per command per device in ms (1s-60s, default 10s)"),
    },
    async ({ profile, commands, devices, timeout }) => {
      try {
        if (!profile && !commands) {
          // List available profiles
          const profileList = Object.entries(TEST_PROFILES)
            .map(([name, p]) => `  ${name}: ${p.description} (${p.checks.length} checks)`)
            .join("\n");
          return {
            content: [{
              type: "text",
              text: `Specify a profile or custom commands.\n\nAvailable profiles:\n${profileList}\n  full: Run all profiles combined\n\nExample: adb_multi_test profile="firmware"\nCustom: adb_multi_test commands=[{label: "Uptime", command: "uptime"}]`,
            }],
          };
        }

        // Build the check list
        let checks: { label: string; command: string }[] = [];
        if (profile === "full") {
          for (const p of Object.values(TEST_PROFILES)) {
            checks.push(...p.checks);
          }
        } else if (profile) {
          checks = TEST_PROFILES[profile].checks;
        }
        if (commands) {
          checks.push(...commands);
        }

        // Security check all commands
        for (const check of checks) {
          const blocked = ctx.security.checkCommand(check.command);
          if (blocked) {
            return { content: [{ type: "text", text: `Blocked command in check "${check.label}": ${blocked}` }], isError: true };
          }
        }

        // Resolve target devices
        const allDevices = await ctx.deviceManager.listDevices();
        const online = allDevices.filter((d) => d.state === "device");
        const targets = devices
          ? online.filter((d) => devices.includes(d.serial))
          : online;

        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No matching online devices found." }], isError: true };
        }

        const sections: string[] = [];
        const profileName = profile === "full" ? "Full Diagnostic" : profile ? TEST_PROFILES[profile].description : "Custom";
        sections.push(`=== Comparative Test: ${profileName} ===`);
        sections.push(`Devices: ${targets.map(d => d.model ? `${d.serial} (${d.model})` : d.serial).join(", ")}`);
        sections.push(`Checks: ${checks.length}`);

        let matches = 0;
        let differences = 0;
        let errors = 0;

        // Run each check across all devices
        for (const check of checks) {
          const results = await Promise.allSettled(
            targets.map(async (d) => {
              const result = await ctx.bridge.shell(check.command, {
                device: d.serial, timeout, ignoreExitCode: true,
              });
              return { serial: d.serial, model: d.model, output: result.stdout.trim() };
            })
          );

          const succeeded = results
            .filter((r) => r.status === "fulfilled")
            .map((r) => (r as PromiseFulfilledResult<{ serial: string; model?: string; output: string }>).value);

          const failed = results.filter((r) => r.status === "rejected");

          if (succeeded.length === 0) {
            sections.push(`\n✗ ${check.label}: All devices failed`);
            errors += targets.length;
            continue;
          }

          errors += failed.length;

          // Compare outputs
          const allSame = succeeded.length >= 2 && succeeded.every((r) => r.output === succeeded[0].output);

          if (allSame) {
            matches++;
            const value = succeeded[0].output || "(empty)";
            // Truncate long identical values
            const display = value.length > 120 ? value.substring(0, 120) + "..." : value;
            sections.push(`\n✓ ${check.label}: MATCH — ${display}`);
          } else if (succeeded.length === 1) {
            matches++;
            sections.push(`\n✓ ${check.label}: ${succeeded[0].output || "(empty)"}`);
          } else {
            differences++;
            sections.push(`\n✗ ${check.label}: DIFFERS`);
            for (const r of succeeded) {
              const label = r.model ? `${r.serial} (${r.model})` : r.serial;
              const value = r.output || "(empty)";
              const display = value.length > 200 ? value.substring(0, 200) + "..." : value;
              sections.push(`  ${label}: ${display}`);
            }
          }

          if (failed.length > 0) {
            for (let i = 0; i < results.length; i++) {
              if (results[i].status === "rejected") {
                const reason = (results[i] as PromiseRejectedResult).reason;
                const label = targets[i].model ? `${targets[i].serial} (${targets[i].model})` : targets[i].serial;
                sections.push(`  ${label}: Error — ${reason instanceof Error ? reason.message : reason}`);
              }
            }
          }
        }

        // Summary
        sections.push(`\n${"─".repeat(50)}`);
        sections.push(`Summary: ${checks.length} checks, ${matches} match${matches !== 1 ? "es" : ""}, ${differences} difference${differences !== 1 ? "s" : ""}, ${errors} error${errors !== 1 ? "s" : ""}`);
        if (differences === 0 && errors === 0 && targets.length >= 2) {
          sections.push("✓ All checks consistent across devices");
        } else if (differences > 0) {
          sections.push("⚠ Differences detected — review per-check details above");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
