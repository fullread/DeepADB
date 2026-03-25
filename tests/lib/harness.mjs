/**
 * Shared test harness for DeepADB hardware tests.
 * Manages stdio JSON-RPC transport, MCP initialization, and test utilities.
 *
 * Usage:
 *   import { createHarness } from './lib/harness.mjs';
 *   const h = await createHarness();
 *   await h.test("Label", "adb_tool_name", { args });
 *   await h.testContains("Label", "adb_tool_name", {}, "expected substring");
 *   h.finish();
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "..", "build", "index.js");

export async function createHarness(suiteName = "Test") {
  let reqId = 0;
  let proc;
  let buffer = "";
  const pending = new Map();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  // Start server
  proc = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // Wire up stdout JSON-RPC message parsing
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
        }
      } catch {}
    }
  });

  // Wait for server ready
  let stderrBuffer = "";
  await new Promise((resolve, reject) => {
    proc.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.includes("Ready")) resolve();
    });
    proc.on("error", (err) => reject(new Error(`Server spawn failed: ${err.message}`)));
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`Server exited with code ${code}.\nStderr: ${stderrBuffer}`));
    });
    setTimeout(() => reject(new Error(`Server startup timeout (15s).\nStderr: ${stderrBuffer}\nServer path: ${SERVER_PATH}`)), 15000);
  });

  // MCP initialize handshake
  function sendRequest(method, params = {}, timeoutMs = 30000) {
    const id = ++reqId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    proc.stdin.write(msg);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(response);
      });
    });
  }

  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: suiteName, version: "1.0.0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // ── Utilities ────────────────────────────────────────────

  function callTool(name, args = {}, timeoutMs = 30000) {
    return sendRequest("tools/call", { name, arguments: args }, timeoutMs);
  }

  function getText(response) {
    if (response.error) return `[RPC ERROR] ${JSON.stringify(response.error)}`;
    return (response.result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  function isError(response) {
    return !!response.error || !!response.result?.isError;
  }

  function printResult(label, response, extraInfo = "") {
    const text = getText(response);
    const err = isError(response);
    const status = err ? "FAIL" : "PASS";
    const icon = err ? "✗" : "✓";
    // Truncate output for readability
    const preview = text.length > 300 ? text.substring(0, 300) + "..." : text;
    console.log(`  ${icon} ${label}${extraInfo ? " — " + extraInfo : ""}`);
    if (err) console.log(`    ${preview.replace(/\n/g, "\n    ")}`);
  }

  // ── Test functions ───────────────────────────────────────

  /** Basic test: call tool, pass if no error. */
  async function test(label, tool, args = {}, timeoutMs = 30000) {
    try {
      const res = await callTool(tool, args, timeoutMs);
      const err = isError(res);
      printResult(label, res);
      if (err) { failed++; failures.push(label); } else { passed++; }
      return res;
    } catch (e) {
      console.log(`  ✗ ${label} — EXCEPTION: ${e.message}`);
      failed++;
      failures.push(label);
      return null;
    }
  }

  /** Test that output contains an expected substring (case-insensitive). */
  async function testContains(label, tool, args, expected, timeoutMs = 30000) {
    try {
      const res = await callTool(tool, args, timeoutMs);
      const text = getText(res);
      const found = text.toLowerCase().includes(expected.toLowerCase());
      const err = isError(res);
      if (!err && found) {
        console.log(`  ✓ ${label}`);
        passed++;
      } else if (err) {
        printResult(label, res, `expected "${expected}"`);
        failed++;
        failures.push(label);
      } else {
        console.log(`  ✗ ${label} — expected "${expected}" not found in output`);
        failed++;
        failures.push(label);
      }
      return res;
    } catch (e) {
      console.log(`  ✗ ${label} — EXCEPTION: ${e.message}`);
      failed++;
      failures.push(label);
      return null;
    }
  }

  /** Test that tool returns an error (for negative/rejection tests). */
  async function testRejects(label, tool, args, timeoutMs = 30000) {
    try {
      const res = await callTool(tool, args, timeoutMs);
      if (isError(res)) {
        console.log(`  ✓ ${label} — correctly rejected`);
        passed++;
      } else {
        console.log(`  ✗ ${label} — expected rejection but tool succeeded`);
        failed++;
        failures.push(label);
      }
      return res;
    } catch (e) {
      console.log(`  ✓ ${label} — correctly rejected (exception)`);
      passed++;
      return null;
    }
  }

  /** Test that output does NOT contain a substring (case-insensitive). */
  async function testNotContains(label, tool, args, forbidden, timeoutMs = 30000) {
    try {
      const res = await callTool(tool, args, timeoutMs);
      const text = getText(res);
      const found = text.toLowerCase().includes(forbidden.toLowerCase());
      const err = isError(res);
      if (err) {
        printResult(label, res, `expected success without "${forbidden}"`);
        failed++;
        failures.push(label);
      } else if (found) {
        console.log(`  ✗ ${label} — forbidden string "${forbidden}" found in output`);
        failed++;
        failures.push(label);
      } else {
        console.log(`  ✓ ${label}`);
        passed++;
      }
      return res;
    } catch (e) {
      console.log(`  ✗ ${label} — EXCEPTION: ${e.message}`);
      failed++;
      failures.push(label);
      return null;
    }
  }

  /** Test that output matches a regex pattern. */
  async function testMatch(label, tool, args, pattern, timeoutMs = 30000) {
    try {
      const res = await callTool(tool, args, timeoutMs);
      const text = getText(res);
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      const matched = regex.test(text);
      const err = isError(res);
      if (!err && matched) {
        console.log(`  ✓ ${label}`);
        passed++;
      } else if (err) {
        printResult(label, res, `expected match for ${pattern}`);
        failed++;
        failures.push(label);
      } else {
        console.log(`  ✗ ${label} — pattern ${pattern} not matched in output`);
        failed++;
        failures.push(label);
      }
      return res;
    } catch (e) {
      console.log(`  ✗ ${label} — EXCEPTION: ${e.message}`);
      failed++;
      failures.push(label);
      return null;
    }
  }

  /** Skip a test with a reason. */
  function skip(label, reason) {
    console.log(`  ○ ${label} — SKIPPED: ${reason}`);
    skipped++;
  }

  /** Print section header. */
  function section(name) {
    console.log(`\n── ${name} ${"─".repeat(Math.max(0, 55 - name.length))}`);
  }

  /** Print summary and exit. */
  function finish() {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${suiteName}: ${passed} passed, ${failed} failed, ${skipped} skipped (${passed + failed + skipped} total)`);
    if (failures.length > 0) {
      console.log(`  Failures: ${failures.join(", ")}`);
    }
    console.log("═".repeat(60));
    proc.kill();
    return failed;
  }

  return { callTool, getText, isError, test, testContains, testNotContains, testMatch, testRejects, skip, section, finish };
}
