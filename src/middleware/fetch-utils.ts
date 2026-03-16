/**
 * Fetch Utilities — Shared HTTP helpers with response size limits.
 *
 * Used by the plugin registry, workflow marketplace, and any module
 * that fetches external resources. Enforces a maximum response body
 * size to prevent memory exhaustion from oversized or malicious responses.
 */

/** Maximum response body size in bytes (5 MB). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Fetch a URL and parse the response as JSON.
 * Enforces a response size limit to prevent memory exhaustion.
 */
export async function fetchJson(url: string): Promise<unknown> {
  const text = await fetchText(url);
  return JSON.parse(text);
}

/**
 * Fetch a URL and return the response body as text.
 * Enforces a response size limit via streaming to prevent memory exhaustion,
 * even when the server omits the Content-Length header.
 */
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} — ${url}`);
  }

  // Fast-reject via Content-Length header if available
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`);
  }

  // Stream-read the body with incremental size checking.
  // This prevents memory exhaustion even when Content-Length is absent.
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

  // Fallback for environments where response.body is null
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Response body too large: ${text.length} characters (max ${MAX_RESPONSE_BYTES})`);
  }
  return text;
}
