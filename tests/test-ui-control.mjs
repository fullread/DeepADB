/**
 * UI & Device Control Test Suite — Screen interaction, UI analysis, and settings.
 * Tests: screencap, ui_dump, ui_find, current_activity, settings, screen, control toggles.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("UI & Device Control");

// ── Pre-flight: recover from locked state left by prior failed run ──
// If the device is locked (keyguard active) and we have a PIN, unlock first.
// Without this guard, all UI tests would fail behind the keyguard.
const testPin = process.env.DA_TEST_PIN;
{
  const preflight = await h.callTool("adb_shell", {
    command: "dumpsys window | grep -c keyguard", timeout: 5000,
  });
  const kgCount = parseInt(h.getText(preflight) || "0", 10);
  if (kgCount > 0) {
    // Device appears locked — attempt recovery
    if (testPin) {
      console.log("  ⚠ Pre-flight: keyguard detected — attempting unlock with DA_TEST_PIN");
      await h.callTool("adb_screen", { action: "unlock", pin: testPin });
      await new Promise(r => setTimeout(r, 1000));
    } else {
      console.log("  ⚠ Pre-flight: keyguard detected but no DA_TEST_PIN — UI tests may fail");
    }
  }
}

h.section("Screen State");
// Always wake first — establishes a known-good baseline regardless of prior state
await h.testContains("Screen → wake", "adb_screen", { action: "wake" }, "wake sent");
await new Promise(r => setTimeout(r, 600)); // let Dozing→Awake transition complete before lock check

// Lock/unlock tests require DA_TEST_PIN to guarantee full recovery.
// Locking without being able to re-enter the PIN leaves the phone on the keyguard,
// which breaks all subsequent UI tests. Skip cleanly when no PIN is supplied.
// DEPENDENCY: wake must precede lock — lock checks mWakefulness='Awake' before sending KEYCODE_SLEEP.
if (testPin) {
  await h.testContains("Screen → lock", "adb_screen", { action: "lock" }, "keyguard");
  await new Promise(r => setTimeout(r, 600));
  await h.testContains("Screen → wake (after lock)", "adb_screen", { action: "wake" }, "wake sent");
  await new Promise(r => setTimeout(r, 500));
  // Verify the no-PIN advisory path: unlock without PIN when keyguard is active
  await h.testContains("Screen → unlock (no PIN, keyguard active)", "adb_screen",
    { action: "unlock" }, "keyguard still active");
  await new Promise(r => setTimeout(r, 300));
  // Tool handles the full sequence: wm dismiss-keyguard → swipe → PIN → ENTER → verify
  await h.testContains("Screen → unlock (PIN)", "adb_screen",
    { action: "unlock", pin: testPin }, "PIN accepted");
  await new Promise(r => setTimeout(r, 400));
} else {
  h.skip("Screen → lock",          "DA_TEST_PIN not set — skipped to keep subsequent tests unblocked");
  h.skip("Screen → wake (after lock)", "DA_TEST_PIN not set");
  h.skip("Screen → unlock (no PIN, keyguard active)", "DA_TEST_PIN not set");
  h.skip("Screen → unlock (PIN)", "DA_TEST_PIN not set — set env var to enable (e.g. DA_TEST_PIN=0000 npm test)");
}

h.section("Current Activity");
await h.testContains("Current Activity", "adb_current_activity", {}, "Focused Activity");

h.section("UI Hierarchy");
await h.test("UI Dump (full)", "adb_ui_dump", {});
await h.test("UI Dump (clickable only)", "adb_ui_dump", { clickableOnly: true });
await h.testContains("UI Dump (TSV format)", "adb_ui_dump", { format: "tsv" }, "center_x");
await h.testContains("UI Dump (XML format)", "adb_ui_dump", { format: "xml" }, "<hierarchy");
await h.test("UI Find (by text)", "adb_ui_find", { text: "Settings" });

h.section("Screenshot");
await h.testContains("Screenshot", "adb_screencap", { filename: "DA_test_screenshot.png" }, "Screenshot saved");
await h.testContains("Screenshot annotated", "adb_screencap_annotated", { clickableOnly: true }, "Annotated screenshot:");

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
await h.testContains("Fling (scroll down)", "adb_input_fling", { x1: 540, y1: 1400, x2: 540, y2: 400, durationMs: 50 }, "Fling:");
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
await h.testContains("Batch actions → fling type", "adb_batch_actions", {
  actions: [
    { type: "fling", args: "540 1400 540 400" },
  ],
  delayMs: 0,
}, "1/1 executed");
await h.testContains("Batch actions → pinch type", "adb_batch_actions", {
  actions: [
    { type: "pinch", args: "540 1200 300 150 400" },
  ],
  delayMs: 0,
}, "1/1 executed");

h.section("Multi-Touch");
// Open Google Maps at a known location to provide a zoomable surface for pinch verification
await h.callTool("adb_shell", { command: "am start -a android.intent.action.VIEW -d 'geo:38.0406,-84.5037?z=14'" });
await new Promise(r => setTimeout(r, 4000)); // Maps needs time to load tiles
await h.testContains("Pinch (swipe method)", "adb_input_pinch",
  { cx: 540, cy: 1200, startRadius: 300, endRadius: 100, durationMs: 400, method: "swipe" },
  "pinch");
await new Promise(r => setTimeout(r, 500));
await h.testContains("Spread (sendevent method)", "adb_input_pinch",
  { cx: 540, cy: 1200, startRadius: 100, endRadius: 300, durationMs: 400, method: "sendevent", steps: 15 },
  "spread");
await new Promise(r => setTimeout(r, 500));
await h.testContains("Pinch (auto method)", "adb_input_pinch",
  { cx: 540, cy: 1200, startRadius: 350, endRadius: 150, durationMs: 400 },
  "pinch");
await new Promise(r => setTimeout(r, 500));
await h.testContains("Spread (horizontal angle)", "adb_input_pinch",
  { cx: 540, cy: 1200, startRadius: 100, endRadius: 350, durationMs: 400, angle: 0, method: "swipe" },
  "spread");
// Return to home screen after Maps interaction
await h.callTool("adb_input", { type: "keyevent", args: "KEYCODE_HOME" });
await new Promise(r => setTimeout(r, 500));

h.section("Device Awareness");
await h.testContains("Screen size", "adb_screen_size", {}, "Screen:");
await h.testContains("Device state", "adb_device_state", {}, "Battery:");
await h.testContains("Notifications", "adb_notifications", { maxResults: 5 }, "notification");
await h.testContains("Screen state", "adb_screen_state", { clickableOnly: true }, "Activity:");

h.section("Accessibility");
await h.testContains("A11y Audit", "adb_a11y_audit", {}, "Accessibility Audit");
await h.test("A11y Touch Targets", "adb_a11y_touch_targets", {});
await h.test("A11y Tree", "adb_a11y_tree", {});

h.section("Split APK");
await h.test("List Splits (Magisk)", "adb_list_splits", { packageName: "com.topjohnwu.magisk" });
await h.test("APEX List", "adb_apex_list", {});

const exitCode = h.finish();
process.exit(exitCode);
