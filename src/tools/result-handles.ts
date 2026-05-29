// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Result Handle Tools — MCP-facing surface for the result-handle storage layer.
 *
 * Provides three discoverability tools (list/get/drop) and registers the
 * `result://{tool}/{name}` resource scheme. Tier A tools opt in by adding
 * a `result_handle` parameter to their schema and calling storeResult()
 * after producing their response.
 *
 * The Resource scheme is intentionally non-enumerable (list: undefined) so
 * resources/list does not leak active handle names — discoverability goes
 * through adb_result_list, which is auth-gated like any other tool call.
 */

import { z } from "zod";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "../tool-context.js";
import {
  storeResult as _storeResult,
  getResult,
  listHandles,
  dropHandle,
  dropAllHandles,
  getTokenHash,
  getStoreRoot,
  DEFAULT_TTL_SECONDS,
  type HandleMeta,
  type ContentBlock,
  type StoreResult,
} from "../middleware/result-handle.js";

// Re-export storage primitives so Tier A tools have a single import surface.
export { _storeResult as storeResult };
export type { HandleMeta, ContentBlock, StoreResult };

// ── Formatting helpers ───────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  let s: string;
  if (day > 0) s = `${day}d ${hr % 24}h`;
  else if (hr > 0) s = `${hr}h ${min % 60}m`;
  else if (min > 0) s = `${min}m ${sec % 60}s`;
  else s = `${sec}s`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

function formatHandleRow(h: HandleMeta, now: number): string {
  return [
    `  result://${h.tool}/${h.name}`,
    `    size: ${formatBytes(h.size)}`,
    `    created: ${formatRelative(h.createdAt, now)}`,
    `    expires: ${formatRelative(h.expiresAt, now)}`,
    `    last accessed: ${formatRelative(h.lastAccessedAt, now)}`,
  ].join("\n");
}

// ── Tool registrations ───────────────────────────────────────────────────

export function registerResultHandleTools(ctx: ToolContext): void {

  // adb_result_list — enumerate active handles
  ctx.server.tool(
    "adb_result_list",
    "List all result handles currently stored in this session. Returns metadata for each: tool, name, size, creation/expiry/last-access times. Use the URIs (`result://<tool>/<name>`) with adb_result_get or by reading them as MCP Resources to retrieve stored content. Handles are scoped per-auth-token and survive server restart within their TTL.",
    {},
    async () => {
      try {
        const handles = listHandles();
        if (handles.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No result handles stored.\nNamespace: ${getTokenHash()}\nStore root: ${getStoreRoot()}\n\nHandles are created opt-in by passing result_handle: "name" to supporting tools (adb_firmware_diff, adb_baseband_info, adb_dumpsys, adb_logcat, adb_logcat_poll, adb_find, adb_grep, adb_screenshot_diff, adb_screenshot_baseline, adb_screenshot_history).`,
            }],
          };
        }

        const now = Date.now();
        const totalBytes = handles.reduce((sum, h) => sum + h.size, 0);
        // Sort by most recently created first — typical use is "show me what I just stored"
        handles.sort((a, b) => b.createdAt - a.createdAt);

        const lines = [
          `${handles.length} result handle(s) stored — ${formatBytes(totalBytes)} total`,
          `Namespace: ${getTokenHash()}`,
          "",
          ...handles.map(h => formatHandleRow(h, now)),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to list handles: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // adb_result_get — retrieve a handle's content as structured blocks
  ctx.server.tool(
    "adb_result_get",
    "Retrieve the content of a stored result handle by tool name + handle name. Returns the original content blocks as the source tool produced them. Updates the handle's last-accessed time. For URI-based retrieval, read `result://<tool>/<name>` as an MCP Resource instead.",
    {
      tool: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Source tool name (the tool that originally stored the handle, e.g., 'bugreport')"),
      name: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Handle name supplied at storage time (e.g., 'initial')"),
    },
    async ({ tool, name }) => {
      try {
        const stored = getResult(tool, name);
        if (!stored) {
          return {
            content: [{
              type: "text",
              text: `Handle "result://${tool}/${name}" not found, expired, or invalid.\nUse adb_result_list to see active handles.`,
            }],
            isError: true,
          };
        }
        // Return content blocks narrowed to MCP's strict text-block shape.
        // v1.1.2 is text-only by design; the filter+map also guards against
        // any non-text block sneaking into the store via future code paths.
        return {
          content: stored.content
            .filter(b => b.type === "text" && typeof b.text === "string")
            .map(b => ({ type: "text" as const, text: b.text as string })),
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to retrieve handle: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // adb_result_drop — delete a single handle, or clear all
  ctx.server.tool(
    "adb_result_drop",
    "Delete a stored result handle, or clear all handles in this session. Either provide both `tool` and `name` to drop one specific handle, or pass `all: true` to drop everything in the current namespace. Useful for freeing up the store cap proactively or removing stale data before a sensitive operation.",
    {
      tool: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional()
        .describe("Source tool name (required unless all=true)"),
      name: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional()
        .describe("Handle name (required unless all=true)"),
      all: z.boolean().optional().default(false)
        .describe("If true, delete every handle in this namespace. tool/name must be omitted when all=true."),
    },
    async ({ tool, name, all }) => {
      try {
        if (all) {
          if (tool !== undefined || name !== undefined) {
            return {
              content: [{ type: "text", text: "Cannot combine all=true with tool/name. Use one mode or the other." }],
              isError: true,
            };
          }
          const count = dropAllHandles();
          return { content: [{ type: "text", text: `Dropped ${count} handle(s) from namespace ${getTokenHash()}.` }] };
        }

        if (!tool || !name) {
          return {
            content: [{ type: "text", text: "Must specify both tool and name, or pass all=true." }],
            isError: true,
          };
        }

        const dropped = dropHandle(tool, name);
        if (!dropped) {
          return {
            content: [{ type: "text", text: `Handle "result://${tool}/${name}" not found (already evicted or never stored).` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Dropped result://${tool}/${name}.` }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to drop handle: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // ── MCP Resource: result://{tool}/{name} ─────────────────────────────
  //
  // Resolves a stored handle via the standard MCP Resources interface.
  // Returns flattened text (concatenated text blocks) — for structured
  // block retrieval, use adb_result_get instead.
  //
  // The template is non-enumerable (list: undefined) so resources/list
  // does not leak active handle names. Discoverability goes through
  // adb_result_list, which is auth-gated.

  ctx.server.resource(
    "result-handle",
    new ResourceTemplate("result://{tool}/{name}", { list: undefined }),
    {
      description: "Stored tool result handle. Resolve by URI; URI is supplied by the source tool's storeResult response and listed in adb_result_list.",
    },
    async (uri, { tool, name }) => {
      try {
        // C6 note: the MCP SDK's ResourceTemplate parameter type is
        // `string | string[]` to accommodate variadic templates. The template
        // `result://{tool}/{name}` has single placeholders, so single-value
        // extraction is guaranteed by the SDK contract — but the cast is
        // unsafe-by-type-system. If this template ever evolves to use a
        // variadic placeholder (e.g., `{name+}`), the cast would silently
        // coerce an array to `[object Object]`. Guarded below to fail loud
        // instead. Future-proof by checking shape, not just type.
        if (typeof tool !== "string" || typeof name !== "string") {
          return {
            contents: [{
              uri: uri.href,
              mimeType: "text/plain",
              text: `Handle URI parse failed: expected single-value tool and name parameters, got tool=${typeof tool} name=${typeof name}`,
            }],
          };
        }
        const stored = getResult(tool, name);
        if (!stored) {
          return {
            contents: [{
              uri: uri.href,
              mimeType: "text/plain",
              text: `Handle not found, expired, or invalid: ${uri.href}`,
            }],
          };
        }

        // Flatten text content blocks into a single resource entry.
        // The structure-preserving path is adb_result_get; this surface
        // optimizes for the common "just give me the text" use case.
        const flat = stored.content
          .filter(b => b.type === "text" && typeof b.text === "string")
          .map(b => b.text as string)
          .join("\n\n");

        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: flat || "(handle stored but contains no text content)",
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: `Error resolving handle: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    }
  );
}

// ── Tier-A wiring helpers ────────────────────────────────────────────────
//
// These two exports let any tool opt in to result-handle storage with two
// minimal additions to its existing registration:
//   1. Spread `resultHandleSchemaFields` into the Zod args schema
//   2. Wrap the response with `withResultHandle(result, "<tool_name>", args)`
//      before returning
//
// The wrapper is a no-op when result_handle is undefined, so adding it does
// not change the behavior of tools called without the parameter.

/** Zod schema fragment to spread into any Tier A tool's args schema. */
export const resultHandleSchemaFields = {
  result_handle: z.string()
    .min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/)
    .optional()
    .describe(
      "Optional. If provided, store this tool's result under `result://<tool>/<name>` " +
      "for retrieval after compaction. Name must be 1-32 chars, [a-zA-Z0-9_-]. " +
      "Existing handles with the same tool+name are overwritten. " +
      "Use adb_result_list to see active handles, adb_result_get or the MCP " +
      "Resource URI to retrieve."
    ),
  result_handle_ttl: z.number().int().min(60).max(7 * 24 * 60 * 60).optional()
    .describe(
      "Optional. TTL in seconds for the result handle (60 to 604800). " +
      "Default 43200 (12 hours). Ignored if result_handle is not provided."
    ),
};

/** Args shape that Tier A tool handlers destructure for the wrapper. */
export interface ResultHandleArgs {
  result_handle?: string;
  result_handle_ttl?: number;
}

/** Wrap a tool response with optional result-handle storage. No-op if
 *  result_handle is undefined. Appends a footer block describing the
 *  storage outcome (success URI or failure reason). The footer is the
 *  only mutation to the result on success — content blocks are preserved
 *  exactly as the tool produced them, so retrieval round-trips faithfully. */
export function withResultHandle<T extends { content: ContentBlock[] }>(
  result: T,
  toolName: string,
  args: ResultHandleArgs,
): T {
  if (!args.result_handle) return result;

  // Snapshot the original content for storage BEFORE we append the footer,
  // so that retrieval returns the original tool output without the footer.
  const originalContent = [...result.content];
  const stored = _storeResult(toolName, args.result_handle, originalContent, args.result_handle_ttl);

  if (stored.ok) {
    // C8 fix: read the constant from result-handle.ts so this footer
    // tracks DA_RESULT_HANDLE_TTL env var rather than lying about a 12h default.
    const ttlDisplay = args.result_handle_ttl ?? DEFAULT_TTL_SECONDS;
    const evictedNote = stored.evicted && stored.evicted.length > 0
      ? `\nEvicted ${stored.evicted.length} older handle(s) to make room: ${stored.evicted.join(", ")}`
      : "";
    result.content.push({
      type: "text",
      text: `\n──\nStored as ${stored.uri} (expires in ${ttlDisplay}s).${evictedNote}\nRetrieve with adb_result_get or by reading the URI as an MCP Resource.`,
    });
  } else {
    result.content.push({
      type: "text",
      text: `\n──\nResult handle "${args.result_handle}" NOT stored: ${stored.reason}`,
    });
  }
  return result;
}
