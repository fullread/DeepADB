// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Supply Chain Test Suite — Validates v1.1.2 supply-chain hardening:
 *   - Soft fail-closed registry/marketplace (item [1])
 *   - HTTPS-only protocol allowlist in fetch-utils (item [3])
 *   - Per-hop redirect re-validation in fetch-utils (BA1)
 *
 * Items [2] (fetch timeout) and [4] (mandatory SHA-256 on install) are NOT
 * tested here because they require a mock HTTP server — a slow-drip response
 * for [2], and a manifest endpoint that serves a registry entry without an
 * sha256 field for [4]. The redirect-following loop (BA1's other half) is in
 * the same bucket: it needs a mock HTTPS server to drive 302/303/307 hops.
 * Those are covered by manual audit during release prep.
 */
import { createHarness } from "./lib/harness.mjs";
import { fetchText, requireHttps } from "../build/middleware/fetch-utils.js";

// Ensure clean env so the spawned server sees no registry URL configured.
// Default state on a fresh checkout; the explicit delete keeps the test
// deterministic on machines where these vars may be set globally.
delete process.env.DA_REGISTRY_URL;
delete process.env.DA_WORKFLOW_REGISTRY_URL;

const h = await createHarness("Supply Chain Hardening");

// ── Soft fail-closed registry/marketplace (item [1]) ──────────────────────

h.section("Registry / Marketplace Not Configured (item [1])");

// These tools should all return isError:true with a friendly "not configured"
// message when DA_REGISTRY_URL / DA_WORKFLOW_REGISTRY_URL are unset. The
// previous behavior (pre-v1.1.2) was to silently fall back to a hardcoded
// default URL pointing at a namespace DeepADB does not control.

await h.testRejects("adb_registry_search rejects with no registry configured",
  "adb_registry_search", {});

await h.testRejects("adb_registry_update rejects with no registry configured",
  "adb_registry_update", {});

await h.testRejects("adb_market_search rejects with no marketplace configured",
  "adb_market_search", {});

// Sanity check: the error message should be the friendly "not configured"
// text, not a stack trace or HTTP failure. testContains on a known error path
// — we know testRejects passed above, so re-call and inspect the response text.
const searchResp = await h.callTool("adb_registry_search", {});
const searchText = h.getText(searchResp).toLowerCase();
h.assert(
  "Registry not-configured message is the friendly version",
  searchText.includes("registry not configured") && searchText.includes("da_registry_url"),
  `got: ${searchText.substring(0, 200)}`
);

const marketResp = await h.callTool("adb_market_search", {});
const marketText = h.getText(marketResp).toLowerCase();
h.assert(
  "Marketplace not-configured message is the friendly version",
  marketText.includes("marketplace not configured") && marketText.includes("da_workflow_registry_url"),
  `got: ${marketText.substring(0, 200)}`
);

// ── HTTPS-only protocol allowlist (item [3]) ───────────────────────────────

h.section("Protocol Allowlist (item [3])");

// fetchText() is imported directly from the build. Each non-https URL should
// throw with a message containing the canonical refusal text. The check
// happens before any network call, so these tests are fast and offline-safe.

async function expectFetchRejection(label, url) {
  let thrown = null;
  try {
    await fetchText(url);
  } catch (e) {
    thrown = e;
  }
  const ok = thrown !== null
    && typeof thrown.message === "string"
    && thrown.message.includes("Refusing to fetch non-https URL");
  h.assert(label, ok, ok ? "" : `expected refusal, got: ${thrown ? thrown.message : "no throw"}`);
}

await expectFetchRejection("Rejects http:// URL", "http://example.com/registry.json");
await expectFetchRejection("Rejects data: URL", "data:application/json,%7B%7D");
await expectFetchRejection("Rejects file:// URL", "file:///etc/passwd");
await expectFetchRejection("Rejects ftp:// URL", "ftp://example.com/x");
await expectFetchRejection("Rejects javascript: URL", "javascript:void(0)");
await expectFetchRejection("Rejects empty string", "");
await expectFetchRejection("Rejects relative path", "/etc/passwd");
await expectFetchRejection("Rejects bare host with no scheme", "example.com/registry.json");

// Positive control: https:// URLs must NOT be rejected by the protocol check.
// The fetch itself will fail (no DNS for example.invalid), but the error
// message must NOT be the protocol-refusal text. This proves the allowlist
// is exact-match on the https:// prefix and doesn't accidentally over-reject.
let httpsThrown = null;
try {
  await fetchText("https://example.invalid/never-resolves");
} catch (e) {
  httpsThrown = e;
}
h.assert(
  "Accepts https:// URL (protocol check passes; fetch may still fail downstream)",
  httpsThrown !== null && !httpsThrown.message.includes("Refusing to fetch non-https URL"),
  `https URL was wrongly refused by protocol check: ${httpsThrown ? httpsThrown.message : "no throw"}`
);

// ── Redirect re-validation (BA1) ───────────────────────────────────────────

h.section("Redirect Re-validation (BA1)");

// requireHttps is the unit-testable component of the per-hop redirect
// re-validation. The full redirect-following loop is covered by manual audit
// at release prep (per the test convention noted at the top of this file),
// but the validator's pass/fail behavior is locked in here.
//
// Background: previously fetch-utils relied on Node's default `redirect: "follow"`
// which silently follows https→http and https→file redirects, defeating the
// initial protocol allowlist. BA1 introduces manual redirect handling with
// per-hop scheme re-validation via this helper.

function expectRequireHttpsThrows(label, url, ctx = "test") {
  let thrown = null;
  try {
    requireHttps(url, ctx);
  } catch (e) {
    thrown = e;
  }
  const ok = thrown !== null
    && typeof thrown.message === "string"
    && thrown.message.includes("Refusing to fetch non-https URL")
    && thrown.message.includes(ctx);
  h.assert(label, ok, ok ? "" : `expected refusal with context "${ctx}", got: ${thrown ? thrown.message : "no throw"}`);
}

function expectRequireHttpsAccepts(label, url) {
  let thrown = null;
  try {
    requireHttps(url, "test");
  } catch (e) {
    thrown = e;
  }
  h.assert(label, thrown === null, thrown ? `wrongly rejected: ${thrown.message}` : "");
}

// Every non-https scheme is rejected when validating a redirect target.
expectRequireHttpsThrows("requireHttps rejects http:// on redirect hop", "http://attacker.com", "redirect hop 1");
expectRequireHttpsThrows("requireHttps rejects file:// on redirect hop", "file:///etc/passwd", "redirect hop 1");
expectRequireHttpsThrows("requireHttps rejects data: on redirect hop", "data:text/plain,evil", "redirect hop 1");
expectRequireHttpsThrows("requireHttps rejects ftp:// on redirect hop", "ftp://x", "redirect hop 1");
expectRequireHttpsThrows("requireHttps rejects javascript: on redirect hop", "javascript:void(0)", "redirect hop 1");
expectRequireHttpsThrows("requireHttps rejects relative path on redirect hop", "/relative/path", "redirect hop 1");
expectRequireHttpsThrows("requireHttps rejects scheme-less host on redirect hop", "example.com", "redirect hop 1");
expectRequireHttpsThrows("requireHttps rejects empty string on redirect hop", "", "redirect hop 1");

// Positive control: https:// passes the validator.
expectRequireHttpsAccepts("requireHttps accepts https:// on redirect hop", "https://example.com/path");

// The context string must surface in the error message so multi-hop failures
// point at which specific hop was refused, not just "the URL was bad".
let ctxThrown = null;
try {
  requireHttps("http://x", "redirect hop 3 from https://registry.example.com/manifest.json");
} catch (e) {
  ctxThrown = e;
}
h.assert(
  "requireHttps surfaces context in error message",
  ctxThrown !== null
    && ctxThrown.message.includes("redirect hop 3")
    && ctxThrown.message.includes("registry.example.com"),
  ctxThrown ? `got: ${ctxThrown.message}` : "no throw"
);

process.exit(h.finish());
