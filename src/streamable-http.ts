// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** One bounded Streamable HTTP session over the process's existing MCP server. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  isInitializeRequest, isJSONRPCRequest, isSpecType,
  isJSONRPCResultResponse, isJSONRPCErrorResponse,
  type McpServer, type RequestId,
} from "@modelcontextprotocol/server";
import type { Logger } from "./middleware/logger.js";

function sessionTtl(): number {
  const value = process.env.DA_HTTP_SESSION_TTL_MS ?? "1800000";
  if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 3600000) {
    throw new Error("DA_HTTP_SESSION_TTL_MS must be an integer from 1000 to 3600000");
  }
  return Number(value);
}

function error(res: ServerResponse, status: number, message: string, code = -32000): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}

const MAX_BODY = 1024 * 1024;
class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Parse once with a byte limit and deadline before reserving a session. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"]) > MAX_BODY) throw new BodyError(413, "Request body exceeds 1 MiB");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (err?: Error): void => {
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", abort);
      if (err) { reject(err); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new BodyError(400, "Invalid JSON")); }
    };
    const data = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY) { finish(new BodyError(413, "Request body exceeds 1 MiB")); return; }
      chunks.push(chunk);
    };
    const end = (): void => finish();
    const fail = (): void => finish(new BodyError(400, "Request body interrupted"));
    const abort = (): void => fail();
    const timer = setTimeout(() => finish(new BodyError(408, "Request body timeout")), 15_000);
    req.on("data", data); req.once("end", end); req.once("error", fail); req.once("aborted", abort);
  });
}

interface PendingRequest { dispatched: boolean }

interface HttpSession {
  transport: NodeStreamableHTTPServerTransport;
  origin: string | undefined;
  pending: Map<RequestId, PendingRequest>;
  uploads: Set<IncomingMessage>;
  requests: Map<ServerResponse, string>;
  disconnected: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class StreamableHttpSession {
  private session: HttpSession | undefined;
  private replacing = false;
  private readonly ttl = sessionTtl();

  constructor(private readonly server: McpServer, private readonly logger: Logger) {}

  get active(): boolean { return this.session !== undefined || this.replacing; }

  private touch(session: HttpSession): void {
    if (this.session !== session) return;
    clearTimeout(session.timer);
    // A request waiting for a tool result (or a client response to elicitation)
    // is active work. GET notification streams alone do not keep sessions alive.
    if (session.pending.size > 0 || session.uploads.size > 0) return;
    session.timer = setTimeout(() => {
      this.logger.info("Streamable HTTP session expired; client must initialize again.");
      void session.transport.close().catch(err => this.logger.warn(`HTTP session close failed: ${String(err)}`));
    }, this.ttl);
    session.timer.unref();
  }

  /** Count uploads as well as response streams; body parsing can yield to a reload. */
  private track(session: HttpSession, req: IncomingMessage, res: ServerResponse, uploading = false): void {
    if (session.requests.has(res)) return;
    session.requests.set(res, req.method!);
    if (uploading) session.uploads.add(req);
    const release = (): void => {
      res.off("finish", release); res.off("close", release);
      session.requests.delete(res);
      session.uploads.delete(req);
      if (req.method === "GET" && res.headersSent && res.statusCode === 200 &&
          String(res.getHeader("content-type")).includes("text/event-stream")) {
        // A peer-aborted notification stream is evidence of a lost browser
        // connection. Normal server stream closure (e.g. polling) is not.
        session.disconnected = !res.writableFinished;
      }
      this.touch(session);
    };
    res.once("finish", release); res.once("close", release);
    this.touch(session);
  }

  // Origin and bearer authentication must already have passed for every request.
  async handle(req: IncomingMessage, res: ServerResponse, legacyBusy: boolean): Promise<void> {
    if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
      res.setHeader("Allow", "GET, POST, DELETE");
      error(res, 405, "Method not allowed");
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const receiving = this.session;
    if (!this.replacing && this.session?.transport.sessionId && sessionId === this.session.transport.sessionId) {
      this.track(this.session, req, res, req.method === "POST");
    }
    let body: unknown;
    if (req.method === "POST") {
      try { body = await readJson(req); }
      catch (err) {
        if (!(err instanceof BodyError)) throw err;
        res.setHeader("Connection", "close");
        error(res, err.status, err.message);
        req.resume();
        return;
      } finally {
        if (receiving?.uploads.delete(req)) this.touch(receiving);
      }
    }
    if (res.destroyed) return;
    let session = this.session;
    if (sessionId !== undefined) {
      if (this.replacing || typeof sessionId !== "string" || !session?.transport.sessionId || sessionId !== session.transport.sessionId) {
        error(res, 404, "Session not found; initialize a new session");
        return;
      }
    } else {
      if (req.method !== "POST" || !isJSONRPCRequest(body) || !isInitializeRequest(body)) {
        error(res, 400, "A valid initialize request or Mcp-Session-Id header is required"); return;
      }
      // Validate headers before retiring an abandoned session. A malformed
      // initialize must not evict a client that could still resume with its ID.
      if (!req.headers.accept?.includes("application/json") || !req.headers.accept.includes("text/event-stream")) {
        error(res, 406, "Client must accept application/json and text/event-stream"); return;
      }
      if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        error(res, 415, "Content-Type must be application/json"); return;
      }
      const reclaimable = session && session.origin !== undefined && session.origin === req.headers.origin &&
        session.disconnected && session.pending.size === 0 && session.requests.size === 0;
      if (this.replacing || legacyBusy || (session ? !reclaimable : this.server.isConnected())) {
        error(res, 409, "Another MCP client is active; close its session first");
        return;
      }
      // Hold the slot across asynchronous close/connect, including against SSE.
      this.replacing = true;
      try {
        if (session) {
          this.logger.info("Reclaiming disconnected browser HTTP session for the same Origin.");
          await session.transport.close();
        }
        session = await this.connect(req.headers.origin);
      } finally { this.replacing = false; }
    }
    // The branch above either validated an existing session or reserved a new one.
    const current = session!;
    this.track(current, req, res);
    const reserved = new Map<RequestId, PendingRequest>();
    // Validate the whole batch before reserving or letting the SDK overwrite
    // its request-to-stream and abort-controller maps. Reserve synchronously:
    // SDK dispatch may yield before onmessage is called.
    for (const message of Array.isArray(body) ? body : [body]) {
      if (!isJSONRPCRequest(message)) continue;
      if (current.pending.has(message.id) || reserved.has(message.id)) {
        error(res, 400, "Duplicate in-flight request ID", -32600);
        return;
      }
      reserved.set(message.id, { dispatched: false });
    }
    for (const [id, entry] of reserved) current.pending.set(id, entry);
    this.touch(current);
    try {
      await current.transport.handleRequest(req, res, body);
    } finally {
      // Invalid headers/protocol/body batches can be rejected by the SDK before
      // dispatch. Release only this upload's reservations, never active work or
      // a later request that has reused an already completed ID.
      for (const [id, entry] of reserved) {
        if (!entry.dispatched && current.pending.get(id) === entry) current.pending.delete(id);
      }
      this.touch(current);
      // Bad JSON/headers/non-initialize POSTs must not consume the single slot.
      if (!current.transport.sessionId) await current.transport.close();
    }
  }

  private async connect(origin: string | undefined): Promise<HttpSession> {
    const current = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      maxRequestBodySize: MAX_BODY,
    });
    // Reserve synchronously after validation and before connect/SDK dispatch.
    const session: HttpSession = { transport: current, origin, pending: new Map(), uploads: new Set(), requests: new Map(), disconnected: false };
    this.session = session;
    const pending = session.pending;
    try {
      await this.server.connect(current);
    } catch (err) {
      this.session = undefined;
      await current.close();
      throw err;
    }
    const sdkClose = current.onclose;
    current.onclose = () => {
      try { sdkClose?.(); }
      finally {
        if (this.session === session) {
          clearTimeout(session.timer);
          pending.clear();
          this.session = undefined;
        }
      }
    };
    const sdkMessage = current.onmessage;
    current.onmessage = (message, extra) => {
      session.disconnected = false;
      if (isJSONRPCRequest(message)) {
        const entry = pending.get(message.id);
        if (entry) entry.dispatched = true;
      }
      const cancelledId = isSpecType.CancelledNotification(message) ? message.params.requestId : undefined;
      const cancelled = cancelledId !== undefined ? pending.get(cancelledId) : undefined;
      this.touch(session);
      sdkMessage?.(message, extra);
      // The SDK handles notifications in a microtask. Keep the ID reserved
      // until its cancellation handler has run (including within a batch).
      // Malformed cancellation messages must never release active work.
      if (cancelled && cancelledId !== undefined) queueMicrotask(() => {
        if (pending.get(cancelledId) === cancelled) pending.delete(cancelledId);
        this.touch(session);
      });
    };
    const sdkSend = current.send.bind(current);
    current.send = async (message, options) => {
      const id = (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        (typeof message.id === "string" || typeof message.id === "number") ? message.id : undefined;
      const entry = id !== undefined ? pending.get(id) : undefined;
      try { await sdkSend(message, options); }
      finally {
        if (entry && id !== undefined && pending.get(id) === entry) {
          pending.delete(id);
          // Capture both session and request ownership: a late send must not
          // clear a replacement request that reused a cancelled/completed ID.
          this.touch(session);
        }
      }
    };
    return session;
  }
}
