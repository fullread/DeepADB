// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Result Handle Storage — Tempdir-backed cache for tool result content blocks.
 *
 * Closes the "compaction gap" for expensive one-shot tools. When a tool opts
 * in by accepting a `result_handle` parameter, its content can be stashed
 * under a `result://<tool>/<name>` URI for retrieval via MCP Resources.
 * Survives server restart; eviction by TTL + LRU within a total-size cap.
 *
 * Scope (v1.1.2): text content blocks only. Image/binary content is not
 * supported because no current DeepADB tool emits image blocks in its MCP
 * response (screenshots are saved as files on disk; the response is text
 * with the path).
 *
 * Storage layout:
 *   ${DA_RESULT_HANDLE_DIR}/
 *     <tokenHash>/         ← isolates handles across DA_AUTH_TOKEN values
 *       <tool>/
 *         <name>.content.json   ← JSON-serialized content blocks
 *         <name>.meta.json      ← creation/expiry/access/size metadata
 *
 * Token-hash isolation: handles are scoped by the SHA-256 of the configured
 * DA_AUTH_TOKEN (truncated to 16 hex chars). For stdio mode (no token), uses
 * the literal "_local". This means token rotation invalidates old handles
 * naturally (the old hash is no longer in use) and multiple DeepADB instances
 * on the same machine with different tokens have separate stores.
 */

import { createHash } from "crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  rmSync,
  statSync,
} from "fs";
import { join } from "path";
import { config } from "../config/config.js";
import { ensurePrivateDir, writeAtomicSync } from "./fs-utils.js";
import { parseIntSafe } from "./parse-utils.js";

// ── Config (env-tunable with reasonable defaults) ────────────────────────

/** Default 12 hours. Env var is in seconds; bounded to [60s, 7 days]. */
export const DEFAULT_TTL_SECONDS = parseIntSafe(process.env.DA_RESULT_HANDLE_TTL, 12 * 60 * 60);
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Per-handle and total-store size caps. Both env-tunable. */
const MAX_HANDLE_BYTES = parseIntSafe(process.env.DA_RESULT_HANDLE_MAX_BYTES, 5 * 1024 * 1024);
const MAX_TOTAL_BYTES = parseIntSafe(process.env.DA_RESULT_HANDLE_TOTAL_BYTES, 100 * 1024 * 1024);
const MAX_HANDLE_COUNT = parseIntSafe(process.env.DA_RESULT_HANDLE_MAX_COUNT, 100);

/** Refuse storing handles smaller than this. Sized so that a substantive
 *  multi-stat result (e.g., a screenshot-diff report) is accepted while
 *  trivial single-value responses (e.g., "OK", "Level: 78%") are not. */
const MIN_HANDLE_BYTES = 64;

/** Skip lastAccessedAt rewrites within this window. Coarse-LRU heuristic:
 *  evictions run at minutes-to-hours granularity, so updating timestamps
 *  more frequently than once a minute is wasted disk I/O without any
 *  observable change in eviction behavior. */
const LAST_ACCESS_UPDATE_THRESHOLD_MS = 60_000;

/** Validation regex for both tool names and operator-supplied handle names. */
const NAME_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;

/** Truncated SHA-256 of the active auth token, or "_local" for stdio mode. */
const TOKEN_HASH: string = (() => {
  const token = process.env.DA_AUTH_TOKEN ?? "";
  if (!token) return "_local";
  return createHash("sha256").update(token).digest("hex").substring(0, 16);
})();

/** Resolved storage root. Operator-overridable via DA_RESULT_HANDLE_DIR. */
const STORE_ROOT: string = process.env.DA_RESULT_HANDLE_DIR ?? join(config.tempDir, "result-handles");
const TOKEN_DIR: string = join(STORE_ROOT, TOKEN_HASH);

// ── Types ────────────────────────────────────────────────────────────────

export interface HandleMeta {
  name: string;
  tool: string;
  createdAt: number;       // ms since epoch
  expiresAt: number;
  lastAccessedAt: number;
  size: number;            // bytes of content (not including meta sidecar)
  tokenHash: string;
}

export interface StoreResult {
  ok: boolean;
  uri?: string;
  reason?: string;
  evicted?: string[];      // URIs evicted to make room, if any
}

export interface ContentBlock {
  type: string;
  text?: string;
  // Other fields (e.g., for future image support) intentionally not modeled here.
}

// ── Helpers ──────────────────────────────────────────────────────────────

function validateName(name: string): boolean {
  return typeof name === "string" && NAME_REGEX.test(name);
}

/** Type guard: structurally validate a parsed JSON value as HandleMeta.
 *  Catches corruption (NaN timestamps, missing fields, wrong types) that the
 *  type system trusts on a generic JSON parse. Defense in depth against
 *  another process writing malformed meta files (which is feasible on shared
 *  Unix hosts with the world-readable directory mode pre-v1.1.3). */
function isValidMeta(value: unknown): value is HandleMeta {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return validateName(v.name as string)
    && validateName(v.tool as string)
    && typeof v.createdAt === "number" && isFinite(v.createdAt)
    && typeof v.expiresAt === "number" && isFinite(v.expiresAt)
    && typeof v.lastAccessedAt === "number" && isFinite(v.lastAccessedAt)
    && typeof v.size === "number" && isFinite(v.size) && v.size >= 0
    && typeof v.tokenHash === "string";
}

function pathsFor(tool: string, name: string): { content: string; meta: string; dir: string } {
  // B6 fix: belt-and-suspenders validation. All current callers validate
  // tool/name upstream via validateName, but a future caller that forgets
  // would build a traversal-vulnerable path. Refuse inputs the regex rejects.
  if (!validateName(tool) || !validateName(name)) {
    throw new Error(`pathsFor: invalid tool/name (must match ${NAME_REGEX})`);
  }
  const dir = join(TOKEN_DIR, tool);
  return {
    content: join(dir, `${name}.content.json`),
    meta: join(dir, `${name}.meta.json`),
    dir,
  };
}

/** Try to read JSON. Returns null on any failure (missing, corrupt, etc.). */
function tryReadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Try to delete a file. Silent on failure. Used in eviction paths where
 *  partial-cleanup is acceptable — the next scan will pick up stragglers. */
function tryUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* missing or busy — ignore */ }
}

/** Walk the current token's directory and return all valid handles.
 *  Skips files that don't have both .content.json and .meta.json (orphans),
 *  and skips meta files that fail to parse. */
function scanStore(): Array<HandleMeta & { contentPath: string; metaPath: string }> {
  const results: Array<HandleMeta & { contentPath: string; metaPath: string }> = [];
  if (!existsSync(TOKEN_DIR)) return results;

  for (const toolDirName of readdirSync(TOKEN_DIR)) {
    const toolDir = join(TOKEN_DIR, toolDirName);
    let toolStat;
    try { toolStat = statSync(toolDir); } catch { continue; }
    if (!toolStat.isDirectory()) continue;

    // B7 fix: tool subdirectory may be deleted between the outer readdir
    // and this inner one (concurrent eviction, manual cleanup, antivirus).
    // Catch and skip rather than abort the whole scan mid-walk.
    let files: string[];
    try {
      files = readdirSync(toolDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".meta.json")) continue;
      const baseName = file.substring(0, file.length - ".meta.json".length);
      const metaPath = join(toolDir, file);
      const contentPath = join(toolDir, `${baseName}.content.json`);

      // Orphan check: meta without content
      if (!existsSync(contentPath)) {
        tryUnlink(metaPath);
        continue;
      }

      const rawMeta = tryReadJson<unknown>(metaPath);
      if (!isValidMeta(rawMeta)) {
        // Corrupt or malformed meta — drop both files
        tryUnlink(metaPath);
        tryUnlink(contentPath);
        continue;
      }

      results.push({ ...rawMeta, contentPath, metaPath });
    }
  }

  return results;
}

/** Drop a single handle from disk by path pair. Returns true if either was removed. */
function dropFiles(contentPath: string, metaPath: string): boolean {
  const had = existsSync(contentPath) || existsSync(metaPath);
  tryUnlink(metaPath);   // delete meta first so a partial state can't be "found"
  tryUnlink(contentPath);
  return had;
}

/** Run TTL + LRU + count eviction. Idempotent; safe to call repeatedly.
 *  Returns the list of URIs evicted, in eviction order. */
function evictIfNeeded(now: number): string[] {
  const evicted: string[] = [];
  let handles = scanStore();

  // Step 1: TTL eviction — drop anything past its expiry.
  for (const h of handles) {
    if (h.expiresAt <= now) {
      if (dropFiles(h.contentPath, h.metaPath)) {
        evicted.push(`result://${h.tool}/${h.name}`);
      }
    }
  }
  handles = handles.filter(h => h.expiresAt > now);

  // Step 2: LRU eviction — while over count or total-bytes cap, drop oldest-accessed.
  handles.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  let totalBytes = handles.reduce((sum, h) => sum + h.size, 0);

  // B11 fix: use >= so a write at exactly MAX_HANDLE_COUNT triggers
  // eviction BEFORE the new entry pushes the store transiently to MAX+1.
  // Same for byte budget.
  while ((handles.length >= MAX_HANDLE_COUNT || totalBytes >= MAX_TOTAL_BYTES) && handles.length > 0) {
    const victim = handles.shift()!;
    if (dropFiles(victim.contentPath, victim.metaPath)) {
      evicted.push(`result://${victim.tool}/${victim.name}`);
    }
    totalBytes -= victim.size;
  }

  return evicted;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Store a tool result's content blocks under result://<tool>/<name>.
 *  Validates name + size, runs eviction, and persists atomically.
 *  Caller is responsible for ensuring `content` is the unmodified MCP
 *  result.content array (so retrieval can return it as-is). */
export function storeResult(
  tool: string,
  name: string,
  content: ContentBlock[],
  ttlSecondsOverride?: number,
): StoreResult {
  if (!validateName(tool)) {
    return { ok: false, reason: `Invalid tool name "${tool}". Must match ${NAME_REGEX} (a-z, A-Z, 0-9, _, -; 1-32 chars).` };
  }
  if (!validateName(name)) {
    return { ok: false, reason: `Invalid handle name "${name}". Must match ${NAME_REGEX} (a-z, A-Z, 0-9, _, -; 1-32 chars).` };
  }
  if (!Array.isArray(content) || content.length === 0) {
    return { ok: false, reason: "Content must be a non-empty array of content blocks." };
  }

  const ttlSec = ttlSecondsOverride !== undefined
    ? Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, ttlSecondsOverride))
    : DEFAULT_TTL_SECONDS;

  // Serialize and measure
  const serialized = JSON.stringify(content);
  const size = Buffer.byteLength(serialized, "utf-8");

  if (size < MIN_HANDLE_BYTES) {
    return {
      ok: false,
      reason: `Content (${size} bytes) is below the minimum handle size of ${MIN_HANDLE_BYTES} bytes. Small results are cheaper to regenerate than to store; skip the result_handle parameter for this call.`,
    };
  }
  if (size > MAX_HANDLE_BYTES) {
    return {
      ok: false,
      reason: `Content (${size.toLocaleString()} bytes) exceeds per-handle limit of ${MAX_HANDLE_BYTES.toLocaleString()} bytes. Tool should paginate or use a session-based primitive (e.g., adb_logcat_start) instead.`,
    };
  }

  // Ensure storage directory exists
  const paths = pathsFor(tool, name);
  try { ensurePrivateDir(paths.dir); }
  catch (e) {
    return { ok: false, reason: `Failed to create handle directory: ${(e as Error).message}` };
  }

  // Evict before writing so we don't transiently exceed caps. The new handle
  // itself is not yet on disk during this scan, so the cap check is against
  // existing handles only — the +1 / +size margin is implicit headroom.
  const now = Date.now();
  const evicted = evictIfNeeded(now);

  const meta: HandleMeta = {
    name,
    tool,
    createdAt: now,
    expiresAt: now + ttlSec * 1000,
    lastAccessedAt: now,
    size,
    tokenHash: TOKEN_HASH,
  };

  try {
    writeAtomicSync(paths.content, serialized);
    writeAtomicSync(paths.meta, JSON.stringify(meta, null, 2));
  } catch (e) {
    // Cleanup partial state
    tryUnlink(paths.content);
    tryUnlink(paths.meta);
    return { ok: false, reason: `Failed to write handle: ${(e as Error).message}` };
  }

  return {
    ok: true,
    uri: `result://${tool}/${name}`,
    evicted: evicted.length > 0 ? evicted : undefined,
  };
}

/** Retrieve a stored handle's content blocks. Updates lastAccessedAt on hit.
 *  Returns null if the handle is missing, expired, or corrupt. */
export function getResult(tool: string, name: string): { content: ContentBlock[]; meta: HandleMeta } | null {
  if (!validateName(tool) || !validateName(name)) return null;

  const paths = pathsFor(tool, name);
  const rawMeta = tryReadJson<unknown>(paths.meta);
  if (!isValidMeta(rawMeta)) {
    // Either parse failed, file missing, OR meta is structurally invalid.
    // For structural invalidity, the file is corrupted (or was tampered
    // with on a shared host) - drop both files to clean state.
    if (rawMeta !== null) dropFiles(paths.content, paths.meta);
    return null;
  }
  const meta: HandleMeta = rawMeta;

  const now = Date.now();
  if (meta.expiresAt <= now) {
    // Lazy TTL eviction on access
    dropFiles(paths.content, paths.meta);
    return null;
  }

  const content = tryReadJson<ContentBlock[]>(paths.content);
  if (!content) {
    // Content gone or corrupt — clean up the orphaned meta
    dropFiles(paths.content, paths.meta);
    return null;
  }

  // Defensive: enforce size cap on read too. Protects against post-write
  // file tampering or environment changes that lowered the cap.
  const onDiskSize = Buffer.byteLength(JSON.stringify(content), "utf-8");
  if (onDiskSize > MAX_HANDLE_BYTES) {
    dropFiles(paths.content, paths.meta);
    return null;
  }

  // Update lastAccessedAt (for LRU). Failure to update is non-fatal —
  // the handle is still readable; we just lose some LRU precision.
  // F5: skip the rewrite if the previous update was recent. Eviction
  // operates at coarse time-scale, so 60s LRU precision is more than enough
  // and we avoid a disk write on every read.
  if (now - meta.lastAccessedAt <= LAST_ACCESS_UPDATE_THRESHOLD_MS) {
    return { content, meta };
  }
  try {
    const updated: HandleMeta = { ...meta, lastAccessedAt: now };
    writeAtomicSync(paths.meta, JSON.stringify(updated, null, 2));
    return { content, meta: updated };
  } catch {
    return { content, meta };
  }
}

/** Return metadata for all current handles (across all tools, current token). */
export function listHandles(): HandleMeta[] {
  return scanStore().map(({ contentPath: _c, metaPath: _m, ...meta }) => meta);
}

/** Delete a specific handle. Returns true if it existed. */
export function dropHandle(tool: string, name: string): boolean {
  if (!validateName(tool) || !validateName(name)) return false;
  const paths = pathsFor(tool, name);
  return dropFiles(paths.content, paths.meta);
}

/** Delete all handles for the current token. Returns count dropped. */
export function dropAllHandles(): number {
  const handles = scanStore();
  let count = 0;
  for (const h of handles) {
    if (dropFiles(h.contentPath, h.metaPath)) count++;
  }
  // Also remove now-empty tool subdirectories
  if (existsSync(TOKEN_DIR)) {
    for (const toolDirName of readdirSync(TOKEN_DIR)) {
      const toolDir = join(TOKEN_DIR, toolDirName);
      try {
        if (statSync(toolDir).isDirectory() && readdirSync(toolDir).length === 0) {
          rmSync(toolDir, { recursive: false });
        }
      } catch { /* ignore */ }
    }
  }
  return count;
}

/** Startup sweep — called once from index.ts on server boot. Walks the store,
 *  enforces TTL and size caps against any existing handles from prior sessions,
 *  and reports a summary line to stderr. */
export function startupSweep(): { evicted: number; kept: number } {
  if (!existsSync(TOKEN_DIR)) return { evicted: 0, kept: 0 };
  const evictedUris = evictIfNeeded(Date.now());
  const after = scanStore().length;
  return { evicted: evictedUris.length, kept: after };
}

/** Exposed for the discoverability tools layer — current token's namespace. */
export function getTokenHash(): string {
  return TOKEN_HASH;
}

/** Exposed for the discoverability tools layer — resolved store root. */
export function getStoreRoot(): string {
  return STORE_ROOT;
}
