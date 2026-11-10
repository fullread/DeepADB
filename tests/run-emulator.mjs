// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Install only on a verified disposable emulator; always remove our fixture. */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIXTURE_PACKAGE } from "./lib/test-profile.mjs";

export function selectEmulator(list, requested) {
  const online = list.split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(([, state]) => state === "device").map(([serial]) => serial);
  const serial = requested || (online.length === 1 ? online[0] : "");
  if (online.length !== 1 || !serial || !online.includes(serial) || !/^emulator-\d+$/.test(serial)) throw new Error("Connect only one emulator, selected by ANDROID_SERIAL; refusing physical/ambiguous device selection");
  return serial;
}

export async function withFixture(adb, apk, run) {
  if (adb(["shell", "getprop", "ro.kernel.qemu"]).trim() !== "1") throw new Error("Target is not a verified Android emulator");
  if (adb(["shell", "getprop", "sys.boot_completed"]).trim() !== "1") throw new Error("Emulator has not completed boot");
  const existing = adb(["shell", "pm", "list", "packages", FIXTURE_PACKAGE]).trim();
  if (existing && !existing.split(/\r?\n/).every(line => /^package:[a-zA-Z0-9_.]+$/.test(line))) throw new Error(`Cannot verify fixture absence: ${existing}`);
  if (existing.split(/\r?\n/).includes(`package:${FIXTURE_PACKAGE}`)) throw new Error("Fixture package already installed; refusing to replace or delete an existing installation");
  // Mark cleanup necessary before install: even a partially failed install may leave state.
  let failure;
  try {
    if (!/\bSuccess\b/.test(adb(["install", "-t", apk]))) throw new Error("Fixture installation did not report Success");
    if (!/^package:.*base\.apk\s*$/m.test(adb(["shell", "pm", "path", FIXTURE_PACKAGE]))) throw new Error("Installed fixture APK path could not be verified");
    return await run();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (!/\bSuccess\b/.test(adb(["uninstall", FIXTURE_PACKAGE]))) throw new Error("Fixture cleanup failed");
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], "Test setup/execution and fixture cleanup both failed");
      throw cleanupError;
    }
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const apk = join(root, ".test-artifacts", "android-fixture", "fixture.apk");
  if (!existsSync(apk)) throw new Error("Build the test APK first: node tests/fixtures/android/build.mjs");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const binary = process.env.ADB_PATH || (sdk ? join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb") : "adb");
  const raw = args => execFileSync(binary, args, { encoding: "utf8", timeout: 60000, windowsHide: true });
  const serial = selectEmulator(raw(["devices"]), process.env.ANDROID_SERIAL);
  const adb = args => raw(["-s", serial, ...args]);
  const outputDirectory = mkdtempSync(join(root, ".test-artifacts", "emulator-run-"));
  console.log(`Test profile: emulator; target: ${serial}; disposable package: ${FIXTURE_PACKAGE}`);
  console.log(`Isolated test output: ${outputDirectory}`);
  process.exitCode = await withFixture(adb, apk, () => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, "tests", "run-all.mjs")], {
      cwd: root, stdio: "inherit", windowsHide: true,
      env: { ...process.env, DA_LOCAL: "false", DA_TEST_PROFILE: "emulator", DA_TEMP_DIR: outputDirectory, ADB_PATH: binary, DA_DEVICE: serial, ANDROID_SERIAL: serial },
    });
    const interrupt = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      resolveRun(signal ? 1 : code ?? 1);
    });
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
