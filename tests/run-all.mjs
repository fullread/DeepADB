// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Run all DeepADB test suites sequentially.
 * Usage: node tests/run-all.mjs
 */
import { execFileSync } from "child_process";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Device-free suites — safe to run in CI without a connected device or
// emulator. They either touch no device at all (transports, supply-chain) or
// skip-guard their device-dependent assertions (boundaries, result-handles,
// sanitize-fuzz). Pass --ci to restrict the run to this set.
const CI_SAFE = new Set([
  "test-boundaries.mjs",
  "test-browser-access.mjs",
  "test-local-llm.mjs",
  "test-next-version.mjs",
  "test-result-handles.mjs",
  "test-sanitize-fuzz.mjs",
  "test-sdk-compat.mjs",
  "test-supply-chain.mjs",
  "test-transports.mjs",
  "test-audit-hardening.mjs",
  "test-code-scanning.mjs",
  "test-runtime-audit.mjs",
]);

const ciMode = process.argv.includes("--ci");
const suites = readdirSync(__dirname)
  .filter(f => f.startsWith("test-") && f.endsWith(".mjs"))
  .filter(f => !ciMode || CI_SAFE.has(f))
  .sort();

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║          DeepADB — Full Test Suite                 ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`\nMode: ${ciMode ? "CI (device-free suites only)" : "full"}`);
console.log(`Suites: ${suites.join(", ")}\n`);

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const results = [];

// Require one complete summary. Do not accept a progress message, a truncated
// count, or conflicting summaries as evidence that the suite finished.
function parseSummary(output) {
  const matches = [...output.matchAll(/^.*?:\s*(\d+) passed, (\d+) failed, (\d+) skipped(?: \((\d+) total\))?\s*$/gm)];
  if (matches.length !== 1) return null;
  const [, p, f, s, total] = matches[0];
  const values = [p, f, s].map(Number);
  if (!values.every(Number.isSafeInteger) || (total !== undefined && Number(total) !== values.reduce((a, b) => a + b))) return null;
  return values;
}

for (const suite of suites) {
  const suitePath = join(__dirname, suite);
  console.log(`\n${"▓".repeat(60)}`);
  console.log(`  Running: ${suite}`);
  console.log("▓".repeat(60));

  try {
    const output = execFileSync(process.execPath, [suitePath], {
      encoding: "utf-8",
      timeout: 300000, // 5 minutes per suite
      windowsHide: true,
    });
    console.log(output);

    // Parse results from output
    const match = parseSummary(output);
    if (match) {
      const [p, f, s] = match;
      totalPassed += p;
      totalFailed += f;
      totalSkipped += s;
      results.push({ suite, passed: p, failed: f, skipped: s, status: f > 0 ? "FAIL" : "PASS" });
    } else {
      results.push({ suite, passed: 0, failed: 0, skipped: 0, status: "UNKNOWN" });
    }
  } catch (err) {
    // execFileSync throws on non-zero exit code
    const output = err.stdout?.toString() ?? "";
    console.log(output);
    if (err.stderr) console.error(err.stderr.toString());

    const match = parseSummary(output);
    if (match) {
      const [p, f, s] = match;
      totalPassed += p;
      totalFailed += f;
      totalSkipped += s;
      results.push({ suite, passed: p, failed: f, skipped: s, status: "FAIL" });
    } else {
      totalFailed++;
      results.push({ suite, passed: 0, failed: 1, skipped: 0, status: "CRASH" });
    }
  }
}

// Final summary
console.log(`\n${"╔"}${"═".repeat(58)}${"╗"}`);
console.log(`${"║"}  FINAL RESULTS${" ".repeat(43)}${"║"}`);
console.log(`${"╠"}${"═".repeat(58)}${"╣"}`);
for (const r of results) {
  const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "?";
  const line = `  ${icon} ${r.suite}: ${r.passed} passed, ${r.failed} failed${r.skipped > 0 ? `, ${r.skipped} skipped` : ""}`;
  console.log(`${"║"}${line}${" ".repeat(Math.max(0, 58 - line.length))}${"║"}`);
}
console.log(`${"╠"}${"═".repeat(58)}${"╣"}`);
const totalLine = `  TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped (${totalPassed + totalFailed + totalSkipped} tests)`;
console.log(`${"║"}${totalLine}${" ".repeat(Math.max(0, 58 - totalLine.length))}${"║"}`);
console.log(`${"╚"}${"═".repeat(58)}${"╝"}`);

const unsuccessful = results.filter(r => r.status !== "PASS");
if (unsuccessful.length || !suites.length) {
  console.error(`Incomplete/failed suites: ${unsuccessful.map(r => `${r.suite} (${r.status})`).join(", ") || "no suites selected"}`);
}
process.exit(totalFailed > 0 || unsuccessful.length > 0 || !suites.length ? 1 : 0);
