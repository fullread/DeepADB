/**
 * UI & Device Control Test Suite — Screen interaction, UI analysis, and settings.
 * Tests: screencap, ui_dump, ui_find, current_activity, settings, screen, control toggles.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("UI & Device Control");

h.section("Screen State");
await h.test("Screen → wake", "adb_screen", { action: "wake" });

h.section("Current Activity");
await h.testContains("Current Activity", "adb_current_activity", {}, "Focused Activity");

h.section("UI Hierarchy");
await h.test("UI Dump (full)", "adb_ui_dump", {});
await h.test("UI Dump (clickable only)", "adb_ui_dump", { clickableOnly: true });
await h.test("UI Find (by text)", "adb_ui_find", { text: "Settings" });

h.section("Screenshot");
await h.testContains("Screenshot", "adb_screencap", { filename: "DA_test_screenshot.png" }, "Screenshot saved");

h.section("Android Settings");
await h.testContains("Settings Get → brightness_mode", "adb_settings_get", { namespace: "system", key: "screen_brightness_mode" }, "system/screen_brightness_mode");
await h.testContains("Settings Get → airplane_mode", "adb_settings_get", { namespace: "global", key: "airplane_mode_on" }, "airplane_mode_on");
await h.testContains("Settings Get → location_mode", "adb_settings_get", { namespace: "secure", key: "location_mode" }, "secure/location_mode");

// Round-trip: read a setting, write it back to same value (non-destructive)
const airplaneRes = await h.callTool("adb_settings_get", { namespace: "global", key: "airplane_mode_on" });
const airplaneText = h.getText(airplaneRes);
const currentAirplane = airplaneText.includes("= 1") ? "1" : "0";
await h.testContains("Settings Put → write back same value", "adb_settings_put",
  { namespace: "global", key: "airplane_mode_on", value: currentAirplane },
  `airplane_mode_on = ${currentAirplane}`);

h.section("Accessibility");
await h.testContains("A11y Audit", "adb_a11y_audit", {}, "Accessibility Audit");
await h.test("A11y Touch Targets", "adb_a11y_touch_targets", {});
await h.test("A11y Tree", "adb_a11y_tree", {});

h.section("Split APK");
await h.test("List Splits (Magisk)", "adb_list_splits", { packageName: "com.topjohnwu.magisk" });
await h.test("APEX List", "adb_apex_list", {});

const exitCode = h.finish();
process.exit(exitCode);
