/**
 * SELinux & Permission Auditing — OS-level security inspection.
 *
 * Inspects SELinux enforcement mode, queries policy denials from
 * kernel audit logs, and audits runtime permission grants against
 * actual usage to detect over-provisioning.
 *
 * Extends the existing accessibility and security auditing capabilities
 * to the Android OS permission layer. Useful for security hardening,
 * compliance checks, and understanding app permission behavior.
 *
 * Root access recommended for full audit log access; basic SELinux
 * mode and permission grant queries work without root.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { validateShellArg } from "../middleware/sanitize.js";

interface PermissionGrant {
  permission: string;
  granted: boolean;
  flags: string;
}

function parsePermissions(dumpsysOutput: string): PermissionGrant[] {
  const grants: PermissionGrant[] = [];
  const lines = dumpsysOutput.split("\n");

  for (const line of lines) {
    // Format: "android.permission.CAMERA: granted=true, flags=[ USER_SET ]"
    // or "android.permission.CAMERA granted=true"
    const match = line.match(/(android\.permission\.\S+)[:\s]+granted=(\w+)(?:.*flags=\[([^\]]*)\])?/);
    if (match) {
      grants.push({
        permission: match[1],
        granted: match[2] === "true",
        flags: match[3]?.trim() ?? "",
      });
    }
  }
  return grants;
}

/** Well-known dangerous permissions grouped by category. */
const DANGEROUS_PERMISSION_GROUPS: Record<string, string[]> = {
  "Camera": ["android.permission.CAMERA"],
  "Microphone": ["android.permission.RECORD_AUDIO"],
  "Location": [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
  ],
  "Storage": [
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_MEDIA_AUDIO",
    "android.permission.MANAGE_EXTERNAL_STORAGE",
  ],
  "Contacts": [
    "android.permission.READ_CONTACTS",
    "android.permission.WRITE_CONTACTS",
    "android.permission.GET_ACCOUNTS",
  ],
  "Phone": [
    "android.permission.READ_PHONE_STATE",
    "android.permission.READ_PHONE_NUMBERS",
    "android.permission.CALL_PHONE",
    "android.permission.READ_CALL_LOG",
    "android.permission.WRITE_CALL_LOG",
  ],
  "SMS": [
    "android.permission.SEND_SMS",
    "android.permission.RECEIVE_SMS",
    "android.permission.READ_SMS",
  ],
  "Calendar": [
    "android.permission.READ_CALENDAR",
    "android.permission.WRITE_CALENDAR",
  ],
  "Body Sensors": [
    "android.permission.BODY_SENSORS",
    "android.permission.BODY_SENSORS_BACKGROUND",
  ],
  "Nearby Devices": [
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_ADVERTISE",
    "android.permission.NEARBY_WIFI_DEVICES",
    "android.permission.UWB_RANGING",
  ],
  "Notifications": ["android.permission.POST_NOTIFICATIONS"],
};

export function registerSelinuxAuditTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_selinux_status",
    "Check SELinux enforcement mode, policy version, and recent denial count. Shows whether the device is in Enforcing, Permissive, or Disabled mode. Root access provides additional policy details from dmesg audit logs.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        const sections: string[] = [];
        sections.push("=== SELinux Status ===");

        // Get SELinux mode via getenforce
        const enforceResult = await ctx.bridge.shell("getenforce", {
          device: serial, ignoreExitCode: true,
        });
        const mode = enforceResult.stdout.trim() || "unknown";
        sections.push(`Mode: ${mode}`);

        // Get SELinux context of the shell
        const contextResult = await ctx.bridge.shell("id -Z 2>/dev/null || echo 'unavailable'", {
          device: serial, ignoreExitCode: true,
        });
        const context = contextResult.stdout.trim();
        if (context && context !== "unavailable") {
          sections.push(`Shell context: ${context}`);
        }

        // SELinux-related properties
        const props = await ctx.deviceManager.getDeviceProps(serial);
        const selinuxProps = [
          "ro.build.selinux",
          "ro.boot.selinux",
          "selinux.reload_policy",
        ];
        for (const prop of selinuxProps) {
          const val = props[prop];
          if (val) sections.push(`${prop}: ${val}`);
        }

        // Try to get policy version and stats
        const policyResult = await ctx.bridge.shell(
          "cat /sys/fs/selinux/policyvers 2>/dev/null && echo '---' && cat /sys/fs/selinux/status 2>/dev/null",
          { device: serial, ignoreExitCode: true }
        );
        if (policyResult.stdout.includes("---")) {
          const parts = policyResult.stdout.split("---");
          const policyVer = parts[0].trim();
          if (policyVer) sections.push(`Policy version: ${policyVer}`);
        }

        // Count recent denials from logcat (doesn't require root)
        const denialResult = await ctx.bridge.shell(
          "logcat -d -b events -t 500 | grep -c 'avc.*denied' 2>/dev/null || echo 0",
          { device: serial, ignoreExitCode: true }
        );
        const denialCount = parseInt(denialResult.stdout.trim(), 10) || 0;
        sections.push(`\nRecent AVC denials (last 500 events): ${denialCount}`);

        // Try root access for dmesg denials
        let hasRoot = false;
        try {
          const rootResult = await ctx.bridge.shell("su -c 'dmesg | grep -c avc 2>/dev/null || echo 0'", {
            device: serial, timeout: 5000, ignoreExitCode: true,
          });
          if (rootResult.stdout.trim() && !rootResult.stdout.includes("Permission denied")) {
            hasRoot = true;
            const dmesgDenials = parseInt(rootResult.stdout.trim(), 10) || 0;
            sections.push(`Kernel AVC denials (dmesg): ${dmesgDenials}`);
          }
        } catch { /* no root */ }

        if (!hasRoot) {
          sections.push("\nNote: Root access provides additional kernel audit log details.");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_selinux_denials",
    "List recent SELinux AVC denial messages from logcat and kernel logs. Shows which processes were blocked, what they tried to do, and the SELinux contexts involved. Useful for diagnosing permission issues and understanding security policy enforcement.",
    {
      lines: z.number().min(1).max(1000).optional().default(50).describe("Max denial entries to return (1-1000, default 50)"),
      process: z.string().optional().describe("Filter denials by process/source context name"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ lines, process: processFilter, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        if (processFilter) {
          const filterErr = validateShellArg(processFilter, "process");
          if (filterErr) return { content: [{ type: "text", text: filterErr }], isError: true };
        }

        const maxLines = Math.min(lines, 500);
        const sections: string[] = [];
        sections.push("=== SELinux AVC Denials ===\n");

        // Logcat denials
        const grepFilter = processFilter ? ` | grep -iF '${processFilter}'` : "";
        const logcatResult = await ctx.bridge.shell(
          `logcat -d -b events,main -t 2000 | grep 'avc.*denied'${grepFilter} | tail -${maxLines}`,
          { device: serial, timeout: 15000, ignoreExitCode: true }
        );

        const logcatDenials = logcatResult.stdout.trim().split("\n").filter((l) => l.trim().length > 0);

        if (logcatDenials.length > 0) {
          sections.push(`Logcat denials (${logcatDenials.length}):\n`);
          for (const denial of logcatDenials) {
            // Parse the AVC denial for readable output
            const scontextMatch = denial.match(/scontext=(\S+)/);
            const tcontextMatch = denial.match(/tcontext=(\S+)/);
            const tclassMatch = denial.match(/tclass=(\S+)/);
            const permMatch = denial.match(/\{\s*([^}]+)\s*\}/);

            if (scontextMatch && tcontextMatch) {
              const source = scontextMatch[1];
              const target = tcontextMatch[1];
              const tclass = tclassMatch ? tclassMatch[1] : "?";
              const perms = permMatch ? permMatch[1].trim() : "?";
              sections.push(`  ${perms} [${tclass}] ${source} → ${target}`);
            } else {
              // Raw line if parsing fails
              sections.push(`  ${denial.substring(0, 200)}`);
            }
          }
        } else {
          sections.push("No AVC denials found in logcat.");
        }

        // Try dmesg for kernel-level denials (root)
        try {
          const dmesgGrepFilter = processFilter ? ` | grep -iF "${processFilter}"` : "";
          const dmesgResult = await ctx.bridge.shell(
            `su -c 'dmesg | grep "avc.*denied"${dmesgGrepFilter} | tail -20'`,
            { device: serial, timeout: 10000, ignoreExitCode: true }
          );
          const dmesgDenials = dmesgResult.stdout.trim().split("\n").filter((l) => l.includes("avc"));
          if (dmesgDenials.length > 0) {
            sections.push(`\nKernel denials (${dmesgDenials.length}):\n`);
            for (const d of dmesgDenials.slice(0, 20)) {
              sections.push(`  ${d.substring(0, 200)}`);
            }
          }
        } catch { /* no root — skip silently */ }

        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n")) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_permission_audit",
    "Audit runtime permission grants for a package. Lists all granted dangerous permissions grouped by category (Camera, Location, Phone, SMS, etc.) and flags potentially over-provisioned permissions. Compares grants against the dangerous permission manifest to identify unnecessary access.",
    {
      packageName: z.string().describe("Package name to audit (e.g., 'com.example.app')"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, device }) => {
      try {
        const pkgErr = validateShellArg(packageName, "packageName");
        if (pkgErr) return { content: [{ type: "text", text: pkgErr }], isError: true };

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Get permission state from dumpsys
        const dumpResult = await ctx.bridge.shell(
          `dumpsys package ${packageName} | grep -A 200 'runtime permissions'`,
          { device: serial, timeout: 15000, ignoreExitCode: true }
        );

        if (!dumpResult.stdout || dumpResult.stdout.trim().length === 0) {
          return { content: [{ type: "text", text: `Package "${packageName}" not found or has no runtime permissions section.` }], isError: true };
        }

        const grants = parsePermissions(dumpResult.stdout);

        // Also get requested permissions from the manifest
        const requestedResult = await ctx.bridge.shell(
          `dumpsys package ${packageName} | grep -A 500 'requested permissions:' | grep 'android.permission' | head -100`,
          { device: serial, timeout: 10000, ignoreExitCode: true }
        );
        const requestedPerms = requestedResult.stdout.split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("android.permission."));

        const sections: string[] = [];
        sections.push(`=== Permission Audit: ${packageName} ===\n`);

        const granted = grants.filter((g) => g.granted);
        const denied = grants.filter((g) => !g.granted);

        sections.push(`Runtime permissions: ${grants.length} total, ${granted.length} granted, ${denied.length} denied`);
        if (requestedPerms.length > 0) {
          sections.push(`Manifest-requested permissions: ${requestedPerms.length}`);
        }

        // Group granted permissions by category
        sections.push(`\n--- Granted Dangerous Permissions ---`);
        let dangerousGrantedCount = 0;

        for (const [category, perms] of Object.entries(DANGEROUS_PERMISSION_GROUPS)) {
          const grantedInCategory = granted.filter((g) => perms.includes(g.permission));
          if (grantedInCategory.length > 0) {
            dangerousGrantedCount += grantedInCategory.length;
            sections.push(`\n[${category}]`);
            for (const g of grantedInCategory) {
              const flags = g.flags ? ` (${g.flags})` : "";
              sections.push(`  ✓ ${g.permission}${flags}`);
            }
          }
        }

        // Show non-categorized grants
        const allDangerousPerms = Object.values(DANGEROUS_PERMISSION_GROUPS).flat();
        const uncategorizedGrants = granted.filter((g) => !allDangerousPerms.includes(g.permission));
        if (uncategorizedGrants.length > 0) {
          sections.push(`\n[Other Granted]`);
          for (const g of uncategorizedGrants) {
            sections.push(`  ✓ ${g.permission}`);
          }
        }

        if (dangerousGrantedCount === 0 && uncategorizedGrants.length === 0) {
          sections.push("  (none)");
        }

        // Denied permissions
        if (denied.length > 0) {
          sections.push(`\n--- Denied Permissions (${denied.length}) ---`);
          for (const d of denied) {
            sections.push(`  ✗ ${d.permission}`);
          }
        }

        // Over-provisioning analysis
        sections.push(`\n--- Analysis ---`);
        sections.push(`Dangerous permissions granted: ${dangerousGrantedCount}`);

        const highRisk = granted.filter((g) =>
          g.permission.includes("BACKGROUND_LOCATION") ||
          g.permission.includes("MANAGE_EXTERNAL_STORAGE") ||
          g.permission.includes("BODY_SENSORS_BACKGROUND") ||
          g.permission.includes("READ_CALL_LOG") ||
          g.permission.includes("READ_SMS")
        );
        if (highRisk.length > 0) {
          sections.push(`\nHigh-sensitivity permissions granted:`);
          for (const hr of highRisk) {
            sections.push(`  ⚠ ${hr.permission}`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
