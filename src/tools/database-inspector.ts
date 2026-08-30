// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Read-only Room / SQLite inspection.
 *
 * The tool deliberately scopes database access to an installed package's
 * databases directory and requires either Android's run-as sandbox or root.
 * SQL is validated before any device lookup and sqlite3 is launched with both
 * -readonly and PRAGMA query_only=ON as defense in depth.
 */

import { z } from "zod";
import { createWriteStream, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellQuote } from "../middleware/sanitize.js";
import { ensurePrivateDir } from "../middleware/fs-utils.js";
import { isOnDevice } from "../config/config.js";

const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SQL_LENGTH = 8192;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;

const READ_ONLY_PRAGMAS = new Set([
  "application_id",
  "compile_options",
  "database_list",
  "encoding",
  "foreign_key_list",
  "freelist_count",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "page_count",
  "quick_check",
  "schema_version",
  "table_info",
  "table_list",
  "table_xinfo",
  "user_version",
]);

const MUTATING_SQL = /\b(?:ALTER|ANALYZE|ATTACH|BEGIN|COMMIT|CREATE|DELETE|DETACH|DROP|EVAL|INSERT|LOAD_EXTENSION|PRAGMA\s+WRITABLE_SCHEMA|READFILE|REINDEX|RELEASE|REPLACE|ROLLBACK|SAVEPOINT|UPDATE|VACUUM|WRITEFILE)\b/i;
const SIDE_EFFECT_FUNCTION = /(?:^|[^A-Za-z0-9_])(?:EVAL|LOAD_EXTENSION|READFILE|WRITEFILE|"(?:EVAL|LOAD_EXTENSION|READFILE|WRITEFILE)"|`(?:EVAL|LOAD_EXTENSION|READFILE|WRITEFILE)`|\[(?:EVAL|LOAD_EXTENSION|READFILE|WRITEFILE)\])\s*\(/i;

export interface ReadOnlySqlValidation {
  sql?: string;
  kind?: "query" | "pragma" | "explain";
  error?: string;
}

/** Require a regular file and explicitly reject symbolic links before reading. */
export function buildReadOnlyFileGuard(path: string): string {
  const quoted = shellQuote(path);
  return `test -f ${quoted} && ! test -L ${quoted}`;
}

/** Mask SQL string/identifier literals so safety keywords are checked as syntax, not data. */
function maskSqlLiterals(sql: string): string {
  let quote: "'" | '"' | null = null;
  let masked = "";
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (quote) {
      if (char === quote && sql[index + 1] === quote) {
        masked += "  ";
        index++;
      } else if (char === quote) {
        quote = null;
        masked += char;
      } else {
        masked += " ";
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      masked += char;
    } else {
      masked += char;
    }
  }
  return masked;
}

/** Validate and normalize a single read-only SQLite statement. */
export function validateReadOnlySql(input: string): ReadOnlySqlValidation {
  if (input.length > MAX_SQL_LENGTH) {
    return { error: `SQL exceeds ${MAX_SQL_LENGTH} characters.` };
  }

  let sql = input.trim();
  if (!sql) return { error: "SQL query must not be empty." };
  if (sql.includes("\0")) return { error: "SQL query contains a NUL byte." };
  if (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd();
  const syntaxOnly = maskSqlLiterals(sql);
  if (/--|\/\*|\*\//.test(syntaxOnly)) {
    return { error: "SQL comments are not allowed in read-only inspection queries." };
  }
  if (syntaxOnly.includes(";")) {
    return { error: "Only one SQL statement is allowed." };
  }
  if (MUTATING_SQL.test(syntaxOnly) || SIDE_EFFECT_FUNCTION.test(sql)) {
    return { error: "Only read-only SELECT, WITH, EXPLAIN, and approved PRAGMA statements are allowed." };
  }

  if (/^(?:SELECT|WITH)\b/i.test(sql)) {
    return { sql, kind: "query" };
  }

  if (/^EXPLAIN(?:\s+QUERY\s+PLAN)?\s+(?:SELECT|WITH)\b/i.test(sql)) {
    return { sql, kind: "explain" };
  }

  const pragma = sql.match(/^PRAGMA\s+([A-Za-z0-9_]+)(?:\s*\([^;]*\))?$/i);
  if (pragma) {
    const name = pragma[1]!.toLowerCase();
    if (!READ_ONLY_PRAGMAS.has(name)) {
      return { error: `PRAGMA ${name} is not on the read-only allowlist.` };
    }
    if (/=/.test(sql)) {
      return { error: "PRAGMA assignments are not allowed." };
    }
    return { sql, kind: "pragma" };
  }

  return { error: "Only read-only SELECT, WITH, EXPLAIN, and approved PRAGMA statements are allowed." };
}

/** Apply a hard row cap to result-producing SELECT/WITH queries. */
export function limitReadOnlySql(validation: ReadOnlySqlValidation, maxRows: number): string {
  if (!validation.sql || !validation.kind) throw new Error("Validated SQL is required.");
  if (validation.kind === "query") {
    return `SELECT * FROM (${validation.sql}) AS deepadb_readonly LIMIT ${maxRows}`;
  }
  return validation.sql;
}

type AccessMode = "run-as" | "root";

async function resolveAccessMode(
  ctx: ToolContext,
  serial: string,
  packageName: string,
  requested: "auto" | AccessMode,
): Promise<AccessMode | null> {
  if (requested === "run-as" || requested === "auto") {
    const probe = await ctx.bridge.shell(`run-as ${shellQuote(packageName)} id`, {
      device: serial,
      timeout: 5000,
      ignoreExitCode: true,
    });
    if (probe.exitCode === 0 && /uid=\d+/.test(probe.stdout)) return "run-as";
    if (requested === "run-as") return null;
  }

  const rootProbe = await ctx.bridge.shell("su -c id", {
    device: serial,
    timeout: 5000,
    ignoreExitCode: true,
  });
  return rootProbe.stdout.includes("uid=0") ? "root" : null;
}

async function executeForPackage(
  ctx: ToolContext,
  serial: string,
  packageName: string,
  access: AccessMode,
  command: string,
) {
  if (access === "run-as") {
    return ctx.bridge.shell(`run-as ${shellQuote(packageName)} sh -c ${shellQuote(command)}`, {
      device: serial,
      timeout: 30000,
      ignoreExitCode: true,
    });
  }
  return ctx.bridge.rootShell(command, {
    device: serial,
    timeout: 30000,
    ignoreExitCode: true,
  });
}

async function copyPackageFileToHost(
  ctx: ToolContext,
  serial: string,
  packageName: string,
  access: AccessMode,
  remotePath: string,
  localPath: string,
  maxBytes: number,
): Promise<number> {
  const guardedRead = `${buildReadOnlyFileGuard(remotePath)} && cat ${shellQuote(remotePath)}`;
  const args = access === "run-as"
    ? ["exec-out", "run-as", packageName, "sh", "-c", guardedRead]
    : ["exec-out", "su", "-c", guardedRead];
  const child = ctx.bridge.spawnStreaming(args, serial);
  if (!child.stdout) throw new Error("ADB snapshot stream has no stdout pipe.");

  let bytes = 0;
  let stderr = "";
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60000);
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length);
  });
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error(`Database snapshot exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB safety limit.`));
      } else {
        callback(null, chunk);
      }
    },
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  try {
    await pipeline(child.stdout, limiter, createWriteStream(localPath, { mode: 0o600 }));
    const exitCode = await exited;
    if (timedOut) throw new Error("Database snapshot copy timed out after 60 seconds.");
    if (exitCode !== 0) throw new Error(`ADB snapshot copy failed (exit ${exitCode}): ${stderr.trim() || "no detail"}`);
    return bytes;
  } catch (error) {
    child.kill();
    try { unlinkSync(localPath); } catch { /* best-effort cleanup */ }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatSqliteRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows returned)";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const display = (value: unknown): string => {
    if (value === null) return "NULL";
    if (value instanceof Uint8Array) return `<BLOB ${value.byteLength} bytes>`;
    const text = String(value).replace(/[\r\n\t]+/g, " ");
    return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
  };
  return [columns.join("\t"), ...rows.map((row) => columns.map((column) => display(row[column])).join("\t"))].join("\n");
}

async function executeHostSnapshotQuery(
  ctx: ToolContext,
  serial: string,
  packageName: string,
  access: AccessMode,
  remoteDatabasePath: string,
  sql: string,
): Promise<{ text: string; bytes: number }> {
  const snapshotDir = join(ctx.config.tempDir, "sqlite-readonly");
  ensurePrivateDir(snapshotDir);
  const unique = `${process.pid}_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const localDatabase = join(snapshotDir, `snapshot_${unique}.db`);
  const localWal = `${localDatabase}-wal`;
  const cleanup = () => {
    for (const path of [localDatabase, localWal, `${localDatabase}-shm`]) {
      try { unlinkSync(path); } catch { /* missing or already cleaned */ }
    }
  };

  try {
    const bytes = await copyPackageFileToHost(
      ctx, serial, packageName, access, remoteDatabasePath, localDatabase, MAX_DATABASE_BYTES,
    );
    const walProbe = await executeForPackage(
      ctx, serial, packageName, access,
      `wal=${shellQuote(`${remoteDatabasePath}-wal`)}; if test -L "$wal"; then echo WAL_UNSAFE_LINK; elif test -f "$wal"; then stat -c '%s' "$wal"; else echo 0; fi`,
    );
    if (walProbe.stdout.trim() === "WAL_UNSAFE_LINK") {
      throw new Error("The database WAL is a symbolic link; package-scoped inspection refuses linked files.");
    }
    const walBytes = Number.parseInt(walProbe.stdout.trim(), 10) || 0;
    if (walBytes > 0) {
      if (bytes + walBytes > MAX_DATABASE_BYTES) {
        throw new Error(`Database plus WAL exceeds the ${MAX_DATABASE_BYTES / 1024 / 1024} MiB safety limit.`);
      }
      try {
        await copyPackageFileToHost(
          ctx, serial, packageName, access, `${remoteDatabasePath}-wal`, localWal, MAX_DATABASE_BYTES - bytes,
        );
      } catch (error) {
        ctx.logger.warn(`SQLite WAL snapshot was unavailable; inspecting the main database copy only: ${error instanceof Error ? error.message : error}`);
      }
    }

    const sqlite = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(localDatabase, { readOnly: true, allowExtension: false });
    try {
      database.exec("PRAGMA query_only=ON");
      const statement = database.prepare(sql);
      statement.setReadBigInts(true);
      const rows = statement.all() as Record<string, unknown>[];
      return { text: formatSqliteRows(rows), bytes: bytes + walBytes };
    } finally {
      database.close();
    }
  } catch (error) {
    if (error instanceof Error && /node:sqlite|No such built-in module/i.test(error.message)) {
      throw new Error(
        "Neither device sqlite3 nor the Node.js node:sqlite fallback is available. Use Node.js 22.5 or newer.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    cleanup();
  }
}

export function registerDatabaseInspectorTools(ctx: ToolContext): void {
  ctx.server.tool(
    "adb_sqlite_inspect",
    "Safely inspect a Room or SQLite database inside an installed app. Lists package databases, shows schema, or executes one validated read-only query. Requires a debuggable app (run-as) or root; uses device sqlite3 when available and otherwise a bounded read-only host snapshot.",
    {
      packageName: z.string().regex(PACKAGE_NAME_PATTERN)
        .describe("Installed Android package whose databases directory may be inspected"),
      action: z.enum(["list", "schema", "query"]).optional().default("list")
        .describe("List databases, show sqlite_master schema, or run a read-only query"),
      database: z.string().regex(DATABASE_NAME_PATTERN).optional()
        .describe("Database filename inside the package databases directory (no path separators)"),
      query: z.string().max(MAX_SQL_LENGTH).optional()
        .describe("One read-only SELECT, WITH, EXPLAIN, or allowlisted PRAGMA statement"),
      maxRows: z.number().int().min(1).max(1000).optional().default(100)
        .describe("Maximum rows returned for SELECT/WITH queries (1-1000, default 100)"),
      access: z.enum(["auto", "run-as", "root"]).optional().default("auto")
        .describe("Access method. auto prefers run-as and falls back to root."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ packageName, action, database, query, maxRows, access, device }) => {
      try {
        let validatedSql: ReadOnlySqlValidation | undefined;
        if (action === "query") {
          if (!database) {
            return { content: [{ type: "text", text: "database is required for action=query." }], isError: true };
          }
          if (!query) {
            return { content: [{ type: "text", text: "query is required for action=query." }], isError: true };
          }
          validatedSql = validateReadOnlySql(query);
          if (validatedSql.error) {
            return { content: [{ type: "text", text: validatedSql.error }], isError: true };
          }
        }
        if (action === "schema" && !database) {
          return { content: [{ type: "text", text: "database is required for action=schema." }], isError: true };
        }

        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const packageProbe = await ctx.bridge.shell(`pm path ${shellQuote(packageName)}`, {
          device: serial,
          timeout: 10000,
          ignoreExitCode: true,
        });
        if (!packageProbe.stdout.includes("package:")) {
          return { content: [{ type: "text", text: `Package is not installed: ${packageName}` }], isError: true };
        }

        const selectedAccess = await resolveAccessMode(ctx, serial, packageName, access);
        if (!selectedAccess) {
          return {
            content: [{ type: "text", text: `Cannot inspect ${packageName}: run-as is unavailable and root access was not detected.` }],
            isError: true,
          };
        }

        const databaseDir = `/data/user/0/${packageName}/databases`;
        if (action === "list") {
          const command = [
            `dir=${shellQuote(databaseDir)}`,
            `test -d "$dir" || { echo NO_DATABASE_DIR; exit 0; }`,
            `for f in "$dir"/*; do`,
            `  test -f "$f" || continue`,
            `  test -L "$f" && continue`,
            `  name=$(basename "$f")`,
            `  case "$name" in *-wal|*-shm|*-journal) continue ;; esac`,
            `  size=$(stat -c '%s' "$f" 2>/dev/null || echo unknown)`,
            `  printf '%s\t%s bytes\n' "$name" "$size"`,
            `done`,
          ].join("\n");
          const result = await executeForPackage(ctx, serial, packageName, selectedAccess, command);
          const body = result.stdout.trim();
          if (body === "NO_DATABASE_DIR" || !body) {
            return { content: [{ type: "text", text: `${packageName} has no visible databases in its app data directory (access: ${selectedAccess}).` }] };
          }
          return { content: [{ type: "text", text: `=== Databases for ${packageName} (${selectedAccess}) ===\n${OutputProcessor.process(body, 30000)}` }] };
        }

        const databasePath = `${databaseDir}/${database}`;
        const selectedSql = action === "schema"
          ? "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
          : limitReadOnlySql(validatedSql!, maxRows);
        const fileProbe = await executeForPackage(
          ctx, serial, packageName, selectedAccess,
          `db=${shellQuote(databasePath)}; if test -L "$db"; then echo DATABASE_UNSAFE_LINK; elif test -f "$db"; then echo DATABASE_OK; else echo DATABASE_NOT_FOUND; fi`,
        );
        if (fileProbe.stdout.includes("DATABASE_UNSAFE_LINK")) {
          return { content: [{ type: "text", text: `Database is a symbolic link and cannot be inspected safely: ${database}` }], isError: true };
        }
        if (!fileProbe.stdout.includes("DATABASE_OK")) {
          return { content: [{ type: "text", text: `Database not found inside ${packageName}: ${database}` }], isError: true };
        }

        const sqliteProbe = await executeForPackage(
          ctx, serial, packageName, selectedAccess,
          "command -v sqlite3 >/dev/null 2>&1 && echo SQLITE_OK",
        );
        let body: string;
        let execution = "device sqlite3 (-readonly + query_only)";
        if (sqliteProbe.stdout.includes("SQLITE_OK")) {
          const command = `${buildReadOnlyFileGuard(databasePath)} || { echo 'DeepADB: linked or non-regular database refused' >&2; exit 1; }; sqlite3 -readonly -batch -header -column ${shellQuote(databasePath)} ${shellQuote(`PRAGMA query_only=ON; ${selectedSql}`)}`;
          const result = await executeForPackage(ctx, serial, packageName, selectedAccess, command);
          if (result.exitCode !== 0 || result.stderr.trim()) {
            const detail = (result.stderr || result.stdout).trim();
            return { content: [{ type: "text", text: `Read-only SQLite inspection failed: ${detail || `exit ${result.exitCode}`}` }], isError: true };
          }
          body = result.stdout.trim() || "(no rows returned)";
        } else if (!isOnDevice()) {
          const snapshot = await executeHostSnapshotQuery(
            ctx, serial, packageName, selectedAccess, databasePath, selectedSql,
          );
          body = snapshot.text;
          execution = `host read-only snapshot (${snapshot.bytes} bytes copied; private local snapshot deleted after use)`;
        } else {
          return {
            content: [{ type: "text", text: "sqlite3 is unavailable on this Android host. In on-device mode, install a trusted sqlite3 binary; no database was changed." }],
            isError: true,
          };
        }

        const title = action === "schema" ? "Schema" : `Read-only query (max ${maxRows} rows)`;
        return {
          content: [{ type: "text", text: `=== ${title}: ${packageName}/${database} ===\nAccess: ${selectedAccess}\nExecution: ${execution}\n${OutputProcessor.process(body, 30000)}` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    },
  );
}
