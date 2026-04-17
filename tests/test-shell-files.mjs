/**
 * Shell, Files & Packages Test Suite — Command execution, filesystem, and app management.
 * Tests: shell, root_shell, ls, cat, push/pull, packages, permissions.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Shell, Files & Packages");

h.section("Shell Execution");
await h.testContains("Shell → echo", "adb_shell", { command: "echo hello_DeepADB" }, "hello_DeepADB");
await h.testContains("Shell → uname", "adb_shell", { command: "uname -a" }, "Linux");
await h.testContains("Shell → id", "adb_shell", { command: "id" }, "uid=");
await h.testContains("Shell → date", "adb_shell", { command: "date" }, "2026");
await h.testContains("Root Shell → id", "adb_root_shell", { command: "id" }, "uid=0");
await h.testContains("Root Shell → whoami", "adb_root_shell", { command: "whoami" }, "root");

h.section("Filesystem Operations");
await h.test("ls /sdcard", "adb_ls", { path: "/sdcard" });
await h.test("ls /sdcard (detailed)", "adb_ls", { path: "/sdcard", details: true });
// /system/bin always contains a 'sh' binary on Android — but "sh" is too
// loose (matches "she", "shell", "shape" anywhere). Use "toybox" or "linker64"
// which are unambiguous Android system binaries present on every build.
await h.testContains("ls /system/bin", "adb_ls", { path: "/system/bin" }, "toybox");

// Create a temp file, cat it, then clean up
await h.test("Shell → create temp file", "adb_shell", { command: "echo 'DeepADB test content 12345' > /sdcard/DA_test_file.txt" });
await h.testContains("Cat temp file", "adb_cat", { path: "/sdcard/DA_test_file.txt" }, "DeepADB test content 12345");
await h.testContains("Cat with maxLines", "adb_cat", { path: "/sdcard/DA_test_file.txt", maxLines: 1 }, "DeepADB");
await h.test("Shell → remove temp file", "adb_shell", { command: "rm /sdcard/DA_test_file.txt" });

h.section("Package Management");
await h.testContains("List all packages", "adb_list_packages", { type: "all" }, "android");
await h.testContains("List system packages", "adb_list_packages", { type: "system" }, "com.android");
await h.testContains("List third-party packages", "adb_list_packages", { type: "third-party" }, "magisk");
await h.testContains("Package info (Magisk)", "adb_package_info", { packageName: "com.topjohnwu.magisk" }, "com.topjohnwu.magisk");
await h.testContains("Filter packages → magisk", "adb_list_packages", { filter: "magisk" }, "magisk");
await h.test("Resolve intents (Magisk)", "adb_resolve_intents", { packageName: "com.topjohnwu.magisk" });

h.section("Diagnostics");
await h.testContains("Dumpsys battery", "adb_dumpsys", { service: "battery" }, "level");
await h.testContains("Dumpsys list", "adb_dumpsys", { service: "list" }, "battery");
await h.test("Top (1 iteration)", "adb_top", { count: 1 });
await h.test("Network Connections", "adb_network_connections", { protocol: "all" });

h.section("Port Forwarding");
await h.test("Forward List (empty is OK)", "adb_forward_list");

const exitCode = h.finish();
process.exit(exitCode);
