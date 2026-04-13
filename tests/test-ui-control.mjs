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

h.section("Input Gestures");
await h.testContains("Long press (safe coords)", "adb_input_long_press", { x: 540, y: 1200, durationMs: 500 }, "Long press");
await h.testContains("Double tap (safe coords)", "adb_input_double_tap", { x: 540, y: 1200 }, "Double tap");
await h.testContains("Drag (safe coords)", "adb_input_drag", { x1: 300, y1: 1200, x2: 700, y2: 1200, durationMs: 500 }, "Drag");
await h.testContains("Input text", "adb_input_text", { text: "test" }, "Typed");
await h.testContains("Open URL", "adb_open_url", { url: "https://example.com" }, "Opened");
await h.testContains("Orientation get", "adb_orientation", { action: "get" }, "Orientation");
await h.testContains("Clipboard read", "adb_clipboard", { action: "read" }, "Clipboard");

h.section("UI Automation Helpers");
// Launch Settings, then dismiss any GMS account overlay that may appear post-OS-reinstall
await h.callTool("adb_shell", { command: "am force-stop com.android.chrome" });
await h.callTool("adb_input", { type: "keyevent", args: "KEYCODE_HOME" });
await new Promise(r => setTimeout(r, 500));
await h.callTool("adb_shell", { command: "am start -n com.android.settings/.Settings" });
await new Promise(r => setTimeout(r, 2000));
// Dismiss any overlay: press BACK to clear GMS dialogs, then re-launch Settings
await h.callTool("adb_input", { type: "keyevent", args: "KEYCODE_BACK" });
await new Promise(r => setTimeout(r, 300));
await h.callTool("adb_input", { type: "keyevent", args: "KEYCODE_BACK" });
await new Promise(r => setTimeout(r, 300));
await h.callTool("adb_shell", { command: "am start -n com.android.settings/.Settings" });
await new Promise(r => setTimeout(r, 3000));
await h.testContains("Wait stable", "adb_wait_stable", { stableCount: 2, timeoutMs: 10000, pollMs: 600 }, "stable");
await h.testContains("Tap element (by text)", "adb_tap_element", { text: "Network" }, "Tapped");
// Go back to main Settings after tap navigated into sub-screen
await h.callTool("adb_input", { type: "keyevent", args: "KEYCODE_BACK" });
await new Promise(r => setTimeout(r, 1500));
await h.testContains("Wait element appear", "adb_wait_element", { text: "Network", condition: "appear", timeoutMs: 8000 }, "appeared");
// Ensure Settings is fully rendered before scrolling
await h.callTool("adb_wait_stable", { stableCount: 2, timeoutMs: 5000, pollMs: 400 });
await h.testContains("Scroll until", "adb_scroll_until", { text: "About", direction: "down", maxScrolls: 15 }, "Found", 90000);

h.section("Efficiency");
await h.testContains("Screenshot compressed", "adb_screenshot_compressed", { quality: 50, scale: 0.5 }, "Screenshot saved");
await h.testContains("Batch actions", "adb_batch_actions", {
  actions: [
    { type: "home" },
    { type: "sleep", args: "500" },
    { type: "tap", args: "540 1200" },
  ],
  delayMs: 100,
}, "3/3 executed");

h.section("Device Awareness");
await h.testContains("Screen size", "adb_screen_size", {}, "Screen:");
await h.testContains("Device state", "adb_device_state", {}, "Battery:");
await h.testContains("Notifications", "adb_notifications", { maxResults: 5 }, "notification");

h.section("Accessibility");
await h.testContains("A11y Audit", "adb_a11y_audit", {}, "Accessibility Audit");
await h.test("A11y Touch Targets", "adb_a11y_touch_targets", {});
await h.test("A11y Tree", "adb_a11y_tree", {});

h.section("Split APK");
await h.test("List Splits (Magisk)", "adb_list_splits", { packageName: "com.topjohnwu.magisk" });
await h.test("APEX List", "adb_apex_list", {});

const exitCode = h.finish();
process.exit(exitCode);
