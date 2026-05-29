// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP/SSE Transport — Alternative to stdio for browser-based MCP clients.
 *
 * When DA_HTTP_PORT is set, DeepADB starts an HTTP server instead of
 * the stdio transport. Clients connect via Server-Sent Events.
 *
 * Endpoints:
 *   GET  /sse      — SSE stream (client subscribes here)
 *   POST /message  — Client sends JSON-RPC messages here
 *   GET  /health   — Simple health check
 *
 * Uses the MCP SDK's SSEServerTransport.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Logger } from "./middleware/logger.js";
import { checkAuth } from "./middleware/auth.js";
import { VERSION } from "./config/config.js";

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
  let activeTransport: SSEServerTransport | null = null;

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // CORS headers — restrict to configured origin (default: deny cross-origin)
      // BO7 fix: support comma-separated list of allowed origins. Production
      // deployments often need dev + staging + prod URLs; previously only
      // one was supported per process. The request's Origin header is
      // matched against the configured list; only the matched origin is
      // reflected in the response. Empty config = deny all cross-origin.
      const rawAllowedOrigins = process.env.DA_HTTP_CORS_ORIGIN ?? "";
      if (rawAllowedOrigins) {
        const allowedList = rawAllowedOrigins.split(",").map(s => s.trim()).filter(Boolean);
        const requestOrigin = req.headers.origin;
        if (typeof requestOrigin === "string" && allowedList.includes(requestOrigin)) {
          res.setHeader("Access-Control-Allow-Origin", requestOrigin);
          res.setHeader("Vary", "Origin");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        } else if (allowedList.length === 1 && !requestOrigin) {
          // Backwards compat: if exactly one origin is configured and no
          // Origin header is present (e.g., server-to-server), reflect the
          // single origin as before. Pre-BO7 behavior was unconditional.
          res.setHeader("Access-Control-Allow-Origin", allowedList[0]);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        }
        // No match: omit CORS headers entirely → browser blocks the request.
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${host}:${options.port}`);

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

      // SSE endpoint — client subscribes here
      if (url.pathname === "/sse" && req.method === "GET") {
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

        // When the SSE connection closes, clean up
        req.on("close", () => {
          logger.info("SSE client disconnected.");
          if (activeTransport === transport) {
            activeTransport = null;
          }
        });

        await server.connect(transport);
        return;
      }

      // Message endpoint — client sends JSON-RPC here
      if (url.pathname === "/message" && req.method === "POST") {
        if (!activeTransport) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No active SSE session. Connect to /sse first." }));
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

  return new Promise((resolve, reject) => {
    httpServer.on("error", (err) => {
      logger.error(`HTTP transport failed to start: ${err.message}`);
      reject(err);
    });

    httpServer.listen(options.port, host, () => {
      logger.info(`HTTP/SSE transport listening on http://${host}:${options.port}`);
      logger.info(`  SSE endpoint: http://${host}:${options.port}/sse`);
      logger.info(`  Message endpoint: http://${host}:${options.port}/message`);
      resolve();
    });
  });
}
