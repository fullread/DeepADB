/**
 * DeepADB Configuration
 * 
 * Central configuration for ADB paths, timeouts, and output limits.
 * Adjust these values based on your environment.
 */

import { platform } from "os";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Package version — read from package.json at startup.
 * Single source of truth: update version in package.json only.
 * Used by McpServer, HTTP/SSE, WebSocket, and GraphQL transports.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
let _version = "unknown";
try {
  // config.ts builds to build/config/config.js — ../../package.json is the project root
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
  _version = pkg.version ?? "unknown";
} catch { /* fallback if package.json not found (e.g., bundled deployment) */ }
export const VERSION = _version;

export interface DeepADBConfig {
  /** Path to the ADB binary. Auto-detected if not set. */
  adbPath: string;

  /** Default timeout for ADB commands in milliseconds */
  commandTimeout: number;

  /** Maximum output size in characters before truncation */
  maxOutputSize: number;

  /** Maximum logcat lines to return per snapshot */
  maxLogcatLines: number;

  /** Default device serial (empty = auto-select single device) */
  defaultDevice: string;

  /** Temp directory for binary file operations (screenshots, pulls) */
  tempDir: string;

  /** Device list cache TTL in milliseconds (0 = no caching) */
  deviceCacheTtl: number;

  /** Number of retries for transient ADB failures */
  retryCount: number;

  /** Base delay between retries in milliseconds (doubles each retry) */
  retryBaseDelay: number;
}

function getDefaultAdbPath(): string {
  const isWindows = platform() === "win32";
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    return localAppData
      ? `${localAppData}\\Android\\Sdk\\platform-tools\\adb.exe`
      : "adb";
  }
  return "adb";
}

/**
 * Detect if we're running directly on an Android device (e.g., Termux).
 * Checks for /system/build.prop which exists on all Android devices
 * but never on Windows/macOS/Linux hosts.
 * Can be overridden with DA_LOCAL=true or DA_LOCAL=false.
 */
export function isOnDevice(): boolean {
  const override = process.env.DA_LOCAL;
  if (override === "true" || override === "1") return true;
  if (override === "false" || override === "0") return false;
  return existsSync("/system/build.prop");
}

function getTempDir(): string {
  // On-device (Termux): use Termux home or /data/local/tmp
  if (isOnDevice()) {
    const home = process.env.HOME ?? "/data/local/tmp";
    return `${home}/.deepadb`;
  }
  return platform() === "win32"
    ? `${process.env.TEMP ?? "C:\\Temp"}\\deepadb`
    : "/tmp/deepadb";
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.error(`[DeepADB] Invalid config value "${value}", using default: ${fallback}`);
    return fallback;
  }
  return parsed;
}

export const config: DeepADBConfig = {
  adbPath: process.env.ADB_PATH ?? getDefaultAdbPath(),
  commandTimeout: parseIntSafe(process.env.DA_TIMEOUT, 30000),
  maxOutputSize: parseIntSafe(process.env.DA_MAX_OUTPUT, 50000),
  maxLogcatLines: parseIntSafe(process.env.DA_MAX_LOGCAT, 500),
  defaultDevice: process.env.DA_DEVICE ?? "",
  tempDir: process.env.DA_TEMP_DIR ?? getTempDir(),
  deviceCacheTtl: parseIntSafe(process.env.DA_CACHE_TTL, 5000),
  retryCount: parseIntSafe(process.env.DA_RETRY_COUNT, 1),
  retryBaseDelay: parseIntSafe(process.env.DA_RETRY_DELAY, 500),
};

/**
 * Validate configuration at startup. Returns warnings for non-fatal issues.
 */
export function validateConfig(): string[] {
  const warnings: string[] = [];

  // Skip ADB binary check in on-device mode (no ADB needed)
  if (!isOnDevice()) {
    if (config.adbPath !== "adb" && !existsSync(config.adbPath)) {
      warnings.push(`ADB binary not found at configured path: ${config.adbPath}. Falling back to PATH lookup.`);
      config.adbPath = "adb";
    }
  }

  if (config.commandTimeout < 1000) {
    warnings.push(`Command timeout (${config.commandTimeout}ms) is very low. Commands may fail prematurely.`);
  }

  if (config.maxOutputSize < 5000) {
    warnings.push(`Max output size (${config.maxOutputSize}) is very low. Output will be heavily truncated.`);
  }

  return warnings;
}
