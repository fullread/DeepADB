/**
 * Sensor Test Suite — Hardware sensor enumeration, IIO power monitors, and reading.
 * Tests adb_sensor_read (HAL-level, no root) and adb_iio_read (IIO subsystem, root).
 * Covers discovery, value reading, category filtering, formatting, and edge cases.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Sensors");

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
await h.testContains("Accelerometer filter", "adb_sensor_read",
  { category: "accelerometer" }, "LSM6DSR");

await h.testContains("Gyroscope filter", "adb_sensor_read",
  { category: "gyroscope" }, "LSM6DSR");

await h.testContains("Barometer filter", "adb_sensor_read",
  { category: "barometer" }, "ICP10101");

await h.testContains("Light filter", "adb_sensor_read",
  { category: "light" }, "TMD3719");

await h.testContains("Proximity filter", "adb_sensor_read",
  { category: "proximity" }, "TMD3719");

await h.testContains("Magnetometer filter", "adb_sensor_read",
  { category: "magnetometer" }, "MMC56X3X");

await h.testContains("Rotation filter", "adb_sensor_read",
  { category: "rotation" }, "Rotation Vector");

await h.testContains("Orientation filter", "adb_sensor_read",
  { category: "orientation" }, "Orientation");

await h.testContains("Motion filter", "adb_sensor_read",
  { category: "motion" }, "Significant Motion");

await h.testContains("Step filter", "adb_sensor_read",
  { category: "step" }, "Step");

await h.testContains("Temperature filter", "adb_sensor_read",
  { category: "temperature" }, "Temperature");

// ── List-only with Filter ──────────────────────────────────

h.section("List-only with Filter");

await h.testContains("List accelerometers only", "adb_sensor_read",
  { category: "accelerometer", listOnly: true }, "LSM6DSR");

// ── Value Formatting Regression ────────────────────────────

h.section("Value Formatting Regression");

// Regression: event block boundary bug truncated 3-axis values to 2
await h.testContains("Accelerometer shows z-axis", "adb_sensor_read",
  { category: "accelerometer" }, "z=");

// ── Rate Display Formatting ────────────────────────────────

h.section("Rate Display Formatting");

// One-shot sensors must show just the mode, not ugly "—–—" double-dash
await h.testNotContains("One-shot has no trailing dash", "adb_sensor_read",
  { category: "motion", listOnly: true }, "—–—");

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

await h.testContains("IIO list devices", "adb_iio_read",
  { listOnly: true }, "IIO device");

await h.testContains("IIO detects ODPM", "adb_iio_read",
  { listOnly: true }, "odpm");

h.section("IIO Subsystem — Power Monitor");

await h.testContains("IIO full read has power data", "adb_iio_read",
  {}, "Power Monitor");

await h.testContains("IIO shows sampling rate", "adb_iio_read",
  {}, "Sampling rate:");

await h.testContains("IIO shows channels", "adb_iio_read",
  {}, "Channels:");

await h.testContains("IIO shows total power", "adb_iio_read",
  {}, "Total:");

await h.testContains("IIO shows CPU subsystem", "adb_iio_read",
  {}, "CPU");

// "W" alone matches any word containing W (Watch, Wait, etc). "mW" is the
// actual unit emitted by sensors.ts formatChannelValue() for power channels.
await h.testContains("IIO power has unit (mW)", "adb_iio_read",
  {}, "mW");

const exitCode = h.finish();
process.exit(exitCode);
