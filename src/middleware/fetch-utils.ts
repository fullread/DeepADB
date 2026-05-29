// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Fetch Utilities — Shared HTTP helpers with protocol, timeout, redirect, and size limits.
 *
 * Used by the plugin registry, workflow marketplace, and any module that
 * fetches external resources. Layered defenses against malicious or
 * misconfigured external sources:
 *   - Protocol allowlist: https:// only (no http://, data:, file://, etc.).
 *     Validated on the INITIAL url AND on every redirect target. Defends
 *     against SSRF (file://, http://internal.rfc1918), plaintext credential
 *     leak (http://), and content injection via local-file or inline-data URLs.
 *   - Manual redirect handling: redirects are NOT auto-followed by the
 *     underlying fetch — we follow them ourselves with per-hop protocol
 *     re-validation and a 5-hop cap. Defends against a compromised or
 *     hijacked initial endpoint that 302-redirects to http://attacker.com
 *     or file:///etc/passwd, which the default `redirect: "follow"` would
 *     traverse silently and bypass the initial protocol check.
 *   - Request timeout: 30 seconds via AbortSignal.timeout() — shared across
 *     redirect hops, header arrival, AND body read. Total operation is
 *     bounded by one 30s window, not 30s × hops. Defends against slow-loris
 *     servers and slow-drip redirect chains.
 *   - Response size cap: 5 MB streaming check. Defends against memory
 *     exhaustion from oversized or pathological responses, even when the
 *     server omits Content-Length.
 *
 * Tests that need to exercise post-fetch parsing logic should mock
 * fetchText/fetchJson at the function level rather than feeding non-https
 * URLs through the real fetcher. Redirect-following behavior is validated
 * during manual audit at release prep (per the test-supply-chain.mjs convention).
 */

/** Maximum response body size in bytes (5 MB). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Maximum time to wait for the entire fetch operation, in milliseconds (30 seconds).
 *  Covers initial request, all redirect hops, header arrival, and body read. */
const FETCH_TIMEOUT_MS = 30_000;

/** Maximum number of redirect hops to follow before failing closed.
 *  Matches the typical 5-hop limits in browsers (curl defaults to 50,
 *  but for a supply-chain fetch we want tight bounds). */
const MAX_REDIRECTS = 5;

/**
 * Throw if the URL does not begin with `https://`. Applied to the initial
 * URL and re-applied to every redirect target so a `Location: http://...`
 * header cannot bypass the protocol allowlist.
 *
 * Exported for unit testing.
 */
/**
 * H1 note: case-sensitivity is INTENTIONAL. RFC 3986 says scheme is
 * case-insensitive, so technically `HTTPS://example.com` is valid. But
 * any URL produced by a real client library normalizes to lowercase, so
 * an uppercase scheme in practice signals either (a) a hand-typed URL by
 * an operator (the strict check catches typos), or (b) an adversarial
 * input trying to bypass an allowlist check by using a non-canonical
 * form. Strict-lowercase is the safer choice for an allowlist gate.
 */
export function requireHttps(url: string, context: string): void {
  if (!url.startsWith("https://")) {
    throw new Error(
      `Refusing to fetch non-https URL: ${url} (${context}). Only https:// URLs are permitted.`
    );
  }
}

/**
 * Fetch a URL and parse the response as JSON.
 * Enforces protocol, timeout, redirect, and size limits via fetchText().
 */
export async function fetchJson(url: string): Promise<unknown> {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch (err) {
    // H2 fix: wrap JSON parse errors with the URL context so a misconfigured
    // registry returning an HTML error page produces "Invalid JSON from
    // https://... — Unexpected token <" instead of a bare parse error with
    // no indication of which fetch failed.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON from ${url} — ${detail}`, { cause: err });
  }
}

/**
 * Fetch a URL and return the response body as text.
 *
 * Enforces:
 *   - https:// protocol on the INITIAL url AND every redirect target
 *   - At most 5 redirect hops (fail-closed beyond)
 *   - 30s total timeout via shared AbortSignal (covers hops + body read)
 *   - 5 MB body size cap via streaming size check
 */
export async function fetchText(url: string): Promise<string> {
  requireHttps(url, "initial URL");

  // Share one AbortSignal across all redirect hops, header arrival, and body
  // read. The 30s budget is for the entire operation — a chain of slow-drip
  // redirects cannot stack up to 30s × hops.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  // Manual redirect handling so we can re-validate the protocol of every
  // hop. The default `redirect: "follow"` would silently traverse a
  // https→http or https→file redirect from a compromised initial endpoint,
  // defeating the protocol allowlist entirely.
  let currentUrl = url;
  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await fetch(currentUrl, { signal, redirect: "manual" });

    // 304 Not Modified is a 3xx that is NOT a redirect — treat as terminal.
    if (r.status >= 300 && r.status < 400 && r.status !== 304) {
      const location = r.headers.get("location");
      if (!location) {
        // 3xx without Location is unusual but possible (e.g., 305 Use Proxy
        // without a Location header). Treat as a terminal response so the
        // caller sees the raw status.
        response = r;
        break;
      }
      // Drain the redirect response body to free the connection eagerly.
      r.body?.cancel().catch(() => { /* best-effort */ });

      if (hop === MAX_REDIRECTS) {
        throw new Error(
          `Too many redirects (max ${MAX_REDIRECTS}) starting from ${url}`
        );
      }
      // Resolve relative URLs against the current URL, then re-validate.
      currentUrl = new URL(location, currentUrl).href;
      requireHttps(currentUrl, `redirect hop ${hop + 1} from ${url}`);
      continue;
    }

    response = r;
    break;
  }

  if (!response) {
    // Unreachable in practice — the loop either sets response or throws.
    throw new Error(`Failed to fetch ${url}: no response obtained`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} — ${currentUrl}`);
  }

  // Fast-reject via Content-Length header if available.
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`);
  }

  // Stream-read the body with incremental size checking. The AbortSignal
  // attached to fetch above also applies to body reads, so a slow-drip server
  // will trip the 30s timeout here rather than hanging until MAX_RESPONSE_BYTES.
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          reader.cancel();
          throw new Error(`Response body too large: exceeded ${MAX_RESPONSE_BYTES} bytes (read aborted)`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  // Fallback for environments where response.body is null (extremely rare
  // in modern Node). H4 audit note: the function-level Content-Length
  // pre-check at the top of this function already rejects declared-oversize
  // bodies BEFORE we get here. The remaining unguarded case is a chunked
  // response with no Content-Length AND null response.body — buffer below
  // and post-read length check is the best we can do without a streaming
  // body. Accept the unbounded read for this rare path; the post-check
  // still catches the result.
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Response body too large: ${text.length} characters (max ${MAX_RESPONSE_BYTES})`);
  }
  return text;
}
