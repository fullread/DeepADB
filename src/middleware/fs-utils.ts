// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Filesystem Utilities - Shared helpers for safe on-disk state.
 *
 * Four primitives used across DeepADB tempDir-backed storage:
 *
 *   1. ensurePrivateDir(path) - Create a directory with restrictive
 *      permissions (0o700 on Unix; mode bits ignored on Windows). Use
 *      everywhere we create a subdirectory under tempDir. Defends against
 *      other-user reads on shared Unix hosts.
 *
 *   2. writeAtomicSync(path, data) - Write via a unique-per-call .tmp
 *      path then atomic rename. Defends against (a) mid-write crashes
 *      leaving corrupt data on disk, (b) concurrent readers seeing a
 *      partially-written file, (c) concurrent writers to the same path
 *      racing on .tmp filenames.
 *
 *   3. sanitizeFilenameComponent(name, maxLen?) - Replace any character
 *      outside [a-zA-Z0-9_-] with underscore. Optional maxLen truncates
 *      the result. Empty results are coerced to "_" so the caller never
 *      receives a zero-length component. Centralizes the pattern used
 *      across several tool modules for user-supplied identifier strings.
 *
 *   4. sanitizeFilenameComponentDotted(name, maxLen?) - Like (3) but
 *      ALSO allows "." in the output (for package names like
 *      "com.example.app"). Defangs pure-dot strings (".", "..", "...")
 *      by coercing them to "_", so a caller using the result directly
 *      as a path component cannot be steered into parent-directory
 *      traversal by an adversarial input.
 *
 * Note on existing directories: ensurePrivateDir only sets mode on
 * directories it CREATES. Directories that already exist (from older
 * DeepADB versions) keep their existing permissions. To remediate, the
 * operator can chmod 700 the affected directories manually, or just
 * delete them so they are recreated with the new mode.
 */

import { mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync, openSync, fsyncSync, closeSync } from "fs";
import { resolve } from "path";
import { randomBytes } from "crypto";

/** Create directory with owner-only permissions. Idempotent. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Atomic write: unique .tmp + rename. Throws on failure (caller handles). */
export function writeAtomicSync(path: string, data: string | Buffer): void {
  // Unique per call: process + time + 4 random bytes. Defends against
  // concurrent writers to the same target path (each picks its own .tmp).
  const suffix = randomBytes(4).toString("hex");
  const tmp = `${path}.${process.pid}.${Date.now()}.${suffix}.tmp`;
  try {
    writeFileSync(tmp, data);
    // A4 fix: fsync the .tmp file's contents to durable storage BEFORE the
    // atomic rename. Without this, a system crash between write and rename
    // could leave the target file pointing at an empty or partial inode
    // (the rename is atomic at the directory-entry level, but the data
    // blocks of the renamed inode may not have been flushed yet on some
    // filesystems). Cost: one extra syscall per write; negligible compared
    // to the protection against crash-induced corruption of profiles,
    // baselines, snapshots, and other persistent state. Falls through on
    // platforms where fsync raises (rare in practice) — the rename still
    // happens, matching pre-fix behavior.
    try {
      const fd = openSync(tmp, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch { /* fsync best-effort; do not block the rename */ }
    renameSync(tmp, path);
  } catch (e) {
    // Cleanup any partial state. If writeFileSync failed early, tmp may
    // not exist; that is fine - unlinkSync just throws which we swallow.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Sanitize a string for use as a filename component. Replaces every
 * character outside [a-zA-Z0-9_-] with "_".
 *
 * Safe against path traversal because `.`, `/`, and `\\` are all outside
 * the allowlist (they become `_`). For cases where rejection is preferable
 * to silent replacement, validate the raw input against /^[a-zA-Z0-9_-]+$/
 * before calling tools.
 *
 * @param name  Raw user-supplied identifier.
 * @param maxLen Optional length cap applied after sanitization. Callers
 *               that build long paths (Windows MAX_PATH-sensitive) should
 *               always pass this.
 * @returns Sanitized string, guaranteed non-empty (empty input collapses
 *          to "_" so callers never receive a zero-length component).
 */
export function sanitizeFilenameComponent(name: string, maxLen?: number): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  // A6 fix: truncation can also produce empty (maxLen=0 edge case). Apply
  // the empty-check AFTER truncation, matching the order used in
  // sanitizeFilenameComponentDotted post-A7. Defense in depth: empty input
  // would produce an empty component, which then concatenated with an
  // extension yields a hidden file like ".json".
  if (maxLen !== undefined && s.length > maxLen) s = s.substring(0, maxLen);
  // Collapse empty to "_" so the caller always gets a real component.
  if (s.length === 0) s = "_";
  return s;
}

/**
 * Like sanitizeFilenameComponent but ALSO allows "." in the output.
 * Intended for Android-style package identifiers ("com.example.app") and
 * similar dotted names where stripping dots would damage the identifier.
 *
 * Pure-dot strings (".", "..", "...", etc.) are coerced to "_" so a
 * caller that uses the result directly as a path component cannot be
 * steered into parent-directory traversal by an adversarial input.
 *
 * @param name  Raw user-supplied dotted identifier (e.g., package name).
 * @param maxLen Optional length cap applied after sanitization.
 * @returns Sanitized string, guaranteed non-empty AND not a pure-dot
 *          traversal sequence.
 */
/**
 * A8 note: a LEADING dot is preserved (only character-class filtering
 * applies — the dot is in the allowed set). On Unix, a result like
 * `.hidden` becomes an actual hidden file in the result-handle store and
 * other directory listings. This is intentional under the design (callers
 * who want to allow package names like com.example.app need the dot), but
 * means operators browsing the temp directory should pass `ls -A` not
 * bare `ls` to see all entries. If a future caller wants the no-leading-
 * dot behavior, it should sanitize the input before calling this helper.
 */
export function sanitizeFilenameComponentDotted(name: string, maxLen?: number): string {
  let s = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  // A7 fix: defenses run AFTER truncation, not before. The previous order
  // (defang → empty-check → truncate) had a gap: input "..a" with maxLen=2
  // would pass the defang (not pure-dot), then truncate to "..", and a
  // pure-dot traversal string would reach the caller. Same hazard if
  // truncation produces an empty string. Apply both the pure-dot defang
  // and the empty-check LAST so any reduction-by-truncation is caught.
  if (maxLen !== undefined && s.length > maxLen) s = s.substring(0, maxLen);
  // Defang pure-dot strings: ".", "..", "..." would resolve to current-dir
  // or parent-dir if passed as a path component without an extension.
  // `join(dir, "..")` escapes dir entirely; this prevents that.
  if (/^\.+$/.test(s)) s = "_";
  // Empty-input defense (sanitizeFilenameComponent has the same).
  if (s.length === 0) s = "_";
  return s;
}

/**
 * Returns true iff `candidatePath`, after path resolution, is contained
 * within `dir` — either equal to `dir` or strictly underneath it.
 *
 * Containment uses a path-separator boundary check, NOT a string prefix.
 * Without the boundary, `candidatePath = /parent/tempDir_evil/x` would
 * pass containment against `dir = /parent/tempDir` because the absolute
 * path string-prefix-matches — even though the two are sibling directories.
 *
 * Both POSIX `/` and Windows `\\` separators are recognized so a candidate
 * resolved on either platform is handled correctly.
 *
 * Usage:
 *   if (!isWithinDir(userOutputDir, ctx.config.tempDir)) {
 *     throw new Error("Output directory must be inside tempDir");
 *   }
 *
 * This is the centralized successor to the inline pattern that previously
 * lived in tools/qemu.ts (verifyContainment, correctly using a separator
 * boundary) and tools/split-apk.ts / tools/registry.ts (which used a bare
 * string-prefix check and were vulnerable to the sibling-directory bypass).
 * Lifting to shared middleware fixes the bypass at both call sites.
 */
export function isWithinDir(candidatePath: string, dir: string): boolean {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedDir = resolve(dir);
  if (resolvedCandidate === resolvedDir) return true;
  // A9 note: the two startsWith checks are intentionally redundant. After
  // path.resolve(), the separator is platform-native — `/` on POSIX, `\\`
  // on Windows — so one of the two checks ALWAYS misses on a given run.
  // Keeping both means the code reads correctly regardless of platform,
  // and the dead branch costs one extra string comparison per call. If a
  // future contributor "cleans up" by removing one of the checks, they
  // would break the code on the other platform. The dual check is a
  // platform-portability defense, not a bug.
  return resolvedCandidate.startsWith(resolvedDir + "/")
      || resolvedCandidate.startsWith(resolvedDir + "\\");
}
/**
 * Read and JSON-parse a file. On any failure (missing, unreadable, malformed),
 * log a warning via the supplied logger and return null. Used by tools that
 * walk a directory of JSON files (fingerprints, baselines, marketplace
 * workflows, plugin metadata) and want to skip-but-surface corruption rather
 * than abort the whole walk OR silently drop the entry.
 *
 * Closes audit findings AE8 / AO6 / AU6 / BJ7 / BN7 — the recurring silent
 * `} catch { /* skip corrupt * / }` pattern. Surfaces corruption to the
 * operator so a quietly-shrinking handle count doesn't go unnoticed.
 *
 * The logger is optional so this is safe to call from contexts without a
 * Logger in scope (some loadFingerprints / listing functions don't take a
 * ToolContext). When absent, the warning goes to stderr — non-silent.
 *
 * Returns null on any failure; caller should skip the entry.
 */
export function tryReadJsonOrWarn<T = unknown>(
  filePath: string,
  context: string,
  logger?: { warn: (msg: string) => void }
): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const msg = `tryReadJsonOrWarn[${context}]: skipped ${filePath} — ${detail}`;
    if (logger) logger.warn(msg);
    else process.stderr.write(msg + "\n");
    return null;
  }
}

