// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Optional live-device smoke tests for the next-version diagnostics. */

import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Next-Version Device Smoke Tests");
let deviceAvailable = false;
try {
  const devices = await h.callTool("adb_devices", {});
  deviceAvailable = !h.isError(devices) && /\(device\)/.test(h.getText(devices));
} catch {
  deviceAvailable = false;
}

if (!deviceAvailable) {
  for (const label of ["Runtime audit", "Per-app route context", "SQLite inspector", "Wear preflight", "Shannon session"]) {
    h.skip(label, "no authorized device");
  }
} else {
  await h.testContains("Runtime audit", "adb_runtime_audit", {}, "Unified Runtime Audit", 60000);
  await h.testContains("Per-app route context", "adb_app_route_context", {
    packageName: "com.android.settings",
  }, "Per-App Route Context", 60000);

  let sqlitePackage = "com.android.settings";
  let sqlite = await h.callTool("adb_sqlite_inspect", {
    packageName: "com.android.settings", action: "list",
  }, 60000);
  let sqliteText = h.getText(sqlite);
  if (/no visible databases/i.test(sqliteText)) {
    sqlitePackage = "com.google.android.gms";
    sqlite = await h.callTool("adb_sqlite_inspect", {
      packageName: sqlitePackage, action: "list",
    }, 60000);
    sqliteText = h.getText(sqlite);
  }
  const listedDatabase = sqliteText.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\t\d+ bytes$/m)?.[1];
  if (listedDatabase && !h.isError(sqlite)) {
    const schema = await h.callTool("adb_sqlite_inspect", {
      packageName: sqlitePackage, action: "schema", database: listedDatabase,
    }, 60000);
    const schemaText = h.getText(schema);
    h.assert(
      "SQLite inspector opens a listed database read-only or reports the missing on-device backend",
      (!h.isError(schema) && schemaText.includes("=== Schema:"))
        || /sqlite3 is unavailable on this Android host/i.test(schemaText),
      schemaText.slice(0, 240),
    );
  } else {
    h.assert(
      "SQLite inspector returns a bounded capability or database result",
      sqliteText.length > 0 && /sqlite3|database|run-as|root access/i.test(sqliteText),
      sqliteText.slice(0, 240),
    );
  }

  await h.testContains("Wear preflight", "adb_wear_datalayer_preflight", {}, "Wear Data Layer Preflight", 60000);

  const shannon = await h.callTool("adb_shannon_session", {}, 60000);
  const shannonText = h.getText(shannon);
  const shannonHardwareReady = /Chipset family: shannon/i.test(shannonText)
    && /Root: available/i.test(shannonText)
    && /Ports present: (?!none\b)/i.test(shannonText);
  h.assert(
    shannonHardwareReady
      ? "Shannon session completes the live AT/OK handshake"
      : "Shannon session completes a bounded preflight",
    shannonText.includes("Shannon Session Preflight")
      && (!shannonHardwareReady || shannonText.includes("SHANNON SESSION READY")),
    shannonText.slice(0, 240),
  );
}

process.exit(h.finish());
