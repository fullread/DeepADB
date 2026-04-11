/**
 * Hardware Test Suite — Core device identification and diagnostics.
 * Tests: health, device info, battery, baseband, telephony, SELinux, thermal, network, profiles.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Hardware Core");

h.section("Health & Identity");
await h.test("Health Check", "adb_health_check");
await h.testContains("Device Info → Pixel 6a", "adb_device_info", {}, "Pixel 6a");
await h.testContains("Device Info → Android 16", "adb_device_info", {}, "Android Version: 16");
await h.test("Device List", "adb_devices");
await h.testContains("Getprop (single)", "adb_getprop", { key: "ro.product.model" }, "Pixel 6a");
await h.test("Getprop (all)", "adb_getprop", {});

h.section("Battery & Thermal");
await h.testContains("Battery Status", "adb_battery", {}, "level:");
await h.testContains("Thermal Snapshot", "adb_thermal_snapshot", {}, "CPU frequencies");
await h.testContains("Battery Drain (3s)", "adb_battery_drain", { durationMs: 3000 }, "Power consumption");

h.section("Baseband & Radio");
await h.testContains("Baseband Info", "adb_baseband_info", {}, "g5123b");
await h.testContains("Baseband Dual SIM", "adb_baseband_info", {}, "Dual SIM");
await h.testContains("Cell Identity", "adb_cell_identity", {}, "Quick Reference");
await h.test("Signal Detail", "adb_signal_detail");
await h.test("Neighboring Cells", "adb_neighboring_cells");
await h.test("Carrier Config", "adb_carrier_config");
await h.testContains("Modem Logs", "adb_modem_logs", { lines: 50 }, "Radio Buffer");
await h.testContains("Firmware Probe", "adb_firmware_probe", {}, "Shannon");

h.section("Telephony & Network");
await h.testContains("Telephony State", "adb_telephony", {}, "mServiceState");
await h.testContains("Network Info", "adb_network", {}, "IP Addresses");
await h.testContains("Device WiFi IP", "adb_network_device_ip", {}, "WiFi IP");

h.section("SELinux & Security");
await h.testContains("SELinux Status", "adb_selinux_status", {}, "Enforcing");
await h.test("SELinux Denials", "adb_selinux_denials", { lines: 10 });

h.section("Device Profile");
await h.testContains("Profile Detect → Shannon", "adb_profile_detect", {}, "shannon");
await h.testContains("Profile Detect → Dual SIM", "adb_profile_detect", {}, "Dual SIM: yes");
await h.testContains("Profile Detect → Bluejay", "adb_profile_detect", {}, "bluejay");
await h.test("Profile List", "adb_profile_list");

h.section("Wireless Firmware");
await h.testContains("WiFi Firmware", "adb_wifi_firmware", {}, "WiFi Firmware");
await h.testContains("WiFi (no MAC by default)", "adb_wifi_firmware", {}, "WiFi");
await h.testContains("Bluetooth Firmware", "adb_bluetooth_firmware", {}, "Bluetooth Firmware");
await h.testContains("NFC Firmware", "adb_nfc_firmware", {}, "NFC Firmware");
await h.testContains("GPS Firmware → Broadcom", "adb_gps_firmware", {}, "Broadcom");
await h.testContains("GPS Firmware → Constellations", "adb_gps_firmware", {}, "GPS");
await h.testContains("Firmware Probe → Wireless", "adb_firmware_probe", {}, "Wireless Firmware");

const exitCode = h.finish();
process.exit(exitCode);
