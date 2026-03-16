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

function buildResolvers(bridge: AdbBridge, deviceManager: DeviceManager) {
  return {
    devices: async () => {
      const devices = await deviceManager.listDevices();
      // Pre-fetch props for each device so field resolvers share one getprop call
      const results = [];
      for (const d of devices) {
        let props: Record<string, string> = {};
        if (d.state === "device") {
          try { props = await deviceManager.getDeviceProps(d.serial); } catch { /* offline */ }
        }
        results.push({ serial: d.serial, state: d.state, _serial: d.serial, _props: props });
      }
      return results;
    },

    device: async ({ serial }: { serial?: string }) => {
      const resolved = await deviceManager.resolveDevice(serial);
      const props = await deviceManager.getDeviceProps(resolved.serial);
      return { serial: resolved.serial, state: "device", _serial: resolved.serial, _props: props };
    },
  };
}

function buildFieldResolvers(bridge: AdbBridge, deviceManager: DeviceManager) {
  return {
    Device: {
      model: async (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.product.model"] ?? "unknown";
      },
      manufacturer: async (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.product.manufacturer"] ?? "unknown";
      },
      androidVersion: async (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.build.version.release"] ?? "unknown";
      },
      sdkLevel: async (parent: { _serial: string; _props: Record<string, string> }) => {
        return parseInt(parent._props["ro.build.version.sdk"] ?? "0", 10) || 0;
      },
      securityPatch: async (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.build.version.security_patch"] ?? "unknown";
      },
      buildId: async (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.build.display.id"] ?? "unknown";
      },
      abi: async (parent: { _serial: string; _props: Record<string, string> }) => {
        return parent._props["ro.product.cpu.abi"] ?? "unknown";
      },
      battery: async (parent: { _serial: string; _props: Record<string, string> }) => {
        const result = await bridge.shell("dumpsys battery", { device: parent._serial });
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
        const wifiResult = await bridge.shell("dumpsys wifi | grep 'mWifiInfo' | head -1", {
          device: parent._serial, ignoreExitCode: true,
        });
        const ssidMatch = wifiResult.stdout.match(/SSID:\s*([^,]+)/);
        const ipResult = await bridge.shell("ip route | grep 'src' | head -1", {
          device: parent._serial, ignoreExitCode: true,
        });
        const ipMatch = ipResult.stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);

        return {
          wifi: ssidMatch ? ssidMatch[1].trim() : "disconnected",
          ip: ipMatch ? ipMatch[1] : "unknown",
          operator: props["gsm.operator.alpha"] ?? "unknown",
          networkType: props["gsm.network.type"] ?? "unknown",
        };
      },
      properties: async (parent: { _serial: string; _props: Record<string, string> }, { keys }: { keys?: string[] }) => {
        const props = parent._props;
        if (keys) {
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
  let graphqlModule: {
    buildSchema: (source: string) => unknown;
    graphql: (args: { schema: unknown; source: string; rootValue: unknown; fieldResolver?: unknown }) => Promise<{ data?: unknown; errors?: Array<{ message: string }> }>;
  };

  try {
    const moduleName = "graphql";
    const mod = await import(/* webpackIgnore: true */ moduleName) as Record<string, unknown>;
    graphqlModule = {
      buildSchema: (mod.buildSchema ?? (mod.default as Record<string, unknown>)?.buildSchema) as typeof graphqlModule.buildSchema,
      graphql: (mod.graphql ?? (mod.default as Record<string, unknown>)?.graphql) as typeof graphqlModule.graphql,
    };
    if (!graphqlModule.buildSchema || !graphqlModule.graphql) {
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
  const rootValue = buildResolvers(bridge, deviceManager);
  const fieldResolvers = buildFieldResolvers(bridge, deviceManager);

  // Custom field resolver that checks our type-specific resolvers
  const fieldResolver = (source: Record<string, unknown>, _args: unknown, _context: unknown, info: { parentType: { name: string }; fieldName: string }) => {
    const typeResolvers = (fieldResolvers as Record<string, Record<string, unknown>>)[info.parentType.name];
    if (typeResolvers && typeof typeResolvers[info.fieldName] === "function") {
      return (typeResolvers[info.fieldName] as (parent: unknown, args: unknown) => unknown)(source, (_args ?? {}) as Record<string, unknown>);
    }
    return source[info.fieldName];
  };

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    const allowedOrigin = process.env.DA_GRAPHQL_CORS_ORIGIN ?? "";
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", transport: "graphql", version: options.version ?? "unknown" }));
      return;
    }

    if (req.url?.startsWith("/graphql")) {
      try {
        let query = "";
        let variables: Record<string, unknown> = {};

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
        } else if (req.method === "GET") {
          const url = new URL(req.url, `http://${host}`);
          query = url.searchParams.get("query") ?? "";
          const varsParam = url.searchParams.get("variables");
          if (varsParam) variables = JSON.parse(varsParam);
        }

        if (!query) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ errors: [{ message: "Missing 'query' parameter" }] }));
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await graphqlModule.graphql({
          schema,
          source: query,
          rootValue,
          variableValues: variables,
          fieldResolver: fieldResolver as any,
        } as any);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: err instanceof Error ? err.message : String(err) }] }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /graphql or GET /health" }));
  });

  return new Promise((resolve, reject) => {
    httpServer.on("error", (err) => {
      logger.error(`GraphQL API failed to start: ${err.message}`);
      reject(err);
    });

    httpServer.listen(options.port, host, () => {
      logger.info(`GraphQL API listening on http://${host}:${options.port}/graphql`);
      logger.info(`  Health check: http://${host}:${options.port}/health`);
      resolve();
    });
  });
}
