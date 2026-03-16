/**
 * QEMU/KVM Test Suite — On-device VM management tools.
 * Tests: setup, image management (create/list/delete), status, resource detection.
 * Skips all tests in ADB mode (QEMU tools are on-device only).
 */
import { createHarness } from "./lib/harness.mjs";
import { existsSync } from "fs";

const h = await createHarness("QEMU/KVM Virtualization");

// Detect on-device mode: /data/data/com.termux exists only on Android
const onDevice = existsSync("/data/data/com.termux");

if (!onDevice) {
  h.section("QEMU (on-device only — skipping)");
  h.skip("QEMU Setup", "on-device only");
  h.skip("Image Management", "on-device only");
  h.skip("VM Status", "on-device only");
} else {
  h.section("QEMU Setup");
  await h.testContains("QEMU Setup (detect)", "adb_qemu_setup", { install: false }, "KVM");
  await h.testContains("QEMU Version", "adb_qemu_setup", { install: false }, "QEMU");
  await h.testContains("Host Resources", "adb_qemu_setup", { install: false }, "CPU cores");

  h.section("Disk Image Management");
  await h.test("Image List (empty)", "adb_qemu_images", { action: "list" });
  await h.testContains("Image Create (qcow2)", "adb_qemu_images", { action: "create", name: "test-vm", sizeMb: 256, format: "qcow2" }, "Image created");
  await h.testContains("Image List (has image)", "adb_qemu_images", { action: "list" }, "test-vm.qcow2");
  await h.testContains("Image Delete", "adb_qemu_images", { action: "delete", name: "test-vm" }, "Deleted");
  await h.test("Image List (empty again)", "adb_qemu_images", { action: "list" });

  h.section("VM Status");
  await h.testContains("Status (no VMs)", "adb_qemu_status", {}, "Running VMs: 0");
  await h.testContains("Status (resource budget)", "adb_qemu_status", {}, "allocatable");
}

h.finish();
