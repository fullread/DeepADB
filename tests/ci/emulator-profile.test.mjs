// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readTestProfile, FIXTURE_PACKAGE, pixelContains, scopedToolArguments } from "../lib/test-profile.mjs";
import { selectEmulator, withFixture } from "../run-emulator.mjs";

test("Pixel is the strict default and unknown profiles fail closed", () => {
  assert.deepEqual(readTestProfile({}), { name: "pixel", emulator: false, packageName: "com.topjohnwu.magisk", appLabel: "Magisk", permission: "android.permission.POST_NOTIFICATIONS" });
  assert.equal(readTestProfile({ DA_TEST_PROFILE: "emulator" }).packageName, FIXTURE_PACKAGE);
  for (const name of ["", "Pixel", "auto", "inspect", "emulatr"]) assert.throws(() => readTestProfile({ DA_TEST_PROFILE: name }), /Unknown DA_TEST_PROFILE/);
});
test("Pixel-only assertions really execute and propagate failure", async () => {
  // CI runs with the default Pixel profile; this test must not run as emulator.
  assert.equal(readTestProfile().name, "pixel");
  const calls = [];
  const h = { skip() { assert.fail("Strict Pixel assertions must not skip"); },
    async testContains(...args) { calls.push(args); throw new Error("missing hardware"); } };
  await assert.rejects(pixelContains(h, "Modem", "adb_at_detect", {}, "shannon"), /missing hardware/);
  assert.deepEqual(calls, [["Modem", "adb_at_detect", {}, "shannon"]]);
});
test("Emulator selection rejects phones, ambiguity, offline targets and stale serials", () => {
  assert.equal(selectEmulator("List of devices attached\nemulator-5554\tdevice\n"), "emulator-5554");
  for (const [list, serial] of [
    ["Pixel6a device"], ["emulator-5554 offline"], [""],
    ["emulator-5554 device\nPixel6a device", "emulator-5554"],
    ["emulator-5554 device\nemulator-5556 device"],
    ["emulator-5554 device", "emulator-5556"],
  ]) assert.throws(() => selectEmulator(list, serial), /refusing/);
});
test("Emulator calls carry a serial even if other devices appear during the run", () => {
  const env = { DA_TEST_PROFILE: "emulator", DA_DEVICE: "emulator-5554" };
  assert.deepEqual(scopedToolArguments({ command: "id" }, env), { device: "emulator-5554", command: "id" });
  assert.deepEqual(scopedToolArguments({ device: "nonexistent_device" }, env), { device: "nonexistent_device" });
  for (const serial of [undefined, "", "Pixel6a"]) assert.throws(() => scopedToolArguments({}, { ...env, DA_DEVICE: serial }), /require DA_DEVICE/);
  const original = { command: "id" };
  assert.equal(scopedToolArguments(original, { DA_TEST_PROFILE: "pixel" }), original);
});
function mock(overrides = {}) {
  const calls = [];
  const defaults = {
    "shell getprop ro.kernel.qemu": "1", "shell getprop sys.boot_completed": "1",
    [`shell pm list packages ${FIXTURE_PACKAGE}`]: "",
    "install -t fixture.apk": "Success", [`shell pm path ${FIXTURE_PACKAGE}`]: "package:/data/app/test/base.apk",
    [`uninstall ${FIXTURE_PACKAGE}`]: "Success",
  };
  const adb = args => {
    const key = args.join(" "); calls.push(key);
    assert.ok(Object.hasOwn(defaults, key), `Unexpected command: ${key}`);
    const value = Object.hasOwn(overrides, key) ? overrides[key] : defaults[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, adb };
}
test("Preflight never installs or removes packages on a physical/unbooted target", async () => {
  for (const override of [{ "shell getprop ro.kernel.qemu": "0" }, { "shell getprop sys.boot_completed": "" }]) {
    const f = mock(override);
    await assert.rejects(withFixture(f.adb, "fixture.apk", () => assert.fail("must not run")));
    assert.ok(!f.calls.some(c => c.startsWith("install") || c.startsWith("uninstall")));
  }
});
test("Existing fixture installations are preserved, never replaced or deleted", async () => {
  const f = mock({ [`shell pm list packages ${FIXTURE_PACKAGE}`]: `package:${FIXTURE_PACKAGE}\n` });
  await assert.rejects(withFixture(f.adb, "fixture.apk", () => assert.fail("must not run")), /already installed/);
  assert.ok(!f.calls.some(c => c.startsWith("install") || c.startsWith("uninstall")));
});
test("A package-query error is not mistaken for an absent fixture", async () => {
  const f = mock({ [`shell pm list packages ${FIXTURE_PACKAGE}`]: "Error: package service unavailable" });
  await assert.rejects(withFixture(f.adb, "fixture.apk", () => assert.fail("must not run")), /Cannot verify/);
  assert.ok(!f.calls.some(c => c.startsWith("install") || c.startsWith("uninstall")));
});
test("Fixture removal occurs after both successful and nonzero suite exits", async () => {
  for (const status of [0, 7]) {
    const f = mock(); assert.equal(await withFixture(f.adb, "fixture.apk", async () => status), status);
    assert.equal(f.calls.at(-1), `uninstall ${FIXTURE_PACKAGE}`);
  }
});
test("Install/path verification errors fail and attempt cleanup before any suites", async () => {
  for (const override of [{ "install -t fixture.apk": "Failure" }, { [`shell pm path ${FIXTURE_PACKAGE}`]: "" }]) {
    const f = mock(override);
    await assert.rejects(withFixture(f.adb, "fixture.apk", () => assert.fail("must not run")));
    assert.equal(f.calls.at(-1), `uninstall ${FIXTURE_PACKAGE}`);
  }
});
test("Execution and cleanup failures remain visible together", async () => {
  const f = mock({ [`uninstall ${FIXTURE_PACKAGE}`]: "Failure" });
  await assert.rejects(withFixture(f.adb, "fixture.apk", () => { throw new Error("suite crashed"); }), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /suite crashed/);
    assert.match(error.errors[1].message, /cleanup failed/);
    return true;
  });
});
