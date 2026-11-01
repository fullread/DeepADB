// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerCleanup, unregisterCleanup } from "./cleanup.js";

const MAX_OUTPUT = 128 * 1024;
let activeQueries = 0;

/** A subprocess is killable even while SQLite is inside a synchronous C call. */
export async function runSqliteSnapshot(database: string, sql: string, options: {
  signal?: AbortSignal; maxRows: number; deviceCli?: boolean; timeoutMs?: number;
}): Promise<string> {
  if (options.signal?.aborted) throw new Error("SQLite query cancelled");
  if (activeQueries >= 2) throw new Error("SQLite inspector is busy (maximum two queries)");
  activeQueries++;
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = options.deviceCli
        ? spawn("sqlite3", ["-readonly", "-batch", "-header", "-column",
          "-cmd", ".output /dev/null", "-cmd", ".limit length 65536", "-cmd", ".limit column 128",
          "-cmd", "PRAGMA hard_heap_limit=67108864; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY",
          "-cmd", ".output stdout", database, sql],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(process.execPath, ["--max-old-space-size=64", fileURLToPath(new URL("./sqlite-worker.js", import.meta.url))],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", errors = "", bytes = 0, failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
      const cleanupKey = `sqlite-query:${child.pid}`;
      registerCleanup(cleanupKey, async () => {
        const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
        stop(new Error("SQLite query stopped during server shutdown"));
        await closed;
      });
      const timeout = setTimeout(() => stop(new Error("SQLite query exceeded its execution deadline")), Math.min(options.timeoutMs ?? 10_000, 10_000));
      const cancel = () => stop(new Error("SQLite query cancelled"));
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.stdout.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > MAX_OUTPUT) stop(new Error("SQLite output exceeds 128 KiB"));
        else output += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => { errors = (errors + data.toString()).slice(0, 8192); });
      child.on("error", error => {
        failure ??= options.deviceCli && (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("sqlite3 is unavailable on this Android host. Install a trusted sqlite3 binary; no database was changed.") : error;
      });
      child.stdin.on("error", error => { failure ??= error; });
      child.once("close", code => {
        unregisterCleanup(cleanupKey);
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancel);
        // Wait for close before settling: callers may now safely remove the
        // snapshot, including on Windows where SQLite holds open file handles.
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(errors.trim() || `SQLite child exited ${code}`));
        else if (options.deviceCli) resolve(output.trim() || "(no rows returned)");
        else {
          try { resolve(JSON.parse(output).text); }
          catch { reject(new Error("Invalid SQLite worker response")); }
        }
      });
      child.stdin.end(options.deviceCli ? undefined : JSON.stringify({ database, sql, maxRows: options.maxRows }));
    });
  } finally { activeQueries--; }
}
