// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
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

  // Check 2: Character diversity — proper entropy estimate (F1 fix).
  //
  // The previous check used a unique/total ratio < 0.3 — which false-positives
  // on the documented best-practice generator `openssl rand -hex 32` (64 hex
  // chars drawn from 16-char alphabet has ratio ≈ 0.25). Users who followed
  // the documentation saw spurious "weak token" warnings at startup.
  //
  // Switched to Shannon-style entropy estimate: `length × log2(uniqueChars)`
  // gives an upper bound on bits of entropy in the token. A 64-hex token has
  // 64 × log2(16) = 256 bits → strong. A 24-char "passwordpassword..." has
  // 24 × log2(~8) ≈ 72 bits → correctly flagged. 128 bits is the threshold
  // used for symmetric secrets.
  const uniqueChars = new Set(AUTH_TOKEN).size;
  const entropyBits = AUTH_TOKEN.length * Math.log2(Math.max(2, uniqueChars));
  if (AUTH_TOKEN.length >= 8 && entropyBits < 128) {
    warnings.push(`Token has low estimated entropy (~${Math.floor(entropyBits)} bits from ${uniqueChars} unique characters across ${AUTH_TOKEN.length} total). Consider a longer or more varied token; 128+ bits is recommended.`);
  }

  // Check 3: Common weak patterns
  if (/^(.)\1+$/.test(AUTH_TOKEN)) {
    warnings.push("Token is a single repeated character — this is trivially guessable.");
  } else if (/^(0123456789|abcdefgh|password|secret|token|changeme|test)/i.test(AUTH_TOKEN)) {
    warnings.push("Token appears to use a common weak pattern.");
  }

  if (warnings.length > 0) {
    // F2 fix: pad dynamic-content lines so the right edge stays aligned with
    // the fixed-text lines. Box interior is 62 cells (matches the 62 '═' in
    // the border lines). "║  " prefix is 3 cells, "  ║" suffix is 3 cells,
    // so the content has 56 cells of width. Lines longer than 56 are emitted
    // unpadded (no truncation — operators need full warnings).
    const BOX_WIDTH = 62;
    const PREFIX = "║  ";
    const SUFFIX = "  ║";
    const CONTENT_WIDTH = BOX_WIDTH - PREFIX.length - SUFFIX.length;
    console.error("╔══════════════════════════════════════════════════════════════╗");
    console.error("║  ⚠  WARNING: DA_AUTH_TOKEN may be weak                        ║");
    console.error("╠══════════════════════════════════════════════════════════════╣");
    for (const w of warnings) {
      if (w.length <= CONTENT_WIDTH) {
        console.error(`${PREFIX}${w.padEnd(CONTENT_WIDTH)}${SUFFIX}`);
      } else {
        console.error(`${PREFIX}${w}`);
      }
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
  //
  // F3 fix: on length mismatch we still run timingSafeEqual against a
  // same-length buffer so the function takes roughly the same time as a
  // successful-length-mismatch comparison. Without this, the response time
  // leaks the configured token's byte length (an attacker could probe with
  // tokens of various lengths). The result of the self-compare is discarded.
  const tokenBuf = Buffer.from(token);
  if (tokenBuf.length !== AUTH_TOKEN_BUF.length) {
    // Self-compare to burn equivalent CPU to the success path. Result is
    // necessarily true and is discarded — we still return false.
    timingSafeEqual(AUTH_TOKEN_BUF, AUTH_TOKEN_BUF);
    return false;
  }
  return timingSafeEqual(tokenBuf, AUTH_TOKEN_BUF);
}
