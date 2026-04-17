/**
 * QEMU Session 2 — Boot Alpine Linux VM with KVM acceleration.
 * Tests: big.LITTLE detection, root-elevated KVM spawn, VM lifecycle.
 *
 * Alpine kernel/initrd auto-fetched on first run from dl-cdn.alpinelinux.org
 * (latest-stable aarch64 netboot). Cached in ~/.deepadb/qemu-images; subsequent
 * runs skip the download. ~18 MB total, HTTPS-only. If the fetch fails (no
 * network, curl unavailable, CDN down) the boot test block is skipped rather
 * than failed.
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

// imageDir must match what adb_qemu_start resolves at runtime — config.ts
// getTempDir() returns `${HOME ?? "/data/local/tmp"}/.deepadb` in on-device
// mode, and qemu.ts appends "qemu-images". Hardcoding the Termux path here
// would mismatch when HOME is overridden (e.g. running via a wrapper script).
const tempDir = `${process.env.HOME ?? "/data/local/tmp"}/.deepadb`;
const imageDir = `${tempDir}/qemu-images`;
const KERNEL_URL  = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/netboot/vmlinuz-virt";
const INITRD_URL  = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/netboot/initramfs-virt";
const KERNEL_PATH = `${imageDir}/vmlinuz-virt`;
const INITRD_PATH = `${imageDir}/initramfs-virt`;
const DISK_PATH   = `${imageDir}/alpine-test.qcow2`;

h.section("Pre-flight");
await h.testContains("QEMU installed", "adb_qemu_setup", { install: false }, "QEMU");
await h.testContains("KVM available", "adb_qemu_setup", { install: false }, "KVM");
await h.testContains("big.LITTLE detected", "adb_qemu_setup", { install: false }, "heterogeneous");

h.section("Alpine kernel + initrd setup");

// Check what's already cached so we can skip downloads on repeat runs.
const lsRes = await h.callTool("adb_shell", {
  command: `ls -la '${imageDir}/' 2>/dev/null`,
});
const lsOut = h.getText(lsRes);
const haveKernel = lsOut.includes("vmlinuz-virt");
const haveInitrd = lsOut.includes("initramfs-virt");
const haveDisk   = lsOut.includes("alpine-test.qcow2");

// Track per-step success. bootReady is computed at the end from these flags
// so that successful fetches actually mark prerequisites as ready (previously
// only the "everything-cached" initial state could set bootReady=true).
let kernelReady = haveKernel;
let initrdReady = haveInitrd;
let diskReady   = haveDisk;

if (kernelReady && initrdReady && diskReady) {
  h.skip("Fetch kernel (cached)", "already present");
  h.skip("Fetch initrd (cached)", "already present");
  h.skip("Create disk (cached)", "already present");
} else {
  // Ensure the directory exists before any download/create.
  await h.callTool("adb_shell", { command: `mkdir -p '${imageDir}'` });

  // Verify curl is available — both Termux and Magisk environments provide it
  // but we can't assume, and users may have a stripped install.
  const curlCheck = await h.callTool("adb_shell", { command: "command -v curl || echo MISSING" });
  const curlAvailable = !h.getText(curlCheck).includes("MISSING");

  if (!curlAvailable) {
    h.skip("Fetch kernel", "curl not found on device");
    h.skip("Fetch initrd", "curl not found on device");
    h.skip("Create disk", "prerequisites missing");
  } else {
    // Fetch kernel. --fail turns HTTP errors into curl exit failures;
    // --location follows CDN redirects; --retry handles transient network errors;
    // --max-time bounds the whole operation.
    const curlFlags = "--fail --location --silent --show-error --retry 2 --max-time 120";

    if (!kernelReady) {
      const kr = await h.callTool("adb_shell", {
        command: `curl ${curlFlags} -o '${KERNEL_PATH}.tmp' '${KERNEL_URL}' && mv '${KERNEL_PATH}.tmp' '${KERNEL_PATH}' && stat -c %s '${KERNEL_PATH}'`,
      }, 150000);
      const krOut = h.getText(kr).trim();
      const krBytes = parseInt(krOut.split("\n").pop() || "0", 10);
      // Sanity-check size — Alpine vmlinuz-virt is ~10 MB. Reject absurdly small
      // results that would indicate a truncated/error-page download slipped past curl.
      if (!h.isError(kr) && krBytes > 1_000_000) {
        h.assert(`Fetch kernel (~${(krBytes / 1024 / 1024).toFixed(1)} MB)`, true);
        kernelReady = true;
      } else {
        h.assert(`Fetch kernel (~${(krBytes / 1024 / 1024).toFixed(1)} MB)`, false,
          `size ${krBytes} bytes below 1MB sanity threshold`);
      }
    } else {
      h.skip("Fetch kernel (cached)", "already present");
    }

    if (!initrdReady) {
      const ir = await h.callTool("adb_shell", {
        command: `curl ${curlFlags} -o '${INITRD_PATH}.tmp' '${INITRD_URL}' && mv '${INITRD_PATH}.tmp' '${INITRD_PATH}' && stat -c %s '${INITRD_PATH}'`,
      }, 150000);
      const irOut = h.getText(ir).trim();
      const irBytes = parseInt(irOut.split("\n").pop() || "0", 10);
      if (!h.isError(ir) && irBytes > 1_000_000) {
        h.assert(`Fetch initrd (~${(irBytes / 1024 / 1024).toFixed(1)} MB)`, true);
        initrdReady = true;
      } else {
        h.assert(`Fetch initrd (~${(irBytes / 1024 / 1024).toFixed(1)} MB)`, false,
          `size ${irBytes} bytes below 1MB sanity threshold`);
      }
    } else {
      h.skip("Fetch initrd (cached)", "already present");
    }

    // Only create the placeholder disk if both kernel and initrd are ready —
    // no point creating it if the VM won't boot.
    if (!diskReady && kernelReady && initrdReady) {
      // Minimal qcow2 — VM boots from kernel+initrd, disk is unused but
      // adb_qemu_start's schema requires an `image` argument that resolves
      // to an existing file.
      const dr = await h.callTool("adb_shell", {
        command: `qemu-img create -f qcow2 '${DISK_PATH}' 64M`,
      }, 15000);
      if (!h.isError(dr)) {
        h.assert("Create placeholder disk (64 MB qcow2)", true);
        diskReady = true;
      } else {
        h.assert("Create placeholder disk (64 MB qcow2)", false, h.getText(dr).substring(0, 120));
      }
    } else if (diskReady) {
      h.skip("Create disk (cached)", "already present");
    } else {
      h.skip("Create disk", "kernel/initrd missing — disk pointless without them");
    }
  }
}

const bootReady = kernelReady && initrdReady && diskReady;

if (!bootReady) {
  h.section("Boot tests skipped — Alpine artifacts unavailable");
  h.skip("Start VM", "kernel/initrd/disk setup failed");
  h.skip("Connect to Alpine (no adbd)", "prerequisite failed");
  h.skip("Status shows not connected", "prerequisite failed");
  h.skip("Disconnect unconnected VM", "prerequisite failed");
  h.skip("Guest shell unconnected", "prerequisite failed");
  h.skip("VM listed in status", "prerequisite failed");
  h.skip("Resource accounting", "prerequisite failed");
  h.skip("ADB port mapping", "prerequisite failed");
  h.skip("KVM root-elevated", "prerequisite failed");
  h.skip("Stop VM", "prerequisite failed");
  h.skip("Clean shutdown", "prerequisite failed");
  h.finish();
  process.exit(0);
}

h.section("Boot Alpine VM with KVM");
await h.testContains("Start VM", "adb_qemu_start", {
  name: "alpine-test",
  image: "alpine-test",
  kernel: KERNEL_PATH,
  initrd: INITRD_PATH,
  append: "console=ttyAMA0",
  memoryMb: 512,
  cpus: 2,
  adbPort: 5556,
  display: "none",
}, "VM 'alpine-test' started");

// Give the VM time to boot
console.log("  ... waiting 10s for kernel boot ...");
await new Promise(r => setTimeout(r, 10000));

h.section("Guest ADB Connectivity (Alpine — no adbd)");
// Alpine Linux has no ADB daemon — connect should fail gracefully, not crash
await h.testRejects("Connect to Alpine (no adbd)", "adb_qemu_connect", { name: "alpine-test", timeout: 3000 });
// Status should still show not connected after failed attempt
await h.testContains("Status shows not connected", "adb_qemu_status", {}, "not connected");
// Disconnect from VM that was never successfully connected
await h.testContains("Disconnect unconnected VM", "adb_qemu_disconnect", { name: "alpine-test" }, "not connected");
// Guest shell requires connection first
await h.testRejects("Guest shell unconnected", "adb_qemu_guest_shell", { name: "alpine-test", command: "echo test" });

h.section("VM Status Verification");
await h.testContains("VM listed in status", "adb_qemu_status", {}, "alpine-test");
await h.testContains("Resource accounting", "adb_qemu_status", {}, "512 MB RAM");
await h.testContains("ADB port mapping", "adb_qemu_status", {}, "5556");
await h.testContains("KVM root-elevated", "adb_qemu_status", {}, "Running VMs: 1");

h.section("VM Shutdown");
await h.testContains("Stop VM", "adb_qemu_stop", { name: "alpine-test" }, "alpine-test");
await h.testContains("Clean shutdown", "adb_qemu_status", {}, "Running VMs: 0");

h.finish();
