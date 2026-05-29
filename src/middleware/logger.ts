// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Logger — Simple stderr-based logger for MCP servers.
 *
 * IMPORTANT: MCP stdio servers MUST NOT write to stdout.
 * All logging goes to stderr to avoid corrupting JSON-RPC messages.
 *
 * M1 THREAT-MODEL NOTE: This Logger does NOT redact sensitive content.
 * Direct calls like `logger.info(\`token=${token}\`)` log credentials
 * verbatim. Redaction lives at the SecurityMiddleware layer for audit-log
 * entries (see middleware/security.ts `redactForLog`) and does NOT cover
 * arbitrary Logger calls. Adding redaction at the Logger level was
 * considered and rejected — too aggressive, it would hide useful debug
 * info (e.g., truncated stack traces with hex offsets that look like
 * tokens to a redactor). The divergent behavior IS the design:
 *
 *   • SecurityMiddleware audit log → redacted (untrusted command strings)
 *   • Logger.info/warn/error      → verbatim (callers are trusted code)
 *
 * Callers writing secret values into log strings are responsible for
 * pre-redaction. The Logger trusts its own callers; it does not trust the
 * commands flowing through SecurityMiddleware.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: number;

  constructor(level: LogLevel = "info") {
    this.level = LOG_LEVELS[level];
  }

  debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log("info", message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log("error", message, ...args);
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LOG_LEVELS[level] >= this.level) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
      console.error(`${prefix} ${message}`, ...args);
    }
  }
}
