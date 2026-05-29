// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Sanitizer Fuzz Suite - property-based tests for the shell-safety primitives
 * in src/middleware/sanitize.ts. These functions are the command-injection
 * boundary for every tool that interpolates user input into an adb shell
 * command, so they are exercised here with thousands of generated inputs
 * (including high-density shell-metacharacter strings) rather than a handful
 * of hand-picked examples.
 *
 * Oracle: a minimal POSIX single-quote decoder (posixDecode) reverses the
 * quoting so we can assert round-trip faithfulness. Example-based checks at
 * the end verify exact output bytes independently of that decoder.
 *
 * Device-free and fast; included in the --ci suite set.
 */
import fc from "fast-check";
import { validateShellArg, validateShellArgs, shellEscape, shellQuote } from "../build/middleware/sanitize.js";

// Character-code constants avoid embedding raw quote/backslash literals.
const SQ = String.fromCharCode(39);    // single quote
const BS = String.fromCharCode(92);    // backslash
const NL = String.fromCharCode(10);

let passed = 0, failed = 0, skipped = 0;
const ok = (l) => { console.log("  ✓ " + l); passed++; };
const bad = (l, d) => { console.log("  ✗ " + l + (d ? " - " + d : "")); failed++; };
const section = (n) => { console.log(NL + "── " + n + " ──"); };

// Run one fast-check property; report pass or the shrunk counterexample.
function prop(label, arb, predicate, runs) {
  const n = runs || 1000;
  try {
    fc.assert(fc.property(arb, predicate), { numRuns: n });
    ok(label + " (" + n + " runs)");
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).split(NL)[0].slice(0, 200);
    bad(label, msg);
  }
}
function check(label, cond, detail) { if (cond) ok(label); else bad(label, detail); }

// Minimal POSIX single-quote decoder: the inverse of shellQuote/shellEscape.
// Inside a single-quoted region every byte is literal except the closing
// quote; outside, a backslash escapes the next byte (the closing-quote dance
// that shellQuote emits as quote then backslash-quote then reopen-quote).
function posixDecode(s) {
  let out = "";
  let i = 0;
  let inQ = false;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === SQ) { inQ = false; i++; }
      else { out += c; i++; }
    } else if (c === SQ) {
      inQ = true; i++;
    } else if (c === BS) {
      if (i + 1 < s.length) { out += s[i + 1]; i += 2; }
      else { out += BS; i++; }
    } else { out += c; i++; }
  }
  return out;
}

// Shell metacharacters rejected by validateShellArg, mirrored as code units
// so the oracle matches the regex character class exactly.
const META = new Set([59,124,38,36,96,40,41,123,125,60,62,33,10,13,92,39,34]);
function hasMeta(s) {
  for (let i = 0; i < s.length; i++) if (META.has(s.charCodeAt(i))) return true;
  return false;
}

// Arbitraries: general strings plus a high-density metacharacter generator.
const DANGER = [59,124,38,36,96,40,41,123,125,60,62,33,92,39,34,10,13,9,32,97,90,57,47,46,45,95].map((c) => String.fromCharCode(c));
const metaArb = fc.array(fc.constantFrom(...DANGER), { maxLength: 40 }).map((a) => a.join(""));
const anyStr = fc.oneof(fc.string(), metaArb);

section("shellQuote - round-trip faithfulness");
prop("posixDecode(shellQuote(s)) === s for arbitrary strings", anyStr, (s) => posixDecode(shellQuote(s)) === s, 4000);
prop("posixDecode(shellQuote(s)) === s for metacharacter-dense strings", metaArb, (s) => posixDecode(shellQuote(s)) === s, 4000);

section("shellQuote - structural guarantees");
prop("output begins and ends with a single quote", anyStr, (s) => { const q = shellQuote(s); return q.length >= 2 && q[0] === SQ && q[q.length - 1] === SQ; });
prop("output length is at least input length plus the two wrappers", anyStr, (s) => shellQuote(s).length >= s.length + 2);

section("shellEscape - faithful inside a single-quoted context");
prop("posixDecode(SQ + shellEscape(s) + SQ) === s", anyStr, (s) => posixDecode(SQ + shellEscape(s) + SQ) === s, 4000);

section("validateShellArg - rejection invariant");
prop("returns null exactly when no metacharacter is present", anyStr, (s) => (validateShellArg(s, "p") === null) === !hasMeta(s), 4000);
prop("never throws on arbitrary input", anyStr, (s) => { validateShellArg(s, "p"); return true; });
prop("a rejection always yields a non-empty error string", metaArb, (s) => { if (!hasMeta(s)) return true; const r = validateShellArg(s, "p"); return typeof r === "string" && r.length > 0; });

section("validateShellArgs - first-failure composition");
prop("null iff every argument individually validates", fc.array(anyStr, { maxLength: 6 }), (arr) => {
  const pairs = arr.map((v, i) => [v, "p" + i]);
  const combined = validateShellArgs(pairs);
  const firstBad = pairs.find((pr) => validateShellArg(pr[0], pr[1]) !== null);
  if (!firstBad) return combined === null;
  return combined === validateShellArg(firstBad[0], firstBad[1]);
});

section("known attack vectors (example-based, decoder-independent)");
check("rejects command-chaining semicolon", validateShellArg("foo; rm -rf /", "x") !== null);
check("rejects command substitution via dollar-paren", validateShellArg("$(whoami)", "x") !== null);
check("rejects backtick command substitution", validateShellArg("a" + String.fromCharCode(96) + "id" + String.fromCharCode(96), "x") !== null);
check("rejects a pipe", validateShellArg("a | b", "x") !== null);
check("rejects an embedded newline", validateShellArg("a" + NL + "b", "x") !== null);
check("rejects redirection", validateShellArg("cmd > /tmp/x", "x") !== null);
check("accepts a normal package-style identifier", validateShellArg("com.example.app-1_2", "x") === null);
check("shellQuote of empty string is two single quotes", shellQuote("") === SQ + SQ);
check("shellQuote neutralizes a quote-breakout attempt", posixDecode(shellQuote(SQ + "; rm -rf /; " + SQ)) === SQ + "; rm -rf /; " + SQ);
{
  // POSIX bytes for the value a-quote-b: open, a, close, escaped-quote, open, b, close
  const expected = SQ + "a" + SQ + BS + SQ + SQ + "b" + SQ;
  check("shellQuote(a-quote-b) emits exact POSIX bytes", shellQuote("a" + SQ + "b") === expected, "got " + shellQuote("a" + SQ + "b"));
}

console.log(NL + "=".repeat(60));
console.log("  Sanitizer Fuzz: " + passed + " passed, " + failed + " failed, " + skipped + " skipped (" + (passed + failed + skipped) + " total)");
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
