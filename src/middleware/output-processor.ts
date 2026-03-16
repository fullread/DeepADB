/**
 * Output Processor — Truncation, formatting, structured parsing, and binary handling.
 * 
 * Sits between raw ADB output and what gets returned to Claude.
 * Prevents context window blowout from verbose commands.
 */

import { config } from "../config/config.js";

export class OutputProcessor {
  /**
   * Truncate output at a logical boundary (line break or section separator)
   * rather than cutting mid-line. Falls back to character limit if no
   * clean break is found within a reasonable range.
   */
  static truncate(text: string, maxSize?: number): string {
    const limit = maxSize ?? config.maxOutputSize;
    if (text.length <= limit) return text;

    // Scan backward from the limit to find a clean break point
    // Look within the last 500 chars of the allowed range
    const searchStart = Math.max(0, limit - 500);
    const searchRegion = text.substring(searchStart, limit);

    // Prefer section separators, then newlines
    let breakOffset = -1;
    const sectionBreak = searchRegion.lastIndexOf("\n\n");
    if (sectionBreak !== -1) {
      breakOffset = searchStart + sectionBreak;
    } else {
      const lineBreak = searchRegion.lastIndexOf("\n");
      if (lineBreak !== -1) {
        breakOffset = searchStart + lineBreak;
      }
    }

    const cutPoint = breakOffset > 0 ? breakOffset : limit;
    const truncated = text.substring(0, cutPoint);
    const remaining = text.length - cutPoint;
    return `${truncated}\n\n--- OUTPUT TRUNCATED (${remaining.toLocaleString()} characters omitted) ---`;
  }

  /**
   * Format ADB command output for clean presentation.
   * Strips trailing whitespace and normalizes line endings.
   */
  static clean(text: string): string {
    return text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trimEnd();
  }

  /**
   * Process raw ADB output: clean, then truncate.
   */
  static process(text: string, maxSize?: number): string {
    return this.truncate(this.clean(text), maxSize);
  }

  /**
   * Format a structured error response.
   */
  static formatError(error: unknown): string {
    if (error instanceof Error) {
      return `Error: ${error.message}`;
    }
    return `Error: ${String(error)}`;
  }

  /**
   * Limit output to N lines (useful for logcat, dumpsys).
   */
  static limitLines(text: string, maxLines: number): string {
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;

    const kept = lines.slice(0, maxLines);
    const omitted = lines.length - maxLines;
    return `${kept.join("\n")}\n\n--- ${omitted} lines omitted (showing first ${maxLines}) ---`;
  }

  // ── Structured Output Parsers ────────────────────────────────────

  /**
   * Extract the stdout string from a Promise.allSettled result.
   * Handles fulfilled/rejected states, applies optional truncation,
   * and provides a configurable fallback message on failure.
   *
   * Used by tools that run parallel ADB commands and need to present
   * results even when some commands fail (e.g., diagnostics, baseband).
   */
  static settledValue(
    result: PromiseSettledResult<{ stdout: string }>,
    maxSize?: number,
    fallback = "unavailable"
  ): string {
    if (result.status === "fulfilled") {
      const text = result.value.stdout.trim();
      return text ? (maxSize ? OutputProcessor.process(text, maxSize) : text) : "(empty)";
    }
    const reason = (result as PromiseRejectedResult).reason;
    return `${fallback}: ${reason instanceof Error ? reason.message : String(reason ?? "unknown error")}`;
  }

  /**
   * Parse `dumpsys battery` output into a concise key-value summary.
   */
  static parseBattery(raw: string): string {
    const pairs: string[] = [];
    const extract = (key: string): string | undefined => {
      const match = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
      return match?.[1]?.trim();
    };
    const level = extract("level");
    const status = extract("status");
    const health = extract("health");
    const plugged = extract("plugged");
    const temperature = extract("temperature");
    const voltage = extract("voltage");

    if (level) pairs.push(`Level: ${level}%`);
    if (status) {
      const statusMap: Record<string, string> = { "2": "Charging", "3": "Discharging", "4": "Not charging", "5": "Full" };
      pairs.push(`Status: ${statusMap[status] ?? status}`);
    }
    if (health) {
      const healthMap: Record<string, string> = { "2": "Good", "3": "Overheat", "4": "Dead", "5": "Over voltage" };
      pairs.push(`Health: ${healthMap[health] ?? health}`);
    }
    if (plugged) {
      const plugMap: Record<string, string> = { "0": "Unplugged", "1": "AC", "2": "USB", "4": "Wireless" };
      pairs.push(`Plugged: ${plugMap[plugged] ?? plugged}`);
    }
    if (temperature) pairs.push(`Temperature: ${(parseInt(temperature, 10) / 10).toFixed(1)}°C`);
    if (voltage) pairs.push(`Voltage: ${(parseInt(voltage, 10) / 1000).toFixed(3)}V`);

    return pairs.length > 0 ? pairs.join(" | ") : raw.trim();
  }

  /**
   * Parse `dumpsys meminfo <package>` to extract the summary line.
   * Returns the TOTAL line with key heap metrics, or falls back to raw.
   */
  static parseMeminfo(raw: string): string {
    const lines = raw.split("\n");
    const sections: string[] = [];

    // Find TOTAL line
    const totalLine = lines.find((l) => /^\s*TOTAL\b/.test(l));
    if (totalLine) sections.push(`Memory: ${totalLine.trim()}`);

    // Find summary section
    const summaryIdx = lines.findIndex((l) => l.includes("App Summary"));
    if (summaryIdx !== -1) {
      const summaryLines = lines.slice(summaryIdx, summaryIdx + 10)
        .filter((l) => l.trim().length > 0);
      sections.push(summaryLines.join("\n"));
    }

    return sections.length > 0 ? sections.join("\n\n") : raw;
  }

  /**
   * Parse `getprop` output into a clean key=value map string.
   * Strips the [brackets] format.
   */
  static parseGetprop(raw: string): Record<string, string> {
    const props: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.trim().match(/^\[(.+?)\]: \[(.*)?\]$/);
      if (match) {
        props[match[1]] = match[2] ?? "";
      }
    }
    return props;
  }
}
