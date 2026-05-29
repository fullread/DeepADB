#!/usr/bin/env node
// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * DeepADB — MCP Server for Android Debug Bridge
 *
 * Entry point. Supports three transport modes (mutually exclusive):
 *   - stdio (default) — JSON-RPC over stdin/stdout for MCP clients (Claude Code, etc.)
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
import { isAuthEnabled, validateTokenStrength } from "./middleware/auth.js";

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

  // BL7 fix: HTTP and WebSocket transports are mutually exclusive (HTTP takes
  // precedence). Without this warning, an operator who set both env vars
  // silently got HTTP only with no indication their WS_PORT was ignored.
  if (httpPort && wsPort) {
    console.error("[DeepADB] ⚠ Both DA_HTTP_PORT and DA_WS_PORT are set — HTTP takes precedence. DA_WS_PORT is ignored.");
  }

  // Warn when binding network transports to non-loopback addresses.
  // This is the #2 most common MCP security finding (Backslash/AgentSeal research):
  // servers exposed on 0.0.0.0 without authentication allow anyone on the network
  // to execute tools, including shell commands, on the host machine.
  const isLoopback = httpHost === "127.0.0.1" || httpHost === "localhost" || httpHost === "::1";
  if (!isLoopback && (httpPort || wsPort || graphqlPort) && !isAuthEnabled()) {
    // BL6 fix: detect Unicode-capable terminal. Windows Terminal, VS Code,
    // and any non-Windows host can render the box-drawing characters
    // (╔═╗║╠╣╚╝). Legacy cmd.exe on the OEM code page (CP437/CP850) cannot
    // and renders them as mojibake. Detection heuristic: anything other
    // than Windows = OK; Windows + WT_SESSION (Windows Terminal) or
    // TERM_PROGRAM (VS Code, etc.) = OK; otherwise fall back to ASCII.
    // Operator can force ASCII by setting DA_ASCII_ONLY=1.
    const wantsAscii =
      process.env.DA_ASCII_ONLY === "1" ||
      (process.platform === "win32" &&
        !process.env.WT_SESSION &&
        !process.env.TERM_PROGRAM &&
        !process.env.TERM);
    const C = wantsAscii
      ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", sep: "+", warn: "!!" }
      : { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", sep: "╠", warn: "⚠" };
    const sepR = wantsAscii ? "+" : "╣";
    const hLine = C.h.repeat(62);
    console.error(`${C.tl}${hLine}${C.tr}`);
    console.error(`${C.v}  ${C.warn}  WARNING: Network-exposed transport without authentication  ${C.v}`);
    console.error(`${C.sep}${hLine}${sepR}`);
    console.error(`${C.v}  Binding to ${httpHost} — accessible to other machines on the network.`);
    console.error(`${C.v}  DeepADB provides shell execution, file access, and root commands.`);
    console.error(`${C.v}  Anyone who can reach this port can execute tools without auth.`);
    console.error(`${C.v}                                                                  ${C.v}`);
    console.error(`${C.v}  Recommendations:                                                ${C.v}`);
    console.error(`${C.v}    ${wantsAscii ? "*" : "•"} Set a bearer token: DA_AUTH_TOKEN=your-secret-token         ${C.v}`);
    console.error(`${C.v}    ${wantsAscii ? "*" : "•"} Enable security middleware: DA_SECURITY=true                ${C.v}`);
    console.error(`${C.v}    ${wantsAscii ? "*" : "•"} Set an allowlist: DA_ALLOWED_COMMANDS=dumpsys,getprop,...    ${C.v}`);
    console.error(`${C.v}    ${wantsAscii ? "*" : "•"} Restrict CORS: DA_HTTP_CORS_ORIGIN=https://your-app.example ${C.v}`);
    console.error(`${C.v}    ${wantsAscii ? "*" : "•"} Use a reverse proxy with HTTPS in front of DeepADB          ${C.v}`);
    console.error(`${C.v}                                                                  ${C.v}`);
    console.error(`${C.v}  See SECURITY.md for deployment guidance.                        ${C.v}`);
    console.error(`${C.bl}${hLine}${C.br}`);
  }

  // Log auth status for network transports
  if (httpPort || wsPort || graphqlPort) {
    if (isAuthEnabled()) {
      console.error("[DeepADB] Bearer token authentication enabled (DA_AUTH_TOKEN set)");
      validateTokenStrength();
    } else if (!isLoopback) {
      console.error("[DeepADB] ⚠ No authentication configured. Set DA_AUTH_TOKEN for bearer token auth.");
    }
  }

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
