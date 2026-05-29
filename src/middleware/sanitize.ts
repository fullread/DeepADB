// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Input Sanitization — Shell injection prevention for ADB command construction.
 *
 * Tools that interpolate user-supplied parameters into shell command strings
 * must validate those parameters before passing them to bridge.shell().
 * This module provides validation for common parameter types.
 */

/**
 * Characters that are dangerous in shell command interpolation.
 *
 * D1 note: whitespace (space, tab) is NOT in this set. Whitespace would
 * cause word-splitting if the value reached an UNQUOTED shell context, but
 * v1.1.2 made `shellQuote` the canonical interpolation path across the
 * codebase (Fix #1). Every interpolation that flows through
 * `shellQuote(x)` wraps the value in single quotes, where whitespace is
 * harmless. validateShellArg therefore intentionally permits whitespace —
 * legitimate identifiers should not contain it, but the schema layer
 * (Zod regex) is the right place to enforce that per-tool.
 */
const SHELL_METACHARACTERS = /[;|&$`(){}<>!\n\r\\'"]/;

/**
 * Validate that a string is safe to interpolate into a shell command.
 * Rejects strings containing shell metacharacters that could enable injection.
 *
 * Use for: package names, property keys, service names, setting keys,
 * test class names, runner names, interface names — any identifier that
 * should never contain shell operators.
 *
 * Returns null if safe, or an error message string if unsafe.
 */
/**
 * D4 note: this function does NOT runtime type-check `value`. A caller
 * mistakenly passing `null` or `undefined` would have it coerced to the
 * string "null" / "undefined" before the regex test, and those literals
 * pass as valid identifiers. All current callers receive Zod-validated
 * strings from the MCP tool layer, so theoretical only — but future
 * non-MCP callers should pre-check or this function will silently accept
 * non-string inputs.
 */
export function validateShellArg(value: string, paramName: string): string | null {
  if (SHELL_METACHARACTERS.test(value)) {
    return `Invalid ${paramName}: contains shell metacharacters. Value must not include: ; | & $ \` ( ) { } < > ! \\ ' " (also no newlines or carriage returns)`;
  }
  return null;
}

/**
 * Escape a string for safe use inside single-quoted shell arguments.
 * Handles the only character that can break single-quote context: the quote itself.
 * Use for file paths, grep patterns, and any value interpolated into shell commands
 * within single quotes.
 */
export function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/**
 * Wrap a string as a single shell argument using POSIX single-quote escaping.
 *
 * Unlike `shellEscape` (which only escapes inner single quotes), this returns
 * a fully-wrapped, ready-to-interpolate token. Use this whenever a value is
 * being substituted into a backtick template literal that becomes a shell
 * command — it's the safe replacement for ALL `${shellEscape(x)}` sites that
 * weren't already wrapped by their caller.
 *
 * Algorithm: close the open quote, escape with backslash, reopen.
 *   foo'bar  →  'foo'\''bar'
 *   plain    →  'plain'
 *   ""       →  ''
 *
 * Safe-by-construction inside POSIX `sh -c`. Works with toybox sh on Android.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate multiple arguments at once. Returns the first error found, or null if all pass.
 */
export function validateShellArgs(args: Array<[string, string]>): string | null {
  for (const [value, paramName] of args) {
    const error = validateShellArg(value, paramName);
    if (error) return error;
  }
  return null;
}
