/**
 * Bearer Token Authentication — Optional auth layer for network transports.
 *
 * When DA_AUTH_TOKEN is set, all HTTP/SSE/WebSocket/GraphQL requests must
 * include an Authorization header with the matching bearer token.
 * Health check endpoints are exempt (they only return status info).
 *
 * When DA_AUTH_TOKEN is not set, all requests pass through (backwards compatible).
 *
 * Usage:
 *   import { checkAuth, isAuthEnabled } from "./middleware/auth.js";
 *   import { hasValidToken } from "./middleware/auth.js";  // for WebSocket upgrades
 *
 *   // In HTTP request handler:
 *   if (!checkAuth(req, res)) return;  // Returns false and sends 401 if unauthorized
 *
 *   // In WebSocket connection handler:
 *   if (!hasValidToken(req)) { ws.close(4401, "Unauthorized"); return; }
 */

import { IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";

/** The configured auth token, or empty string if auth is disabled. */
const AUTH_TOKEN = process.env.DA_AUTH_TOKEN ?? "";

/** Pre-computed buffer for constant-time comparison (avoids re-allocation per request). */
const AUTH_TOKEN_BUF = Buffer.from(AUTH_TOKEN);

/** Whether token auth is enabled. */
export function isAuthEnabled(): boolean {
  return AUTH_TOKEN.length > 0;
}

/**
 * Check bearer token authentication on an incoming HTTP request.
 *
 * - If DA_AUTH_TOKEN is not set, always returns true (auth disabled).
 * - If DA_AUTH_TOKEN is set, checks the Authorization header for a matching
 *   Bearer token. Returns true if valid, sends 401 and returns false if not.
 *
 * @param req  Incoming HTTP request
 * @param res  Server response (used to send 401 if unauthorized)
 * @returns true if the request is authorized, false if 401 was sent
 */
export function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!AUTH_TOKEN) return true;

  if (hasValidToken(req)) return true;

  // Unauthorized — send 401
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": "Bearer",
  });
  res.end(JSON.stringify({ error: "Unauthorized. Set Authorization: Bearer <token> header." }));
  return false;
}

/**
 * Check bearer token from request headers without sending a response.
 * Useful for WebSocket upgrade requests where the HTTP response is unavailable.
 *
 * @param req  Incoming HTTP request (or upgrade request)
 * @returns true if auth is disabled or token is valid
 */
export function hasValidToken(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;

  const authHeader = req.headers.authorization ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1] ?? "";

  // Constant-time comparison to prevent timing-based side-channel attacks.
  // Compare buffer byte lengths (not string char lengths) to handle multi-byte
  // UTF-8 tokens correctly — string length can match while byte lengths differ,
  // which would cause timingSafeEqual to throw.
  const tokenBuf = Buffer.from(token);
  if (tokenBuf.length !== AUTH_TOKEN_BUF.length) return false;
  return timingSafeEqual(tokenBuf, AUTH_TOKEN_BUF);
}
