// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Private child entry point. Never runs inside the MCP process. */
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 32768) throw new Error("SQLite worker input exceeds limit");
  }
  const { database: filename, sql, maxRows } = JSON.parse(input);
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
  try {
    // SQLite's native heap is separate from V8. This per-process global limit
    // bounds BLOBs, sorting and recursive-query allocations on older Node too.
    database.exec("PRAGMA hard_heap_limit=67108864; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY");
    const heap = database.prepare("PRAGMA hard_heap_limit").get() as { hard_heap_limit?: number };
    if (!heap.hard_heap_limit || heap.hard_heap_limit > 67108864) throw new Error("SQLite memory limit unavailable");
    if (database.limits) {
      database.limits.length = 1024 * 1024;
      database.limits.column = 128;
    }
    let statement = database.prepare(sql);
    if (!statement.columns || !statement.iterate) throw new Error("Host SQLite inspection requires Node.js 22.16 or newer");
    const columns = statement.columns().map(c => c.name);
    if (columns.length > 128) throw new Error("SQLite column limit exceeded (128)");
    if (/^(SELECT|WITH)\b/i.test(sql)) {
      // Older LTS Node lacks database.limits. Bound values inside SQLite,
      // before node:sqlite materializes them in V8 (zeroblob is lazy in SQLite).
      const identifiers = columns.map((_, i) => `c${i}`);
      const projection = identifiers.map((id, i) => `CASE WHEN typeof(${id})='blob' THEN '<BLOB '||length(${id})||' bytes>' WHEN typeof(${id})='text' THEN substr(${id},1,1000) ELSE ${id} END AS "${columns[i].replace(/"/g, '""')}"`);
      statement = database.prepare(`WITH deepadb_output(${identifiers.join(",")}) AS (${sql}) SELECT ${projection.join(",")} FROM deepadb_output`);
    }
    statement.setReadBigInts(true);
    const lines = [columns.join("\t")];
    let bytes = Buffer.byteLength(lines[0]), rows = 0;
    if (bytes > 65536) throw new Error("SQLite column headings exceed output limit");
    for (const row of statement.iterate()) {
      if (rows++ >= maxRows) { lines.push("[row limit reached]"); break; }
      const line = columns.map(column => {
        const value = row[column];
        if (value === null) return "NULL";
        if (value instanceof Uint8Array) return `<BLOB ${value.byteLength} bytes>`;
        return String(value).slice(0, 1000).replace(/[\r\n\t]+/g, " ");
      }).join("\t");
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > 65536) { lines.push("[output limit reached]"); break; }
      lines.push(line);
    }
    process.stdout.write(JSON.stringify({ text: rows ? lines.join("\n") : "(no rows returned)" }));
  } finally { database.close(); }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
