// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Sensor Test Suite — Hardware sensor enumeration, IIO power monitors, and reading.
 * Tests adb_sensor_read (HAL-level, no root) and adb_iio_read (IIO subsystem, root).
 * Covers discovery, value reading, category filtering, formatting, and edge cases.
 */
import { createHarness } from "./lib/harness.mjs";
import { profile, pixelContains, requireFixtureScreen, FIXTURE_PACKAGE } from "./lib/test-profile.mjs";

const h = await createHarness("Sensors");
let inventory = [];
if (profile.emulator) {
  await requireFixtureScreen(h, "sensors");
  // The fixture writes this only after receiving a calibrated accelerometer
  // event. Missing listener data is a failure, never an "unsupported" skip.
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await h.callTool("adb_shell", { command: `run-as ${FIXTURE_PACKAGE} cat files/sensors.json` });
    try { inventory = JSON.parse(h.getText(r)); } catch {}
    if (Array.isArray(inventory) && inventory.length) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!Array.isArray(inventory) || !inventory.some(s => s.type === "android.sensor.accelerometer")) {
    throw new Error("Sensor fixture never received an accelerometer event");
  }
}
const types = {
  accelerometer: ["accelerometer"], gyroscope: ["gyroscope"], barometer: ["pressure"],
  light: ["light"], proximity: ["proximity"], magnetometer: ["magnetic_field"],
  rotation: ["rotation_vector", "game_rotation_vector"], orientation: ["orientation", "device_orientation"],
  motion: ["significant_motion", "tilt_detector", "pick_up_gesture"],
  step: ["step_counter", "step_detector"], temperature: ["ambient_temperature", "temperature"],
};
async function categoryCheck(label, category, pixelName, listOnly = false) {
  if (!profile.emulator) return h.testContains(label, "adb_sensor_read", { category, listOnly }, pixelName);
  const known = inventory.filter(s => types[category].some(t => s.type === `android.sensor.${t}`));
  if (!known.length) {
    await h.testContains(`${label}: reports absent category`, "adb_sensor_read", { category }, `No sensors found for category "${category}"`);
    h.skip(label, `Android SensorManager inventory has no ${category} sensor`);
    return;
  }
  // Exact device names come from the Android API, independently of our dump parser.
  for (const sensor of known) await h.testContains(`${label}: ${sensor.name}`, "adb_sensor_read", { category, listOnly }, sensor.name);
}

// ── Sensor Discovery ───────────────────────────────────────

h.section("Sensor Discovery");

await h.testContains("List all sensors", "adb_sensor_read",
  { listOnly: true }, "sensors");

await h.testContains("List shows categories", "adb_sensor_read",
  { listOnly: true }, "Categories:");

await h.testContains("List shows total", "adb_sensor_read",
  { listOnly: true }, "Total:");

// ── Full Sensor Read ───────────────────────────────────────

h.section("Full Sensor Read");

await h.testContains("Read all sensors", "adb_sensor_read",
  {}, "sensors have recent readings");

// Verify actual calibrated data is present (not just the summary line)
await h.testContains("Full read has calibrated values", "adb_sensor_read",
  {}, "m/s²");

// ── Category Filters ───────────────────────────────────────

h.section("Category Filters");

// Each filter checks for a known sensor name specific to that category,
// proving the filter actually returns the right sensors (not just the header)
await categoryCheck("Accelerometer filter", "accelerometer", "LSM6DSR");

await categoryCheck("Gyroscope filter", "gyroscope", "LSM6DSR");

await categoryCheck("Barometer filter", "barometer", "ICP10101");

await categoryCheck("Light filter", "light", "TMD3719");

await categoryCheck("Proximity filter", "proximity", "TMD3719");

await categoryCheck("Magnetometer filter", "magnetometer", "MMC56X3X");

await categoryCheck("Rotation filter", "rotation", "Rotation Vector");

await categoryCheck("Orientation filter", "orientation", "Orientation");

await categoryCheck("Motion filter", "motion", "Significant Motion");

await categoryCheck("Step filter", "step", "Step");

await categoryCheck("Temperature filter", "temperature", "Temperature");

// ── List-only with Filter ──────────────────────────────────

h.section("List-only with Filter");

await categoryCheck("List accelerometers only", "accelerometer", "LSM6DSR", true);

// ── Value Formatting Regression ────────────────────────────

h.section("Value Formatting Regression");

// Regression: event block boundary bug truncated 3-axis values to 2
await h.testContains("Accelerometer shows z-axis", "adb_sensor_read",
  { category: "accelerometer" }, "z=");

// ── Rate Display Formatting ────────────────────────────────

h.section("Rate Display Formatting");

// One-shot sensors must show just the mode, not ugly "—–—" double-dash
if (profile.emulator && !inventory.some(s => types.motion.some(t => s.type === `android.sensor.${t}`))) {
  h.skip("One-shot has no trailing dash", "Android SensorManager inventory has no motion sensor; formatting is covered device-free");
} else {
  await h.testNotContains("One-shot has no trailing dash", "adb_sensor_read",
    { category: "motion", listOnly: true }, "—–—");
}

// Continuous sensors with both rates show "min–max" range
await h.testContains("Continuous shows rate range", "adb_sensor_read",
  { category: "accelerometer", listOnly: true }, "Hz–");

// ── Wake-Up Flag Correctness ────────────────────────────────

h.section("Wake-Up Flag Correctness");

// Accelerometer is non-wakeUp — must NOT show [wake] in listOnly
await h.testNotContains("Accelerometer not wake-up", "adb_sensor_read",
  { category: "accelerometer", listOnly: true }, "[wake]");

// Proximity is a wake-up sensor — must show [wake] in listOnly
await h.testContains("Proximity is wake-up", "adb_sensor_read",
  { category: "proximity", listOnly: true }, "[wake]");

// ── IIO Subsystem (adb_iio_read) ───────────────────────────

h.section("IIO Subsystem — Discovery");

await pixelContains(h, "IIO list devices", "adb_iio_read",
  { listOnly: true }, "IIO device");

await pixelContains(h, "IIO detects ODPM", "adb_iio_read",
  { listOnly: true }, "odpm");

h.section("IIO Subsystem — Power Monitor");

await pixelContains(h, "IIO full read has power data", "adb_iio_read",
  {}, "Power Monitor");

await pixelContains(h, "IIO shows sampling rate", "adb_iio_read",
  {}, "Sampling rate:");

await pixelContains(h, "IIO shows channels", "adb_iio_read",
  {}, "Channels:");

await pixelContains(h, "IIO shows total power", "adb_iio_read",
  {}, "Total:");

await pixelContains(h, "IIO shows CPU subsystem", "adb_iio_read",
  {}, "CPU");

// "W" alone matches any word containing W (Watch, Wait, etc). "mW" is the
// actual unit emitted by sensors.ts formatChannelValue() for power channels.
await pixelContains(h, "IIO power has unit (mW)", "adb_iio_read",
  {}, "mW");

if (profile.emulator) {
  // Avoid leaving a foreground sensor subscription running for later suites.
  const stop = await h.callTool("adb_force_stop", { packageName: FIXTURE_PACKAGE });
  h.assert("Stop fixture sensor listeners", !h.isError(stop));
}

const exitCode = h.finish();
process.exit(exitCode);
