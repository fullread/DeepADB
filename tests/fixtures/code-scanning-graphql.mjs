// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
// Exercise the real HTTP API with synthetic failures and no device access.
import { GraphQLError } from "graphql";
import { startGraphQLApi } from "../../build/graphql-api.js";
import { GraphQLClientError } from "../../build/middleware/graphql-errors.js";

const canary = "CODE_SCANNING_PRIVATE_DETAIL /private/fixture/adb";
const manager = {
  listDevices: async () => [],
  resolveDevice: async serial => {
    if (serial === "internal") throw new Error(canary);
    if (serial === "non-error") throw { message: canary, toString: () => canary };
    if (serial === "graphql-error") throw new GraphQLError(canary, { extensions: { stack: canary, code: "PROPERTY_LIMIT" } });
    if (serial === "spoofed") throw Object.assign(new Error(canary), { name: "GraphQLClientError", code: "PROPERTY_LIMIT" });
    if (serial === "unknown-code") {
      const error = new GraphQLClientError("OPERATION_LIMIT");
      error.code = canary;
      throw error;
    }
    if (serial === "known-limit") {
      const error = new GraphQLClientError("OPERATION_LIMIT");
      error.message = canary; // Only the trusted code's fixed message may escape.
      throw error;
    }
    return { serial: serial ?? "fixture" };
  },
  getDeviceProps: async serial => ({
    "ro.product.model": serial === "catch-error" ? "TRIGGER_SERIALIZATION_FAILURE"
      : serial === "large-response" ? "x".repeat(1024 * 1024) : "Fixture",
  }),
};
const bridge = {
  shell: async (_command, options) => {
    if (options.device === "nested-error") throw new Error(canary);
    return { stdout: "  level: 75\n", stderr: "", exitCode: 0 };
  },
};
const stringify = JSON.stringify;
JSON.stringify = function(value, ...args) {
  if (value?.data?.device?.model === "TRIGGER_SERIALIZATION_FAILURE") throw new Error(canary);
  return stringify(value, ...args);
};
await startGraphQLApi(bridge, manager, { port: Number(process.env.AUDIT_PORT) }, {
  info() {}, error(...args) { console.error(...args); },
});
process.send({ ready: true });
