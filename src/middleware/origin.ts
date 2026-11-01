// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Browser-origin policy shared by the HTTP and WebSocket transports. */
import type { IncomingMessage, ServerResponse } from "http";

export function readAllowedOrigins(variable: string): ReadonlySet<string> {
  const origins = new Set((process.env[variable] ?? "").split(",").map(s => s.trim()).filter(Boolean));
  for (const origin of origins) {
    let valid = false;
    try {
      const url = new URL(origin);
      valid = (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
    } catch { /* Invalid origins fail startup rather than widening the policy. */ }
    if (!valid) throw new Error(`${variable} must contain exact http(s) origins, without paths, wildcards, or credentials`);
  }
  return origins;
}

/** Requests without Origin remain available to native/server-to-server clients. */
export function hasAllowedOrigin(req: IncomingMessage, origins: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  return origin === undefined || (typeof origin === "string" && origins.has(origin));
}

export function checkOriginAndCors(
  req: IncomingMessage,
  res: ServerResponse,
  origins: ReadonlySet<string>,
  methods: readonly string[],
  headers: readonly string[],
): boolean {
  res.setHeader("Vary", "Origin");
  if (!hasAllowedOrigin(req, origins)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Origin is not allowed" }));
    return false;
  }
  // Preserve the legacy single-origin response for non-browser clients too.
  const origin = req.headers.origin ?? (origins.size === 1 ? [...origins][0] : undefined);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", headers.join(", "));
  }
  if (req.method === "OPTIONS") {
    const requestedMethod = req.headers["access-control-request-method"];
    const requestedHeaders = req.headers["access-control-request-headers"];
    const allowedHeaders = new Set(headers.map(h => h.toLowerCase()));
    if ((requestedMethod !== undefined && (typeof requestedMethod !== "string" || !methods.includes(requestedMethod))) ||
        (requestedHeaders !== undefined && (typeof requestedHeaders !== "string" ||
          requestedHeaders.split(",").some(h => !allowedHeaders.has(h.trim().toLowerCase()))))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "CORS method or headers are not allowed" }));
      return false;
    }
    // Browser preflights carry no bearer token. Actual requests still require it.
    res.writeHead(204);
    res.end();
    return false;
  }
  return true;
}
