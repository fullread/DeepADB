// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Device-free child servers: never inherit a user's device, plugin, or auth settings. */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

export const serverPath = fileURLToPath(new URL("../../build/index.js", import.meta.url));
const fixtureRoots = new Set();
export function isolatedEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "deepadb-sdk-test-"));
  fixtureRoots.add(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DA_") && key !== "ADB_PATH"));
  // Existing directory: config validation cannot fall back to a real adb on PATH,
  // but execFile cannot execute this path. LocalBridge is explicitly disabled.
  mkdirSync(join(root, "disabled-adb"));
  mkdirSync(join(root, "plugins"));
  Object.assign(env, {
    ADB_PATH: join(root, "disabled-adb"), DA_LOCAL: "false",
    DA_TEMP_DIR: join(root, "state"), DA_RESULT_HANDLE_DIR: join(root, "results"),
    DA_PLUGIN_DIR: join(root, "plugins"),
  });
  return { root, env };
}

export function cleanupEnvironments() {
  for (const root of fixtureRoots) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("deepadb-sdk-test-")) {
      throw new Error("Refusing to clean a path outside this test's temporary fixtures");
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  fixtureRoots.clear();
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function bootServer(env, marker) {
  const child = spawn(process.execPath, [serverPath], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 15000);
      const finish = fn => value => { clearTimeout(timer); fn(value); };
      child.once("error", finish(reject));
      child.once("exit", finish(code => reject(new Error(`Server exited ${code}: ${stderr}`))));
      child.stderr.on("data", () => { if (stderr.includes(marker)) finish(resolve)(); });
    });
    return child;
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

export async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}
