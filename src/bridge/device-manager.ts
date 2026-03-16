/**
 * Device Manager — Discovery, caching, state tracking, and device selection.
 * 
 * Includes a TTL-based device list cache to avoid redundant `adb devices`
 * calls on every tool invocation. Cache is automatically invalidated on
 * connection-related errors.
 */

import { AdbBridge } from "./adb-bridge.js";
import { config } from "../config/config.js";

export interface DeviceInfo {
  serial: string;
  state: "device" | "offline" | "unauthorized" | "no permissions" | string;
  model?: string;
  product?: string;
  transportId?: string;
}

interface DeviceCache {
  devices: DeviceInfo[];
  timestamp: number;
}

export class DeviceManager {
  private bridge: AdbBridge;
  private cache: DeviceCache | null = null;

  constructor(bridge: AdbBridge) {
    this.bridge = bridge;
  }

  /**
   * List all connected devices with their properties.
   * Results are cached for config.deviceCacheTtl milliseconds.
   */
  async listDevices(): Promise<DeviceInfo[]> {
    const now = Date.now();
    if (this.cache && (now - this.cache.timestamp) < config.deviceCacheTtl) {
      return this.cache.devices;
    }

    const result = await this.bridge.exec(["devices", "-l"]);
    const lines = result.stdout.split("\n").slice(1); // Skip header

    const devices = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => this.parseDeviceLine(line));

    this.cache = { devices, timestamp: now };
    return devices;
  }

  /**
   * Force-refresh the device cache on next call.
   * Call this after connect/disconnect/pair operations.
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Get a single device, auto-selecting if only one is connected.
   * Throws if zero or multiple devices and no serial specified.
   */
  async resolveDevice(serial?: string): Promise<DeviceInfo> {
    const devices = await this.listDevices();
    const online = devices.filter((d) => d.state === "device");

    if (serial) {
      const found = devices.find((d) => d.serial === serial);
      if (!found) {
        // Invalidate cache — device might have just connected
        this.invalidateCache();
        throw new Error(
          `Device ${serial} not found. Connected: ${devices.map((d) => d.serial).join(", ") || "none"}`
        );
      }
      if (found.state !== "device") {
        throw new Error(
          `Device ${serial} is ${found.state}. ` +
          (found.state === "unauthorized"
            ? "Check the device screen for the RSA key approval dialog."
            : "Verify the device is online and USB debugging is enabled.")
        );
      }
      return found;
    }

    if (online.length === 0) {
      this.invalidateCache(); // Force refresh next time
      const unauthorized = devices.filter((d) => d.state === "unauthorized");
      if (unauthorized.length > 0) {
        throw new Error(
          `No authorized devices. ${unauthorized.length} device(s) pending USB debugging authorization. ` +
          `Check the device screen for the RSA key approval dialog.`
        );
      }
      throw new Error("No devices connected. Verify USB connection and USB debugging is enabled.");
    }

    if (online.length > 1) {
      throw new Error(
        `Multiple devices connected. Specify a device serial: ${online.map((d) => d.serial).join(", ")}`
      );
    }

    return online[0];
  }

  /**
   * Get detailed device properties via getprop.
   */
  async getDeviceProps(serial?: string): Promise<Record<string, string>> {
    const device = await this.resolveDevice(serial);
    const result = await this.bridge.shell("getprop", { device: device.serial });
    const props: Record<string, string> = {};

    for (const line of result.stdout.split("\n")) {
      const match = line.trim().match(/^\[(.+?)\]: \[(.*)?\]$/);
      if (match) {
        props[match[1]] = match[2] ?? "";
      }
    }
    return props;
  }

  private parseDeviceLine(line: string): DeviceInfo {
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] as DeviceInfo["state"];
    const info: DeviceInfo = { serial, state };

    // Parse key:value pairs like model:Pixel_6a product:bluejay
    for (let i = 2; i < parts.length; i++) {
      const [key, value] = parts[i].split(":");
      if (key === "model") info.model = value;
      else if (key === "product") info.product = value;
      else if (key === "transport_id") info.transportId = value;
    }

    return info;
  }
}
