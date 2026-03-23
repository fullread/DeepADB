#!/usr/bin/env node
/**
 * DeepADB — MCP Server for Android Debug Bridge
 *
 * Entry point. Supports three transport modes (mutually exclusive):
 *   - stdio (default) — JSON-RPC over stdin/stdout for Claude Code
 *   - HTTP/SSE — Set DA_HTTP_PORT to enable browser-based MCP clients
 *   - WebSocket — Set DA_WS_PORT to enable bidirectional streaming (requires `ws` package)
 *
 * Additionally supports an independent GraphQL API endpoint:
 *   - GraphQL — Set DA_GRAPHQL_PORT for composed device queries (requires `graphql` package)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startHttpTransport } from "./http-transport.js";
import { startWsTransport } from "./ws-transport.js";
import { startGraphQLApi } from "./graphql-api.js";
import { VERSION } from "./config/config.js";

async function main(): Promise<void> {
  const { server, logger, bridge, deviceManager } = await createServer();

  /** Parse a port env var safely — returns null if unset, NaN, out of range, or negative. */
  function parsePort(envVar: string | undefined): number | null {
    if (!envVar) return null;
    const port = parseInt(envVar, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`[DeepADB] Invalid port "${envVar}" — must be 1-65535. Ignoring.`);
      return null;
    }
    return port;
  }

  const httpPort = parsePort(process.env.DA_HTTP_PORT);
  const httpHost = process.env.DA_HTTP_HOST ?? "127.0.0.1";
  const wsPort = parsePort(process.env.DA_WS_PORT);
  const graphqlPort = parsePort(process.env.DA_GRAPHQL_PORT);

  // GraphQL API runs independently alongside any transport mode
  if (graphqlPort) {
    try {
      await startGraphQLApi(bridge, deviceManager, { port: graphqlPort, host: httpHost, version: VERSION }, logger);
      console.error(`[DeepADB] GraphQL API running on http://${httpHost}:${graphqlPort}/graphql`);
    } catch (err) {
      console.error(`[DeepADB] GraphQL API failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (httpPort) {
    // HTTP/SSE mode — start HTTP server
    await startHttpTransport(server, { port: httpPort, host: httpHost, version: VERSION }, logger);
    console.error(`[DeepADB] HTTP/SSE transport running on http://${httpHost}:${httpPort}`);
  } else if (wsPort) {
    // WebSocket mode — requires `ws` npm package
    await startWsTransport(server, { port: wsPort, host: httpHost, version: VERSION }, logger);
    console.error(`[DeepADB] WebSocket transport running on ws://${httpHost}:${wsPort}/ws`);
  } else {
    // Default: stdio mode
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[DeepADB] Server running on stdio transport. Ready for connections.");
  }
}

main().catch((error) => {
  console.error("[DeepADB] Fatal error:", error);
  process.exit(1);
});
