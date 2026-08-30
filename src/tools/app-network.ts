// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-app network route context.
 *
 * Android routes traffic by UID through ip rules and network-policy state.
 * This module resolves an installed package to its UID, then correlates that
 * UID with the device's routing tables without changing any network state.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellQuote } from "../middleware/sanitize.js";

const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const ROUTE_TABLE_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

/** Resolve an Android package UID from dumpsys/cmd package output. */
export function parsePackageUid(output: string, packageName?: string): number | null {
  const direct = output.match(/\b(?:userId|uid)=(\d+)\b/);
  if (direct) return Number.parseInt(direct[1]!, 10);

  for (const line of output.split(/\r?\n/)) {
    if (packageName && !line.includes(`package:${packageName}`)) continue;
    const listed = line.match(/\buid:(\d+)\b/);
    if (listed) return Number.parseInt(listed[1]!, 10);
  }
  return null;
}

/** Return true when an ip-rule line contains a uidrange covering the UID. */
export function uidMatchesRule(line: string, uid: number): boolean {
  for (const match of line.matchAll(/\buidrange\s+(\d+)-(\d+)\b/g)) {
    const start = Number.parseInt(match[1]!, 10);
    const end = Number.parseInt(match[2]!, 10);
    if (uid >= start && uid <= end) return true;
  }
  return false;
}

/** Extract safe, deduplicated route-table names from matched ip rules. */
export function extractRouteTables(lines: string[]): string[] {
  const tables = new Set<string>();
  for (const line of lines) {
    const match = line.match(/\b(?:lookup|table)\s+([^\s]+)/);
    if (match && ROUTE_TABLE_PATTERN.test(match[1]!)) tables.add(match[1]!);
  }
  return [...tables];
}

function policyLinesForUid(output: string, uid: number): string[] {
  const uidToken = new RegExp(`(^|\\D)${uid}(\\D|$)`);
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => uidToken.test(line));
}

function summarizeConnectivity(output: string): string[] {
  const summary: string[] = [];
  const defaultNetwork = output.match(/defaultNetwork\s*[=:]\s*(\d+)/i)
    ?? output.match(/NetworkAgentInfo\{[^}]*\[?([0-9]+)\]?[^}]*VALIDATED/i);
  summary.push(`Default network: ${defaultNetwork?.[1] ?? "not identified"}`);
  summary.push(`VPN present: ${/\bVPN\b|TRANSPORT_VPN/i.test(output) ? "yes" : "no"}`);
  summary.push(`Validated network present: ${/\bVALIDATED\b/.test(output) ? "yes" : "no"}`);
  summary.push(`Private DNS active: ${/privateDns.*(?:active|validated|true)/i.test(output) ? "yes" : "not reported"}`);
  return summary;
}

export function registerAppNetworkTools(ctx: ToolContext): void {
  ctx.server.tool(
    "adb_app_route_context",
    "Show the effective Android routing context for one installed app by correlating its UID with ip rules, route tables, network policy, VPN, and default-network state. Read-only; does not alter routes or app policy.",
    {
      packageName: z.string().regex(PACKAGE_NAME_PATTERN).describe("Installed Android package to inspect"),
      includeConnectivitySummary: z.boolean().optional().default(true)
        .describe("Include a privacy-conscious connectivity/VPN/default-network summary"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, includeConnectivitySummary, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const packageDump = await ctx.bridge.shell(`dumpsys package ${shellQuote(packageName)}`, {
          device: serial,
          timeout: 15000,
          ignoreExitCode: true,
        });
        let uid = parsePackageUid(packageDump.stdout, packageName);
        if (uid === null) {
          const listed = await ctx.bridge.shell(`cmd package list packages -U ${shellQuote(packageName)}`, {
            device: serial,
            timeout: 10000,
            ignoreExitCode: true,
          });
          uid = parsePackageUid(listed.stdout, packageName);
        }
        if (uid === null) {
          return { content: [{ type: "text", text: `Package is not installed or its UID could not be resolved: ${packageName}` }], isError: true };
        }

        const [rules, routes4, routes6, policy, connectivity] = await Promise.all([
          ctx.bridge.shell("ip rule show", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("ip route show", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("ip -6 route show", { device: serial, timeout: 10000, ignoreExitCode: true }),
          ctx.bridge.shell("cmd netpolicy list uid-policy", { device: serial, timeout: 10000, ignoreExitCode: true }),
          includeConnectivitySummary
            ? ctx.bridge.shell("dumpsys connectivity", { device: serial, timeout: 20000, ignoreExitCode: true })
            : Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false, bufferExceeded: false }),
        ]);

        const matchedRules = rules.stdout.split(/\r?\n/).map((line) => line.trim())
          .filter((line) => uidMatchesRule(line, uid!));
        const tableNames = extractRouteTables(matchedRules);
        const tableResults = await Promise.all(tableNames.map(async (table) => {
          // table came from device output, so re-validate before shell reuse.
          if (!ROUTE_TABLE_PATTERN.test(table)) return `${table}: rejected unsafe table name`;
          const result = await ctx.bridge.shell(`ip route show table ${shellQuote(table)}`, {
            device: serial,
            timeout: 10000,
            ignoreExitCode: true,
          });
          return `${table}:\n${result.stdout.trim() || "  (empty or unavailable)"}`;
        }));

        const sections = [
          "=== Per-App Route Context ===",
          `Package: ${packageName}`,
          `UID: ${uid}`,
          `INTERNET permission: ${/android\.permission\.INTERNET/.test(packageDump.stdout) ? "declared/granted" : "not reported"}`,
          "",
          "── Matching UID rules ──",
          matchedRules.length ? matchedRules.join("\n") : "(no explicit uidrange rule; system defaults may apply)",
          "",
          "── Referenced route tables ──",
          tableResults.length ? tableResults.join("\n\n") : "(none referenced by matching UID rules)",
          "",
          "── Default IPv4 routes ──",
          routes4.stdout.split(/\r?\n/).filter((line) => /^default\b/.test(line.trim())).join("\n") || "(none reported)",
          "",
          "── Default IPv6 routes ──",
          routes6.stdout.split(/\r?\n/).filter((line) => /^default\b/.test(line.trim())).join("\n") || "(none reported)",
          "",
          "── UID network policy ──",
          policyLinesForUid(policy.stdout, uid).join("\n") || "(no explicit UID policy)",
        ];
        if (includeConnectivitySummary) {
          sections.push("", "── Connectivity summary ──", ...summarizeConnectivity(connectivity.stdout));
        }

        return { content: [{ type: "text", text: OutputProcessor.process(sections.join("\n"), 40000) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    },
  );
}
