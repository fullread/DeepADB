/**
 * ADB Bridge — Core subprocess wrapper for all ADB interactions.
 * 
 * Every ADB command in DeepADB flows through this module.
 * Handles: subprocess spawning, timeout enforcement, error normalization,
 * device serial routing, output capture, and transient failure retry.
 */

import { execFile, ExecFileOptions, spawn, ChildProcess } from "child_process";
import { config } from "../config/config.js";
import { Logger } from "../middleware/logger.js";
import { shellEscape } from "../middleware/sanitize.js";

export interface AdbResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  bufferExceeded: boolean;
  device?: string;
}

export interface AdbExecOptions {
  /** Target device serial. Falls back to config.defaultDevice. */
  device?: string;
  /** Timeout in ms. Falls back to config.commandTimeout. */
  timeout?: number;
  /** If true, don't throw on non-zero exit codes */
  ignoreExitCode?: boolean;
  /** Override retry count for this call (0 = no retry) */
  retries?: number;
}

/** Patterns in stderr/message that indicate a transient, retryable failure. */
const TRANSIENT_PATTERNS = [
  "device not found",
  "device offline",
  "no devices/emulators found",
  "protocol fault",
  "closed",
  "Connection reset",
  "ECONNRESET",
];

function isTransientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

export class AdbBridge {
  private adbPath: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.adbPath = config.adbPath;
    this.logger = logger;
  }

  /**
   * Execute an ADB command with automatic retry on transient failures.
   * This is the single entry point for all ADB subprocess calls.
   */
  async exec(args: string[], options: AdbExecOptions = {}): Promise<AdbResult> {
    const maxRetries = options.retries ?? config.retryCount;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.execOnce(args, options);
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries && isTransientError(error)) {
          const delay = config.retryBaseDelay * Math.pow(2, attempt);
          this.logger.warn(
            `Transient ADB failure (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${error instanceof Error ? error.message : error}`
          );
          await this.sleep(delay);
          continue;
        }
        throw error;
      }
    }
    throw lastError; // Should never reach here, but TypeScript needs it
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Single-attempt ADB execution (no retry).
   */
  private async execOnce(args: string[], options: AdbExecOptions): Promise<AdbResult> {
    const device = options.device || config.defaultDevice;
    const timeout = options.timeout || config.commandTimeout;

    const fullArgs: string[] = [];
    if (device) {
      fullArgs.push("-s", device);
    }
    fullArgs.push(...args);

    this.logger.debug(`adb ${fullArgs.join(" ")}`);

    return new Promise<AdbResult>((resolve, reject) => {
      const execOptions: ExecFileOptions = {
        timeout,
        maxBuffer: config.maxOutputSize * 2,
        windowsHide: true,
      };

      execFile(this.adbPath, fullArgs, execOptions, (error, stdout, stderr) => {
        const bufferExceeded = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          || error?.message?.includes("maxBuffer") === true;
        const timedOut = error?.killed === true && !bufferExceeded;

        const exitCode = error?.code != null
          ? (typeof error.code === "number" ? error.code : 1)
          : 0;

        const result: AdbResult = {
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode,
          timedOut,
          bufferExceeded,
          device: device || undefined,
        };

        this.logger.debug(
          `Exit: ${exitCode}, timedOut: ${timedOut}, bufferExceeded: ${bufferExceeded}, stdout: ${result.stdout.length} chars`
        );

        if (timedOut) {
          reject(new AdbError(`Command timed out after ${timeout}ms: adb ${fullArgs.join(" ")}`, result));
          return;
        }

        if (bufferExceeded) {
          this.logger.warn(`Output exceeded maxBuffer, returning partial result`);
          resolve(result);
          return;
        }

        if (exitCode !== 0 && !options.ignoreExitCode) {
          reject(new AdbError(
            `ADB command failed (exit ${exitCode}): ${result.stderr || result.stdout}`.trim(),
            result
          ));
          return;
        }

        resolve(result);
      });
    });
  }

  /** Execute an ADB shell command on the device. */
  async shell(command: string, options: AdbExecOptions = {}): Promise<AdbResult> {
    return this.exec(["shell", command], options);
  }

  /** Execute a root shell command (via su). */
  async rootShell(command: string, options: AdbExecOptions = {}): Promise<AdbResult> {
    return this.exec(["shell", `su -c '${shellEscape(command)}'`], options);
  }

  /** Verify ADB is accessible and return version info. */
  async version(): Promise<string> {
    const result = await this.exec(["version"], { retries: 0 });
    return result.stdout.trim();
  }

  /** Check if ADB server is running and reachable. */
  async ping(): Promise<boolean> {
    try {
      await this.exec(["devices"], { timeout: 5000, retries: 0 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a long-running ADB command as a streaming child process.
   * Used by logcat watchers and RIL interceptors that need continuous output.
   * Returns the ChildProcess — caller manages stdout/stderr/lifecycle.
   *
   * In ADB mode: spawns `adb -s <serial> <args...>`
   * LocalBridge overrides this to spawn commands directly.
   */
  spawnStreaming(args: string[], device?: string): ChildProcess {
    const serial = device || config.defaultDevice;
    const fullArgs: string[] = [];
    if (serial) {
      fullArgs.push("-s", serial);
    }
    fullArgs.push(...args);

    this.logger.debug(`spawn: adb ${fullArgs.join(" ")}`);

    return spawn(this.adbPath, fullArgs, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

/** Structured error type for ADB failures. */
export class AdbError extends Error {
  public readonly result: AdbResult;

  constructor(message: string, result: AdbResult) {
    super(message);
    this.name = "AdbError";
    this.result = result;
  }
}
