/**
 * Extended File Tools Test Suite — New filesystem operations, safety protections,
 * and metrics reporting for all file tools.
 *
 * Tests: adb_push hardening, adb_file_write, adb_find, adb_file_stat,
 * adb_file_checksum, adb_mkdir, adb_rm (depth protection), adb_file_move,
 * adb_file_copy, adb_file_chmod, adb_file_touch, adb_file_fsinfo,
 * adb_file_chown, metrics on existing tools, and end-to-end lifecycle.
 *
 * Uses /sdcard/deepadb_test_files/ as a scratch area, cleaned up at end.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Extended File Tools");
const TEST_DIR = "/sdcard/deepadb_test_files";
const TEST_FILE = `${TEST_DIR}/test.txt`;

// Setup: create test directory and a seed file for read-only metric tests
await h.callTool("adb_mkdir", { path: TEST_DIR });
await h.callTool("adb_file_write", { path: `${TEST_DIR}/seed.txt`, content: "seed content for metrics tests\n" });

// ── Push Safety (hardened) ───────────────────────────────

h.section("Push Safety — Hard-Blocked Paths");

await h.testRejects("Push to /dev refuses", "adb_push",
  { localPath: "C:\\nonexistent.txt", remotePath: "/dev/null" });

await h.testRejects("Push to /proc refuses", "adb_push",
  { localPath: "C:\\nonexistent.txt", remotePath: "/proc/test" });

await h.testRejects("Push to /sys refuses", "adb_push",
  { localPath: "C:\\nonexistent.txt", remotePath: "/sys/test" });

await h.testRejects("Push to root refuses", "adb_push",
  { localPath: "C:\\nonexistent.txt", remotePath: "/" });

// ── Existing Tool Metrics ───────────────────────────────

h.section("Existing Tool Metrics");

await h.testContains("ls has execution time", "adb_ls",
  { path: "/sdcard" }, "Execution time:");

await h.testContains("cat has execution time", "adb_cat",
  { path: `${TEST_DIR}/seed.txt` }, "Execution time:");

// ── File Write ──────────────────────────────────────────

h.section("File Write");

await h.testContains("Write creates file", "adb_file_write",
  { path: TEST_FILE, content: "line one\nline two\nline three\n" }, "write");

await h.testContains("Write reports storage", "adb_file_write",
  { path: `${TEST_DIR}/storage_test.txt`, content: "test" }, "Available storage:");

await h.testContains("Write reports execution time", "adb_file_write",
  { path: `${TEST_DIR}/timing_test.txt`, content: "test" }, "Execution time:");

await h.testContains("Append mode works", "adb_file_write",
  { path: TEST_FILE, content: "line four\n", append: true }, "append");

// Verify append actually appended (cat should show all 4 lines)
await h.testContains("Append content verified", "adb_cat",
  { path: TEST_FILE }, "line four");

await h.testRejects("Write to /dev refuses", "adb_file_write",
  { path: "/dev/null", content: "test" });

await h.testRejects("Write to /proc refuses", "adb_file_write",
  { path: "/proc/test", content: "test" });

// ── File Find ───────────────────────────────────────────

h.section("File Find");

await h.testContains("Find locates test files", "adb_find",
  { searchPath: TEST_DIR, name: "*.txt" }, "result(s)");

await h.testContains("Find shows execution time", "adb_find",
  { searchPath: TEST_DIR, name: "*.txt" }, "Execution time:");

await h.testContains("Find no results is clean", "adb_find",
  { searchPath: TEST_DIR, name: "*.nonexistent_ext" }, "No files matching");

await h.testContains("Find respects maxResults", "adb_find",
  { searchPath: TEST_DIR, name: "*.txt", maxResults: 1 }, "1 result");

// ── File Stat ───────────────────────────────────────────

h.section("File Stat");

await h.testContains("Stat shows file size", "adb_file_stat",
  { path: TEST_FILE }, "Size:");

await h.testContains("Stat shows permissions", "adb_file_stat",
  { path: TEST_FILE }, "Access:");

await h.testContains("Stat shows execution time", "adb_file_stat",
  { path: TEST_FILE }, "Execution time:");

await h.testRejects("Stat nonexistent file errors", "adb_file_stat",
  { path: "/sdcard/nonexistent_file_xyz_12345.txt" });

// ── File Checksum ───────────────────────────────────────

h.section("File Checksum");

await h.testContains("SHA-256 hash computed", "adb_file_checksum",
  { path: TEST_FILE }, "Hash:");

await h.testContains("SHA-256 shows algorithm", "adb_file_checksum",
  { path: TEST_FILE }, "SHA256");

await h.testContains("MD5 hash computed", "adb_file_checksum",
  { path: TEST_FILE, algorithm: "md5" }, "MD5");

await h.testContains("Checksum shows file size", "adb_file_checksum",
  { path: TEST_FILE }, "File size:");

await h.testRejects("Checksum nonexistent file errors", "adb_file_checksum",
  { path: "/sdcard/nonexistent_file_xyz_12345.txt" });

// ── Mkdir ───────────────────────────────────────────────

h.section("Mkdir");

await h.testContains("Mkdir creates nested directory", "adb_mkdir",
  { path: `${TEST_DIR}/sub/nested` }, "mkdir");

await h.testContains("Mkdir shows execution time", "adb_mkdir",
  { path: `${TEST_DIR}/timed_dir` }, "Execution time:");

await h.testRejects("Mkdir /dev refuses", "adb_mkdir",
  { path: "/dev/testdir" });

await h.testRejects("Mkdir /proc refuses", "adb_mkdir",
  { path: "/proc/testdir" });

// ── Rm — Depth Protection ───────────────────────────────

h.section("Rm — Depth Protection");

// Create a sacrificial file for single-file delete
await h.callTool("adb_file_write", { path: `${TEST_DIR}/to_delete.txt`, content: "delete me" });

await h.testContains("Rm single file works", "adb_rm",
  { path: `${TEST_DIR}/to_delete.txt` }, "delete");

await h.testContains("Rm shows execution time", "adb_rm",
  { path: `${TEST_DIR}/timing_test.txt` }, "Execution time:");

await h.testRejects("Rm -rf / refuses", "adb_rm",
  { path: "/", recursive: true });

await h.testRejects("Rm -rf /system refuses (depth 1)", "adb_rm",
  { path: "/system", recursive: true });

await h.testRejects("Rm -rf /sdcard refuses (depth 1)", "adb_rm",
  { path: "/sdcard", recursive: true });

await h.testRejects("Rm -rf /system/app refuses (depth 2)", "adb_rm",
  { path: "/system/app", recursive: true });

await h.testRejects("Rm /dev refuses", "adb_rm",
  { path: "/dev/null" });

// Recursive delete at sufficient depth should work
await h.callTool("adb_mkdir", { path: `${TEST_DIR}/sub/nested/deep` });
await h.callTool("adb_file_write", { path: `${TEST_DIR}/sub/nested/deep/file.txt`, content: "deep" });

await h.testContains("Rm -rf at depth 4 succeeds", "adb_rm",
  { path: `${TEST_DIR}/sub/nested/deep`, recursive: true }, "delete (recursive)");

// ── File Move ───────────────────────────────────────────

h.section("File Move");

// Create a file to move
await h.callTool("adb_file_write", { path: `${TEST_DIR}/move_source.txt`, content: "move me" });

await h.testContains("Move file succeeds", "adb_file_move",
  { source: `${TEST_DIR}/move_source.txt`, destination: `${TEST_DIR}/moved.txt` }, "move");

await h.testContains("Move shows verified", "adb_file_move",
  // need a new source since the old one was moved
  { source: `${TEST_DIR}/moved.txt`, destination: `${TEST_DIR}/moved_back.txt` }, "Verified");

await h.testRejects("Move source depth 1 refuses", "adb_file_move",
  { source: "/system", destination: "/sdcard/system_backup" });

await h.testRejects("Move to /dev refuses", "adb_file_move",
  { source: `${TEST_DIR}/moved_back.txt`, destination: "/dev/null" });

await h.testContains("Move shows execution time", "adb_file_move",
  // move back to clean up
  { source: `${TEST_DIR}/moved_back.txt`, destination: `${TEST_DIR}/final_moved.txt` }, "Execution time:");

// ── File Copy ───────────────────────────────────────────

h.section("File Copy");

await h.testContains("Copy file succeeds", "adb_file_copy",
  { source: TEST_FILE, destination: `${TEST_DIR}/copied.txt` }, "copy");

await h.testContains("Copy shows size verification", "adb_file_copy",
  { source: TEST_FILE, destination: `${TEST_DIR}/copied2.txt` }, "Size verification");

await h.testContains("Copy shows available storage", "adb_file_copy",
  { source: TEST_FILE, destination: `${TEST_DIR}/copied3.txt` }, "Available storage:");

await h.testRejects("Copy to /dev refuses", "adb_file_copy",
  { source: TEST_FILE, destination: "/dev/null" });

// ── File Chmod ───────────────────────────────────────────

h.section("File Chmod");

await h.testContains("Chmod shows resulting permissions", "adb_file_chmod",
  { path: TEST_FILE, mode: "644", root: true }, "Resulting permissions:");

await h.testContains("Chmod shows execution time", "adb_file_chmod",
  { path: TEST_FILE, mode: "644", root: true }, "Execution time:");

await h.testRejects("Chmod recursive depth 1 refuses", "adb_file_chmod",
  { path: "/system", mode: "755", recursive: true, root: true });

await h.testRejects("Chmod recursive depth 2 refuses", "adb_file_chmod",
  { path: "/system/app", mode: "755", recursive: true, root: true });

await h.testRejects("Chmod /dev refuses", "adb_file_chmod",
  { path: "/dev/null", mode: "666", root: true });

// Zod rejects invalid mode (not octal)
await h.testRejects("Chmod invalid mode rejects", "adb_file_chmod",
  { path: TEST_FILE, mode: "abc" });

// ── File Touch ───────────────────────────────────────────

h.section("File Touch");

await h.testContains("Touch creates new file", "adb_file_touch",
  { path: `${TEST_DIR}/touched_new.txt` }, "created");

await h.testContains("Touch updates existing file", "adb_file_touch",
  { path: `${TEST_DIR}/touched_new.txt` }, "updated");

await h.testContains("Touch with explicit timestamp", "adb_file_touch",
  { path: `${TEST_DIR}/touched_new.txt`, timestamp: "2024-01-15 10:30:00" }, "timestamp set");

await h.testContains("Touch shows resulting timestamps", "adb_file_touch",
  { path: `${TEST_DIR}/touched_new.txt` }, "Resulting timestamps:");

await h.testRejects("Touch /dev refuses", "adb_file_touch",
  { path: "/dev/test_touch" });

await h.testRejects("Touch invalid timestamp rejects", "adb_file_touch",
  { path: `${TEST_DIR}/touched_new.txt`, timestamp: "not-a-date" });

// ── Filesystem Info ──────────────────────────────────────

h.section("Filesystem Info");

await h.testContains("Fsinfo shows filesystem type", "adb_file_fsinfo",
  { path: "/sdcard" }, "Filesystem type:");

await h.testContains("Fsinfo shows capacity", "adb_file_fsinfo",
  { path: "/sdcard" }, "Capacity:");

await h.testContains("Fsinfo shows capabilities", "adb_file_fsinfo",
  { path: "/sdcard" }, "Supports Unix permissions:");

await h.testContains("Fsinfo shows mount info", "adb_file_fsinfo",
  { path: "/sdcard" }, "Mount point:");

await h.testContains("Fsinfo shows execution time", "adb_file_fsinfo",
  { path: "/sdcard" }, "Execution time:");

// ── File Chown ──────────────────────────────────────────

h.section("File Chown");

await h.testContains("Chown shows resulting ownership", "adb_file_chown",
  { path: TEST_FILE, owner: "0:0" }, "Resulting ownership:");

await h.testContains("Chown shows execution time", "adb_file_chown",
  { path: TEST_FILE, owner: "0:0" }, "Execution time:");

await h.testRejects("Chown recursive depth 1 refuses", "adb_file_chown",
  { path: "/system", owner: "0:0", recursive: true });

await h.testRejects("Chown /dev refuses", "adb_file_chown",
  { path: "/dev/null", owner: "0:0" });

// Zod rejects invalid owner format
await h.testRejects("Chown invalid owner format rejects", "adb_file_chown",
  { path: TEST_FILE, owner: "root" });

// ── Grep ────────────────────────────────────────────────

h.section("Grep");

// Write a multi-line file for grep testing
await h.callTool("adb_file_write", { path: `${TEST_DIR}/grep_target.txt`, content: "hello world\nfoo bar baz\nHELLO AGAIN\ntest line four\n" });

await h.testContains("Grep finds case-insensitive match", "adb_grep",
  { pattern: "hello", path: `${TEST_DIR}/grep_target.txt` }, "match");

await h.testContains("Grep case-sensitive excludes uppercase", "adb_grep",
  { pattern: "hello", path: `${TEST_DIR}/grep_target.txt`, ignoreCase: false }, "1 match");

await h.testContains("Grep shows line numbers", "adb_grep",
  { pattern: "foo", path: `${TEST_DIR}/grep_target.txt` }, "2:");

await h.testContains("Grep no match is clean", "adb_grep",
  { pattern: "nonexistent_xyz", path: `${TEST_DIR}/grep_target.txt` }, "No matches");

await h.testContains("Grep shows execution time", "adb_grep",
  { pattern: "hello", path: `${TEST_DIR}/grep_target.txt` }, "Execution time:");

await h.testContains("Grep recursive finds files", "adb_grep",
  { pattern: "hello", path: TEST_DIR, recursive: true }, "match");

// ── File Replace ────────────────────────────────────────

h.section("File Replace");

// Write a fresh file for replace testing
await h.callTool("adb_file_write", { path: `${TEST_DIR}/replace_target.txt`, content: "aaa bbb ccc\naaa ddd eee\nfff ggg hhh\n" });

await h.testContains("Replace reports match count", "adb_file_replace",
  { path: `${TEST_DIR}/replace_target.txt`, find: "aaa", replace: "ZZZ" }, "Lines with matches: 2");

// Verify replacement happened
await h.testContains("Replace content verified", "adb_cat",
  { path: `${TEST_DIR}/replace_target.txt` }, "ZZZ");

await h.testNotContains("Replace removed original text", "adb_cat",
  { path: `${TEST_DIR}/replace_target.txt` }, "aaa");

// Replace with backup
await h.callTool("adb_file_write", { path: `${TEST_DIR}/backup_test.txt`, content: "before\n" });
await h.testContains("Replace creates backup", "adb_file_replace",
  { path: `${TEST_DIR}/backup_test.txt`, find: "before", replace: "after", backup: true }, "Backup:");

await h.testContains("Backup file exists", "adb_file_stat",
  { path: `${TEST_DIR}/backup_test.txt.bak` }, "regular file");

await h.testContains("Replace no match reports zero", "adb_file_replace",
  { path: `${TEST_DIR}/replace_target.txt`, find: "nonexistent_xyz", replace: "anything" }, "No matches");

await h.testRejects("Replace /dev refuses", "adb_file_replace",
  { path: "/dev/null", find: "x", replace: "y" });

await h.testContains("Replace shows execution time", "adb_file_replace",
  { path: `${TEST_DIR}/replace_target.txt`, find: "ZZZ", replace: "final" }, "Execution time:");

// ── Replace — Injection Regression ──────────────────────
// The sed escapers must neutralize single quotes, and the Zod layer must
// reject newlines. Without these, a crafted find/replace value could
// close the surrounding shell single-quote and execute arbitrary commands.

// Seed a canary file that must NOT be touched by any injection attempt
await h.callTool("adb_file_write", { path: `${TEST_DIR}/canary.txt`, content: "UNTOUCHED\n" });

// Write a file whose content literally contains a single-quote — proves
// the escaper reaches sed's fixed-string matcher intact
await h.callTool("adb_file_write", { path: `${TEST_DIR}/quote_target.txt`, content: "a 'quoted' b\nno match here\n" });

await h.testContains("Replace handles single quotes in find", "adb_file_replace",
  { path: `${TEST_DIR}/quote_target.txt`, find: "'quoted'", replace: "SAFE" }, "Lines with matches: 1");

await h.testContains("Replace single-quote content verified", "adb_cat",
  { path: `${TEST_DIR}/quote_target.txt` }, "a SAFE b");

// Single-quote in replacement must also be handled
await h.callTool("adb_file_write", { path: `${TEST_DIR}/quote_replace.txt`, content: "plain\n" });

await h.testContains("Replace handles single quotes in replacement", "adb_file_replace",
  { path: `${TEST_DIR}/quote_replace.txt`, find: "plain", replace: "it's fine" }, "Lines with matches: 1");

await h.testContains("Replace single-quote replacement verified", "adb_cat",
  { path: `${TEST_DIR}/quote_replace.txt`, }, "it's fine");

// Injection attempt: find value designed to break shell quoting.
// The payload tries to drop a "PWNED" marker into the canary — if the
// escaper is broken, canary.txt ends with "PWNED" appended.
const INJECTION_PAYLOAD = `';echo PWNED >> ${TEST_DIR}/canary.txt;echo '`;
await h.callTool("adb_file_replace", {
  path: `${TEST_DIR}/replace_target.txt`,
  find: INJECTION_PAYLOAD,
  replace: "harmless",
}).catch(() => {}); // may error or succeed — what matters is canary integrity

await h.testNotContains("Canary unaffected by single-quote injection", "adb_cat",
  { path: `${TEST_DIR}/canary.txt` }, "PWNED");

// Zod must reject newlines in find
await h.testRejects("Replace rejects newline in find", "adb_file_replace",
  { path: `${TEST_DIR}/replace_target.txt`, find: "line one\nline two", replace: "x" });

// Zod must reject newlines in replace
await h.testRejects("Replace rejects newline in replace", "adb_file_replace",
  { path: `${TEST_DIR}/replace_target.txt`, find: "x", replace: "a\nb" });

// ── End-to-End Lifecycle ─────────────────────────────────

h.section("End-to-End Lifecycle");

// Lifecycle: write → stat → checksum → copy → compare checksums → rm
const LC_FILE = `${TEST_DIR}/lifecycle.txt`;
const LC_COPY = `${TEST_DIR}/lifecycle_copy.txt`;
const LC_CONTENT = "lifecycle test content\nwith multiple lines\n";

await h.testContains("Lifecycle: write", "adb_file_write",
  { path: LC_FILE, content: LC_CONTENT }, "write");

await h.testContains("Lifecycle: stat confirms file", "adb_file_stat",
  { path: LC_FILE }, "regular file");

const hashRes = await h.callTool("adb_file_checksum", { path: LC_FILE });
const origHash = h.getText(hashRes).match(/Hash:\s+([a-f0-9]+)/)?.[1] ?? "";

await h.testContains("Lifecycle: copy", "adb_file_copy",
  { source: LC_FILE, destination: LC_COPY }, "copy");

// Verify copy has same hash as original
const copyHashRes = await h.callTool("adb_file_checksum", { path: LC_COPY });
const copyHash = h.getText(copyHashRes).match(/Hash:\s+([a-f0-9]+)/)?.[1] ?? "";
if (origHash && copyHash && origHash === copyHash) {
  console.log("  ✓ Lifecycle: copy hash matches original");
} else {
  console.log(`  ✗ Lifecycle: copy hash mismatch (orig=${origHash}, copy=${copyHash})`);
}

await h.testContains("Lifecycle: rm copy", "adb_rm",
  { path: LC_COPY }, "delete");

await h.testContains("Lifecycle: rm original", "adb_rm",
  { path: LC_FILE }, "delete");

// ── Cleanup ─────────────────────────────────────────────

h.section("Cleanup");

// Remove the entire test directory (depth 3: /sdcard/deepadb_test_files → depth 2... wait
// /sdcard = depth 1, /sdcard/deepadb_test_files = depth 2
// Depth ≤ 2 is blocked for recursive delete! We need to clean up individual files.
// This is actually the protection working correctly.

// Clean up all created files individually, then remove empty dirs
const cleanup = [
  `${TEST_DIR}/seed.txt`,
  `${TEST_DIR}/storage_test.txt`,
  `${TEST_DIR}/final_moved.txt`,
  `${TEST_DIR}/copied.txt`,
  `${TEST_DIR}/copied2.txt`,
  `${TEST_DIR}/copied3.txt`,
  `${TEST_DIR}/touched_new.txt`,
  `${TEST_DIR}/grep_target.txt`,
  `${TEST_DIR}/replace_target.txt`,
  `${TEST_DIR}/backup_test.txt`,
  `${TEST_DIR}/backup_test.txt.bak`,
  `${TEST_DIR}/canary.txt`,
  `${TEST_DIR}/quote_target.txt`,
  `${TEST_DIR}/quote_replace.txt`,
];
for (const f of cleanup) {
  await h.callTool("adb_rm", { path: f }).catch(() => {});
}

// Remove test subdirectories (these are at depth 3+, recursive is allowed)
await h.callTool("adb_rm", { path: `${TEST_DIR}/sub`, recursive: true }).catch(() => {});
await h.callTool("adb_rm", { path: `${TEST_DIR}/timed_dir`, recursive: true }).catch(() => {});

// Remaining files in TEST_DIR
await h.callTool("adb_shell", { command: `rm -f ${TEST_DIR}/*.txt 2>/dev/null; rmdir ${TEST_DIR} 2>/dev/null` });

// Verify cleanup
const verifyRes = await h.callTool("adb_shell", { command: `test -d ${TEST_DIR} && echo EXISTS || echo GONE` });
const cleanedUp = h.getText(verifyRes).includes("GONE");
if (cleanedUp) {
  console.log("  ✓ Test directory cleaned up");
} else {
  console.log("  ○ Test directory partially cleaned (non-critical)");
}

const exitCode = h.finish();
process.exit(exitCode);
