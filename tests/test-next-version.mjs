// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Device-free safety and parser tests for the next-version diagnostics. */

import { createHarness } from "./lib/harness.mjs";
import { buildReadOnlyFileGuard, validateReadOnlySql, limitReadOnlySql } from "../build/tools/database-inspector.js";
import { parsePackageUid, uidMatchesRule, extractRouteTables } from "../build/tools/app-network.js";
import { isWearDeviceProperties } from "../build/tools/wear.js";
import { buildAtShellCommand } from "../build/tools/at-commands.js";
import { buildModemCharacterDeviceProbe } from "../build/tools/runtime-audit.js";

const h = await createHarness("Next-Version Diagnostics");

h.section("Read-only SQLite validation");

const select = validateReadOnlySql("SELECT id, name FROM users ORDER BY id;");
h.assertEq("SELECT is accepted", select.kind, "query");
h.assertEq(
  "SELECT receives a hard row cap",
  limitReadOnlySql(select, 25),
  "SELECT * FROM (SELECT id, name FROM users ORDER BY id) AS deepadb_readonly LIMIT 25",
);
h.assertEq("WITH query is accepted", validateReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x").kind, "query");
h.assertEq("EXPLAIN query is accepted", validateReadOnlySql("EXPLAIN QUERY PLAN SELECT * FROM users").kind, "explain");
h.assertEq("Allowlisted PRAGMA is accepted", validateReadOnlySql("PRAGMA table_info(users)").kind, "pragma");
h.assertEq("Mutating word in a value is accepted", validateReadOnlySql("SELECT 'DELETE; -- data' AS sample").kind, "query");
h.assert("Database file guard rejects symbolic links", buildReadOnlyFileGuard("/data/user/0/com.example.app/databases/main.db").includes("! test -L"));

for (const [label, sql] of [
  ["UPDATE is rejected", "UPDATE users SET admin=1"],
  ["DELETE in a CTE is rejected", "WITH x AS (SELECT 1) DELETE FROM users"],
  ["ATTACH is rejected", "ATTACH DATABASE '/tmp/x' AS x"],
  ["Multiple statements are rejected", "SELECT 1; SELECT 2"],
  ["SQL comments are rejected", "SELECT 1 -- conceal another statement"],
  ["Writable PRAGMA is rejected", "PRAGMA writable_schema=ON"],
  ["Unknown PRAGMA is rejected", "PRAGMA journal_mode"],
  ["Device-side writefile function is rejected", "SELECT writefile('/data/local/tmp/x', X'00')"],
  ["Quoted writefile function is rejected", "SELECT \"writefile\"('/data/local/tmp/x', X'00')"],
  ["Device-side readfile escape is rejected", "SELECT readfile('/data/system/users/0/settings_global.xml')"],
  ["Dynamic eval function is rejected", "SELECT eval('DELETE FROM users')"],
]) {
  h.assert(label, typeof validateReadOnlySql(sql).error === "string");
}

h.section("Per-app routing parsers");

h.assertEq("dumpsys UID is parsed", parsePackageUid("userId=10234\n", "com.example.app"), 10234);
h.assertEq("cmd package UID is parsed", parsePackageUid("package:com.example.app uid:10234\n", "com.example.app"), 10234);
h.assert("UID matches inclusive rule range", uidMatchesRule("12000: from all uidrange 10200-10300 lookup wifi", 10234));
h.assert("UID outside rule range does not match", !uidMatchesRule("12000: from all uidrange 10200-10300 lookup wifi", 10301));
h.assertEq(
  "Route tables are safe and deduplicated",
  JSON.stringify(extractRouteTables([
    "100: from all uidrange 10200-10300 lookup wlan0",
    "101: from all uidrange 10200-10300 table local_network",
    "102: from all uidrange 10200-10300 lookup wlan0",
    "103: from all uidrange 10200-10300 lookup ../../escape",
  ])),
  JSON.stringify(["wlan0", "local_network"]),
);

h.section("Wear role classification");

h.assert("watch characteristic is recognized", isWearDeviceProperties({ "ro.build.characteristics": "nosdcard,watch" }));
h.assert("phone characteristic is not a watch", !isWearDeviceProperties({ "ro.build.characteristics": "nosdcard" }));

h.section("MCP input boundaries");

const shannonExchange = buildAtShellCommand("/dev/umts_router", "AT", 3000);
h.assert("Shannon exchange requires a character device", shannonExchange.includes("test -c '/dev/umts_router'"));
h.assert("Shannon exchange cannot create a missing node", shannonExchange.includes("conv=nocreat,notrunc"));
h.assert("Shannon exchange uses CRLF termination", shannonExchange.includes("printf '%s\\r\\n' 'AT'"));
h.assert("Shannon exchange re-arms bounded reads", shannonExchange.includes("while [ \"$i\" -lt 30 ]"));
h.assert("Shannon exchange continues after an empty partial-response read", !shannonExchange.includes("seen"));
h.assert("AT transport does not use output redirection on the node", !shannonExchange.includes("> '/dev/umts_router'"));
const modemProbe = buildModemCharacterDeviceProbe(["/dev/umts_router", "/dev/umts_router0"]);
h.assert("Runtime audit requires modem character devices", modemProbe.includes("test -c '/dev/umts_router'") && !modemProbe.includes("test -e"));

await h.testRejects("SQLite rejects a mutating query before device access", "adb_sqlite_inspect", {
  packageName: "com.example.app", action: "query", database: "main.db", query: "DELETE FROM users",
});
await h.testRejects("SQLite rejects database path traversal", "adb_sqlite_inspect", {
  packageName: "com.example.app", action: "schema", database: "../main.db",
});
await h.testRejects("SQLite enforces maximum rows", "adb_sqlite_inspect", {
  packageName: "com.example.app", action: "query", database: "main.db", query: "SELECT 1", maxRows: 1001,
});
await h.testRejects("Route context rejects an invalid package", "adb_app_route_context", {
  packageName: "com.example.app;id",
});
await h.testRejects("Shannon session rejects an unsafe port", "adb_shannon_session", {
  port: "/dev/umts_router0;id",
});
await h.testRejects("Shannon session rejects a non-AT device node", "adb_shannon_session", {
  port: "/dev/block/sda",
});
await h.testRejects("Wear preflight rejects an invalid package", "adb_wear_datalayer_preflight", {
  phonePackage: "com.example.app$(id)",
});

process.exit(h.finish());
