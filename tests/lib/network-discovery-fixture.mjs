// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Deterministic closed-probe regression; never contacts the local network. */
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { registerNetworkDiscoveryTools } from "../../build/tools/network-discovery.js";

export async function verifyClosedDiscovery() {
  const handlers = new Map(), probes = [];
  let connections = 0, destroyed = 0;
  registerNetworkDiscoveryTools({
    server: { registerTool(name, _schema, handler) { handlers.set(name, handler); } },
    deviceManager: { async resolveDevice() { throw new Error("No fixture anchor"); } },
    bridge: {
      async shell() { throw new Error("Unexpected live ARP query"); },
      async exec() { connections++; throw new Error("Closed probes must not connect"); },
    },
  });
  const original = net.createConnection;
  net.createConnection = options => {
    probes.push({ host: options.host, port: options.port });
    const socket = new EventEmitter();
    socket.destroy = () => { destroyed++; return socket; };
    queueMicrotask(() => socket.emit("error", new Error("Synthetic ECONNREFUSED")));
    return socket;
  };
  syncBuiltinESMExports();
  try {
    const result = await handlers.get("adb_network_auto_connect")({ ipRange: "192.0.2.1-2", port: 5555 });
    assert.ok(!result.isError);
    assert.match(result.content.map(c => c.text).join("\n"), /No ADB listeners found/);
    assert.deepEqual(probes, [{ host: "192.0.2.1", port: 5555 }, { host: "192.0.2.2", port: 5555 }]);
    assert.equal(connections, 0);
    assert.equal(destroyed, 2);
  } finally {
    net.createConnection = original;
    syncBuiltinESMExports();
  }
}
