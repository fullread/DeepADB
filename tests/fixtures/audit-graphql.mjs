// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
// Mocked I/O behind the real HTTP API. Never contacts ADB.
import { startGraphQLApi } from "../../build/graphql-api.js";
let calls = 0, running = 0, maximum = 0;
async function work(value) {
  calls++; running++; maximum = Math.max(maximum, running);
  try { await new Promise(resolve => setTimeout(resolve, 25)); return value; }
  finally { running--; }
}
const manager = {
  listDevices: () => work(Array.from({ length: 16 }, (_, i) => ({ serial: `fixture-${i}`, state: "device" }))),
  resolveDevice: () => work({ serial: "fixture" }),
  getDeviceProps: () => work({ "ro.product.model": "Fixture" }),
};
const bridge = { shell: () => work({ stdout: "  level: 75\n", stderr: "", exitCode: 0 }) };
await startGraphQLApi(bridge, manager, { port: Number(process.env.AUDIT_PORT), host: process.env.AUDIT_HOST }, { info() {}, error() {} });
process.on("message", id => process.send({ id, calls, running, maximum }));
process.send({ ready: true });
