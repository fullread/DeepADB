/**
 * Run all DeepADB test suites sequentially.
 * Usage: node tests/run-all.mjs
 */
import { execFileSync } from "child_process";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = readdirSync(__dirname)
  .filter(f => f.startsWith("test-") && f.endsWith(".mjs"))
  .sort();

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║          DeepADB — Full Test Suite                 ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`\nSuites: ${suites.join(", ")}\n`);

let totalPassed = 0;
let totalFailed = 0;
const results = [];

for (const suite of suites) {
  const suitePath = join(__dirname, suite);
  console.log(`\n${"▓".repeat(60)}`);
  console.log(`  Running: ${suite}`);
  console.log("▓".repeat(60));

  try {
    const output = execFileSync("node", [suitePath], {
      encoding: "utf-8",
      timeout: 300000, // 5 minutes per suite
      windowsHide: true,
    });
    console.log(output);

    // Parse results from output
    const match = output.match(/(\d+) passed, (\d+) failed/);
    if (match) {
      const p = parseInt(match[1], 10);
      const f = parseInt(match[2], 10);
      totalPassed += p;
      totalFailed += f;
      results.push({ suite, passed: p, failed: f, status: f > 0 ? "FAIL" : "PASS" });
    } else {
      results.push({ suite, passed: 0, failed: 0, status: "UNKNOWN" });
    }
  } catch (err) {
    // execFileSync throws on non-zero exit code
    const output = err.stdout?.toString() ?? "";
    console.log(output);
    if (err.stderr) console.error(err.stderr.toString());

    const match = output.match(/(\d+) passed, (\d+) failed/);
    if (match) {
      const p = parseInt(match[1], 10);
      const f = parseInt(match[2], 10);
      totalPassed += p;
      totalFailed += f;
      results.push({ suite, passed: p, failed: f, status: "FAIL" });
    } else {
      totalFailed++;
      results.push({ suite, passed: 0, failed: 1, status: "CRASH" });
    }
  }
}

// Final summary
console.log(`\n${"╔"}${"═".repeat(58)}${"╗"}`);
console.log(`${"║"}  FINAL RESULTS${" ".repeat(43)}${"║"}`);
console.log(`${"╠"}${"═".repeat(58)}${"╣"}`);
for (const r of results) {
  const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "?";
  const line = `  ${icon} ${r.suite}: ${r.passed} passed, ${r.failed} failed`;
  console.log(`${"║"}${line}${" ".repeat(Math.max(0, 58 - line.length))}${"║"}`);
}
console.log(`${"╠"}${"═".repeat(58)}${"╣"}`);
const totalLine = `  TOTAL: ${totalPassed} passed, ${totalFailed} failed (${totalPassed + totalFailed} tests)`;
console.log(`${"║"}${totalLine}${" ".repeat(Math.max(0, 58 - totalLine.length))}${"║"}`);
console.log(`${"╚"}${"═".repeat(58)}${"╝"}`);

process.exit(totalFailed > 0 ? 1 : 0);
