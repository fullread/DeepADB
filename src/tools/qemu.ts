/**
 * QEMU/KVM Tools — On-device virtual machine management.
 *
 * Provides QEMU VM lifecycle management for on-device mode (Termux).
 * Uses KVM hardware acceleration when available (/dev/kvm) for near-native
 * performance. Manages disk images, VM boot/shutdown, and ADB port forwarding
 * to guest VMs.
 *
 * These tools complement the existing AVD emulator tools:
 * - AVD tools (emulator.ts): manage Android SDK emulators on desktop
 * - QEMU tools (this file): manage hardware-accelerated VMs on-device
 *
 * Images are stored in {tempDir}/qemu-images/.
 * QEMU must be installed via Termux: pkg install qemu-system-aarch64-headless
 */

import { z } from "zod";
import { join, resolve, basename } from "path";
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execFile, spawn, spawnSync, ChildProcess } from "child_process";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { isOnDevice } from "../config/config.js";
import { registerCleanup, unregisterCleanup } from "../middleware/cleanup.js";
import { LocalBridge } from "../bridge/local-bridge.js";

/** Maximum concurrent QEMU VMs to prevent resource exhaustion. */
const MAX_VMS = 3;

/**
 * Maximum percentage of physical RAM that a VM may use.
 * Reserves 35% for the host OS, Android services, Termux, and DeepADB itself.
 */
const MAX_MEMORY_PERCENT = 65;

/**
 * Detect available CPU cores on the device.
 * Returns total cores minus 1 for the guest (minimum 1), leaving one core
 * reserved for the host OS. On single-core devices, the VM gets the one core.
 */
async function detectMaxCpus(bridge: import("../bridge/adb-bridge.js").AdbBridge): Promise<{ total: number; forGuest: number }> {
  try {
    const result = await bridge.shell("nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null", {
      ignoreExitCode: true, timeout: 5000,
    });
    const total = parseInt(result.stdout.trim(), 10) || 1;
    // Reserve 1 core for host; minimum 1 for guest
    const forGuest = total > 1 ? total - 1 : 1;
    return { total, forGuest };
  } catch {
    return { total: 1, forGuest: 1 };
  }
}

/**
 * Detect total physical RAM in MB.
 * Returns total system memory and the maximum amount allocatable to a VM
 * (MAX_MEMORY_PERCENT of total), leaving headroom for the host.
 */
async function detectMaxMemoryMb(bridge: import("../bridge/adb-bridge.js").AdbBridge): Promise<{ totalMb: number; forGuestMb: number }> {
  try {
    const result = await bridge.shell("grep MemTotal /proc/meminfo 2>/dev/null", {
      ignoreExitCode: true, timeout: 5000,
    });
    const match = result.stdout.match(/MemTotal:\s+(\d+)\s+kB/i);
    if (match) {
      const totalMb = Math.floor(parseInt(match[1], 10) / 1024);
      const forGuestMb = Math.floor(totalMb * MAX_MEMORY_PERCENT / 100);
      return { totalMb, forGuestMb };
    }
  } catch { /* fallback */ }
  // Conservative fallback: 2GB total, ~1.3GB for guest
  return { totalMb: 2048, forGuestMb: Math.floor(2048 * MAX_MEMORY_PERCENT / 100) };
}

/**
 * Detect big.LITTLE CPU topology by parsing /proc/cpuinfo.
 * On heterogeneous SoCs (e.g., Tensor G1: X1 + A78 + A55), KVM's `-cpu host`
 * fails if QEMU threads migrate between core types with different feature sets.
 * Returns a `taskset` hex mask pinning to the LITTLE (efficiency) cores,
 * which are homogeneous and safe for KVM passthrough.
 *
 * Returns null if the CPU topology is homogeneous (no pinning needed).
 */
async function detectLittleCoresMask(bridge: import("../bridge/adb-bridge.js").AdbBridge): Promise<{
  mask: string | null;
  isHeterogeneous: boolean;
  littleCores: number[];
  totalCores: number;
  description: string;
}> {
  try {
    const result = await bridge.shell(
      "grep -E '^processor|^CPU part' /proc/cpuinfo 2>/dev/null",
      { ignoreExitCode: true, timeout: 5000 }
    );

    const lines = result.stdout.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const cores: Array<{ id: number; part: string }> = [];
    let currentId = -1;

    for (const line of lines) {
      const procMatch = line.match(/^processor\s*:\s*(\d+)/);
      if (procMatch) {
        currentId = parseInt(procMatch[1], 10);
        continue;
      }
      const partMatch = line.match(/^CPU part\s*:\s*(0x[0-9a-fA-F]+)/);
      if (partMatch && currentId >= 0) {
        cores.push({ id: currentId, part: partMatch[1].toLowerCase() });
        currentId = -1;
      }
    }

    if (cores.length === 0) {
      return { mask: null, isHeterogeneous: false, littleCores: [], totalCores: 0, description: "unknown topology" };
    }

    // Check if all cores have the same CPU part
    const uniqueParts = new Set(cores.map(c => c.part));
    if (uniqueParts.size <= 1) {
      return {
        mask: null,
        isHeterogeneous: false,
        littleCores: cores.map(c => c.id),
        totalCores: cores.length,
        description: `homogeneous (${cores.length} cores, part ${cores[0].part})`,
      };
    }

    // Heterogeneous: find the LITTLE cores (smallest CPU part number = efficiency cores)
    // ARM convention: smaller part numbers = smaller/efficiency cores
    // A55=0xd05, A78=0xd41, X1=0xd44, A76=0xd0b, etc.
    const partCounts = new Map<string, number[]>();
    for (const core of cores) {
      const list = partCounts.get(core.part) ?? [];
      list.push(core.id);
      partCounts.set(core.part, list);
    }

    // Sort parts numerically — smallest is LITTLE
    const sortedParts = [...partCounts.entries()].sort(
      ([a], [b]) => parseInt(a, 16) - parseInt(b, 16)
    );

    const littleCores = sortedParts[0][1].sort((a, b) => a - b);

    // Build hex mask for taskset
    let maskBits = 0;
    for (const coreId of littleCores) {
      maskBits |= (1 << coreId);
    }
    const mask = maskBits.toString(16);

    const partLabels = sortedParts.map(([part, ids]) => `${part}×${ids.length}`).join(" + ");

    return {
      mask,
      isHeterogeneous: true,
      littleCores,
      totalCores: cores.length,
      description: `heterogeneous big.LITTLE (${partLabels}), LITTLE cores: [${littleCores.join(",")}]`,
    };
  } catch {
    return { mask: null, isHeterogeneous: false, littleCores: [], totalCores: 0, description: "detection failed" };
  }
}

/** Track spawned QEMU VM processes. Key = VM name. */
interface QemuVmInfo {
  process: ChildProcess;
  name: string;
  imagePath: string;
  adbPort: number;
  memoryMb: number;
  cpus: number;
  startTime: number;
  pid: number | null;
  /** Actual QEMU process PID (from -pidfile). Differs from pid when root-elevated. */
  qemuPid: number | null;
  /** Path to QEMU's pidfile for cleanup. */
  pidFile: string | null;
  rootElevated: boolean;
  /** Whether we have an active ADB connection to the guest. */
  connected: boolean;
  /** Guest ADB serial string, e.g., "localhost:5556". Only set when connected. */
  guestSerial: string | null;
}

const runningVms = new Map<string, QemuVmInfo>();

function getImageDir(tempDir: string): string {
  return join(tempDir, "qemu-images");
}

/** Sanitize a VM/image name for safe filesystem use. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);
}

/**
 * Escape a single shell argument for safe use inside `su -c "<cmd>"`.
 *
 * Unconditionally wraps the argument in single quotes and escapes any
 * internal single quotes using the canonical `'\''` close-reopen pattern.
 * This is the same robust escape used by shellEscape() in sanitize.ts,
 * applied at the argv level so every QEMU arg is individually safe.
 *
 * A previous heuristic ("only quote if the arg contains =/,/:") missed
 * injection payloads like `append: "; reboot"` that contain no trigger
 * chars but still break shell parsing. Don't be clever — quote everything.
 *
 * Exported for unit testing; see tests/test-security.mjs.
 */
export function escapeQemuShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Verify that a path is contained within the image directory.
 * Prevents path traversal attacks via image name manipulation.
 */
function verifyContainment(filePath: string, imageDir: string): boolean {
  const resolved = resolve(filePath);
  const resolvedDir = resolve(imageDir);
  return resolved.startsWith(resolvedDir + "/") || resolved.startsWith(resolvedDir + "\\");
}

/**
 * Find the `adb` binary in the system PATH.
 * Required for guest ADB connectivity (connecting to VMs).
 * Returns null if not found — the tool will suggest installation instructions.
 *
 * SECURITY: The path is discovered from the system, never user-supplied.
 * Only standard Termux locations are checked.
 */
function findAdbBinary(): string | null {
  try {
    const result = spawnSync("which", ["adb"], { timeout: 3000 });
    if (result.status === 0 && result.stdout) {
      const path = result.stdout.toString().trim();
      if (path.length > 0 && existsSync(path)) return path;
    }
  } catch { /* which not available or failed */ }

  // Fallback: common Termux location
  const termuxAdb = "/data/data/com.termux/files/usr/bin/adb";
  if (existsSync(termuxAdb)) return termuxAdb;

  return null;
}

/**
 * Execute an ADB command directly using the system adb binary.
 * Bypasses the bridge (which uses LocalBridge in on-device mode) because
 * guest ADB connectivity requires the actual ADB client/server protocol.
 *
 * SECURITY: Only called with internally-constructed arguments (never raw user input).
 * Host/port values are derived from the runningVms map, not user-supplied.
 */
function execAdb(adbPath: string, args: string[], timeout = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(adbPath, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error?.code != null ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

/** Register cleanup to disconnect and kill all QEMU VMs on process exit. */
function updateCleanup(): void {
  if (runningVms.size > 0) {
    registerCleanup("qemu-vms", () => {
      const adbPath = findAdbBinary();
      for (const [, vm] of runningVms) {
        // Disconnect guest ADB before killing QEMU (best-effort, sync)
        if (vm.connected && vm.guestSerial && adbPath) {
          try {
            spawnSync(adbPath, ["disconnect", vm.guestSerial], { timeout: 3000 });
          } catch { /* best-effort */ }
          LocalBridge.unregisterGuestDevice(vm.guestSerial);
        }
        try { vm.process.kill("SIGKILL"); } catch { /* ignore */ }
        // Root-elevated: kill actual QEMU child by stored PID
        if (vm.rootElevated && vm.qemuPid) {
          try {
            spawnSync("su", ["-c", `kill -9 ${vm.qemuPid} 2>/dev/null; true`], { timeout: 3000 });
          } catch { /* best-effort */ }
        }
        if (vm.pidFile) {
          try {
            spawnSync("su", ["-c", `rm -f '${vm.pidFile.replace(/'/g, "'\\''")}' 2>/dev/null; true`], { timeout: 2000 });
          } catch { /* ignore */ }
        }
      }
    });
  } else {
    unregisterCleanup("qemu-vms");
  }
}

export function registerQemuTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_qemu_setup",
    "Check and install QEMU for on-device virtualization. Verifies KVM availability, checks if QEMU is installed, reports version info, and can install QEMU via Termux package manager. Only available in on-device mode.",
    {
      install: z.boolean().optional().default(false)
        .describe("If true, install QEMU via pkg if not already present"),
    },
    async ({ install }) => {
      try {
        if (!isOnDevice()) {
          return {
            content: [{ type: "text", text: "QEMU tools are only available in on-device mode (Termux). Use adb_emulator_start for AVD management on desktop." }],
            isError: true,
          };
        }

        const sections: string[] = [];
        sections.push("=== QEMU/KVM Setup ===");

        // Check KVM
        const kvmAvailable = existsSync("/dev/kvm");
        sections.push(`\nKVM: ${kvmAvailable ? "✓ /dev/kvm available — hardware acceleration enabled" : "✗ /dev/kvm not found — VMs will be very slow"}`);

        // Check QEMU installation
        let qemuVersion = "";
        let qemuInstalled = false;
        try {
          const result = await ctx.bridge.shell("qemu-system-aarch64 --version 2>&1 | head -1", {
            ignoreExitCode: true, timeout: 5000,
          });
          if (result.stdout.includes("QEMU")) {
            qemuInstalled = true;
            qemuVersion = result.stdout.trim();
          }
        } catch { /* not installed */ }

        if (qemuInstalled) {
          sections.push(`QEMU: ✓ ${qemuVersion}`);
        } else if (install) {
          sections.push("QEMU: not installed — installing...");
          try {
            const installResult = await ctx.bridge.shell(
              "pkg install -y qemu-system-aarch64-headless qemu-utils 2>&1",
              { timeout: 120000, ignoreExitCode: true }
            );
            if (installResult.stdout.includes("Setting up") || installResult.stdout.includes("already the newest")) {
              sections.push("✓ QEMU installed successfully.");
              // Verify
              const verResult = await ctx.bridge.shell("qemu-system-aarch64 --version 2>&1 | head -1", {
                ignoreExitCode: true, timeout: 5000,
              });
              if (verResult.stdout.includes("QEMU")) {
                sections.push(`Version: ${verResult.stdout.trim()}`);
              }
            } else {
              sections.push(`Installation output:\n${installResult.stdout.substring(0, 500)}`);
            }
          } catch (e) {
            sections.push(`✗ Installation failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          sections.push("QEMU: ✗ not installed");
          sections.push("Install with: adb_qemu_setup install=true");
          sections.push("  or manually: pkg install qemu-system-aarch64-headless qemu-utils");
        }

        // Check qemu-img tool
        try {
          const imgResult = await ctx.bridge.shell("qemu-img --version 2>&1 | head -1", {
            ignoreExitCode: true, timeout: 5000,
          });
          if (imgResult.stdout.includes("qemu-img")) {
            sections.push(`qemu-img: ✓ ${imgResult.stdout.trim()}`);
          }
        } catch { /* not available */ }

        // Image directory
        const imageDir = getImageDir(ctx.config.tempDir);
        if (!existsSync(imageDir)) mkdirSync(imageDir, { recursive: true });
        sections.push(`\nImage directory: ${imageDir}`);

        // Host resource detection for VM allocation guidance
        const cpuInfo = await detectMaxCpus(ctx.bridge);
        const memInfo = await detectMaxMemoryMb(ctx.bridge);
        sections.push(`\nHost resources:`);
        sections.push(`  CPU cores: ${cpuInfo.total} total → ${cpuInfo.forGuest} available for VMs (1 reserved for host)`);
        sections.push(`  Memory: ${memInfo.totalMb} MB total → ${memInfo.forGuestMb} MB available for VMs (${MAX_MEMORY_PERCENT}% limit)`);

        // CPU topology (big.LITTLE detection)
        const topology = await detectLittleCoresMask(ctx.bridge);
        sections.push(`  CPU topology: ${topology.description}`);
        if (topology.isHeterogeneous && topology.mask) {
          sections.push(`  KVM strategy: pin to LITTLE cores [${topology.littleCores.join(",")}] via taskset 0x${topology.mask}`);
        }

        // Running VMs
        sections.push(`Running VMs: ${runningVms.size}`);

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_qemu_images",
    "Manage QEMU disk images for virtual machines. List available images, create new qcow2/raw disk images, or delete existing ones. Images are stored in the DeepADB image directory.",
    {
      action: z.enum(["list", "create", "delete"]).describe("Action to perform"),
      name: z.string().optional().describe("Image name (for create/delete). Alphanumeric, hyphens, underscores only."),
      sizeMb: z.number().min(64).max(65536).optional().default(8192)
        .describe("Image size in MB (for create). Default 8192 (8GB). Range: 64-65536."),
      format: z.enum(["qcow2", "raw"]).optional().default("qcow2")
        .describe("Image format. qcow2 is recommended (sparse, snapshots). raw for maximum I/O performance."),
    },
    async ({ action, name, sizeMb, format }) => {
      try {
        if (!isOnDevice()) {
          return { content: [{ type: "text", text: "QEMU tools are only available in on-device mode." }], isError: true };
        }

        const imageDir = getImageDir(ctx.config.tempDir);
        if (!existsSync(imageDir)) mkdirSync(imageDir, { recursive: true });

        if (action === "list") {
          const files = readdirSync(imageDir)
            .filter(f => f.endsWith(".qcow2") || f.endsWith(".img") || f.endsWith(".raw"))
            .sort();

          if (files.length === 0) {
            return { content: [{ type: "text", text: `No disk images found.\nCreate one with: adb_qemu_images action="create" name="myvm"\nImage directory: ${imageDir}` }] };
          }

          const lines: string[] = [`${files.length} disk image(s):\n`];
          for (const file of files) {
            try {
              const stat = statSync(join(imageDir, file));
              const sizeMbStr = (stat.size / (1024 * 1024)).toFixed(1);
              lines.push(`  ${file} — ${sizeMbStr} MB on disk`);
            } catch {
              lines.push(`  ${file} — (stat failed)`);
            }
          }

          // Show running VMs
          if (runningVms.size > 0) {
            lines.push(`\nRunning VMs: ${Array.from(runningVms.keys()).join(", ")}`);
          }

          lines.push(`\nImage directory: ${imageDir}`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        if (!name) {
          return { content: [{ type: "text", text: "Image name is required for create/delete actions." }], isError: true };
        }

        const safeName = sanitizeName(name);
        const ext = format === "raw" ? ".raw" : ".qcow2";
        const imagePath = join(imageDir, safeName + ext);

        // Path containment check
        if (!verifyContainment(imagePath, imageDir)) {
          return { content: [{ type: "text", text: "Invalid image name — path traversal detected." }], isError: true };
        }

        if (action === "create") {
          if (existsSync(imagePath)) {
            return { content: [{ type: "text", text: `Image already exists: ${safeName}${ext}` }], isError: true };
          }

          // Use qemu-img to create the image
          const createResult = await ctx.bridge.shell(
            `qemu-img create -f ${format} '${imagePath.replace(/'/g, "'\\''")}' ${sizeMb}M 2>&1`,
            { timeout: 30000, ignoreExitCode: true }
          );

          if (existsSync(imagePath)) {
            const stat = statSync(imagePath);
            return {
              content: [{
                type: "text",
                text: `✓ Image created: ${safeName}${ext}\nFormat: ${format}\nVirtual size: ${sizeMb} MB\nActual size: ${(stat.size / (1024 * 1024)).toFixed(1)} MB\nPath: ${imagePath}`,
              }],
            };
          } else {
            return {
              content: [{ type: "text", text: `Failed to create image: ${createResult.stdout || createResult.stderr}\nIs qemu-utils installed? Run: adb_qemu_setup install=true` }],
              isError: true,
            };
          }
        }

        if (action === "delete") {
          // Check both extensions
          const candidates = [
            join(imageDir, safeName + ".qcow2"),
            join(imageDir, safeName + ".raw"),
            join(imageDir, safeName + ".img"),
          ];
          const found = candidates.find(c => existsSync(c));

          if (!found) {
            return { content: [{ type: "text", text: `Image not found: ${safeName}` }], isError: true };
          }

          // Don't delete if a VM is using it
          for (const [vmName, vm] of runningVms) {
            if (resolve(vm.imagePath) === resolve(found)) {
              return { content: [{ type: "text", text: `Cannot delete — image is in use by running VM '${vmName}'.` }], isError: true };
            }
          }

          if (!verifyContainment(found, imageDir)) {
            return { content: [{ type: "text", text: "Invalid path — containment check failed." }], isError: true };
          }

          unlinkSync(found);
          return { content: [{ type: "text", text: `✓ Deleted: ${basename(found)}` }] };
        }

        return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_qemu_start",
    "Boot a QEMU virtual machine with KVM hardware acceleration. Auto-detects optimal resource allocation: uses total cores minus 1 for the VM (reserving one for the host OS), and up to 65% of physical RAM. Custom values are accepted but capped at safe limits to prevent host starvation.",
    {
      name: z.string().describe("VM name (used to track and stop the VM)"),
      image: z.string().describe("Disk image filename (from adb_qemu_images) or absolute path"),
      memoryMb: z.number().min(128).max(65536).optional()
        .describe("RAM in MB. Auto-detected if omitted (65% of physical RAM). Capped at safe limit."),
      cpus: z.number().min(1).max(64).optional()
        .describe("Virtual CPUs. Auto-detected if omitted (total cores minus 1). Capped at safe limit."),
      adbPort: z.number().min(1024).max(65535).optional().default(5556)
        .describe("Host port to forward to guest ADB (port 5555). Default 5556."),
      kernel: z.string().optional()
        .describe("Path to kernel image (for Android boot). If omitted, QEMU uses the disk image's bootloader."),
      initrd: z.string().optional()
        .describe("Path to initrd/ramdisk image (for Android boot)."),
      append: z.string().optional()
        .describe("Kernel command line arguments (for Android boot)."),
      display: z.enum(["none", "vnc"]).optional().default("none")
        .describe("Display output. 'none' for headless (default). 'vnc' starts a VNC server on port 5900."),
    },
    async ({ name, image, memoryMb, cpus, adbPort, kernel, initrd, append, display }) => {
      try {
        if (!isOnDevice()) {
          return { content: [{ type: "text", text: "QEMU tools are only available in on-device mode." }], isError: true };
        }

        const safeName = sanitizeName(name);

        if (runningVms.has(safeName)) {
          return { content: [{ type: "text", text: `VM '${safeName}' is already running. Stop it first with adb_qemu_stop.` }], isError: true };
        }

        if (runningVms.size >= MAX_VMS) {
          return { content: [{ type: "text", text: `Maximum ${MAX_VMS} concurrent VMs reached. Stop a VM first.` }], isError: true };
        }

        // ── Auto-detect and cap resources ──
        const cpuInfo = await detectMaxCpus(ctx.bridge);
        const memInfo = await detectMaxMemoryMb(ctx.bridge);

        // Account for resources already consumed by running VMs
        let usedCpus = 0;
        let usedMemMb = 0;
        for (const [, vm] of runningVms) {
          usedCpus += vm.cpus;
          usedMemMb += vm.memoryMb;
        }

        // Remaining pool: host ALWAYS keeps 1 core no matter what.
        // If the pool is exhausted, refuse to start rather than starving the host.
        const availableCpus = cpuInfo.forGuest - usedCpus;
        const availableMemMb = memInfo.forGuestMb - usedMemMb;

        if (availableCpus <= 0) {
          return {
            content: [{ type: "text", text: `Cannot start VM — all allocatable CPU cores are in use.\nHost has ${cpuInfo.total} cores, 1 reserved for host OS, ${usedCpus} allocated to running VMs.\nStop a VM first with adb_qemu_stop.` }],
            isError: true,
          };
        }

        if (availableMemMb < 128) {
          return {
            content: [{ type: "text", text: `Cannot start VM — insufficient memory.\n${memInfo.forGuestMb} MB allocatable (${MAX_MEMORY_PERCENT}% of ${memInfo.totalMb} MB), ${usedMemMb} MB in use by running VMs.\nStop a VM first with adb_qemu_stop.` }],
            isError: true,
          };
        }

        // Check for ADB port conflicts with running VMs
        for (const [vmName, vm] of runningVms) {
          if (vm.adbPort === adbPort) {
            return {
              content: [{ type: "text", text: `Port ${adbPort} is already in use by VM '${vmName}'.\nSpecify a different port: adb_qemu_start adbPort=${adbPort + 2}` }],
              isError: true,
            };
          }
        }

        // Apply auto-detection or cap user-provided values.
        // INVARIANT: sum of all VM CPUs must never exceed (total cores - 1).
        let actualCpus: number;
        let cpuNote = "";
        if (cpus !== undefined) {
          if (cpus > availableCpus) {
            actualCpus = availableCpus;
            cpuNote = ` (requested ${cpus}, capped to ${availableCpus} — ${cpuInfo.total} total cores, 1 reserved for host${usedCpus > 0 ? `, ${usedCpus} used by other VMs` : ""})`;
          } else {
            actualCpus = cpus;
          }
        } else {
          actualCpus = availableCpus;
          cpuNote = ` (auto: ${cpuInfo.total} total, 1 reserved for host${usedCpus > 0 ? `, ${usedCpus} used by other VMs` : ""})`;
        }

        // INVARIANT: sum of all VM memory must never exceed MAX_MEMORY_PERCENT of physical RAM.
        let actualMemMb: number;
        let memNote = "";
        if (memoryMb !== undefined) {
          if (memoryMb > availableMemMb) {
            actualMemMb = availableMemMb;
            memNote = ` (requested ${memoryMb} MB, capped to ${availableMemMb} MB — ${MAX_MEMORY_PERCENT}% of ${memInfo.totalMb} MB${usedMemMb > 0 ? `, ${usedMemMb} MB used by other VMs` : ""})`;
          } else {
            actualMemMb = memoryMb;
          }
        } else {
          // Auto: use the lesser of available pool and 2048 MB (sensible single-VM default)
          actualMemMb = Math.min(availableMemMb, 2048);
          memNote = ` (auto: ${MAX_MEMORY_PERCENT}% of ${memInfo.totalMb} MB${usedMemMb > 0 ? `, ${usedMemMb} MB used by other VMs` : ""}${availableMemMb > 2048 ? ", capped at 2048 MB" : ""})`;
        }

        // Resolve image path — check image directory first, then treat as absolute
        const imageDir = getImageDir(ctx.config.tempDir);
        let resolvedImage = image;
        if (!image.startsWith("/")) {
          // Relative name — look in image directory
          const candidates = [
            join(imageDir, image),
            join(imageDir, image + ".qcow2"),
            join(imageDir, image + ".raw"),
            join(imageDir, image + ".img"),
          ];
          const found = candidates.find(c => existsSync(c));
          if (!found) {
            return { content: [{ type: "text", text: `Image not found: ${image}\nUse adb_qemu_images action="list" to see available images.` }], isError: true };
          }
          resolvedImage = found;
        }

        if (!existsSync(resolvedImage)) {
          return { content: [{ type: "text", text: `Image file not found: ${resolvedImage}` }], isError: true };
        }

        // Check KVM
        const useKvm = existsSync("/dev/kvm");

        // Detect image format from extension.
        // Images created by adb_qemu_images have correct extensions (.qcow2 or .raw).
        // Manually placed .img files are assumed raw — use .qcow2 extension for qcow2 images.
        const fmt = resolvedImage.endsWith(".qcow2") ? "qcow2" : "raw";

        // Build QEMU command
        // Use -pidfile so QEMU writes its own PID — needed for reliable cleanup
        // when spawned via su (the su wrapper PID differs from the QEMU child PID).
        const pidFilePath = join(ctx.config.tempDir, `qemu-${safeName}.pid`);
        const qemuArgs: string[] = [
          "-M", "virt,gic-version=max",
          "-m", String(actualMemMb),
          "-smp", String(actualCpus),
          "-drive", `file=${resolvedImage},format=${fmt},if=virtio`,
          "-netdev", `user,id=net0,hostfwd=tcp::${adbPort}-:5555`,
          "-device", "virtio-net-pci,netdev=net0",
          "-pidfile", pidFilePath,
        ];

        // ── big.LITTLE / KVM handling ──
        // On heterogeneous SoCs (Tensor G1, Snapdragon 8 Gen series, Dimensity, etc.)
        // KVM's `-cpu host` fails when QEMU threads migrate between core types with
        // different feature registers. We pin to LITTLE (efficiency) cores via taskset.
        // SELinux on Android blocks untrusted_app → kvm_device access, so KVM always
        // requires root elevation via `su`.
        let cpuTopologyNote = "";
        let tasksetPrefix = "";
        const topology = useKvm ? await detectLittleCoresMask(ctx.bridge) : null;

        if (useKvm) {
          qemuArgs.unshift("-enable-kvm");
          qemuArgs.push("-cpu", "host");

          if (topology?.isHeterogeneous && topology.mask) {
            tasksetPrefix = `taskset ${topology.mask} `;
            cpuTopologyNote = `\nCPU topology: ${topology.description}\nTaskset: pinned to LITTLE cores [${topology.littleCores.join(",")}] (mask 0x${topology.mask})`;
          } else if (topology) {
            cpuTopologyNote = `\nCPU topology: ${topology.description}`;
          }
        } else {
          qemuArgs.push("-cpu", "cortex-a72");
        }

        // Display
        if (display === "vnc") {
          qemuArgs.push("-vnc", ":0");
        } else {
          qemuArgs.push("-nographic");
        }

        // Kernel/initrd/append for Android boot
        if (kernel) {
          if (!existsSync(kernel)) {
            return { content: [{ type: "text", text: `Kernel not found: ${kernel}` }], isError: true };
          }
          qemuArgs.push("-kernel", kernel);
        }
        if (initrd) {
          if (!existsSync(initrd)) {
            return { content: [{ type: "text", text: `Initrd not found: ${initrd}` }], isError: true };
          }
          qemuArgs.push("-initrd", initrd);
        }
        if (append) {
          qemuArgs.push("-append", append);
        }

        // Serial console for headless mode
        if (display === "none") {
          qemuArgs.push("-serial", "mon:stdio");
        }

        ctx.logger.info(`[qemu:${safeName}] Starting: ${tasksetPrefix}qemu-system-aarch64 ${qemuArgs.join(" ")}`);

        // KVM requires root (SELinux blocks untrusted_app → kvm_device).
        // Spawn via `su -c` with full Termux PATH/LD_LIBRARY_PATH.
        // Without KVM, spawn directly as the current user.
        let proc: ChildProcess;
        const termuxBin = "/data/data/com.termux/files/usr/bin";
        const termuxLib = "/data/data/com.termux/files/usr/lib";

        if (useKvm) {
          // Build a shell command string for su -c.
          // See escapeQemuShellArg() doc: unconditional quoting, argv-level.
          const escapedArgs = qemuArgs.map(escapeQemuShellArg).join(" ");

          const suCmd = `PATH=${termuxBin}:$PATH LD_LIBRARY_PATH=${termuxLib} ${tasksetPrefix}qemu-system-aarch64 ${escapedArgs}`;
          proc = spawn("su", ["-c", suCmd], {
            stdio: ["ignore", "pipe", "pipe"],
          });
        } else {
          proc = spawn("qemu-system-aarch64", qemuArgs, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PATH: `${process.env.PATH}:${termuxBin}` },
          });
        }

        const vmInfo: QemuVmInfo = {
          process: proc,
          name: safeName,
          imagePath: resolvedImage,
          adbPort,
          memoryMb: actualMemMb,
          cpus: actualCpus,
          startTime: Date.now(),
          pid: proc.pid ?? null,
          qemuPid: null,
          pidFile: pidFilePath,
          rootElevated: useKvm,
          connected: false,
          guestSerial: null,
        };

        runningVms.set(safeName, vmInfo);
        updateCleanup();

        let stderrOutput = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrOutput += chunk.toString();
          // Cap stderr accumulation
          if (stderrOutput.length > 4096) stderrOutput = stderrOutput.substring(stderrOutput.length - 4096);
        });

        proc.on("error", (err) => {
          ctx.logger.error(`[qemu:${safeName}] Spawn error: ${err.message}`);
          runningVms.delete(safeName);
          updateCleanup();
        });

        proc.on("exit", (code) => {
          ctx.logger.info(`[qemu:${safeName}] Exited (code: ${code})`);
          const exitedVm = runningVms.get(safeName);
          if (exitedVm) {
            if (exitedVm.guestSerial) {
              LocalBridge.unregisterGuestDevice(exitedVm.guestSerial);
            }
            exitedVm.connected = false;
            exitedVm.guestSerial = null;
          }
          runningVms.delete(safeName);
          updateCleanup();
        });

        // Wait briefly for startup errors
        await new Promise(r => setTimeout(r, 2000));

        if (!runningVms.has(safeName)) {
          const errMsg = stderrOutput.trim().split("\n").slice(0, 5).join("\n");
          return {
            content: [{ type: "text", text: `VM '${safeName}' failed to start.${errMsg ? "\n" + errMsg : ""}\n\nIs QEMU installed? Run: adb_qemu_setup install=true` }],
            isError: true,
          };
        }

        // Read the QEMU PID from the pidfile (written by QEMU's -pidfile option).
        // The pidfile is owned by root (QEMU runs elevated), so read it via su.
        // Store in vmInfo for reliable stop/cleanup without filesystem access at stop time.
        if (vmInfo.rootElevated && vmInfo.pidFile) {
          try {
            const catResult = spawnSync("su", ["-c", `cat '${vmInfo.pidFile.replace(/'/g, "'\\''")}' 2>/dev/null`], { timeout: 3000 });
            const qemuPid = parseInt(catResult.stdout?.toString().trim(), 10);
            if (qemuPid > 0) {
              vmInfo.qemuPid = qemuPid;
              ctx.logger.info(`[qemu:${safeName}] QEMU PID from pidfile: ${qemuPid} (su wrapper: ${vmInfo.pid})`);
            }
          } catch { /* pidfile may not be written yet — non-critical */ }
        }

        const sections: string[] = [];
        sections.push(`✓ VM '${safeName}' started`);
        sections.push(`PID: ${vmInfo.pid}`);
        sections.push(`Image: ${basename(resolvedImage)}`);
        sections.push(`CPUs: ${actualCpus}${cpuNote}`);
        sections.push(`Memory: ${actualMemMb} MB${memNote}`);
        sections.push(`KVM: ${useKvm ? "enabled (root-elevated)" : "disabled (software emulation)"}`);
        if (cpuTopologyNote) sections.push(cpuTopologyNote.trimStart());
        sections.push(`ADB port: ${adbPort} → guest:5555`);
        if (display === "vnc") sections.push("VNC: :0 (port 5900)");
        sections.push(`\nConnect to guest ADB: adb connect localhost:${adbPort}`);
        sections.push("Stop with: adb_qemu_stop name=\"" + safeName + "\"");

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_qemu_stop",
    "Stop a running QEMU virtual machine. Sends SIGTERM for graceful shutdown, with force kill option.",
    {
      name: z.string().optional().describe("VM name to stop. If omitted, lists running VMs."),
      force: z.boolean().optional().default(false).describe("Use SIGKILL instead of SIGTERM for immediate termination."),
    },
    async ({ name, force }) => {
      try {
        if (!name) {
          if (runningVms.size === 0) {
            return { content: [{ type: "text", text: "No QEMU VMs running." }] };
          }
          const lines = ["Running QEMU VMs:\n"];
          for (const [vmName, vm] of runningVms) {
            const uptime = Math.round((Date.now() - vm.startTime) / 1000);
            lines.push(`  ${vmName} — PID ${vm.pid}, ${vm.memoryMb}MB, port ${vm.adbPort}, uptime ${uptime}s`);
          }
          lines.push("\nProvide name to stop a specific VM.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const safeName = sanitizeName(name);
        const vm = runningVms.get(safeName);

        if (!vm) {
          return { content: [{ type: "text", text: `VM '${safeName}' is not running.` }], isError: true };
        }

        // Disconnect guest ADB before killing QEMU (prevents stale ADB entries)
        if (vm.connected && vm.guestSerial) {
          const adbPath = findAdbBinary();
          if (adbPath) {
            try {
              await execAdb(adbPath, ["disconnect", vm.guestSerial], 5000);
              ctx.deviceManager.invalidateCache();
            } catch { /* best-effort */ }
          }
          LocalBridge.unregisterGuestDevice(vm.guestSerial);
          vm.connected = false;
          vm.guestSerial = null;
        }

        try {
          vm.process.kill(force ? "SIGKILL" : "SIGTERM");
        } catch { /* already dead */ }

        // Root-elevated VMs: kill the actual QEMU child by stored PID from pidfile.
        // The su wrapper kill above orphans QEMU — this kills the real process.
        if (vm.rootElevated && vm.qemuPid) {
          try {
            spawnSync("su", ["-c", `kill -9 ${vm.qemuPid} 2>/dev/null; true`], { timeout: 5000 });
            await new Promise(r => setTimeout(r, 500));
          } catch { /* best-effort */ }
        }
        // Clean up pidfile
        if (vm.pidFile) {
          try {
            spawnSync("su", ["-c", `rm -f '${vm.pidFile.replace(/'/g, "'\\''")}' 2>/dev/null; true`], { timeout: 2000 });
          } catch { /* ignore */ }
        }

        runningVms.delete(safeName);
        updateCleanup();

        return {
          content: [{ type: "text", text: `VM '${safeName}' ${force ? "killed" : "stop signal sent"} (was PID ${vm.pid}).` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_qemu_status",
    "Show status of QEMU virtual machines — running VMs with resource usage and port mappings, plus KVM and QEMU availability.",
    {},
    async () => {
      try {
        if (!isOnDevice()) {
          return { content: [{ type: "text", text: "QEMU tools are only available in on-device mode." }], isError: true };
        }

        const sections: string[] = [];
        sections.push("=== QEMU VM Status ===");

        // KVM
        sections.push(`KVM: ${existsSync("/dev/kvm") ? "✓ available" : "✗ unavailable"}`);

        // QEMU binary
        let qemuAvailable = false;
        try {
          const result = await ctx.bridge.shell("qemu-system-aarch64 --version 2>&1 | head -1", {
            ignoreExitCode: true, timeout: 5000,
          });
          qemuAvailable = result.stdout.includes("QEMU");
          if (qemuAvailable) sections.push(`QEMU: ✓ ${result.stdout.trim()}`);
        } catch { /* not installed */ }
        if (!qemuAvailable) sections.push("QEMU: ✗ not installed");

        // Host resource detection
        const cpuInfo = await detectMaxCpus(ctx.bridge);
        const memInfo = await detectMaxMemoryMb(ctx.bridge);
        let usedCpus = 0, usedMemMb = 0;
        for (const [, vm] of runningVms) { usedCpus += vm.cpus; usedMemMb += vm.memoryMb; }

        sections.push(`\nHost resources:`);
        sections.push(`  CPU cores: ${cpuInfo.total} total, ${cpuInfo.forGuest} allocatable (1 reserved for host)`);
        sections.push(`  Memory: ${memInfo.totalMb} MB total, ${memInfo.forGuestMb} MB allocatable (${MAX_MEMORY_PERCENT}% limit)`);
        if (usedCpus > 0 || usedMemMb > 0) {
          sections.push(`  In use by VMs: ${usedCpus} CPUs, ${usedMemMb} MB`);
          sections.push(`  Available: ${Math.max(0, cpuInfo.forGuest - usedCpus)} CPUs, ${Math.max(0, memInfo.forGuestMb - usedMemMb)} MB`);
        }

        // Running VMs
        sections.push(`\nRunning VMs: ${runningVms.size}/${MAX_VMS}`);

        if (runningVms.size > 0) {
          for (const [vmName, vm] of runningVms) {
            const uptimeMs = Date.now() - vm.startTime;
            const uptimeMin = Math.floor(uptimeMs / 60000);
            const uptimeSec = Math.round((uptimeMs % 60000) / 1000);
            sections.push(`\n── ${vmName} ──`);
            sections.push(`  PID: ${vm.pid}`);
            sections.push(`  Image: ${basename(vm.imagePath)}`);
            sections.push(`  Resources: ${vm.memoryMb} MB RAM, ${vm.cpus} CPU(s)`);
            sections.push(`  ADB: localhost:${vm.adbPort} → guest:5555`);
            if (vm.connected && vm.guestSerial) {
              sections.push(`  Guest ADB: ✓ connected (serial: ${vm.guestSerial})`);
            } else {
              sections.push(`  Guest ADB: not connected (use adb_qemu_connect)`);
            }
            sections.push(`  Uptime: ${uptimeMin}m ${uptimeSec}s`);
          }
        }

        // Image inventory
        const imageDir = getImageDir(ctx.config.tempDir);
        if (existsSync(imageDir)) {
          const images = readdirSync(imageDir)
            .filter(f => f.endsWith(".qcow2") || f.endsWith(".img") || f.endsWith(".raw"));
          sections.push(`\nDisk images: ${images.length} in ${imageDir}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_qemu_connect",
    "Connect to a running QEMU VM's ADB service, making the guest appear as a device for DeepADB tools. Requires the guest OS to have an ADB daemon running (e.g., Android guest with USB debugging enabled). Requires the 'adb' binary (install with: pkg install android-tools). Connections are restricted to localhost only — no remote host connections allowed.",
    {
      name: z.string().describe("VM name to connect to (must be running)"),
      timeout: z.number().min(3000).max(30000).optional().default(10000)
        .describe("Connection timeout in milliseconds (3s-30s). Default 10s."),
    },
    async ({ name, timeout }) => {
      try {
        if (!isOnDevice()) {
          return { content: [{ type: "text", text: "QEMU tools are only available in on-device mode." }], isError: true };
        }

        const safeName = sanitizeName(name);
        const vm = runningVms.get(safeName);

        if (!vm) {
          return { content: [{ type: "text", text: `VM '${safeName}' is not running.` }], isError: true };
        }

        if (vm.connected) {
          return { content: [{ type: "text", text: `VM '${safeName}' is already connected (serial: ${vm.guestSerial}).` }] };
        }

        // Find ADB binary
        const adbPath = findAdbBinary();
        if (!adbPath) {
          return {
            content: [{
              type: "text",
              text: "ADB binary not found. Install with: pkg install android-tools\nThen retry: adb_qemu_connect",
            }],
            isError: true,
          };
        }

        // SECURITY: Only connect to localhost — never to external hosts.
        // The port is derived from the running VM's configuration, not user input.
        const guestSerial = `localhost:${vm.adbPort}`;

        // Ensure ADB server is running
        await execAdb(adbPath, ["start-server"], 10000);

        // Connect to guest ADB
        const connectResult = await execAdb(adbPath, ["connect", guestSerial], timeout);
        const output = (connectResult.stdout + connectResult.stderr).trim();

        // Check for success patterns
        const isConnected = output.includes("connected to") || output.includes("already connected");

        if (isConnected) {
          vm.connected = true;
          vm.guestSerial = guestSerial;
          LocalBridge.registerGuestDevice(guestSerial);
          ctx.deviceManager.invalidateCache();

          // Verify the guest appears in device list
          const devicesResult = await execAdb(adbPath, ["devices", "-l"], 5000);
          const guestLine = devicesResult.stdout.split("\n")
            .find(line => line.includes(guestSerial));

          const sections: string[] = [];
          sections.push(`✓ Connected to VM '${safeName}' guest ADB`);
          sections.push(`Guest serial: ${guestSerial}`);
          if (guestLine) {
            sections.push(`Device status: ${guestLine.trim()}`);
          }
          sections.push(`\nRun commands on guest: adb_qemu_guest_shell name="${safeName}" command="getprop ro.build.display.id"`);
          sections.push(`Disconnect: adb_qemu_disconnect name="${safeName}"`);

          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        return {
          content: [{
            type: "text",
            text: `Failed to connect to VM '${safeName}' on ${guestSerial}.\n${output}\n\nEnsure the guest OS has an ADB daemon running (e.g., Android with USB debugging enabled).`,
          }],
          isError: true,
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_qemu_disconnect",
    "Disconnect from a QEMU VM's ADB service. Removes the guest from the device list.",
    {
      name: z.string().describe("VM name to disconnect from"),
    },
    async ({ name }) => {
      try {
        if (!isOnDevice()) {
          return { content: [{ type: "text", text: "QEMU tools are only available in on-device mode." }], isError: true };
        }

        const safeName = sanitizeName(name);
        const vm = runningVms.get(safeName);

        if (!vm) {
          return { content: [{ type: "text", text: `VM '${safeName}' is not running.` }], isError: true };
        }

        if (!vm.connected || !vm.guestSerial) {
          return { content: [{ type: "text", text: `VM '${safeName}' is not connected.` }] };
        }

        const adbPath = findAdbBinary();
        if (!adbPath) {
          // Can't disconnect without ADB, but clear state anyway
          LocalBridge.unregisterGuestDevice(vm.guestSerial);
          vm.connected = false;
          vm.guestSerial = null;
          return { content: [{ type: "text", text: `Cleared connection state for '${safeName}' (ADB binary not found).` }] };
        }

        const serial = vm.guestSerial;
        await execAdb(adbPath, ["disconnect", serial], 5000);
        vm.connected = false;
        vm.guestSerial = null;
        LocalBridge.unregisterGuestDevice(serial);
        ctx.deviceManager.invalidateCache();

        return { content: [{ type: "text", text: `✓ Disconnected from VM '${safeName}' (was ${serial}).` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_qemu_guest_shell",
    "Execute a shell command on a QEMU guest VM via ADB. The VM must be connected first (use adb_qemu_connect). The guest serial is derived internally — no user-supplied host/IP reaches the ADB binary. Subject to the same security middleware checks as adb_shell.",
    {
      name: z.string().describe("VM name (must be connected via adb_qemu_connect)"),
      command: z.string().describe("Shell command to execute on the guest"),
      timeout: z.number().min(1000).max(60000).optional().default(15000)
        .describe("Command timeout in milliseconds (1s-60s). Default 15s."),
    },
    async ({ name, command, timeout }) => {
      try {
        if (!isOnDevice()) {
          return { content: [{ type: "text", text: "QEMU tools are only available in on-device mode." }], isError: true };
        }

        // Security: command goes through the same security middleware as adb_shell
        const blocked = ctx.security.checkCommand(command);
        if (blocked) {
          return { content: [{ type: "text", text: blocked }], isError: true };
        }

        const safeName = sanitizeName(name);
        const vm = runningVms.get(safeName);

        if (!vm) {
          return { content: [{ type: "text", text: `VM '${safeName}' is not running.` }], isError: true };
        }

        if (!vm.connected || !vm.guestSerial) {
          return {
            content: [{
              type: "text",
              text: `VM '${safeName}' is not connected. Run adb_qemu_connect first.`,
            }],
            isError: true,
          };
        }

        const adbPath = findAdbBinary();
        if (!adbPath) {
          return { content: [{ type: "text", text: "ADB binary not found. Install with: pkg install android-tools" }], isError: true };
        }

        // SECURITY: The serial is derived from the running VM's internal state (localhost:<port>).
        // It is NEVER constructed from user input. This prevents injection of arbitrary
        // host addresses into the adb command.
        const result = await execAdb(adbPath, ["-s", vm.guestSerial, "shell", command], timeout);

        if (result.exitCode !== 0 && result.stderr.includes("device offline")) {
          if (vm.guestSerial) LocalBridge.unregisterGuestDevice(vm.guestSerial);
          vm.connected = false;
          vm.guestSerial = null;
          return {
            content: [{
              type: "text",
              text: `Guest '${safeName}' is offline (ADB connection lost). Reconnect with adb_qemu_connect.`,
            }],
            isError: true,
          };
        }

        const output = result.stdout.trim() || result.stderr.trim() || "(no output)";
        return { content: [{ type: "text", text: OutputProcessor.process(output) }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}
