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

/** Minimum recommended token length in characters. Shorter tokens are warned at startup. */
const MIN_TOKEN_LENGTH = 32;

/** Whether token auth is enabled. */
export function isAuthEnabled(): boolean {
  return AUTH_TOKEN.length > 0;
}

/**
 * Validate token strength at startup. Logs warnings for weak tokens.
 * Called once from index.ts when network transports are enabled.
 *
 * Checks:
 * 1. Minimum length (32 chars = 128+ bits for hex, 192+ bits for base64)
 * 2. Entropy estimation — reject tokens with very low character diversity
 * 3. Common weak patterns (all same character, sequential digits, dictionary-like)
 */
export function validateTokenStrength(): void {
  if (!AUTH_TOKEN) return;

  const warnings: string[] = [];

  // Check 1: Minimum length
  if (AUTH_TOKEN.length < MIN_TOKEN_LENGTH) {
    warnings.push(`Token is ${AUTH_TOKEN.length} characters — minimum recommended is ${MIN_TOKEN_LENGTH}.`);
    warnings.push(`Generate a strong token: openssl rand -hex 32`);
    warnings.push(`Or with Node.js: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  }

  // Check 2: Character diversity — estimate entropy
  const uniqueChars = new Set(AUTH_TOKEN).size;
  const entropyRatio = uniqueChars / AUTH_TOKEN.length;
  if (AUTH_TOKEN.length >= 8 && entropyRatio < 0.3) {
    warnings.push(`Token has very low character diversity (${uniqueChars} unique characters in ${AUTH_TOKEN.length} total).`);
  }

  // Check 3: Common weak patterns
  if (/^(.)\1+$/.test(AUTH_TOKEN)) {
    warnings.push("Token is a single repeated character — this is trivially guessable.");
  } else if (/^(0123456789|abcdefgh|password|secret|token|changeme|test)/i.test(AUTH_TOKEN)) {
    warnings.push("Token appears to use a common weak pattern.");
  }

  if (warnings.length > 0) {
    console.error("╔══════════════════════════════════════════════════════════════╗");
    console.error("║  ⚠  WARNING: DA_AUTH_TOKEN may be weak                        ║");
    console.error("╠══════════════════════════════════════════════════════════════╣");
    for (const w of warnings) {
      console.error(`║  ${w}`);
    }
    console.error("║                                                                  ║");
    console.error("║  A strong token should be at least 32 random hex characters:     ║");
    console.error("║    openssl rand -hex 32                                          ║");
    console.error("║    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" ║");
    console.error("╚══════════════════════════════════════════════════════════════╝");
  }
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
