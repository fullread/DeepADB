// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Run the informational emulator suite without hiding its exit status. */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Retain only the end of the output for parsing; the artifact retains it all.
const SUMMARY_TAIL_LIMIT = 256 * 1024;

export function parseTestSummary(output) {
  const start = output.lastIndexOf("FINAL RESULTS");
  if (start < 0) return null;
  const finalResults = output.slice(start);
  const match = finalResults.match(/TOTAL: (\d+) passed, (\d+) failed, (\d+) skipped \((\d+) tests\)/);
  if (!match) return null;
  const [passed, failed, skipped, total] = match.slice(1).map(Number);
  if (![passed, failed, skipped, total].every(Number.isSafeInteger)) return null;
  if (passed + failed + skipped !== total) return null;
  // run-all marks both missing suite summaries and crashes with a question mark.
  const unclassifiedSuites = [...finalResults.matchAll(/^\s*║?\s*\?\s+test-[^:\r\n]+:/gm)].length;
  // A suite can print zero failed assertions and still exit nonzero afterward.
  const failedSuites = [...finalResults.matchAll(/^\s*║?\s*✗\s+test-[^:\r\n]+:/gm)].length;
  return { passed, failed, skipped, total, unclassifiedSuites, failedSuites };
}

export function formatSummary(apiLevel, result) {
  const { commandExitCode, signal, startError, summary } = result;
  let status;
  if (startError) status = "The test command could not start.";
  else if (signal) status = "The test command was interrupted.";
  else if (commandExitCode === null) status = "Incomplete: the runner did not record a completed test process.";
  else if (!summary || summary.unclassifiedSuites > 0) status = "Incomplete: one or more test summaries are missing or invalid.";
  else if (commandExitCode !== 0 || summary.failed > 0 || summary.failedSuites > 0) status = "The test command reported failures.";
  else status = "Completed with no failed assertions.";

  const lines = [
    `## Emulator integration — API ${apiLevel}`,
    "",
    "**Informational, non-gating run.** A green workflow does not mean every assertion passed.",
    "",
    `**Result:** ${status}`,
    `**Test process:** ${startError ? "failed to start" : signal ? `terminated by ${signal}` : commandExitCode === null ? "exit status unavailable" : `exit ${commandExitCode}`}.`,
    "",
  ];
  if (summary) {
    lines.push("| Passed | Failed | Skipped | Total |", "| ---: | ---: | ---: | ---: |",
      `| ${summary.passed} | ${summary.failed} | ${summary.skipped} | ${summary.total} |`, "");
    if (summary.unclassifiedSuites > 0) {
      lines.push(`**Incomplete suite reports:** ${summary.unclassifiedSuites}. Aggregate counts alone are not a complete result.`, "");
    }
    if (summary.failedSuites > 0) {
      lines.push(`**Suites marked failed:** ${summary.failedSuites}. A suite execution failure may occur even when its assertion failure count is zero.`, "");
    }
  } else {
    lines.push("No valid final aggregate summary was found; counts are unknown, not zero.", "");
  }
  lines.push(
    "Stock emulators lack physical Pixel hardware, Magisk, a real modem, and some sensors. Those assertions may fail or skip; this does not classify every failure as expected.",
    "",
    "Inspect the uploaded emulator log to distinguish unsupported hardware checks from regressions.",
    "",
  );
  return lines.join("\n");
}

// This runs in a separate always() step, including when emulator boot fails.
export function publishReport({ apiLevel, logPath, reportPath, summaryPath }) {
  if (!existsSync(reportPath)) {
    if (!existsSync(logPath)) writeFileSync(logPath, "No test log was produced. The emulator or test runner may not have started.\n");
    const summary = parseTestSummary(readFileSync(logPath, "utf8").slice(-SUMMARY_TAIL_LIMIT));
    writeFileSync(reportPath, formatSummary(apiLevel, { commandExitCode: null, signal: null, summary }));
  }
  const report = readFileSync(reportPath, "utf8");
  if (summaryPath) appendFileSync(summaryPath, report);
  else process.stdout.write(report);
  return report;
}

export async function runEmulatorTests({
  apiLevel,
  logPath,
  summaryPath,
  command = "npm",
  args = ["test"],
  stdout = process.stdout,
  stderr = process.stderr,
  spawnChild = spawn,
  forwardSignals = false,
}) {
  const log = openSync(logPath, "w");
  let tail = "";
  let outputError;
  const signalHandlers = new Map();
  let child;
  const capture = (destination, data) => {
    try {
      writeSync(log, data);
      destination.write(data);
      tail = (tail + data).slice(-SUMMARY_TAIL_LIMIT);
    } catch (error) {
      outputError = error;
      child?.kill("SIGTERM");
    }
  };

  let commandResult;
  try {
    if (summaryPath) {
      // Replace any prior run's report before launching; an interrupted rerun
      // must never publish stale success from an earlier invocation.
      writeFileSync(summaryPath, formatSummary(apiLevel, { commandExitCode: null, signal: null, summary: null }));
    }
    commandResult = await new Promise(resolveResult => {
      let startError;
      try {
        child = spawnChild(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        resolveResult({ commandExitCode: null, signal: null, startError: error });
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", data => capture(stdout, data));
      child.stderr.on("data", data => capture(stderr, data));
      child.on("error", error => { startError = error; });
      child.on("close", (commandExitCode, signal) => resolveResult({ commandExitCode, signal, startError }));
      if (forwardSignals) {
        for (const signal of ["SIGINT", "SIGTERM"]) {
          const handler = () => child.kill(signal);
          signalHandlers.set(signal, handler);
          process.on(signal, handler);
        }
      }
    });
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    closeSync(log);
  }

  if (outputError) throw outputError;
  const summary = parseTestSummary(tail);
  const { commandExitCode, signal, startError } = commandResult;
  const exitCode = signal ? 128 + (constants.signals[signal] ?? 0)
    : startError ? 1
    : commandExitCode !== 0 ? (commandExitCode ?? 1)
    : !summary || summary.unclassifiedSuites > 0 || summary.failedSuites > 0 || summary.failed > 0 ? 1 : 0;
  const result = { ...commandResult, summary, exitCode };
  if (summaryPath) writeFileSync(summaryPath, formatSummary(apiLevel, result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reporting = process.argv[2] === "--report";
  const apiLevel = process.argv[reporting ? 3 : 2];
  if (!/^\d+$/.test(apiLevel ?? "")) {
    console.error("Usage: node .github/scripts/run-emulator-tests.mjs [--report] <Android API level>");
    process.exitCode = 1;
  } else {
    try {
      const logPath = `emulator-api${apiLevel}.log`;
      const reportPath = `emulator-api${apiLevel}-summary.md`;
      if (reporting) {
        publishReport({ apiLevel, logPath, reportPath, summaryPath: process.env.GITHUB_STEP_SUMMARY });
      } else {
        const result = await runEmulatorTests({ apiLevel, logPath, summaryPath: reportPath, forwardSignals: true });
        process.exitCode = result.exitCode;
      }
    } catch (error) {
      console.error(`Emulator reporting failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
