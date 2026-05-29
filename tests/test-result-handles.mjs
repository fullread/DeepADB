// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Result Handle Test Suite — Validates the v1.1.2 result-handle primitive.
 *
 * Two tiers:
 *   - Tier 1 (no device required): discoverability tools, validation paths,
 *     drop semantics, MCP Resource resolution for missing handles.
 *   - Tier 2 (device required): end-to-end round-trip via adb_dumpsys (a
 *     Tier A tool), collision overwrite, MCP Resource resolution of a stored
 *     handle, tool-side parameter validation.
 *
 * Tier 2 auto-skips cleanly when no device is authorized so this file can
 * run in any environment without false failures.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Result Handles");

// ── Device detection (gates Tier 2) ───────────────────────────────────────

// Probe via adb_devices and check for a (device) state marker. The tool
// formats output as "<serial> (<state>) | model: ... | product: ..." per
// connected device; we look for the parenthesized "device" state, which
// indicates an authorized, ready connection (not "unauthorized" or "offline").
let deviceAvailable = false;
try {
  const dev = await h.callTool("adb_devices", {});
  if (!h.isError(dev)) {
    const text = h.getText(dev);
    deviceAvailable = /\(device\)/.test(text);
  }
} catch {
  deviceAvailable = false;
}

// ── Setup: ensure clean baseline ──────────────────────────────────────────
// Drop any handles left over from prior test runs so assertions about
// counts and empty-state are deterministic.
await h.callTool("adb_result_drop", { all: true });

// ── Tier 1: Discoverability tools — empty state ───────────────────────────

h.section("Discoverability tools — empty state");

await h.testContains(
  "adb_result_list reports empty state when no handles stored",
  "adb_result_list", {},
  "no result handles stored"
);

await h.testRejects(
  "adb_result_get on nonexistent handle returns isError",
  "adb_result_get", { tool: "nonexistent", name: "handle" }
);

await h.testRejects(
  "adb_result_drop on nonexistent handle returns isError",
  "adb_result_drop", { tool: "nonexistent", name: "handle" }
);

const dropAllEmpty = await h.callTool("adb_result_drop", { all: true });
h.assert(
  "adb_result_drop all=true on empty store reports 0 dropped",
  !h.isError(dropAllEmpty) && h.getText(dropAllEmpty).includes("Dropped 0"),
  `got: ${h.getText(dropAllEmpty).substring(0, 200)}`
);

// ── Tier 1: drop-semantics error paths ────────────────────────────────────

h.section("Drop semantics — error paths");

await h.testRejects(
  "adb_result_drop rejects when combining all=true with tool/name",
  "adb_result_drop", { tool: "x", name: "y", all: true }
);

await h.testRejects(
  "adb_result_drop rejects when missing both modes",
  "adb_result_drop", {}
);

await h.testRejects(
  "adb_result_drop rejects malformed handle name (space)",
  "adb_result_drop", { tool: "valid", name: "has space" }
);

await h.testRejects(
  "adb_result_drop rejects malformed handle name (slash)",
  "adb_result_drop", { tool: "valid", name: "has/slash" }
);

await h.testRejects(
  "adb_result_drop rejects malformed handle name (too long)",
  "adb_result_drop", { tool: "valid", name: "x".repeat(33) }
);

// ── Tier 1: MCP Resource on nonexistent handle ────────────────────────────

h.section("MCP Resource — nonexistent handle");

const nonResource = await h.readResource("result://nonexistent/handle");
const nonResourceText = h.getResourceText(nonResource);
h.assert(
  "result:// URI for missing handle returns 'not found' marker",
  nonResourceText.toLowerCase().includes("not found")
    || nonResourceText.toLowerCase().includes("expired")
    || nonResourceText.toLowerCase().includes("invalid"),
  `got: ${nonResourceText.substring(0, 200)}`
);

// ── Tier 2: End-to-end round-trip (device required) ───────────────────────

h.section("End-to-end round-trip (device required)");

if (!deviceAvailable) {
  h.skip("Round-trip via adb_dumpsys — store via Tier A tool", "no device authorized");
  h.skip("Round-trip — adb_result_list shows the stored handle", "no device authorized");
  h.skip("Round-trip — adb_result_get returns stored content (no footer)", "no device authorized");
  h.skip("Round-trip — MCP Resource resolves stored handle", "no device authorized");
  h.skip("Collision — same name overwrites in place (not added)", "no device authorized");
  h.skip("Tool-side validation — adb_dumpsys rejects bad result_handle name", "no device authorized");
  h.skip("Drop — adb_result_drop removes specific handle", "no device authorized");
  h.skip("Drop — list is empty after dropping the only handle", "no device authorized");
  h.skip("Drop all — idempotent on empty store", "no device authorized");
} else {
  // Fresh baseline
  await h.callTool("adb_result_drop", { all: true });

  // 1. Round-trip via adb_dumpsys with result_handle
  const dumpResp = await h.callTool("adb_dumpsys", {
    service: "meminfo",
    result_handle: "test_round_trip",
  });
  const dumpText = h.getText(dumpResp);
  h.assert(
    "Round-trip via adb_dumpsys — store via Tier A tool",
    !h.isError(dumpResp) && dumpText.includes("result://dumpsys/test_round_trip"),
    `expected URI footer in response; tail: ${dumpText.substring(Math.max(0, dumpText.length - 400))}`
  );

  // 2. List shows the new handle
  const listResp = await h.callTool("adb_result_list", {});
  const listText = h.getText(listResp);
  h.assert(
    "Round-trip — adb_result_list shows the stored handle",
    !h.isError(listResp)
      && listText.includes("result://dumpsys/test_round_trip")
      && /1 result handle\(s\) stored/.test(listText),
    `got: ${listText.substring(0, 400)}`
  );

  // 3. Get returns stored content (without the footer)
  const getResp = await h.callTool("adb_result_get", {
    tool: "dumpsys", name: "test_round_trip"
  });
  const gotText = h.getText(getResp);
  h.assert(
    "Round-trip — adb_result_get returns stored content (no footer)",
    !h.isError(getResp)
      && !gotText.includes("Stored as result://")
      && !gotText.includes("Retrieve with adb_result_get")
      && gotText.length > 64,
    `got length=${gotText.length}, head: ${gotText.substring(0, 200)}`
  );

  // 4. MCP Resource read of the stored handle
  const resourceResp = await h.readResource("result://dumpsys/test_round_trip");
  const resourceText = h.getResourceText(resourceResp);
  h.assert(
    "Round-trip — MCP Resource resolves stored handle",
    !h.isError(resourceResp)
      && resourceText.length > 64
      && !resourceText.toLowerCase().includes("not found"),
    `got length=${resourceText.length}, head: ${resourceText.substring(0, 200)}`
  );

  // 5. Collision: same handle name, different service — should overwrite,
  //    not create a second entry
  await h.callTool("adb_dumpsys", {
    service: "cpuinfo",
    result_handle: "test_round_trip",
  });
  const listAfter = await h.callTool("adb_result_list", {});
  const listAfterText = h.getText(listAfter);
  h.assert(
    "Collision — same name overwrites in place (not added)",
    /1 result handle\(s\) stored/.test(listAfterText)
      && !/2 result handle\(s\) stored/.test(listAfterText),
    `got: ${listAfterText.substring(0, 400)}`
  );

  // 6. Tool-side validation — bad result_handle name on the storing tool
  await h.testRejects(
    "Tool-side validation — adb_dumpsys rejects bad result_handle name",
    "adb_dumpsys", { service: "meminfo", result_handle: "has space" }
  );

  // 7. Drop by tool+name
  const dropResp = await h.callTool("adb_result_drop", {
    tool: "dumpsys", name: "test_round_trip"
  });
  h.assert(
    "Drop — adb_result_drop removes specific handle",
    !h.isError(dropResp)
      && h.getText(dropResp).includes("Dropped result://dumpsys/test_round_trip"),
    `got: ${h.getText(dropResp).substring(0, 200)}`
  );

  // 8. List is empty again
  await h.testContains(
    "Drop — list is empty after dropping the only handle",
    "adb_result_list", {},
    "no result handles stored"
  );

  // 9. Drop all idempotency
  await h.testContains(
    "Drop all — idempotent on empty store",
    "adb_result_drop", { all: true },
    "Dropped 0"
  );
}

// ── Teardown ──────────────────────────────────────────────────────────────
await h.callTool("adb_result_drop", { all: true });

process.exit(h.finish());
