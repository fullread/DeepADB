/**
 * QEMU Session 2 — Boot Alpine Linux VM with KVM acceleration.
 * Tests: big.LITTLE detection, root-elevated KVM spawn, VM lifecycle.
 */
import { createHarness } from "./lib/harness.mjs";
import { existsSync } from "fs";

const h = await createHarness("QEMU Session 2 — Alpine VM Boot");

const onDevice = existsSync("/data/data/com.termux");
if (!onDevice) {
  h.section("QEMU Boot (on-device only — skipping)");
  h.skip("Alpine VM Boot", "on-device only");
  h.finish();
  process.exit(0);
}

const imageDir = "/data/data/com.termux/files/home/.deepadb/qemu-images";

h.section("Pre-flight");
await h.testContains("QEMU installed", "adb_qemu_setup", { install: false }, "QEMU");
await h.testContains("KVM available", "adb_qemu_setup", { install: false }, "KVM");
await h.testContains("big.LITTLE detected", "adb_qemu_setup", { install: false }, "heterogeneous");

h.section("Boot Alpine VM with KVM");
await h.testContains("Start VM", "adb_qemu_start", {
  name: "alpine-test",
  image: "alpine-test",
  kernel: `${imageDir}/vmlinuz-virt`,
  initrd: `${imageDir}/initramfs-virt`,
  append: "console=ttyAMA0",
  memoryMb: 512,
  cpus: 2,
  adbPort: 5556,
  display: "none",
}, "VM 'alpine-test' started");

// Give the VM time to boot
console.log("  ... waiting 10s for kernel boot ...");
await new Promise(r => setTimeout(r, 10000));

h.section("VM Status Verification");
await h.testContains("VM listed in status", "adb_qemu_status", {}, "alpine-test");
await h.testContains("Resource accounting", "adb_qemu_status", {}, "512 MB RAM");
await h.testContains("ADB port mapping", "adb_qemu_status", {}, "5556");
await h.testContains("KVM root-elevated", "adb_qemu_status", {}, "Running VMs: 1");

h.section("VM Shutdown");
await h.testContains("Stop VM", "adb_qemu_stop", { name: "alpine-test" }, "alpine-test");
await h.testContains("Clean shutdown", "adb_qemu_status", {}, "Running VMs: 0");

h.finish();
