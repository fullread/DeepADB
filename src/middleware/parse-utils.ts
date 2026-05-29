// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Parse Utilities — shared numeric/string parsing helpers.
 *
 * Q2 fix: previously \`parseIntSafe\` was duplicated in config.ts and
 * result-handle.ts with slight signature differences. This module is the
 * single source of truth. Both callers now import from here.
 */

/**
 * Parse a numeric environment variable with a defensive fallback.
 *
 * - Returns \`fallback\` when the value is undefined.
 * - Returns \`fallback\` and logs a warning to stderr when the value is
 *   non-numeric or negative (operator typos).
 * - The negative-rejection is intentional: every numeric config in DeepADB
 *   is a duration, count, or size — none of which has a legitimate
 *   negative interpretation.
 */
export function parseIntSafe(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    process.stderr.write(`[DeepADB] Invalid config value "${value}", using default: ${fallback}\n`);
    return fallback;
  }
  return parsed;
}
