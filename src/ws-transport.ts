// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * WebSocket Transport — Bidirectional streaming MCP transport.
 *
 * Alternative to stdio and HTTP/SSE for native clients that support WebSocket.
 * Browser clients needing bearer headers should use HTTP/SSE instead, because
 * the native browser WebSocket API cannot set arbitrary Authorization headers.
 *
 * Requires the `ws` npm package as an optional peer dependency:
 *   npm install ws @types/ws
 *
 * Set DA_WS_PORT to enable (separate from DA_HTTP_PORT).
 * Selected instead of stdio when DA_HTTP_PORT is unset.
 *
 * Endpoints:
 *   ws://host:port/ws  — WebSocket MCP transport
 *   GET /health        — HTTP health check (always available)
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { McpServer, parseJSONRPCMessage, type Transport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { Logger } from "./middleware/logger.js";
import { hasValidToken } from "./middleware/auth.js";
import { checkOriginAndCors, hasAllowedOrigin, readAllowedOrigins } from "./middleware/origin.js";
import type { Duplex } from "stream";
import { VERSION } from "./config/config.js";

export interface WsTransportOptions {
  port: number;
  host?: string;
  version?: string;
}

/**
 * Minimal WebSocket transport that bridges the `ws` WebSocket library
 * to the MCP SDK's Transport interface.
 */
class WebSocketMcpTransport implements Transport {
  private ws: unknown; // WebSocket instance from `ws` library
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  constructor(ws: unknown) {
    this.ws = ws;
    const socket = ws as { on: (event: string, handler: (...args: unknown[]) => void) => void };

    socket.on("message", (data: unknown) => {
      try {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf-8");
        const message = parseJSONRPCMessage(JSON.parse(text));
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

  async send(message: JSONRPCMessage): Promise<void> {
    // BP7 fix: named constant instead of magic number 1. Per WHATWG WebSocket
    // spec (https://websockets.spec.whatwg.org/#dom-websocket-readystate),
    // readyState values are: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED. We
    // can't reference WebSocket.OPEN directly here because the typed cast
    // intentionally avoids importing the ws module's type (would create a
    // dependency cycle), so the value is mirrored as a local constant.
    const WS_OPEN = 1;
    const socket = this.ws as { readyState: number; send: (data: string) => void };
    if (socket.readyState === WS_OPEN) {
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
  const origins = readAllowedOrigins("DA_WS_CORS_ORIGIN");

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
    if (!checkOriginAndCors(req, res, origins, ["GET", "OPTIONS"], ["Content-Type", "Authorization"])) return;

    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // BP8 fix: same as BO6 — fall back to imported VERSION rather than "unknown".
      res.end(JSON.stringify({ status: "ok", transport: "websocket", version: options.version ?? VERSION }));
      return;
    }

    res.writeHead(426, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upgrade to WebSocket required. Connect to ws://host:port/ws" }));
  });

  // X1: cap incoming WebSocket message size. The ws library's default
  // maxPayload is 100 MB — large enough that an authenticated client (or
  // anyone if DA_AUTH_TOKEN is unset and CORS is permissive) could submit
  // multi-MB payloads, triggering JSON.parse on heap-pressuring strings.
  // 10 MB is generous for MCP JSON-RPC messages (which are normally
  // sub-100KB) while bounding worst-case memory pressure.
  const WS_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

  // Authorize upgrades before accepting a WebSocket or touching the MCP session.
  const WssConstructor = WebSocketServer as new (options: { noServer: boolean; maxPayload: number }) => {
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: unknown) => void) => void;
  };
  const wss = new WssConstructor({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  const connectClient = async (ws: unknown, req: IncomingMessage): Promise<void> => {
    logger.info(`WebSocket client connected from ${req.socket.remoteAddress}`);
    const transport = new WebSocketMcpTransport(ws);
    try {
      await server.connect(transport);
    } catch (err) {
      logger.error(`WebSocket transport connection error: ${err instanceof Error ? err.message : err}`);
      (ws as { close: (code: number, reason: string) => void }).close(1011, "MCP connection failed");
    }
    const socket = ws as { on: (event: string, handler: () => void) => void };
    socket.on("close", () => {
      logger.info(`WebSocket client disconnected: ${req.socket.remoteAddress}`);
    });
  };
  httpServer.on("upgrade", (req, socket, head) => {
    const reject = (status: number, reason: string): void => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (req.url?.split("?")[0] !== "/ws") { reject(404, "Not Found"); return; }
    if (!hasAllowedOrigin(req, origins)) { reject(403, "Forbidden"); return; }
    if (!hasValidToken(req)) { reject(401, "Unauthorized"); return; }
    // One MCP instance has one active transport. Reject concurrent clients
    // explicitly instead of leaving an accepted socket that can never reply.
    if (server.isConnected()) { reject(409, "Conflict"); return; }
    wss.handleUpgrade(req, socket, head, ws => { void connectClient(ws, req); });
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
