/**
 * Wireless Firmware Tools — WiFi, Bluetooth, and NFC firmware identification.
 *
 * Provides detailed firmware versioning and chipset identification for
 * short-range wireless radios. Complements the baseband/modem tools which
 * cover cellular radio firmware.
 *
 * Queries Android system properties and dumpsys services to extract
 * firmware versions, driver info, chipset identification, and capabilities.
 *
 * Privacy: MAC addresses and device names are opt-in (like IMEI in baseband
 * tools) since they are permanent hardware identifiers.
 */

import { z } from "zod";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";

/**
 * Parse WiFi firmware/driver information from dumpsys wifi output.
 * Extracts firmware version, driver version, chipset info, and capabilities.
 */
function parseWifiDumpsys(raw: string): Record<string, string> {
  const info: Record<string, string> = {};

  // Firmware version — various formats across vendors
  const fwMatch = raw.match(/Firmware\s*(?:version|Version|Ver)[:\s]+([^\n,]+)/i)
    || raw.match(/Wi-?Fi\s+(?:FW|firmware)[:\s]+([^\n,]+)/i);
  if (fwMatch) info.firmwareVersion = fwMatch[1].trim();

  // Driver version
  const driverMatch = raw.match(/Driver\s*(?:version|Version|Ver)[:\s]+([^\n,]+)/i);
  if (driverMatch) info.driverVersion = driverMatch[1].trim();

  // Chipset / hardware
  const chipMatch = raw.match(/(?:Chip|Chipset|Hardware)[:\s]+([^\n,]+)/i);
  if (chipMatch) info.chipset = chipMatch[1].trim();

  // Supported bands/frequencies
  const band2g = raw.includes("2.4GHz") || raw.includes("2412") || raw.includes("2437");
  const band5g = raw.includes("5GHz") || raw.includes("5180") || raw.includes("5745");
  const band6g = raw.includes("6GHz") || raw.includes("5955") || raw.includes("6115");
  const bands: string[] = [];
  if (band2g) bands.push("2.4 GHz");
  if (band5g) bands.push("5 GHz");
  if (band6g) bands.push("6 GHz");
  if (bands.length > 0) info.supportedBands = bands.join(", ");

  // WiFi standard detection from capabilities
  if (raw.includes("wifi7") || raw.includes("802.11be") || band6g) info.wifiStandard = "Wi-Fi 7 (802.11be)";
  else if (raw.includes("wifi6e") || raw.includes("6GHz")) info.wifiStandard = "Wi-Fi 6E";
  else if (raw.includes("wifi6") || raw.includes("802.11ax")) info.wifiStandard = "Wi-Fi 6 (802.11ax)";
  else if (raw.includes("802.11ac") || raw.includes("VHT")) info.wifiStandard = "Wi-Fi 5 (802.11ac)";

  // Country code
  const ccMatch = raw.match(/Country\s*(?:code|Code)[:\s]+(\w{2})/i);
  if (ccMatch) info.countryCode = ccMatch[1].toUpperCase();

  return info;
}

/**
 * Parse Bluetooth information from dumpsys bluetooth_manager output.
 * Extracts firmware version, chipset, BT version, adapter state, and profile support.
 */
function parseBluetoothDumpsys(raw: string): Record<string, string> {
  const info: Record<string, string> = {};

  // Firmware version / revision
  const fwMatch = raw.match(/(?:FW|Firmware)\s*(?:version|Version|Ver|revision)[:\s]+([^\n,]+)/i)
    || raw.match(/(?:LMP|HCI)\s*(?:sub)?version[:\s]+(?:0x)?([0-9a-fA-F]+)/i);
  if (fwMatch) info.firmwareVersion = fwMatch[1].trim();

  // Chipset identification
  const chipMatch = raw.match(/(?:Chip|Chipset|Controller)[:\s]+([^\n,]+)/i);
  if (chipMatch) info.chipset = chipMatch[1].trim();

  // BT version from LMP version
  const lmpMatch = raw.match(/(?:LMP\s*version|Bluetooth\s*version)[:\s]+(?:0x)?([0-9a-fA-F]+)/i);
  if (lmpMatch) {
    const lmpVer = parseInt(lmpMatch[1], 16) || parseInt(lmpMatch[1], 10);
    if (lmpVer >= 13) info.btVersion = "5.4";
    else if (lmpVer >= 12) info.btVersion = "5.3";
    else if (lmpVer >= 11) info.btVersion = "5.2";
    else if (lmpVer >= 10) info.btVersion = "5.1";
    else if (lmpVer >= 9) info.btVersion = "5.0";
    else if (lmpVer >= 8) info.btVersion = "4.2";
    else if (lmpVer >= 7) info.btVersion = "4.1";
    else if (lmpVer >= 6) info.btVersion = "4.0";
    else info.btVersion = `LMP ${lmpVer}`;
  }

  // Adapter state
  const stateMatch = raw.match(/(?:state|State|isEnabled)[:\s=]+(ON|OFF|true|false|enabled|disabled)/i);
  if (stateMatch) {
    const val = stateMatch[1].toLowerCase();
    info.adapterState = (val === "on" || val === "true" || val === "enabled") ? "enabled" : "disabled";
  }

  // LE (Low Energy) support
  if (raw.includes("LE Audio") || raw.includes("isLeAudioSupported=true")) info.leAudio = "supported";
  if (raw.includes("isLe2MPhySupported=true")) info.le2mPhy = "supported";
  if (raw.includes("isLeCodedPhySupported=true")) info.leCodedPhy = "supported";
  if (raw.includes("isLeExtendedAdvertisingSupported=true")) info.leExtAdv = "supported";

  // Bonded device count (not the names/addresses)
  const bondedMatch = raw.match(/Bonded\s*(?:devices?|count)[:\s]+(\d+)/i);
  if (bondedMatch) info.bondedDevices = bondedMatch[1];

  // Profiles
  const profiles: string[] = [];
  if (raw.includes("A2dpService") || raw.includes("BluetoothA2dp")) profiles.push("A2DP");
  if (raw.includes("HeadsetService") || raw.includes("BluetoothHeadset")) profiles.push("HFP");
  if (raw.includes("HidHostService") || raw.includes("BluetoothHidHost")) profiles.push("HID");
  if (raw.includes("PanService") || raw.includes("BluetoothPan")) profiles.push("PAN");
  if (raw.includes("MapService") || raw.includes("BluetoothMap")) profiles.push("MAP");
  if (raw.includes("LeAudioService")) profiles.push("LE Audio");
  if (profiles.length > 0) info.activeProfiles = profiles.join(", ");

  return info;
}

/**
 * Parse NFC information from dumpsys nfc output.
 * Extracts controller type, firmware version, supported technologies, and SE info.
 */
function parseNfcDumpsys(raw: string): Record<string, string> {
  const info: Record<string, string> = {};

  // NFC controller / chip identification
  const controllerMatch = raw.match(/(?:NFC\s*(?:Controller|Chip|Hardware)|mNfcChip)[:\s]+([^\n,]+)/i)
    || raw.match(/((?:NXP|Broadcom|Samsung|ST|NQ)\s*\w+)/i);
  if (controllerMatch) info.controller = controllerMatch[1].trim();

  // Firmware version
  const fwMatch = raw.match(/(?:FW|Firmware)\s*(?:version|Version|Ver)[:\s]+([^\n,]+)/i)
    || raw.match(/NCI\s*version[:\s]+([^\n,]+)/i);
  if (fwMatch) info.firmwareVersion = fwMatch[1].trim();

  // NFC state
  const stateMatch = raw.match(/mState[=:\s]+(STATE_\w+|\d+)/i)
    || raw.match(/(?:NFC\s*state|isEnabled)[:\s=]+(ON|OFF|true|false|enabled|disabled)/i);
  if (stateMatch) {
    const val = stateMatch[1];
    if (val.includes("ON") || val.includes("true") || val.includes("enabled") || val === "STATE_ON" || val === "3") {
      info.state = "enabled";
    } else {
      info.state = "disabled";
    }
  }

  // Supported technologies
  const techs: string[] = [];
  if (raw.includes("NFC-A") || raw.includes("NfcA") || raw.includes("IsoDep")) techs.push("NFC-A (ISO 14443-3A)");
  if (raw.includes("NFC-B") || raw.includes("NfcB")) techs.push("NFC-B (ISO 14443-3B)");
  if (raw.includes("NFC-F") || raw.includes("NfcF")) techs.push("NFC-F (FeliCa)");
  if (raw.includes("NFC-V") || raw.includes("NfcV")) techs.push("NFC-V (ISO 15693)");
  if (raw.includes("MIFARE")) techs.push("MIFARE");
  if (techs.length > 0) info.supportedTechnologies = techs.join(", ");

  // Secure Element
  if (raw.includes("eSE") || raw.includes("Embedded SE")) info.secureElement = "eSE (embedded)";
  else if (raw.includes("UICC") || raw.includes("SIM-based SE")) info.secureElement = "UICC (SIM-based)";
  if (raw.includes("HCE") || raw.includes("HostEmulation")) {
    info.hce = "supported";
  }

  // Reader mode / tag dispatch
  if (raw.includes("mReaderModeEnabled=true")) info.readerMode = "enabled";
  if (raw.includes("mNdefPushEnabled=true") || raw.includes("Android Beam")) info.beam = "available";

  return info;
}

/**
 * Android GNSS constellation ID to name mapping.
 * From android.location.GnssStatus constants.
 */
const GNSS_CONSTELLATIONS: Record<number, string> = {
  1: "GPS",
  2: "SBAS",
  3: "GLONASS",
  4: "QZSS",
  5: "BeiDou",
  6: "Galileo",
  7: "IRNSS/NavIC",
};

/**
 * Parse GNSS information from dumpsys location output.
 * Extracts hardware model, firmware, capabilities, constellations, and signal types.
 */
function parseGnssDumpsys(raw: string): Record<string, string | string[]> {
  const info: Record<string, string | string[]> = {};

  // Hardware model name — contains chipset manufacturer, model, and firmware
  const hwModelMatch = raw.match(/GNSS Hardware Model Name:\s*(.+)/i);
  if (hwModelMatch) {
    const parts = hwModelMatch[1].trim();
    info.hardwareModel = parts;
    // Parse manufacturer and model from common format: "Broadcom, BCM4776, GLL ver. X.Y.Z"
    const commaSegs = parts.split(",").map(s => s.trim());
    if (commaSegs.length >= 2) {
      info.manufacturer = commaSegs[0];
      info.chipModel = commaSegs[1];
      if (commaSegs.length >= 3) info.firmwareVersion = commaSegs.slice(2).join(", ");
    }
  }

  // Hardware version
  const hwVerMatch = raw.match(/Hardware Version:\s*(\S+)/i);
  if (hwVerMatch) info.hardwareVersion = hwVerMatch[1].trim();

  // Capabilities — extract from the Capabilities: [...] block
  const capMatch = raw.match(/Capabilities:\s*\[([^\]]+)\]/);
  if (capMatch) {
    const capStr = capMatch[1];
    // Extract named capabilities (before signalTypes)
    const sigIdx = capStr.indexOf("signalTypes");
    const capsRaw = sigIdx > 0 ? capStr.substring(0, sigIdx) : capStr;
    const caps = capsRaw.split(/\s+/).filter(c => c.length > 0 && !c.startsWith("signal"));
    if (caps.length > 0) info.capabilities = caps;

    // A-GPS detection from capabilities
    const agpsModes: string[] = [];
    if (caps.includes("MSB")) agpsModes.push("MSB (Mobile Station Based)");
    if (caps.includes("MSA")) agpsModes.push("MSA (Mobile Station Assisted)");
    if (agpsModes.length > 0) info.agpsModes = agpsModes.join(", ");

    // Key capabilities for security research
    if (caps.includes("MEASUREMENTS")) info.rawMeasurements = "supported (pseudorange-level access)";
    if (caps.includes("NAVIGATION_MESSAGES")) info.navMessages = "supported";
    if (caps.includes("SATELLITE_PVT")) info.satellitePvt = "supported";
    if (caps.includes("MEASUREMENT_CORRECTIONS")) info.measurementCorrections = "supported";
    if (caps.includes("ACCUMULATED_DELTA_RANGE")) info.carrierPhase = "supported (accumulated delta range)";

    // Extract constellations and signal types
    const sigTypesMatch = capStr.match(/signalTypes=\[(.+)\]/);
    if (sigTypesMatch) {
      const constellationIds = new Set<number>();
      const freqs = new Set<string>();
      const sigTypeRegex = /Constellation=(\d+),\s*CarrierFrequencyHz=([^,\]]+),\s*CodeType=(\w+)/g;
      let sigMatch;
      while ((sigMatch = sigTypeRegex.exec(sigTypesMatch[1])) !== null) {
        const cId = parseInt(sigMatch[1], 10);
        const freqHz = parseFloat(sigMatch[2]);
        constellationIds.add(cId);
        const freqMhz = (freqHz / 1e6).toFixed(2);
        const cName = GNSS_CONSTELLATIONS[cId] ?? `Unknown(${cId})`;
        freqs.add(`${cName} ${sigMatch[3]} @ ${freqMhz} MHz`);
      }

      const constellations = [...constellationIds]
        .sort()
        .map(id => GNSS_CONSTELLATIONS[id] ?? `Unknown(${id})`);
      if (constellations.length > 0) info.constellations = constellations;

      // Detect dual-frequency (L1+L5) support
      const hasL1 = capStr.includes("1.57542E9");
      const hasL5 = capStr.includes("1.17645E9");
      if (hasL1 && hasL5) info.dualFrequency = "L1 + L5";

      if (freqs.size > 0) info.signalTypes = [...freqs];
    }
  }

  return info;
}

export function registerWirelessFirmwareTools(ctx: ToolContext): void {

  ctx.server.tool(
    "adb_wifi_firmware",
    "WiFi chipset and firmware identification. Reports WiFi driver version, firmware version, chipset/hardware info, supported bands and standards, interface details, and connection state. MAC address is opt-in only (permanent hardware identifier).",
    {
      device: z.string().optional().describe("Device serial"),
      includeMac: z.boolean().optional().default(false)
        .describe("Include WiFi MAC address (permanent hardware identifier — opt-in only)"),
    },
    async ({ device, includeMac }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);

        const sections: string[] = [];
        sections.push("=== WiFi Firmware Information ===");
        sections.push(`Device: ${props["ro.product.model"] ?? "unknown"} (${serial})`);

        // ── Properties ──
        const wifiProps: [string, string][] = [
          ["WiFi hardware", props["ro.hardware.wifi"] ?? ""],
          ["WiFi interface", props["wifi.interface"] ?? ""],
          ["Concurrent interface", props["wifi.concurrent.interface"] ?? ""],
          ["Driver version", props["wlan.driver.version"] ?? ""],
          ["Firmware version", props["vendor.wifi.firmware.version"] ?? props["wifi.firmware.version"] ?? ""],
          ["WiFi HAL", props["ro.hardware.wifi_hal"] ?? ""],
          ["WiFi country code", props["wifi.lbs.lac"] ?? ""],
        ];

        sections.push("\n── System Properties ──");
        for (const [label, value] of wifiProps) {
          if (value) sections.push(`${label}: ${value}`);
        }

        if (includeMac) {
          const mac = props["wifi.interface.mac"] ?? "";
          if (mac) sections.push(`MAC address: ${mac}`);
        }

        // ── dumpsys wifi ──
        try {
          const wifiDump = await ctx.bridge.shell(
            "dumpsys wifi 2>/dev/null | head -200",
            { device: serial, timeout: 10000, ignoreExitCode: true }
          );
          const parsed = parseWifiDumpsys(wifiDump.stdout);

          if (Object.keys(parsed).length > 0) {
            sections.push("\n── WiFi Detailed Info (from dumpsys) ──");
            for (const [key, value] of Object.entries(parsed)) {
              sections.push(`${key}: ${value}`);
            }
          }

          // Connection state
          const connMatch = wifiDump.stdout.match(/mWifiInfo\s+([^\n]+)/);
          if (connMatch) {
            sections.push(`\n── Current Connection ──`);
            const ssidMatch = connMatch[1].match(/SSID:\s*([^,]+)/);
            const rssiMatch = connMatch[1].match(/RSSI:\s*(-?\d+)/);
            const linkMatch = connMatch[1].match(/Link speed:\s*(\d+)\s*Mbps/i);
            const freqMatch = connMatch[1].match(/Frequency:\s*(\d+)/);
            if (ssidMatch) sections.push(`SSID: ${ssidMatch[1].trim()}`);
            if (rssiMatch) sections.push(`RSSI: ${rssiMatch[1]} dBm`);
            if (linkMatch) sections.push(`Link speed: ${linkMatch[1]} Mbps`);
            if (freqMatch) {
              const freq = parseInt(freqMatch[1], 10);
              const band = freq >= 5925 ? "6 GHz" : freq >= 5000 ? "5 GHz" : "2.4 GHz";
              sections.push(`Frequency: ${freq} MHz (${band})`);
            }
          }
        } catch { /* dumpsys may not be available */ }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_bluetooth_firmware",
    "Bluetooth firmware and chipset identification. Reports firmware version, BT version (4.x/5.x), chipset model, adapter state, supported profiles, LE capabilities, and bonded device count. MAC address and device name are opt-in only (permanent identifiers).",
    {
      device: z.string().optional().describe("Device serial"),
      includeIdentifiers: z.boolean().optional().default(false)
        .describe("Include Bluetooth MAC address and device name (permanent identifiers — opt-in only)"),
    },
    async ({ device, includeIdentifiers }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);

        const sections: string[] = [];
        sections.push("=== Bluetooth Firmware Information ===");
        sections.push(`Device: ${props["ro.product.model"] ?? "unknown"} (${serial})`);

        // ── Properties ──
        const btProps: [string, string][] = [
          ["BT hardware", props["ro.hardware.bt"] ?? ""],
          ["Firmware version", props["vendor.bluetooth.firmware.version"] ?? props["bluetooth.firmware.version"] ?? ""],
          ["HCI firmware revision", props["bluetooth.hci.firmware_revision"] ?? ""],
          ["BT enabled", props["bluetooth.enable_timeout_ms"] ? "yes" : ""],
        ];

        sections.push("\n── System Properties ──");
        for (const [label, value] of btProps) {
          if (value) sections.push(`${label}: ${value}`);
        }

        if (includeIdentifiers) {
          const btName = props["persist.bluetooth.bluetooth_name"] ?? props["net.bt.name"] ?? "";
          const btAddr = props["persist.bluetooth.bluetoothaddr"] ?? "";
          if (btName) sections.push(`Device name: ${btName}`);
          if (btAddr) sections.push(`MAC address: ${btAddr}`);
        }

        // ── dumpsys bluetooth_manager ──
        try {
          const btDump = await ctx.bridge.shell(
            "dumpsys bluetooth_manager 2>/dev/null | head -300",
            { device: serial, timeout: 10000, ignoreExitCode: true }
          );
          const parsed = parseBluetoothDumpsys(btDump.stdout);

          if (Object.keys(parsed).length > 0) {
            sections.push("\n── Bluetooth Detailed Info (from dumpsys) ──");
            for (const [key, value] of Object.entries(parsed)) {
              sections.push(`${key}: ${value}`);
            }
          }
        } catch { /* dumpsys may not be available */ }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_nfc_firmware",
    "NFC controller firmware identification. Reports controller type (NXP/Broadcom/Samsung/ST), firmware version, NCI version, supported technologies (NFC-A/B/F/V), secure element availability (eSE/UICC), and HCE (Host Card Emulation) support.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);

        const sections: string[] = [];
        sections.push("=== NFC Firmware Information ===");
        sections.push(`Device: ${props["ro.product.model"] ?? "unknown"} (${serial})`);

        // ── Properties ──
        const nfcProps: [string, string][] = [
          ["NFC hardware", props["ro.hardware.nfc"] ?? props["ro.hardware.nfc_nci"] ?? ""],
          ["NFC port", props["ro.nfc.port"] ?? ""],
          ["NFC SE ID", props["persist.nfc.se_id"] ?? ""],
          ["NFC features", props["ro.hardware.nfc_ese"] ? "eSE present" : ""],
        ];

        sections.push("\n── System Properties ──");
        let hasNfcProps = false;
        for (const [label, value] of nfcProps) {
          if (value) { sections.push(`${label}: ${value}`); hasNfcProps = true; }
        }
        if (!hasNfcProps) {
          sections.push("No NFC hardware properties found — device may not have NFC");
        }

        // ── dumpsys nfc ──
        try {
          const nfcDump = await ctx.bridge.shell(
            "dumpsys nfc 2>/dev/null | head -200",
            { device: serial, timeout: 10000, ignoreExitCode: true }
          );

          if (nfcDump.stdout.includes("NfcService") || nfcDump.stdout.includes("mState")
              || nfcDump.stdout.includes("NFC")) {
            const parsed = parseNfcDumpsys(nfcDump.stdout);

            if (Object.keys(parsed).length > 0) {
              sections.push("\n── NFC Detailed Info (from dumpsys) ──");
              for (const [key, value] of Object.entries(parsed)) {
                sections.push(`${key}: ${value}`);
              }
            }
          } else {
            sections.push("\n── NFC Service ──");
            sections.push("NFC service not responding — NFC may be disabled or unavailable");
          }
        } catch { /* dumpsys may not be available */ }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_gps_firmware",
    "GNSS/GPS chipset and firmware identification. Reports GNSS hardware model (manufacturer, chip, firmware version), supported constellations (GPS, GLONASS, Galileo, BeiDou, QZSS, NavIC, SBAS), signal types with frequencies, dual-frequency (L1+L5) support, raw measurement capabilities (pseudorange access for spoofing detection), A-GPS modes (MSB/MSA — cellular-routed assisted GPS relevant to IMSI catcher research), carrier phase measurements, navigation message decoding, and SUPL server configuration.",
    {
      device: z.string().optional().describe("Device serial"),
    },
    async ({ device }) => {
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const props = await ctx.deviceManager.getDeviceProps(serial);

        const sections: string[] = [];
        sections.push("=== GNSS/GPS Firmware Information ===");
        sections.push(`Device: ${props["ro.product.model"] ?? "unknown"} (${serial})`);

        // ── Properties ──
        const gpsHw = props["ro.hardware.gps"] ?? "";
        if (gpsHw) sections.push(`GPS hardware: ${gpsHw}`);

        // ── dumpsys location (GNSS Manager section) ──
        try {
          const locDump = await ctx.bridge.shell(
            "dumpsys location",
            { device: serial, timeout: 15000, ignoreExitCode: true }
          );
          const parsed = parseGnssDumpsys(locDump.stdout);

          if (parsed.hardwareModel) {
            sections.push(`\n── GNSS Hardware ──`);
            sections.push(`Model: ${parsed.hardwareModel}`);
            if (parsed.manufacturer) sections.push(`Manufacturer: ${parsed.manufacturer}`);
            if (parsed.chipModel) sections.push(`Chipset: ${parsed.chipModel}`);
            if (parsed.firmwareVersion) sections.push(`Firmware: ${parsed.firmwareVersion}`);
            if (parsed.hardwareVersion) sections.push(`Hardware version: ${parsed.hardwareVersion}`);
          }

          if (parsed.constellations && Array.isArray(parsed.constellations)) {
            sections.push(`\n── Supported Constellations (${parsed.constellations.length}) ──`);
            sections.push(parsed.constellations.join(", "));
            if (parsed.dualFrequency) sections.push(`Dual-frequency: ${parsed.dualFrequency}`);
          }

          if (parsed.signalTypes && Array.isArray(parsed.signalTypes)) {
            sections.push(`\n── Signal Types (${parsed.signalTypes.length}) ──`);
            for (const sig of parsed.signalTypes) {
              sections.push(`  ${sig}`);
            }
          }

          // Capabilities relevant to security research
          const secCaps: string[] = [];
          if (parsed.rawMeasurements) secCaps.push(`Raw GNSS measurements: ${parsed.rawMeasurements}`);
          if (parsed.navMessages) secCaps.push(`Navigation messages: ${parsed.navMessages}`);
          if (parsed.satellitePvt) secCaps.push(`Satellite PVT: ${parsed.satellitePvt}`);
          if (parsed.measurementCorrections) secCaps.push(`Measurement corrections: ${parsed.measurementCorrections}`);
          if (parsed.carrierPhase) secCaps.push(`Carrier phase: ${parsed.carrierPhase}`);
          if (secCaps.length > 0) {
            sections.push(`\n── Research Capabilities ──`);
            for (const cap of secCaps) sections.push(cap);
          }

          // A-GPS / SUPL configuration
          sections.push(`\n── A-GPS / Assisted GNSS ──`);
          if (parsed.agpsModes) {
            sections.push(`A-GPS modes: ${parsed.agpsModes}`);
          }

          // Check SUPL settings
          try {
            const agpsEnabled = await ctx.bridge.shell(
              "settings get global assisted_gps_enabled",
              { device: serial, timeout: 5000, ignoreExitCode: true }
            );
            const enabled = agpsEnabled.stdout.trim();
            sections.push(`A-GPS enabled: ${enabled === "1" ? "yes" : enabled === "0" ? "no" : enabled}`);

            const suplHost = await ctx.bridge.shell(
              "settings get global assisted_gps_supl_host",
              { device: serial, timeout: 5000, ignoreExitCode: true }
            );
            const host = suplHost.stdout.trim();
            if (host && host !== "null") {
              sections.push(`SUPL server: ${host}`);
              const suplPort = await ctx.bridge.shell(
                "settings get global assisted_gps_supl_port",
                { device: serial, timeout: 5000, ignoreExitCode: true }
              );
              const port = suplPort.stdout.trim();
              if (port && port !== "null") sections.push(`SUPL port: ${port}`);
              sections.push(`⚠ SUPL traffic is routed through the cellular network — susceptible to interception by IMSI catchers`);
            } else {
              sections.push(`SUPL server: not configured`);
            }
          } catch { /* settings query failed */ }

          // All capabilities dump
          if (parsed.capabilities && Array.isArray(parsed.capabilities) && parsed.capabilities.length > 0) {
            sections.push(`\n── All Capabilities (${parsed.capabilities.length}) ──`);
            sections.push((parsed.capabilities as string[]).join(", "));
          }

        } catch {
          sections.push("\nGNSS data not available — location service may not be running");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );
}

