// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Device-free tests for the informational CI runner; never starts npm or ADB. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { formatSummary, parseTestSummary, publishReport, runEmulatorTests } from "../../.github/scripts/run-emulator-tests.mjs";

const report = (passed = 2, failed = 0, skipped = 1, rows = "") =>
  `FINAL RESULTS\n${rows}\n║  TOTAL: ${passed} passed, ${failed} failed, ${skipped} skipped (${passed + failed + skipped} tests) ║\n`;

function fixture(t) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, "deepadb-emulator-reporting-"));
  t.after(() => {
    // Delete only the isolated directory created by this fixture.
    assert.equal(dirname(directory), root);
    assert.ok(basename(directory).startsWith("deepadb-emulator-reporting-"));
    rmSync(directory, { recursive: true, force: true });
  });
  let streamed = "";
  const output = { write: data => { streamed += data; } };
  return {
    options: {
      apiLevel: "35",
      logPath: join(directory, "emulator.log"),
      summaryPath: join(directory, "summary.md"),
      stdout: output,
      stderr: output,
    },
    streamed: () => streamed,
  };
}

function mockedChild({ chunks = [], code = 0, signal = null, error } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      for (const [stream, text] of chunks) child[stream].write(text);
      child.stdout.end();
      child.stderr.end();
      if (error) child.emit("error", error);
      child.emit("close", code, signal);
    });
    return child;
  };
}

test("parses only the final aggregate, not per-suite counts", () => {
  assert.deepEqual(parseTestSummary(`99 passed, 5 failed, 1 skipped\n${report()}`), {
    passed: 2, failed: 0, skipped: 1, total: 3, unclassifiedSuites: 0, failedSuites: 0,
  });
  assert.equal(parseTestSummary("2 passed, 0 failed, 1 skipped"), null);
  assert.equal(parseTestSummary("FINAL RESULTS\nTOTAL: 2 passed, 0 failed, 1 skipped (99 tests)"), null);
});

test("streams both outputs to the console and artifact and reports successful counts", async t => {
  const fixtureData = fixture(t);
  const text = report();
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({
    chunks: [["stdout", "Starting tests\n"], ["stderr", "A diagnostic\n"], ["stdout", text.slice(0, 20)], ["stdout", text.slice(20)]],
  }) });
  assert.equal(result.exitCode, 0);
  assert.equal(fixtureData.streamed(), `Starting tests\nA diagnostic\n${text}`);
  assert.equal(readFileSync(fixtureData.options.logPath, "utf8"), fixtureData.streamed());
  const summary = readFileSync(fixtureData.options.summaryPath, "utf8");
  assert.match(summary, /Completed with no failed assertions/);
  assert.match(summary, /\| 2 \| 0 \| 1 \| 3 \|/);
  assert.match(summary, /does not classify every failure as expected/);
});

test("preserves the real child exit code instead of the logging outcome", async t => {
  const fixtureData = fixture(t);
  const text = report(2, 1, 0);
  const result = await runEmulatorTests({
    ...fixtureData.options,
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(text)}); process.stderr.write('failure detail\\n'); process.exitCode = 7;`],
  });
  assert.equal(result.commandExitCode, 7);
  assert.equal(result.exitCode, 7);
  assert.match(readFileSync(fixtureData.options.logPath, "utf8"), /failure detail/);
  assert.match(readFileSync(fixtureData.options.summaryPath, "utf8"), /Test process:\*\* exit 7/);
});

test("reports signaled child termination without inventing counts", async t => {
  const fixtureData = fixture(t);
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({
    chunks: [["stderr", "Interrupted during a suite\n"]], code: null, signal: "SIGTERM",
  }) });
  assert.equal(result.exitCode, 128 + constants.signals.SIGTERM);
  assert.equal(result.summary, null);
  const summary = readFileSync(fixtureData.options.summaryPath, "utf8");
  assert.match(summary, /terminated by SIGTERM/);
  assert.match(summary, /counts are unknown, not zero/);
});

test("reports a command-start error and retains a log artifact", async t => {
  const fixtureData = fixture(t);
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({
    code: null, error: new Error("Simulated unavailable executable"),
  }) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.commandExitCode, null);
  assert.equal(readFileSync(fixtureData.options.logPath, "utf8"), "");
  assert.match(readFileSync(fixtureData.options.summaryPath, "utf8"), /could not start/);
});

test("does not turn exit zero without a final report into a successful validation", async t => {
  const fixtureData = fixture(t);
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({
    chunks: [["stdout", "A suite stopped without its final report\n"]],
  }) });
  assert.equal(result.commandExitCode, 0);
  assert.equal(result.exitCode, 1);
  assert.match(readFileSync(fixtureData.options.summaryPath, "utf8"), /Incomplete/);
});

test("marks unknown or crashed suite summaries as incomplete", async t => {
  const fixtureData = fixture(t);
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({
    chunks: [["stdout", report(2, 0, 1, "║  ? test-missing.mjs: 0 passed, 0 failed ║")]],
  }) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.unclassifiedSuites, 1);
  assert.match(readFileSync(fixtureData.options.summaryPath, "utf8"), /Incomplete suite reports:\*\* 1/);
});

test("does not hide reported assertion failures behind a zero command exit", async t => {
  const fixtureData = fixture(t);
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({
    chunks: [["stdout", report(2, 1, 0)]],
  }) });
  assert.equal(result.commandExitCode, 0);
  assert.equal(result.exitCode, 1);
  assert.match(formatSummary("35", result), /reported failures/);
});

test("preserves a failed suite even when aggregate assertion failures and process exit are zero", async t => {
  const fixtureData = fixture(t);
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({
    chunks: [["stdout", report(3, 0, 0, "║  ✗ test-example.mjs: 3 passed, 0 failed ║")]],
  }) });
  assert.equal(result.commandExitCode, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.failedSuites, 1);
  assert.match(formatSummary("35", result), /reported failures/);
  assert.match(formatSummary("35", result), /Suites marked failed:\*\* 1/);
});

test("always-report step creates an incomplete summary and placeholder artifact after boot failure", t => {
  const { options } = fixture(t);
  const reportPath = join(dirname(options.logPath), "report.md");
  publishReport({ ...options, reportPath });
  assert.match(readFileSync(options.logPath, "utf8"), /No test log was produced/);
  const summary = readFileSync(options.summaryPath, "utf8");
  assert.match(summary, /Incomplete: the runner did not record/);
  assert.match(summary, /exit status unavailable/);
  assert.match(summary, /counts are unknown, not zero/);
  assert.equal(readFileSync(reportPath, "utf8"), summary);
});

test("always-report step publishes an existing runner report unchanged", t => {
  const { options } = fixture(t);
  const reportPath = join(dirname(options.logPath), "report.md");
  writeFileSync(reportPath, "Recorded test failure\n");
  publishReport({ ...options, reportPath });
  assert.equal(readFileSync(options.summaryPath, "utf8"), "Recorded test failure\n");
});

test("a complete log without a runner report keeps known counts but not an invented exit outcome", t => {
  const { options } = fixture(t);
  const reportPath = join(dirname(options.logPath), "report.md");
  writeFileSync(options.logPath, report());
  publishReport({ ...options, reportPath });
  const summary = readFileSync(options.summaryPath, "utf8");
  assert.match(summary, /Incomplete: the runner did not record/);
  assert.match(summary, /exit status unavailable/);
  assert.match(summary, /\| 2 \| 0 \| 1 \| 3 \|/);
  assert.doesNotMatch(summary, /exit null|reported failures|Completed with no failed assertions/);
});

test("retains the full artifact while parsing only a bounded output tail", async t => {
  const fixtureData = fixture(t);
  const prefix = "x".repeat(300 * 1024);
  const text = `${prefix}\n${report()}`;
  const result = await runEmulatorTests({ ...fixtureData.options, spawnChild: mockedChild({ chunks: [["stdout", text]] }) });
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(fixtureData.options.logPath, "utf8"), text);
});
