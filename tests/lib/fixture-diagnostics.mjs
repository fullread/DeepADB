// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Bounded evidence from a disposable emulator; never retries or repairs a test. */
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export const DIAGNOSTIC_TIMEOUT_MS = 6000;
export const DIAGNOSTIC_TEXT_BYTES = 256 * 1024;
export const DIAGNOSTIC_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_FAILURE_CAPTURES = 8;

function bounded(value, limit = DIAGNOSTIC_TEXT_BYTES) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""));
  return bytes.subarray(0, limit);
}

function describeError(error) {
  return {
    message: bounded(error?.message ?? error, 4096).toString("utf8"),
    code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : null,
    signal: typeof error?.signal === "string" ? error.signal : null,
  };
}

/** Separate stdout/stderr, preserve partial bytes, and kill a stuck local ADB client. */
export function runDiagnosticProbe(binary, args, { timeoutMs = DIAGNOSTIC_TIMEOUT_MS, maxBytes = DIAGNOSTIC_TEXT_BYTES } = {}) {
  return new Promise(resolveProbe => {
    const finish = (error, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) => {
      const overflow = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      resolveProbe({
        ok: !error,
        stdout: bounded(stdout, maxBytes),
        stderr: bounded(stderr),
        timedOut: !!error?.killed && !overflow,
        truncated: overflow || stdout.length > maxBytes || stderr.length > DIAGNOSTIC_TEXT_BYTES,
        error: error ? describeError(error) : null,
      });
    };
    try {
      execFile(binary, args, {
        encoding: "buffer", timeout: timeoutMs, maxBuffer: maxBytes,
        killSignal: "SIGKILL", windowsHide: true,
      }, finish);
    } catch (error) {
      finish(error);
    }
  });
}

/** Called only after a fixture failure. The caller always preserves its original error. */
export async function collectFixtureDiagnostics({
  error, screen, launchOutput = "", waitOutput = "", env = process.env,
  runProbe = runDiagnosticProbe,
}) {
  const serial = env.DA_DEVICE;
  if (env.DA_TEST_PROFILE !== "emulator" || !/^emulator-\d+$/.test(serial ?? "")) {
    return { skipped: "not a selected emulator" };
  }
  if (!env.ADB_PATH || !isAbsolute(env.DA_TEMP_DIR ?? "") || !isAbsolute(env.DA_EMULATOR_DIAGNOSTICS_DIR ?? "")) {
    return { skipped: "diagnostics were not configured by the emulator wrapper" };
  }
  const runDirectory = resolve(env.DA_TEMP_DIR);
  const directory = resolve(env.DA_EMULATOR_DIAGNOSTICS_DIR);
  if (directory !== join(runDirectory, "fixture-diagnostics")) {
    return { skipped: "diagnostic directory is outside the current emulator run" };
  }
  // Never follow a replacement diagnostics-directory symlink out of the run.
  const realRunDirectory = realpathSync(runDirectory);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== join(realRunDirectory, "fixture-diagnostics")) {
    return { skipped: "diagnostic directory is not a private run directory" };
  }
  if (readdirSync(directory).filter(name => name.startsWith("failure-")).length >= MAX_FAILURE_CAPTURES) {
    return { skipped: "failure capture limit reached" };
  }
  const captureDirectory = mkdtempSync(join(directory, "failure-"));
  const record = {
    timestamp: new Date().toISOString(), serial,
    suite: basename(process.argv[1] ?? "unknown"),
    screen: bounded(screen, 128).toString("utf8"),
    failure: describeError(error),
    probes: {},
  };
  writeFileSync(join(captureDirectory, "launch.txt"), bounded(launchOutput));
  writeFileSync(join(captureDirectory, "wait.txt"), bounded(waitOutput));
  // Write the primary evidence first, even if collection is interrupted later.
  const saveRecord = () => writeFileSync(join(captureDirectory, "failure.json"), JSON.stringify(record, null, 2) + "\n");
  saveRecord();
  const probes = [
    ["window", ["shell", "dumpsys", "window"], "txt"],
    ["activity", ["shell", "dumpsys", "activity", "activities"], "txt"],
    ["power", ["shell", "dumpsys", "power"], "txt"],
    // uiautomator appends a status line after the hierarchy; retain raw stdout.
    ["ui", ["exec-out", "uiautomator", "dump", "/dev/tty"], "stdout.txt"],
    ["screenshot", ["exec-out", "screencap", "-p"], "png"],
    ["logcat", ["logcat", "-d", "-t", "200", "-v", "threadtime", "AndroidRuntime:E", "ActivityTaskManager:I", "ActivityManager:W", "WindowManager:W", "*:S"], "txt"],
  ];
  // Parallel bounded probes keep the failure path near one timeout, not six.
  await Promise.all(probes.map(async ([name, args, extension]) => {
    try {
      const maxBytes = extension === "png" ? DIAGNOSTIC_IMAGE_BYTES : DIAGNOSTIC_TEXT_BYTES;
      const result = await runProbe(env.ADB_PATH, ["-s", serial, ...args], { timeoutMs: DIAGNOSTIC_TIMEOUT_MS, maxBytes });
      const stdout = bounded(result.stdout, maxBytes);
      const stderr = bounded(result.stderr);
      // Failed/partial screenshots remain evidence, and are marked in the manifest.
      writeFileSync(join(captureDirectory, `${name}.${extension}`), stdout);
      writeFileSync(join(captureDirectory, `${name}.stderr.txt`), stderr);
      // Exit status alone does not prove the output is usable XML or a full PNG.
      record.probes[name] = { commandSucceeded: result.ok, timedOut: result.timedOut, truncated: result.truncated, error: result.error };
    } catch (probeError) {
      record.probes[name] = { commandSucceeded: false, error: describeError(probeError) };
    }
    saveRecord();
  }));
  return { directory: captureDirectory };
}
