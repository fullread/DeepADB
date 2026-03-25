/**
 * Security Middleware — Command filtering, rate limiting, and audit logging.
 * 
 * Provides configurable security controls for DeepADB.
 * Currently opt-in: tools and the bridge can consult this middleware
 * before executing commands. Can be tightened for production deployments.
 * 
 * Enable via environment variable: DA_SECURITY=true
 */

import { Logger } from "./logger.js";

export interface SecurityConfig {
  /** Enable security enforcement (default: false in dev, true recommended for shared use) */
  enabled: boolean;
  /** Shell commands that are always blocked (substring match) */
  blockedCommands: string[];
  /** If set, only these shell commands are allowed (substring match). Empty = allow all. */
  allowedCommands: string[];
  /** Maximum commands per minute (0 = unlimited) */
  rateLimit: number;
  /** Enable audit logging of all commands */
  auditLog: boolean;
}

interface RateBucket {
  count: number;
  windowStart: number;
}

export class SecurityMiddleware {
  private config: SecurityConfig;
  private logger: Logger;
  private rateBucket: RateBucket = { count: 0, windowStart: Date.now() };

  constructor(logger: Logger) {
    this.logger = logger;
    this.config = {
      enabled: process.env.DA_SECURITY === "true",
      blockedCommands: this.parseList(process.env.DA_BLOCKED_COMMANDS),
      allowedCommands: this.parseList(process.env.DA_ALLOWED_COMMANDS),
      rateLimit: parseInt(process.env.DA_RATE_LIMIT ?? "0", 10) || 0,
      auditLog: process.env.DA_AUDIT_LOG !== "false",
    };

    if (this.config.enabled) {
      logger.info("Security middleware enabled");
      if (this.config.blockedCommands.length > 0) {
        logger.info(`Blocked commands: ${this.config.blockedCommands.join(", ")}`);
      }
      if (this.config.allowedCommands.length > 0) {
        logger.info(`Allowlist active: ${this.config.allowedCommands.length} patterns`);
      }
      if (this.config.rateLimit > 0) {
        logger.info(`Rate limit: ${this.config.rateLimit} commands/minute`);
      }
    }
  }

  private parseList(value: string | undefined): string[] {
    if (!value) return [];
    return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }

  /**
   * Check if a shell command is allowed to execute.
   * Returns null if allowed, or an error message if blocked.
   */
  checkCommand(command: string, device?: string): string | null {
    // Audit log regardless of enforcement
    if (this.config.auditLog) {
      const deviceLabel = device ? ` [${device}]` : "";
      this.logger.info(`[AUDIT]${deviceLabel} ${this.redactForLog(command)}`);
    }

    if (!this.config.enabled) return null;

    // Rate limiting
    if (this.config.rateLimit > 0) {
      const now = Date.now();
      const windowMs = 60_000;
      if (now - this.rateBucket.windowStart > windowMs) {
        this.rateBucket = { count: 0, windowStart: now };
      }
      this.rateBucket.count++;
      if (this.rateBucket.count > this.config.rateLimit) {
        this.logger.warn(`Rate limit exceeded: ${this.rateBucket.count}/${this.config.rateLimit} per minute`);
        return `Rate limit exceeded (${this.config.rateLimit} commands/minute). Wait before retrying.`;
      }
    }

    // Blocklist check
    const cmdLower = command.toLowerCase();
    for (const blocked of this.config.blockedCommands) {
      if (cmdLower.includes(blocked.toLowerCase())) {
        this.logger.warn(`Blocked command: ${command} (matched: ${blocked})`);
        return `Command blocked by security policy (matched: "${blocked}").`;
      }
    }

    // Allowlist check (only if allowlist is non-empty)
    if (this.config.allowedCommands.length > 0) {
      const allowed = this.config.allowedCommands.some(
        (pattern) => cmdLower.includes(pattern.toLowerCase())
      );
      if (!allowed) {
        this.logger.warn(`Command not in allowlist: ${command}`);
        return "Command not in security allowlist.";
      }
    }

    return null;
  }

  /**
   * Log a completed command for audit trail.
   */
  logResult(command: string, success: boolean, device?: string): void {
    if (!this.config.auditLog) return;
    const status = success ? "OK" : "FAIL";
    const deviceLabel = device ? ` [${device}]` : "";
    this.logger.info(`[AUDIT]${deviceLabel} ${status}: ${this.redactForLog(command)}`);
  }

  /** Whether security enforcement is active. */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Get current rate limit status. */
  getRateStatus(): { count: number; limit: number; windowRemaining: number } {
    const elapsed = Date.now() - this.rateBucket.windowStart;
    return {
      count: this.rateBucket.count,
      limit: this.config.rateLimit,
      windowRemaining: Math.max(0, 60_000 - elapsed),
    };
  }

  /**
   * Redact potentially sensitive content from commands before logging.
   * Truncates long commands and masks common credential patterns.
   */
  private redactForLog(command: string): string {
    const MAX_LOG_LENGTH = 200;

    // Mask common credential patterns
    let redacted = command
      .replace(/(?:password|passwd|token|secret|key|auth)([\s=:]+)\S+/gi, (_, sep) => `***${sep}***REDACTED***`)
      .replace(/echo\s+["'].*?["']\s*>\s*/g, "echo '***' > ");

    if (redacted.length > MAX_LOG_LENGTH) {
      redacted = redacted.substring(0, MAX_LOG_LENGTH) + `... (${command.length} chars total)`;
    }
    return redacted;
  }
}
