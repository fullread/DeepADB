// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP Transport — Streamable HTTP and legacy SSE on the same port.
 *
 * When DA_HTTP_PORT is set, DeepADB starts an HTTP server instead of
 * the stdio transport. Clients connect via Server-Sent Events.
 *
 * Endpoints:
 *   POST/GET/DELETE /mcp — Streamable HTTP session
 *   GET  /sse      — SSE stream (client subscribes here)
 *   POST /message  — Client sends JSON-RPC messages here
 *   GET  /health   — Simple health check
 *
 * Uses the MCP SDK's SSEServerTransport.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { Logger } from "./middleware/logger.js";
import { checkAuth } from "./middleware/auth.js";
import { checkOriginAndCors, readAllowedOrigins } from "./middleware/origin.js";
import { VERSION } from "./config/config.js";
import { StreamableHttpSession } from "./streamable-http.js";
import { httpBaseUrl } from "./middleware/http-url.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  version?: string;
}

/**
 * Start an HTTP server that provides SSE-based MCP transport.
 * Each SSE connection creates a new transport session.
 */
export async function startHttpTransport(
  server: McpServer,
  options: HttpTransportOptions,
  logger: Logger,
): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const origins = readAllowedOrigins("DA_HTTP_CORS_ORIGIN");
  let activeTransport: SSEServerTransport | null = null;
  let replacingSse = false;
  const streamable = new StreamableHttpSession(server, logger);

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", httpBaseUrl(host, options.port));
      const isMcp = url.pathname === "/mcp";
      if (!checkOriginAndCors(req, res, origins, isMcp ? ["GET", "POST", "DELETE", "OPTIONS"] : ["GET", "POST", "OPTIONS"],
        ["Content-Type", "Authorization", "MCP-Protocol-Version", "Last-Event-ID", ...(isMcp ? ["Mcp-Session-Id"] : [])])) return;
      if (isMcp) res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      // Health check (unauthenticated — only returns status info)
      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // BO6 fix: fall back to imported VERSION constant rather than the
        // string "unknown" when options.version is omitted. Keeps /health
        // useful for diagnostics even if the transport is constructed
        // without explicit version.
        res.end(JSON.stringify({ status: "ok", transport: "sse", version: options.version ?? VERSION }));
        return;
      }

      // Bearer token auth — all endpoints below require valid token when DA_AUTH_TOKEN is set
      if (!checkAuth(req, res)) return;

      if (isMcp) {
        await streamable.handle(req, res, activeTransport !== null || replacingSse);
        return;
      }

      // SSE endpoint — client subscribes here
      if (url.pathname === "/sse" && req.method === "GET") {
        if (streamable.active || replacingSse) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Another MCP client is connecting or has an active /mcp session" }));
          return;
        }
        replacingSse = true;
        try {
          logger.info(`SSE client connected from ${req.socket.remoteAddress}`);

          // W1: close the previous transport before replacing it (single-client
          // model). Without the explicit close, the old transport's response
          // stream stays open until GC reclaims it, briefly leaking a file
          // descriptor and a half-open SSE channel that the previous client
          // might still be writing to.
          if (activeTransport) {
            logger.warn("New SSE connection replacing existing one.");
            try {
              await activeTransport.close();
            } catch (err) {
              logger.warn(`Failed to close previous SSE transport: ${err instanceof Error ? err.message : err}`);
            }
            activeTransport = null;
          }

          const transport = new SSEServerTransport("/message", res);
          activeTransport = transport;

          await server.connect(transport);
          const sdkClose = transport.onclose;
          let closed = false;
          transport.onclose = () => {
            // The legacy SDK signals close() immediately, then signals again
            // when the response emits close. Its protocol teardown is shared
            // by all transports, so a late duplicate could detach a new client.
            if (closed) return;
            closed = true;
            logger.info("SSE client disconnected.");
            if (activeTransport === transport) activeTransport = null;
            sdkClose?.();
          };
          // Keep activeTransport until SDK teardown, not IncomingMessage.close:
          // a replacement must close the old protocol before connecting itself.
          const sdkMessage = transport.onmessage;
          transport.onmessage = (message, extra) => {
            // handlePostMessage awaits the upload. The connection may have
            // been replaced while that body was still arriving.
            if (activeTransport !== transport || replacingSse) throw new Error("SSE session is no longer active");
            sdkMessage?.(message, extra);
          };
        } finally { replacingSse = false; }
        return;
      }

      // Message endpoint — client sends JSON-RPC here
      if (url.pathname === "/message" && req.method === "POST") {
        if (!activeTransport) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No active SSE session. Connect to /sse first." }));
          return;
        }

        const ids = url.searchParams.getAll("sessionId");
        if (ids.length !== 1 || !ids[0]) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Exactly one sessionId query parameter is required" }));
          return;
        }
        if (ids[0] !== activeTransport.sessionId) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "SSE session not found; reconnect to /sse" }));
          return;
        }

        await activeTransport.handlePostMessage(req, res);
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Not found",
        endpoints: {
          "GET /sse": "SSE stream for MCP client",
          "POST /message": "JSON-RPC messages",
          "GET /health": "Health check",
          "POST/GET/DELETE /mcp": "Streamable HTTP MCP session",
        },
      }));
    } catch (err) {
      logger.error(`HTTP request error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  // Bound incomplete request uploads, in addition to the SDK's 1 MiB body cap.
  httpServer.requestTimeout = 15_000;

  return new Promise((resolve, reject) => {
    httpServer.on("error", (err) => {
      logger.error(`HTTP transport failed to start: ${err.message}`);
      reject(err);
    });

    httpServer.listen(options.port, host, () => {
      logger.info(`HTTP/SSE transport listening on ${httpBaseUrl(host, options.port)}`);
      logger.info(`  SSE endpoint: ${httpBaseUrl(host, options.port)}/sse`);
      logger.info(`  Message endpoint: ${httpBaseUrl(host, options.port)}/message`);
      logger.info(`  Streamable HTTP endpoint: ${httpBaseUrl(host, options.port)}/mcp`);
      resolve();
    });
  });
}
