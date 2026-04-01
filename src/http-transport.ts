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
      const allowedOrigin = process.env.DA_HTTP_CORS_ORIGIN ?? "";
      if (allowedOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
        res.end(JSON.stringify({ status: "ok", transport: "sse", version: options.version ?? "unknown" }));
        return;
      }

      // Bearer token auth — all endpoints below require valid token when DA_AUTH_TOKEN is set
      if (!checkAuth(req, res)) return;

      // SSE endpoint — client subscribes here
      if (url.pathname === "/sse" && req.method === "GET") {
        logger.info(`SSE client connected from ${req.socket.remoteAddress}`);

        // Close previous transport if any (single-client model)
        if (activeTransport) {
          logger.warn("New SSE connection replacing existing one.");
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
