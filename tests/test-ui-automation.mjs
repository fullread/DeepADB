// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Exercise registered UI handlers with controlled navigation/scroll state. */
import assert from "node:assert/strict";
import { registerInputGestureTools } from "../build/tools/input-gestures.js";
let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}: ${error.stack}`); }
}
const xml = text => `<hierarchy><node text="${text}" resource-id="fixture:id/target" content-desc="" class="android.widget.Button" clickable="true" scrollable="false" enabled="true" bounds="[20,100][220,180]" /></hierarchy>`;
function fixture({ states = [xml("Fixture Home")], onInput } = {}) {
  const handlers = new Map(), calls = [];
  let current, capture = 0;
  registerInputGestureTools({
    server: { registerTool(name, options, handler) { handlers.set(name, { options, handler }); } },
    deviceManager: { async resolveDevice() { return { serial: "fixture" }; } },
    bridge: { async shell(command) {
      calls.push(command);
      if (command.startsWith("uiautomator dump ")) current = states[Math.min(capture++, states.length - 1)];
      else if (command.startsWith("cat ")) return { stdout: current };
      else if (command === "wm size") return { stdout: "Physical size: 1080x2400" };
      else if (command.startsWith("input ")) onInput?.(command);
      else if (!command.startsWith("rm ")) assert.fail(`Unexpected command ${command}`);
      return { stdout: "", stderr: "", exitCode: 0 };
    } },
  });
  return { calls, async run(name, args) {
    const { options, handler } = handlers.get(name);
    const response = await handler(options.inputSchema.parse(args));
    return { error: !!response.isError, text: response.content.map(c => c.text).join("\n") };
  } };
}
await check("Tap uses located element bounds and requires a real match", async () => {
  const f = fixture();
  const tapped = await f.run("adb_tap_element", { text: "Fixture Home" });
  assert.equal(tapped.error, false); assert.ok(f.calls.includes("input tap 120 140"));
  const before = f.calls.filter(c => c.startsWith("input ")).length;
  assert.equal((await f.run("adb_tap_element", { text: "Absent" })).error, true);
  assert.equal(f.calls.filter(c => c.startsWith("input ")).length, before);
});
await check("Wait re-captures navigation state until the target appears", async () => {
  const f = fixture({ states: [xml("Fixture Home"), xml("Fixture Detail")] });
  const result = await f.run("adb_wait_element", { text: "Fixture Detail", timeoutMs: 1000, pollMs: 200 });
  assert.equal(result.error, false); assert.match(result.text, /appeared/);
  assert.equal(f.calls.filter(c => c.startsWith("uiautomator dump")).length, 2);
});
await check("Disappearance requires a valid new hierarchy", async () => {
  const f = fixture({ states: [xml("Fixture Detail"), xml("Fixture Home")] });
  assert.equal((await f.run("adb_wait_element", { text: "Fixture Detail", condition: "disappear", timeoutMs: 1000, pollMs: 200 })).error, false);
  const broken = fixture({ states: [""] });
  assert.equal((await broken.run("adb_wait_element", { text: "Fixture Detail", condition: "disappear", timeoutMs: 1000, pollMs: 200 })).error, true);
});
await check("Scroll finds an off-screen target and optional tap has the expected coordinates", async () => {
  let swipes = 0;
  const f = fixture({ states: [xml("Row 1"), xml("Row 2"), xml("Fixture Scroll Target")], onInput(command) { if (command.startsWith("input swipe")) swipes++; } });
  const result = await f.run("adb_scroll_until", { text: "Fixture Scroll Target", maxScrolls: 3, tapWhenFound: true });
  assert.equal(result.error, false); assert.match(result.text, /after 2 scroll\(s\).*tapped/);
  assert.equal(swipes, 2); assert.equal(f.calls.at(-1), "input tap 120 140");
});
await check("Scroll exhausts its bound and fails for an absent element", async () => {
  const f = fixture();
  const result = await f.run("adb_scroll_until", { text: "Absent", maxScrolls: 1 });
  assert.equal(result.error, true); assert.match(result.text, /after 1 scroll/);
  assert.equal(f.calls.filter(c => c.startsWith("input swipe")).length, 1);
});
await check("Uncapturable UI never becomes a successful scroll result", async () => {
  const f = fixture({ states: [""] });
  assert.equal((await f.run("adb_scroll_until", { text: "Absent", maxScrolls: 1 })).error, true);
  assert.equal(f.calls.filter(c => c.startsWith("rm ")).length, 2);
});
console.log(`UI automation: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
