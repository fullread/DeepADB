// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
// Hold the first response's close event until its replacement is initialized.
import { McpServer } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { startHttpTransport } from "../../build/http-transport.js";

const delayed = [];
let first = true;
const start = SSEServerTransport.prototype.start;
SSEServerTransport.prototype.start = async function() {
  if (first) {
    first = false;
    const response = this.res;
    const emit = response.emit;
    response.emit = function(event, ...args) {
      if (event === "close") {
        delayed.push(() => emit.call(response, event, ...args));
        return true;
      }
      return emit.call(this, event, ...args);
    };
  }
  return start.call(this);
};
const server = new McpServer({ name: "sse-close-order", version: "1" });
server.registerTool("probe", { description: "Synthetic connection probe" }, () => ({ content: [{ type: "text", text: "ok" }] }));
await startHttpTransport(server, { port: Number(process.env.AUDIT_PORT) }, { info() {}, warn() {}, error(...args) { console.error(...args); } });
process.on("message", ({ id, action }) => {
  if (action === "release") for (const close of delayed.splice(0)) close();
  process.send({ id, delayed: delayed.length });
});
process.send({ ready: true });
