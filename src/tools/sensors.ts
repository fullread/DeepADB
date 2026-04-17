/**
 * Hardware Sensor Access — Read values from device hardware sensors.
 *
 * Two tools:
 *   - adb_sensor_read: Android HAL level via `dumpsys sensorservice` (no root)
 *   - adb_iio_read: Linux IIO subsystem via `/sys/bus/iio/` (root required)
 *
 * Data sources:
 *   - `dumpsys sensorservice` — sensor inventory and last-known event values
 *   - `/sys/bus/iio/devices/` — raw IIO channels and ODPM power monitors
 *
 * The sensor inventory is device-dependent — the tools report what's available
 * rather than assuming a fixed set. A Pixel 6a exposes 44 sensors (36 hardware
 * + 8 AOSP virtual) via HAL and 2 PMIC power monitors (16 rails) via IIO.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

// ── HAL Sensor Types & Constants ──────────────────────────────────────────────

/** Map Android sensor type IDs to human-readable categories and units. */
const SENSOR_TYPE_MAP: Record<string, { category: string; unit: string }> = {
  "android.sensor.accelerometer":              { category: "accelerometer",  unit: "m/s²" },
  "android.sensor.magnetic_field":             { category: "magnetometer",   unit: "μT" },
  "android.sensor.orientation":                { category: "orientation",    unit: "°" },
  "android.sensor.gyroscope":                  { category: "gyroscope",      unit: "rad/s" },
  "android.sensor.light":                      { category: "light",          unit: "lux" },
  "android.sensor.pressure":                   { category: "barometer",      unit: "hPa" },
  "android.sensor.proximity":                  { category: "proximity",      unit: "cm" },
  "android.sensor.gravity":                    { category: "gravity",        unit: "m/s²" },
  "android.sensor.linear_acceleration":        { category: "linear_accel",   unit: "m/s²" },
  "android.sensor.rotation_vector":            { category: "rotation",       unit: "" },
  "android.sensor.magnetic_field_uncalibrated": { category: "magnetometer",  unit: "μT" },
  "android.sensor.game_rotation_vector":       { category: "rotation",       unit: "" },
  "android.sensor.gyroscope_uncalibrated":     { category: "gyroscope",      unit: "rad/s" },
  "android.sensor.significant_motion":         { category: "motion",         unit: "" },
  "android.sensor.step_detector":              { category: "step",           unit: "" },
  "android.sensor.step_counter":               { category: "step",           unit: "steps" },
  "android.sensor.geomagnetic_rotation_vector": { category: "rotation",     unit: "" },
  "android.sensor.tilt_detector":              { category: "motion",         unit: "" },
  "android.sensor.pick_up_gesture":            { category: "motion",         unit: "" },
  "android.sensor.device_orientation":         { category: "orientation",    unit: "" },
  "android.sensor.accelerometer_uncalibrated": { category: "accelerometer",  unit: "m/s²" },
};

/** Known category names for the filter parameter. */
const CATEGORIES = [
  "all", "accelerometer", "gyroscope", "magnetometer", "light",
  "barometer", "proximity", "gravity", "linear_accel", "rotation",
  "orientation", "motion", "step", "temperature",
] as const;

interface SensorInfo {
  handle: string;
  name: string;
  vendor: string;
  version: number;
  type: string;
  category: string;
  unit: string;
  mode: string;         // continuous, on-change, one-shot, special-trigger
  minRate: string;
  maxRate: string;
  wakeUp: boolean;
}

interface SensorEvent {
  sensorName: string;
  timestamp: string;    // wall clock from dumpsys
  values: number[];
}

// ── HAL Parsers ──────────────────────────────────────────────────────────────

/** Parse the "Sensor List:" section from dumpsys sensorservice. */
function parseSensorList(dump: string): SensorInfo[] {
  const sensors: SensorInfo[] = [];
  const listStart = dump.indexOf("Sensor List:");
  if (listStart === -1) return sensors;
  const listEnd = dump.indexOf("Fusion States:");
  const block = dump.substring(listStart, listEnd > listStart ? listEnd : listStart + 10000);

  const lines = block.split("\n");

  // Pre-build line start offsets for O(1) line lookup (avoids O(n²) substring+split)
  const lineStarts: number[] = [0];
  for (let i = 0; i < block.length; i++) {
    if (block[i] === "\n") lineStarts.push(i + 1);
  }

  // Each sensor entry looks like:
  // 0x01010001) LSM6DSR Accelerometer     | STMicro         | ver: 1 | type: android.sensor.accelerometer(1) | ...
  // followed by a line with mode info: continuous | minRate=... | maxRate=... | ...
  const entryRegex = /^(0x[\da-f]+)\)\s+(.+?)\s*\|\s*(.+?)\s*\|\s*ver:\s*(\d+)\s*\|\s*type:\s*(\S+?)(?:\(\d+\))?\s*\|/gm;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(block)) !== null) {
    const handle = match[1]!;
    const name = match[2]!.trim();
    const vendor = match[3]!.trim();
    const version = parseInt(match[4]!, 10);
    const type = match[5]!;
    const typeInfo = SENSOR_TYPE_MAP[type];

    // O(log n) line lookup via binary search on pre-built offsets
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= match.index) lo = mid; else hi = mid - 1;
    }
    const matchLine = lo;

    const nextLine = lines[matchLine + 1] || "";
    const modeMatch = nextLine.match(/^\s+(continuous|on-change|one-shot|special-trigger)/);
    const minRateMatch = nextLine.match(/minRate=([\d.]+)Hz/);
    const maxRateMatch = nextLine.match(/maxRate=([\d.]+)Hz/);
    const wakeUp = /\bwakeUp\b/.test(nextLine) && !nextLine.includes("non-wakeUp");

    // Detect temperature sensors by vendor type string
    let category = typeInfo?.category || "other";
    let unit = typeInfo?.unit || "";
    if (type.includes("temperature") || type.includes("temp")) {
      category = "temperature";
      unit = "°C";
    }

    sensors.push({
      handle, name, vendor, version, type, category, unit,
      mode: modeMatch?.[1] || "unknown",
      minRate: minRateMatch?.[1] ? `${minRateMatch[1]} Hz` : "—",
      maxRate: maxRateMatch?.[1] ? `${maxRateMatch[1]} Hz` : "—",
      wakeUp,
    });
  }
  return sensors;
}

/** Parse the "Recent Sensor events:" section for last-known values. */
function parseRecentEvents(dump: string): Map<string, SensorEvent> {
  const events = new Map<string, SensorEvent>();
  const eventsStart = dump.indexOf("Recent Sensor events:");
  if (eventsStart === -1) return events;
  const eventsEnd = dump.indexOf("Active sensors:");
  const block = dump.substring(eventsStart, eventsEnd > eventsStart ? eventsEnd : eventsStart + 20000);

  // Each sensor's events block starts with: "SensorName: last N events"
  // Event lines: "  N (ts=..., wall=HH:MM:SS.mmm) val1, val2, val3, ..."
  const sensorBlockRegex = /^(\S.+?):\s+last\s+\d+\s+events$/gm;
  let sMatch: RegExpExecArray | null;
  const positions: { name: string; headerStart: number; start: number }[] = [];

  while ((sMatch = sensorBlockRegex.exec(block)) !== null) {
    positions.push({ name: sMatch[1]!.trim(), headerStart: sMatch.index, start: sMatch.index + sMatch[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]!.headerStart : block.length;
    const eventBlock = block.substring(pos.start, end);

    // Get the LAST event line (most recent reading)
    const eventLines = eventBlock.split("\n").filter(l => l.match(/^\s+\d+\s+\(ts=/));
    const lastLine = eventLines[eventLines.length - 1];
    if (!lastLine) continue;

    const wallMatch = lastLine.match(/wall=([^\)]+)/);
    const valsMatch = lastLine.match(/\)\s+(.+)/);
    if (!valsMatch) continue;

    const values = valsMatch[1]!.split(",")
      .map(v => v.trim())
      .filter(v => v.length > 0)
      .map(v => parseFloat(v))
      .filter(v => !isNaN(v));

    events.set(pos.name, {
      sensorName: pos.name,
      timestamp: wallMatch?.[1] || "unknown",
      values,
    });
  }
  return events;
}

// ── HAL Display Helpers ──────────────────────────────────────────────────────

/** Format sensor values with axis labels and units based on sensor type. */
function formatValues(sensor: SensorInfo, values: number[]): string {
  const u = sensor.unit;
  switch (sensor.category) {
    case "accelerometer":
    case "gravity":
    case "linear_accel":
      return values.length >= 3
        ? `x=${values[0]!.toFixed(3)} y=${values[1]!.toFixed(3)} z=${values[2]!.toFixed(3)} ${u}`
        : values.map(v => v.toFixed(3)).join(", ") + (u ? ` ${u}` : "");

    case "gyroscope":
      return values.length >= 3
        ? `x=${values[0]!.toFixed(4)} y=${values[1]!.toFixed(4)} z=${values[2]!.toFixed(4)} ${u}`
        : values.map(v => v.toFixed(4)).join(", ") + (u ? ` ${u}` : "");
    case "magnetometer":
      return values.length >= 3
        ? `x=${values[0]!.toFixed(2)} y=${values[1]!.toFixed(2)} z=${values[2]!.toFixed(2)} ${u}`
        : values.map(v => v.toFixed(2)).join(", ") + (u ? ` ${u}` : "");
    case "light":       return `${values[0]?.toFixed(1) ?? "?"} ${u}`;
    case "barometer":   return `${values[0]?.toFixed(2) ?? "?"} ${u}`;
    case "proximity":   return `${values[0]?.toFixed(1) ?? "?"} ${u}`;
    case "temperature": return `${values[0]?.toFixed(1) ?? "?"} ${u}`;
    case "step":        return `${values[0]?.toFixed(0) ?? "?"} ${u}`.trim();
    default:
      return values.map(v => v.toFixed(3)).join(", ") + (u ? ` ${u}` : "");
  }
}

/** Format sensor rate range for display, avoiding ugly double-dash output. */
function formatRateRange(minRate: string, maxRate: string): string {
  const hasMin = minRate !== "—";
  const hasMax = maxRate !== "—";
  if (hasMin && hasMax) return `, ${minRate}–${maxRate}`;
  if (hasMin) return `, ${minRate}`;
  if (hasMax) return `, up to ${maxRate}`;
  return "";
}

// ── IIO Types & Constants ────────────────────────────────────────────────────

/** IIO device classification based on the kernel driver name. */
type IioDeviceType = "odpm" | "accel" | "gyro" | "magn" | "pressure" | "light" | "temp" | "adc" | "unknown";

interface IioDevice {
  path: string;         // e.g. "iio:device0"
  name: string;         // kernel driver name
  type: IioDeviceType;
}

// ── IIO Helpers ──────────────────────────────────────────────────────────────

/** Classify an IIO device by its kernel driver name. */
function classifyIioDevice(name: string): IioDeviceType {
  const lower = name.toLowerCase();
  if (lower.includes("odpm")) return "odpm";
  if (lower.includes("accel")) return "accel";
  if (lower.includes("gyro") || lower.includes("anglvel")) return "gyro";
  if (lower.includes("magn")) return "magn";
  if (lower.includes("pressure") || lower.includes("baro")) return "pressure";
  if (lower.includes("light") || lower.includes("als") || lower.includes("illuminance")) return "light";
  if (lower.includes("temp")) return "temp";
  if (lower.includes("adc")) return "adc";
  return "unknown";
}

/** Parse the ODPM channel-to-rail mapping from enabled_rails output. */
function parseEnabledRails(text: string): Map<number, { rail: string; subsystem: string }> {
  const rails = new Map<number, { rail: string; subsystem: string }>();
  // Format: CH0[S10M_VDD_TPU]:TPU
  const regex = /^CH(\d+)\[([^\]]+)\]:(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    rails.set(parseInt(match[1]!, 10), { rail: match[2]!, subsystem: match[3]!.trim() });
  }
  return rails;
}

/** Parse LPF power output into channel values. */
function parseLpfValues(text: string): Map<number, number> {
  const values = new Map<number, number>();
  // Format: CH0[rail_name], 12345
  const regex = /^CH(\d+)\[[^\]]+\],\s*(\d+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    values.set(parseInt(match[1]!, 10), parseInt(match[2]!, 10));
  }
  return values;
}

/** Parse self-describing key=value output from IIO for-loop reads.
 *  Input format: "in_accel_x_raw=123\nin_accel_y_raw=456\n..."
 *  Returns a map of attribute name → numeric value. */
function parseKeyValueOutput(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of text.trim().split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.substring(0, eq).trim();
    const val = parseFloat(line.substring(eq + 1).trim());
    if (key.length > 0) result.set(key, val);  // NaN preserved for missing values
  }
  return result;
}

/** Read a list of IIO sysfs attributes in a single shell round-trip using
 *  self-describing key=value output. Immune to `cat` alignment issues when
 *  multiple files are read together. Returns attr name → numeric value. */
async function readIioAttrs(
  bridge: { shell: (cmd: string, opts: any) => Promise<{ stdout: string }> },
  serial: string,
  base: string,
  attrs: string[],
  timeoutMs: number,
): Promise<Map<string, number>> {
  if (attrs.length === 0) return new Map();
  const list = attrs.join(" ");
  const result = await bridge.shell(
    `su -c 'for f in ${list}; do v=$(cat ${base}/$f 2>/dev/null) && echo "$f=$v" || echo "$f=NaN"; done'`,
    { device: serial, timeout: timeoutMs, ignoreExitCode: true },
  );
  return parseKeyValueOutput(result.stdout);
}

/** Map IIO channel type prefixes to SI units.
 * Note: IIO standard specifies temperature in millidegrees Celsius after scale,
 * but some drivers apply the 1000x conversion in the scale factor itself.
 * The unit label "°C" is correct for most production drivers. */
function getIioUnit(channelKey: string): string {
  if (channelKey.includes("accel")) return "m/s²";
  if (channelKey.includes("anglvel")) return "rad/s";
  if (channelKey.includes("magn")) return "Gauss";
  if (channelKey.includes("pressure")) return "kPa";
  if (channelKey.includes("temp")) return "°C";
  if (channelKey.includes("illuminance")) return "lux";
  if (channelKey.includes("voltage")) return "mV";
  if (channelKey.includes("current")) return "mA";
  if (channelKey.includes("power")) return "mW";
  if (channelKey.includes("energy")) return "mJ";
  return "";
}

/** Format a power value for display with auto-scaling units. */
function formatPower(mw: number): string {
  if (mw >= 1000) return `${(mw / 1000).toFixed(2)} W`;
  if (mw >= 1) return `${mw.toFixed(1)} mW`;
  return `${(mw * 1000).toFixed(0)} μW`;
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerSensorTools(ctx: ToolContext): void {

  // ── adb_sensor_read ─────────────────────────────────────────────────────

  ctx.server.tool(
    "adb_sensor_read",
    "Read current hardware sensor values from the device. Enumerates all available sensors from sensorservice and returns their last-known readings with timestamps. Sensor availability is device-dependent — the tool reports what's present. No root required.",
    {
      category: z.enum(CATEGORIES).optional().default("all")
        .describe("Filter by sensor category: all, accelerometer, gyroscope, magnetometer, light, barometer, proximity, gravity, linear_accel, rotation, orientation, motion, step, temperature"),
      listOnly: z.boolean().optional().default(false)
        .describe("If true, list available sensors without reading values (faster, useful for discovery)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ category, listOnly, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const bridge = ctx.bridge;
        const result = await bridge.shell("dumpsys sensorservice", {
          device: serial, timeout: 10000, ignoreExitCode: true,
        });
        const dump = result.stdout;
        const sensors = parseSensorList(dump);

        if (sensors.length === 0) {
          return { content: [{ type: "text", text: "No sensors found in sensorservice dump." }], isError: true };
        }

        // Filter by category
        const filtered = category === "all"
          ? sensors
          : sensors.filter(s => s.category === category);

        if (filtered.length === 0) {
          const available = [...new Set(sensors.map(s => s.category))].sort().join(", ");
          return { content: [{ type: "text", text: `No sensors found for category "${category}". Available categories: ${available}` }] };
        }

        // List-only mode: just show sensor inventory
        if (listOnly) {
          const lines = [`${filtered.length} sensors (${category === "all" ? "all categories" : category}):\n`];
          for (const s of filtered) {
            const rateStr = formatRateRange(s.minRate, s.maxRate);
            lines.push(`  [${s.category}] ${s.name} (${s.vendor}) — ${s.mode}${rateStr}${s.wakeUp ? " [wake]" : ""}`);
          }
          const categories = [...new Set(sensors.map(s => s.category))].sort();
          lines.push(`\nCategories: ${categories.join(", ")}`);
          lines.push(`Total: ${sensors.length} sensors on device`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Full mode: sensor values
        const events = parseRecentEvents(dump);
        const lines: string[] = [];

        lines.push(`${filtered.length} sensors (${category === "all" ? "all categories" : category}):\n`);

        let withValues = 0;
        for (const s of filtered) {
          const event = events.get(s.name);
          if (event) {
            withValues++;
            const valStr = formatValues(s, event.values);
            lines.push(`  ${s.name} (${s.vendor})`);
            lines.push(`    ${valStr}  [${event.timestamp}]`);
          } else {
            lines.push(`  ${s.name} (${s.vendor})`);
            lines.push(`    (no recent reading — sensor may be inactive)`);
          }
        }

        lines.push(`\n${withValues}/${filtered.length} sensors have recent readings`);
        lines.push(`Total: ${sensors.length} sensors on device`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // ── adb_iio_read ───────────────────────────────────────────────────────────

  const IIO_BASE = "/sys/bus/iio/devices";

  ctx.server.tool(
    "adb_iio_read",
    "Read raw hardware data from the Linux IIO (Industrial I/O) subsystem. Discovers all IIO devices and reads their current values. On Tensor/Exynos devices, this exposes per-rail power monitors (ODPM) showing real-time power consumption per SoC subsystem (CPU clusters, GPU, display, memory, TPU, GPS, etc.) — data not available through the Android sensor HAL. On other devices, may expose raw accelerometer, gyroscope, magnetometer, or ADC channels. Root required.",
    {
      listOnly: z.boolean().optional().default(false)
        .describe("If true, list available IIO devices without reading values"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ listOnly, device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const bridge = ctx.bridge;

        // Check root availability
        const rootCheck = await bridge.shell("su -c id", {
          device: serial, timeout: 5000, ignoreExitCode: true,
        });
        if (!rootCheck.stdout.includes("uid=0")) {
          return { content: [{ type: "text", text: "Root required. The IIO subsystem (/sys/bus/iio/) is not accessible without root on stock Android (SELinux blocks untrusted_app access to sysfs). Use adb_sensor_read for non-root sensor access via the Android HAL." }], isError: true };
        }

        // Enumerate IIO devices
        const lsResult = await bridge.shell(`su -c "ls ${IIO_BASE}/ 2>/dev/null"`, {
          device: serial, timeout: 5000, ignoreExitCode: true,
        });
        const deviceDirs = lsResult.stdout.trim().split("\n")
          .map(l => l.trim())
          .filter(l => l.startsWith("iio:device"))
          .filter(l => /^iio:device\d+$/.test(l));  // defense-in-depth: strict naming

        if (deviceDirs.length === 0) {
          return { content: [{ type: "text", text: "No IIO devices found in /sys/bus/iio/devices/. This device may not expose hardware sensors or power monitors through the IIO subsystem." }] };
        }

        // Read device names and classify
        const devices: IioDevice[] = [];
        for (const dir of deviceDirs) {
          const nameResult = await bridge.shell(`su -c "cat ${IIO_BASE}/${dir}/name 2>/dev/null"`, {
            device: serial, timeout: 3000, ignoreExitCode: true,
          });
          const name = nameResult.stdout.trim() || "unknown";
          devices.push({ path: dir, name, type: classifyIioDevice(name) });
        }

        // List-only mode
        if (listOnly) {
          const lines = [`${devices.length} IIO device(s):\n`];
          for (const d of devices) {
            lines.push(`  ${d.path}: ${d.name} [${d.type}]`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Full read — handle each device type
        const output: string[] = [];
        for (const dev of devices) {
          if (dev.type === "odpm") {
            output.push(await readOdpmDevice(bridge, serial, dev));
          } else {
            output.push(await readGenericIioDevice(bridge, serial, dev));
          }
        }

        return { content: [{ type: "text", text: output.join("\n\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  /** Read an ODPM power monitor device and return formatted output. */
  async function readOdpmDevice(bridge: typeof ctx.bridge, serial: string, dev: IioDevice): Promise<string> {
    const base = `${IIO_BASE}/${dev.path}`;
    const lines: string[] = [`=== ${dev.name} (${dev.path}) — Power Monitor ===\n`];

    // Parallel reads: enabled_rails, lpf_power, sampling_rate
    const [railsR, powerR, rateR] = await Promise.allSettled([
      bridge.shell(`su -c "cat ${base}/enabled_rails"`, { device: serial, timeout: 5000, ignoreExitCode: true }),
      bridge.shell(`su -c "cat ${base}/lpf_power"`, { device: serial, timeout: 5000, ignoreExitCode: true }),
      bridge.shell(`su -c "cat ${base}/sampling_rate"`, { device: serial, timeout: 3000, ignoreExitCode: true }),
    ]);

    const railsText = railsR.status === "fulfilled" ? railsR.value.stdout : "";
    const powerText = powerR.status === "fulfilled" ? powerR.value.stdout : "";
    const rateText = rateR.status === "fulfilled" ? rateR.value.stdout.trim() : "?";

    const rails = parseEnabledRails(railsText);
    const powerValues = parseLpfValues(powerText);
    const channelCount = rails.size;

    if (channelCount === 0) {
      lines.push("  (no enabled channels)");
      return lines.join("\n");
    }

    // Build channel data — lpf_power values are in μW from the ODPM driver
    const channels: { index: number; rail: string; subsystem: string; powerMw: number }[] = [];
    for (const [idx, info] of rails) {
      const pRaw = powerValues.get(idx) ?? 0;

      channels.push({
        index: idx, rail: info.rail, subsystem: info.subsystem,
        powerMw: pRaw / 1000,  // μW → mW
      });
    }

    // Sort by power consumption descending
    channels.sort((a, b) => b.powerMw - a.powerMw);

    // Format output
    lines.push(`  Sampling rate: ${rateText} Hz`);
    lines.push(`  Channels: ${channelCount}\n`);

    const totalPower = channels.reduce((sum, ch) => sum + ch.powerMw, 0);
    for (const ch of channels) {
      const pct = totalPower > 0 ? ((ch.powerMw / totalPower) * 100).toFixed(1) : "0.0";
      lines.push(`  CH${ch.index} ${ch.subsystem} (${ch.rail})`);
      lines.push(`    ${formatPower(ch.powerMw)}  (${pct}%)`);
    }

    lines.push(`\n  Total: ${formatPower(totalPower)}`);
    return lines.join("\n");
  }

  /** Read a generic (non-ODPM) IIO device and return formatted output. */
  async function readGenericIioDevice(bridge: typeof ctx.bridge, serial: string, dev: IioDevice): Promise<string> {
    const base = `${IIO_BASE}/${dev.path}`;
    const lines: string[] = [`=== ${dev.name} (${dev.path}) — ${dev.type === "unknown" ? "IIO Device" : dev.type} ===\n`];

    // List all attributes to discover what's available
    const lsResult = await bridge.shell(`su -c "ls ${base}/ 2>/dev/null"`, {
      device: serial, timeout: 3000, ignoreExitCode: true,
    });
    const attrs = lsResult.stdout.trim().split("\n").map(a => a.trim()).filter(a => a.length > 0);

    // Find raw value attributes (defense-in-depth: only allow alphanumeric + underscore)
    const iioAttrSafe = /^[a-zA-Z0-9_]+$/;
    const rawAttrs = attrs.filter(a => a.match(/^in_.*_raw$/) && iioAttrSafe.test(a));
    const scaleAttrs = attrs.filter(a => a.match(/^in_.*_scale$/) && iioAttrSafe.test(a));
    const offsetAttrs = attrs.filter(a => a.match(/^in_.*_offset$/) && iioAttrSafe.test(a));

    if (rawAttrs.length === 0) {
      // No raw attributes — report what's available
      const interesting = attrs.filter(a => !["name", "power", "subsystem", "uevent", "dev"].includes(a));
      lines.push(`  No raw sensor channels found.`);
      if (interesting.length > 0) {
        lines.push(`  Available attributes: ${interesting.join(", ")}`);
      }
      return lines.join("\n");
    }

    // Read raw values using self-describing key=value output (immune to alignment issues)
    // Single-quoted su -c argument prevents outer shell expansion; $f expanded by inner su shell
    const rawMap = await readIioAttrs(bridge, serial, base, rawAttrs, 10000);

    // Read scales (same self-describing approach)
    const scaleMap = new Map<string, number>();
    const scaleRaw = await readIioAttrs(bridge, serial, base, scaleAttrs, 5000);
    for (const [key, val] of scaleRaw) {
      scaleMap.set(key.replace("_scale", ""), val);
    }

    // Read offsets (same self-describing approach)
    const offsetMap = new Map<string, number>();
    const offsetRaw = await readIioAttrs(bridge, serial, base, offsetAttrs, 5000);
    for (const [key, val] of offsetRaw) {
      offsetMap.set(key.replace("_offset", ""), val);
    }

    // Format each raw channel — lookup by attribute name, not array index
    for (const attr of rawAttrs) {
      const channelKey = attr.replace("_raw", "");
      const raw = rawMap.get(attr) ?? NaN;

      // Look up scale: try exact match, then shared scale (strip axis/index suffix)
      const scale = scaleMap.get(channelKey)
        ?? scaleMap.get(channelKey.replace(/_[xyz]$/, ""))
        ?? scaleMap.get(channelKey.replace(/_\d+$/, ""))
        ?? 1;
      const offset = offsetMap.get(channelKey)
        ?? offsetMap.get(channelKey.replace(/_[xyz]$/, ""))
        ?? offsetMap.get(channelKey.replace(/_\d+$/, ""))
        ?? 0;
      const calibrated = (raw + offset) * scale;

      const unit = getIioUnit(channelKey);
      const label = channelKey.replace("in_", "").replace(/_/g, " ");

      if (isNaN(raw)) {
        lines.push(`  ${label}: (no reading)`);
      } else {
        lines.push(`  ${label}: ${calibrated.toFixed(4)}${unit ? " " + unit : ""} (raw: ${raw})`);
      }
    }

    return lines.join("\n");
  }
}
