// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Test policy only; never changes the server's tool/security profile. */
import { collectFixtureDiagnostics } from "./fixture-diagnostics.mjs";

export const FIXTURE_PACKAGE = "io.github.fullread.deepadb.fixture";
export function readTestProfile(env = process.env) {
  const name = env.DA_TEST_PROFILE ?? "pixel";
  if (!["pixel", "emulator"].includes(name)) throw new Error(`Unknown DA_TEST_PROFILE: ${name}. Use pixel or emulator.`);
  const emulator = name === "emulator";
  return Object.freeze({ name, emulator,
    packageName: emulator ? FIXTURE_PACKAGE : "com.topjohnwu.magisk",
    appLabel: emulator ? "DeepADB fixture" : "Magisk",
    permission: emulator ? "android.permission.CAMERA" : "android.permission.POST_NOTIFICATIONS",
  });
}
export const profile = readTestProfile();

/** Pin implicit tool calls; preserve explicit invalid serials in rejection tests. */
export function scopedToolArguments(args, env = process.env) {
  if (!readTestProfile(env).emulator) return args;
  if (!/^emulator-\d+$/.test(env.DA_DEVICE ?? "")) throw new Error("Emulator tests require DA_DEVICE from the verified wrapper");
  return { device: env.DA_DEVICE, ...args };
}

export async function pixelContains(h, label, tool, args, expected) {
  if (profile.emulator) h.skip(label, "Requires the rooted Pixel 6a hardware profile; not emulated by this stock AVD");
  else await h.testContains(label, tool, args, expected);
}

/** An independent raw property, not a substring from the tool under test. */
export async function expectedProperty(h, key, pixelValue) {
  if (!profile.emulator) return pixelValue;
  const response = await h.callTool("adb_shell", { command: `getprop ${key}` });
  const value = h.getText(response).trim();
  if (h.isError(response) || !value || /\n/.test(value)) throw new Error(`Cannot establish device property ${key}: ${value}`);
  return value;
}

export async function requireFixtureScreen(h, screen = "main", collectDiagnostics = collectFixtureDiagnostics) {
  let launchOutput = "";
  let waitOutput = "";
  try {
    const r = await h.callTool("adb_shell", { command: `am start -W -S -n ${FIXTURE_PACKAGE}/.MainActivity --es screen ${screen}` });
    launchOutput = h.getText(r);
    if (h.isError(r) || !/Status: ok/.test(launchOutput)) throw new Error(`Fixture launch failed: ${launchOutput}`);
    const ready = await h.callTool("adb_wait_element", { text: "DeepADB Fixture", timeoutMs: 15000 });
    waitOutput = h.getText(ready);
    if (h.isError(ready)) throw new Error(`Fixture UI not ready: ${waitOutput}`);
  } catch (error) {
    if (profile.emulator) {
      try {
        const diagnostics = await collectDiagnostics({ error, screen, launchOutput, waitOutput });
        console.error(`Fixture diagnostics: ${diagnostics.directory ?? diagnostics.skipped}`);
      } catch (diagnosticError) {
        console.error(`Fixture diagnostics unavailable: ${String(diagnosticError?.message ?? diagnosticError).slice(0, 4096)}`);
      }
    }
    throw error;
  }
}
