// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Registered sensor handler with real dump shapes, no ADB or active listeners. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerSensorTools } from "../build/tools/sensors.js";
let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}: ${error.stack}`); }
}
const goldfish = readFileSync(new URL("./fixtures/sensors/goldfish-zero-handle.txt", import.meta.url), "utf8");
async function read(dump, args = {}) {
  const handlers = new Map();
  registerSensorTools({
    server: { registerTool(name, _options, handler) { handlers.set(name, handler); } },
    deviceManager: { async resolveDevice() { return { serial: "sensor-fixture" }; } },
    bridge: { async shell(command) {
      assert.equal(command, "dumpsys sensorservice");
      return { stdout: dump, stderr: "", exitCode: 0 };
    } },
  });
  const response = await handlers.get("adb_sensor_read")({ category: "all", listOnly: false, ...args });
  return { text: response.content.map(c => c.text).join("\n"), isError: response.isError };
}
await check("Goldfish handle zero contributes to inventory and category filtering", async () => {
  const result = await read(goldfish, { listOnly: true });
  assert.ok(!result.isError); assert.match(result.text, /Total: 2 sensors/);
  const accel = await read(goldfish, { category: "accelerometer", listOnly: true });
  assert.match(accel.text, /Goldfish 3-axis Accelerometer/);
  assert.doesNotMatch(accel.text, /Goldfish Proximity sensor/);
  assert.match(accel.text, /continuous, 2.00 Hz–100.00 Hz/);
  assert.doesNotMatch(accel.text, /\[wake\]/);
});
await check("Calibrated x/y/z uses the newest complete event, without bleeding into the next sensor", async () => {
  const result = await read(goldfish, { category: "accelerometer" });
  assert.match(result.text, /x=0.010 y=9.770 z=0.820 m\/s².*20:22:13.305/);
  assert.match(result.text, /1\/1 sensors have recent readings/);
});
await check("Pixel-style nonzero handles preserve calibrated values and wake/rate formatting", async () => {
  const pixel = goldfish.replace("0000000000)", "0x01010001)").replaceAll("Goldfish 3-axis Accelerometer", "LSM6DSR Accelerometer").replaceAll("Goldfish Proximity sensor", "TMD3719 Proximity");
  const values = await read(pixel, { category: "accelerometer" });
  assert.match(values.text, /LSM6DSR Accelerometer/);
  assert.match(values.text, /z=0.820 m\/s²/);
  const proximity = await read(pixel, { category: "proximity", listOnly: true });
  assert.match(proximity.text, /on-change \[wake\]/);
  assert.doesNotMatch(proximity.text, /—–—/);
});
await check("Inactive sensors are reported explicitly, never fabricated as zero readings", async () => {
  const result = await read(goldfish.slice(0, goldfish.indexOf("Recent Sensor events:")));
  assert.match(result.text, /no recent reading — sensor may be inactive/);
  assert.match(result.text, /0\/2 sensors have recent readings/);
  assert.doesNotMatch(result.text, /x=|y=|z=/);
});
await check("One-shot sensors without rate fields do not get a fabricated range", async () => {
  const dump = "Sensor List:\n0x01010011) Significant Motion | Fixture | ver: 1 | type: android.sensor.significant_motion(17) | flags: 0x03\n\tone-shot | wakeUp |\nFusion States:\n";
  const result = await read(dump, { category: "motion", listOnly: true });
  assert.match(result.text, /Significant Motion .* — one-shot \[wake\]/);
  assert.doesNotMatch(result.text, /Hz|—–—|unknown/);
});
await check("Missing category differs from a missing or invalid sensor inventory", async () => {
  const missing = await read(goldfish, { category: "step" });
  assert.ok(!missing.isError); assert.match(missing.text, /No sensors found for category "step"/);
  assert.equal((await read("Permission denied")).isError, true);
});
console.log(`Sensor parsing: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
