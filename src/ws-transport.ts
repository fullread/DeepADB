/**
 * WebSocket Transport — Bidirectional streaming MCP transport.
 *
 * Alternative to stdio and HTTP/SSE for MCP clients that benefit from
 * true bidirectional communication. Lower latency than SSE polling and
 * better compatibility with modern web frameworks.
 *
 * Requires the `ws` npm package as an optional peer dependency:
 *   npm install ws @types/ws
 *
 * Set DA_WS_PORT to enable (separate from DA_HTTP_PORT).
 * Can run alongside stdio or HTTP/SSE transport.
 *
 * Endpoints:
 *   ws://host:port/ws  — WebSocket MCP transport
 *   GET /health        — HTTP health check (always available)
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "./middleware/logger.js";
import { hasValidToken } from "./middleware/auth.js";

/** MCP Transport interface — matches the SDK's Transport contract. */
interface McpTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: unknown): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
}

export interface WsTransportOptions {
  port: number;
  host?: string;
  version?: string;
}

/**
 * Minimal WebSocket transport that bridges the `ws` WebSocket library
 * to the MCP SDK's Transport interface.
 */
class WebSocketMcpTransport implements McpTransport {
  private ws: unknown; // WebSocket instance from `ws` library
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  constructor(ws: unknown) {
    this.ws = ws;
    const socket = ws as { on: (event: string, handler: (...args: unknown[]) => void) => void };

    socket.on("message", (data: unknown) => {
      try {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf-8");
        const message = JSON.parse(text);
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on("close", () => {
      this.onclose?.();
    });

    socket.on("error", (err: unknown) => {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  async start(): Promise<void> {
    // Already started via constructor
  }

  async close(): Promise<void> {
    const socket = this.ws as { close: () => void };
    socket.close();
  }

  async send(message: unknown): Promise<void> {
    const socket = this.ws as { readyState: number; send: (data: string) => void };
    if (socket.readyState === 1) { // OPEN
      socket.send(JSON.stringify(message));
    }
  }
}

/**
 * Start a WebSocket transport server for MCP.
 * Requires the `ws` npm package to be installed.
 */
export async function startWsTransport(
  server: McpServer,
  options: WsTransportOptions,
  logger: Logger,
): Promise<void> {
  const host = options.host ?? "127.0.0.1";

  // Dynamic import of ws — optional dependency.
  // Use a variable to prevent TypeScript from resolving the module at compile time.
  let WebSocketServer: unknown;
  try {
    const wsModuleName = "ws";
    const wsModule = await import(/* webpackIgnore: true */ wsModuleName) as Record<string, unknown>;
    WebSocketServer = wsModule.WebSocketServer ?? (wsModule.default as Record<string, unknown>)?.WebSocketServer;
    if (!WebSocketServer) {
      throw new Error("WebSocketServer not found in ws module");
    }
  } catch {
    logger.error(
      "WebSocket transport requires the 'ws' npm package.\n" +
      "Install with: npm install ws\n" +
      "For TypeScript types: npm install -D @types/ws\n" +
      "Then restart DeepADB with DA_WS_PORT set."
    );
    throw new Error("Optional dependency 'ws' not installed. Run: npm install ws");
  }

  // Create HTTP server for health check endpoint
  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS
    const allowedOrigin = process.env.DA_WS_CORS_ORIGIN ?? "";
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", transport: "websocket", version: options.version ?? "unknown" }));
      return;
    }

    res.writeHead(426, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upgrade to WebSocket required. Connect to ws://host:port/ws" }));
  });

  // Create WebSocket server attached to the HTTP server
  const WssConstructor = WebSocketServer as new (options: { server: unknown; path: string }) => {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };

  const wss = new WssConstructor({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws: unknown, req: unknown) => {
    const incomingReq = req as IncomingMessage;
    const remoteAddr = incomingReq.socket.remoteAddress;

    // Bearer token auth — reject unauthorized WebSocket connections immediately
    if (!hasValidToken(incomingReq)) {
      logger.warn(`WebSocket connection rejected (unauthorized) from ${remoteAddr}`);
      const socket = ws as { close: (code: number, reason: string) => void };
      socket.close(4401, "Unauthorized");
      return;
    }

    logger.info(`WebSocket client connected from ${remoteAddr}`);

    const transport = new WebSocketMcpTransport(ws);

    try {
      // Cast — our McpTransport is structurally compatible with the SDK's Transport interface
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await server.connect(transport as any);
    } catch (err) {
      logger.error(`WebSocket transport connection error: ${err instanceof Error ? err.message : err}`);
    }

    const socket = ws as { on: (event: string, handler: () => void) => void };
    socket.on("close", () => {
      logger.info(`WebSocket client disconnected: ${remoteAddr}`);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.on("error", (err) => {
      logger.error(`WebSocket transport failed to start: ${err.message}`);
      reject(err);
    });

    httpServer.listen(options.port, host, () => {
      logger.info(`WebSocket transport listening on ws://${host}:${options.port}/ws`);
      logger.info(`  Health check: http://${host}:${options.port}/health`);
      resolve();
    });
  });
}
