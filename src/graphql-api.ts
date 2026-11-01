// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * GraphQL API — Composed device query endpoint.
 *
 * Optional HTTP endpoint serving a GraphQL API over device state.
 * Enables clients to compose multiple device queries into a single
 * request — for example, fetching device info, battery, signal, and
 * installed packages in one round trip instead of 4+ MCP tool calls.
 *
 * Requires the `graphql` npm package as an optional peer dependency:
 *   npm install graphql
 *
 * Set DA_GRAPHQL_PORT to enable. Runs independently from the MCP
 * transport (stdio/HTTP/WebSocket).
 *
 * Endpoints:
 *   POST /graphql  — GraphQL query execution
 *   GET  /graphql  — GraphQL query via query string (for introspection tools)
 *   GET  /health   — Health check
 *
 * Example query:
 *   { devices { serial model androidVersion battery { level charging } } }
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { AdbBridge } from "./bridge/adb-bridge.js";
import { DeviceManager } from "./bridge/device-manager.js";
import { Logger } from "./middleware/logger.js";
import { checkAuth } from "./middleware/auth.js";
import { checkOriginAndCors, readAllowedOrigins } from "./middleware/origin.js";
import { httpBaseUrl } from "./middleware/http-url.js";
import { checkGraphQLBudget, GraphQLRequestBudget, GraphQLWorkPool } from "./middleware/graphql-budget.js";

export interface GraphQLOptions {
  port: number;
  host?: string;
  version?: string;
}

const SCHEMA_SDL = `
  type Query {
    devices: [Device!]!
    device(serial: String): Device!
  }

  type Device {
    serial: String!
    state: String!
    model: String!
    manufacturer: String!
    androidVersion: String!
    sdkLevel: Int!
    securityPatch: String!
    buildId: String!
    abi: String!
    battery: Battery!
    network: Network!
    properties(keys: [String!]): [Property!]!
  }

  type Battery {
    level: Int!
    status: String!
    charging: Boolean!
    temperature: Float!
    voltage: Float!
    health: String!
    technology: String!
  }

  type Network {
    wifi: String!
    ip: String!
    operator: String!
    networkType: String!
  }

  type Property {
    key: String!
    value: String!
  }
`;

function parseBatteryDump(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s+(\S[\w\s]*\w):\s+(.*)/);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

function buildResolvers(deviceManager: DeviceManager, budget: GraphQLRequestBudget) {
  return {
    devices: async () => {
      const devices = await budget.run(() => deviceManager.listDevices());
      if (devices.length > 16) throw new Error("GraphQL device list exceeds limit (16); select a device by serial");
      // Pre-fetch props for each device so field resolvers share one getprop call
      const results = [];
      for (const d of devices) {
        let props: Record<string, string> = {};
        if (d.state === "device") {
          props = await budget.run(() => deviceManager.getDeviceProps(d.serial).catch(() => ({})));
        }
        results.push({ serial: d.serial, state: d.state, _serial: d.serial, _props: props });
      }
      return results;
    },

    device: async ({ serial }: { serial?: string }) => {
      const resolved = await budget.run(() => deviceManager.resolveDevice(serial));
      const props = await budget.run(() => deviceManager.getDeviceProps(resolved.serial));
      return { serial: resolved.serial, state: "device", _serial: resolved.serial, _props: props };
    },
  };
}

function buildFieldResolvers(bridge: AdbBridge, budget: GraphQLRequestBudget) {
  return {
    Device: {
      model: (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.product.model"] ?? "unknown";
      },
      manufacturer: (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.product.manufacturer"] ?? "unknown";
      },
      androidVersion: (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.build.version.release"] ?? "unknown";
      },
      sdkLevel: (parent: { _serial: string; _props: Record<string, string> }) => {
        return parseInt(parent._props["ro.build.version.sdk"] ?? "0", 10) || 0;
      },
      securityPatch: (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.build.version.security_patch"] ?? "unknown";
      },
      buildId: (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.build.display.id"] ?? "unknown";
      },
      abi: (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.product.cpu.abi"] ?? "unknown";
      },
      battery: async (parent: { _serial: string; _props: Record<string, string> }) => {
        const result = await budget.run(() => bridge.shell("dumpsys battery", { device: parent._serial, timeout: 5000 }));
        const parsed = parseBatteryDump(result.stdout);
        return {
          level: parseInt(parsed["level"] ?? "0", 10),
          status: parsed["status"] ?? "unknown",
          charging: (parsed["status"] ?? "").includes("2") || (parsed["AC powered"] ?? "") === "true" || (parsed["USB powered"] ?? "") === "true",
          temperature: parseFloat(parsed["temperature"] ?? "0") / 10,
          voltage: parseFloat(parsed["voltage"] ?? "0") / 1000,
          health: parsed["health"] ?? "unknown",
          technology: parsed["technology"] ?? "unknown",
        };
      },
      network: async (parent: { _serial: string; _props: Record<string, string> }) => {
        const props = parent._props;
        const wifiResult = await budget.run(() => bridge.shell("dumpsys wifi | grep 'mWifiInfo' | head -1", {
          device: parent._serial, ignoreExitCode: true, timeout: 5000,
        }));
        const ssidMatch = wifiResult.stdout.match(/SSID:\s*([^,]+)/);
        const ipResult = await budget.run(() => bridge.shell("ip route | grep 'src' | head -1", {
          device: parent._serial, ignoreExitCode: true, timeout: 5000,
        }));
        const ipMatch = ipResult.stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);

        return {
          wifi: ssidMatch ? ssidMatch[1].trim() : "disconnected",
          ip: ipMatch ? ipMatch[1] : "unknown",
          operator: props["gsm.operator.alpha"] ?? "unknown",
          networkType: props["gsm.network.type"] ?? "unknown",
        };
      },
      properties: (parent: { _serial: string; _props: Record<string, string> }, { keys }: { keys?: string[] }) => {
        const props = parent._props;
        if (keys) {
          if (keys.length > 100) throw new Error("properties keys exceeds limit (100)");
          return keys.map((k) => ({ key: k, value: props[k] ?? "" }));
        }
        // Return all properties, capped at 500 to prevent response size explosion
        const MAX_PROPERTIES = 500;
        const entries = Object.entries(props);
        const limited = entries.slice(0, MAX_PROPERTIES).map(([key, value]) => ({ key, value }));
        if (entries.length > MAX_PROPERTIES) {
          limited.push({ key: "_truncated", value: `${entries.length - MAX_PROPERTIES} properties omitted. Use keys parameter to query specific properties.` });
        }
        return limited;
      },
    },
  };
}

/** Maximum POST body size (1 MB) to prevent memory exhaustion. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Start a GraphQL API server.
 * Requires the `graphql` npm package to be installed.
 */
export async function startGraphQLApi(
  bridge: AdbBridge,
  deviceManager: DeviceManager,
  options: GraphQLOptions,
  logger: Logger,
): Promise<void> {
  const host = options.host ?? "127.0.0.1";

  // Dynamic import of graphql — optional dependency
  let graphqlModule: typeof import("graphql");

  try {
    const moduleName = "graphql";
    graphqlModule = await import(/* webpackIgnore: true */ moduleName) as typeof import("graphql");
    if (!graphqlModule.buildSchema || !graphqlModule.execute) {
      throw new Error("buildSchema or graphql not found in module");
    }
  } catch {
    logger.error(
      "GraphQL API requires the 'graphql' npm package.\n" +
      "Install with: npm install graphql\n" +
      "Then restart DeepADB with DA_GRAPHQL_PORT set."
    );
    throw new Error("Optional dependency 'graphql' not installed. Run: npm install graphql");
  }

  const schema = graphqlModule.buildSchema(SCHEMA_SDL);
  const origins = readAllowedOrigins("DA_GRAPHQL_CORS_ORIGIN");
  const pool = new GraphQLWorkPool();
  let activeRequests = 0;

  // Custom field resolver that checks our type-specific resolvers
  const fieldResolver = (source: Record<string, unknown>, _args: unknown, _context: GraphQLRequestBudget, info: { parentType: { name: string }; fieldName: string }) => {
    const fieldResolvers = buildFieldResolvers(bridge, _context);
    const typeResolvers = (fieldResolvers as Record<string, Record<string, unknown>>)[info.parentType.name];
    if (typeResolvers && typeof typeResolvers[info.fieldName] === "function") {
      return (typeResolvers[info.fieldName] as (parent: unknown, args: unknown) => unknown)(source, (_args ?? {}) as Record<string, unknown>);
    }
    // Default-resolver semantics: if the field on the source object is a
    // function (e.g. a rootValue Query resolver such as devices/device),
    // invoke it with the field args; otherwise return the property value.
    // Without this function-invocation branch, root Query resolvers would
    // resolve to the function object itself rather than its result, which
    // surfaces as a GraphQL "Expected Iterable" error for list fields.
    const value = source[info.fieldName];
    return typeof value === "function"
      ? (value as (args: unknown, context: unknown, info: unknown) => unknown)(_args ?? {}, _context, info)
      : value;
  };

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!checkOriginAndCors(req, res, origins, ["GET", "POST", "OPTIONS"], ["Content-Type", "Authorization"])) return;

    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", transport: "graphql", version: options.version ?? "unknown" }));
      return;
    }

    // Bearer token auth — all endpoints below require valid token when DA_AUTH_TOKEN is set
    if (!checkAuth(req, res)) return;

    if (req.url?.startsWith("/graphql")) {
      if (activeRequests >= 8) { res.writeHead(429); res.end("Too many GraphQL requests"); return; }
      activeRequests++;
      const budget = new GraphQLRequestBudget(pool);
      res.once("close", () => { budget.cancelled = true; });
      try {
        let query = "";
        let variables: Record<string, unknown> = {};
        let operationName: string | undefined;

        if (req.method === "POST") {
          const body = await new Promise<string>((resolve, reject) => {
            let data = "";
            let bytes = 0;
            req.on("data", (chunk: Buffer | string) => {
              bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
              if (bytes > MAX_BODY_BYTES) {
                req.destroy();
                reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`));
                return;
              }
              data += chunk.toString();
            });
            req.on("end", () => resolve(data));
            req.on("error", reject);
          });
          const parsed = JSON.parse(body);
          query = parsed.query ?? "";
          variables = parsed.variables ?? {};
          operationName = parsed.operationName;
        } else if (req.method === "GET") {
          const url = new URL(req.url, httpBaseUrl(host, options.port));
          query = url.searchParams.get("query") ?? "";
          operationName = url.searchParams.get("operationName") ?? undefined;
          const varsParam = url.searchParams.get("variables");
          if (varsParam) variables = JSON.parse(varsParam);
        }

        if (!query) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ errors: [{ message: "Missing 'query' parameter" }] }));
          return;
        }

        if (typeof query !== "string" || Buffer.byteLength(query) > 65536 || !variables || typeof variables !== "object" || Array.isArray(variables)) throw new Error("Invalid GraphQL request or query exceeds 64 KiB");
        const document = graphqlModule.parse(query, { maxTokens: 4096 });
        checkGraphQLBudget(document, variables);
        const errors = graphqlModule.validate(schema, document, undefined, { maxErrors: 20 });
        if (errors.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ errors })); return; }
        const result = await graphqlModule.execute({
          schema, document, rootValue: buildResolvers(deviceManager, budget),
          variableValues: variables, fieldResolver, contextValue: budget, operationName,
        });
        const response = JSON.stringify(result);
        if (Buffer.byteLength(response) > MAX_BODY_BYTES) throw new Error("GraphQL response exceeds 1 MiB");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(response);
      } catch (err) {
        if (res.headersSent || res.destroyed) return;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: err instanceof Error ? err.message : String(err) }] }));
      } finally { budget.cancelled = true; activeRequests--; }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /graphql or GET /health" }));
  });

  httpServer.requestTimeout = 15_000;
  return new Promise((resolve, reject) => {
    httpServer.on("error", (err) => {
      logger.error(`GraphQL API failed to start: ${err.message}`);
      reject(err);
    });

    httpServer.listen(options.port, host, () => {
      logger.info(`GraphQL API listening on ${httpBaseUrl(host, options.port)}/graphql`);
      logger.info(`  Health check: ${httpBaseUrl(host, options.port)}/health`);
      resolve();
    });
  });
}
