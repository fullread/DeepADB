# Changelog

All notable changes to DeepADB are documented in this file.

## v1.0.7 — Wireless Firmware, QEMU Guest Connectivity & Dependency Security Patch

### Wireless Firmware Tools (4 new tools, 1 new module — 156 tools across 42 modules)

- **`adb_wifi_firmware`** — WiFi chipset and firmware identification: driver version, firmware version, supported bands (2.4/5/6 GHz), WiFi standard detection (5/6/6E/7), current connection info (SSID, RSSI, link speed, frequency). MAC address opt-in only (permanent hardware identifier).
- **`adb_bluetooth_firmware`** — Bluetooth firmware and chipset identification: firmware version, BT version (4.0–5.4 from LMP), adapter state, LE capabilities (2M PHY, Coded PHY, extended advertising, LE Audio), active profiles (A2DP/HFP/HID/PAN/MAP), bonded device count. MAC/name opt-in only.
- **`adb_nfc_firmware`** — NFC controller firmware identification: controller type (NXP/Broadcom/Samsung/ST), firmware version, NCI version, supported technologies (NFC-A/B/F/V, MIFARE), secure element availability (eSE/UICC), HCE support.
- **`adb_gps_firmware`** — GNSS/GPS chipset and firmware identification: hardware model (manufacturer, chip, firmware), supported constellations (GPS/GLONASS/Galileo/BeiDou/QZSS/NavIC/SBAS), signal types with frequencies, dual-frequency (L1+L5) detection, raw GNSS measurement capabilities (pseudorange access for spoofing detection), A-GPS modes (MSB/MSA — cellular-routed assisted GPS relevant to IMSI catcher research), SUPL server configuration, carrier phase measurements, navigation message decoding.
- Enhanced `adb_firmware_probe` with WiFi/Bluetooth/NFC/GPS firmware summary section and cross-references to detailed tools

### QEMU Session 3 — Guest ADB Connectivity (3 new tools)

- **`adb_qemu_connect`** — Connect to a running VM's guest ADB service. Restricted to `localhost` only — no remote host connections. Port derived from running VM state, never user input.
- **`adb_qemu_disconnect`** — Disconnect from a guest VM's ADB service. Auto-clears connection state.
- **`adb_qemu_guest_shell`** — Execute shell commands on a guest VM via ADB. Subject to the same security middleware as `adb_shell`. Guest serial derived internally — no user-supplied host/IP reaches the ADB binary.

### AT Cross-Validation (1 new tool)

- **`adb_at_cross_validate`** — Cross-validate baseband firmware by comparing direct modem AT command responses (ATI, AT+CGMR, AT+CGMM) against Android system properties (gsm.version.baseband, ro.hardware.chipname). Shannon-specific AT+DEVCONINFO support. Flags discrepancies as potential firmware tampering, incomplete OTA updates, or property spoofing. Performs 4 validation checks: firmware revision consistency, modem identity vs chipset family, model identification, and expected vs running baseband. Requires root.

### Comparative Testing Workflows (1 new tool)

- **`adb_multi_test`** — Run comparative test workflows across all connected devices (host + QEMU guests). Supports predefined diagnostic profiles: `firmware` (baseband, bootloader, kernel, security patch, build fingerprint), `security` (SELinux, verified boot, encryption, flash lock), `network` (radio type, operator, SIM state, WiFi), `identity` (model, chipset, architecture, RAM), and `full` (all profiles combined). Also accepts custom command lists (max 50 checks). Runs each check in parallel across all devices, compares outputs per-check, and produces a structured match/difference report. All commands go through security middleware.

### QEMU Enhancements
- Enhanced `adb_qemu_stop` to auto-disconnect guest ADB before killing QEMU process
- Enhanced `adb_qemu_status` to show per-VM ADB connection state
- Enhanced process cleanup to disconnect all connected VMs before killing on exit
- VM exit handler clears connection state when QEMU process exits unexpectedly

### Multi-Device Integration (QEMU Session 4)

- Enhanced `LocalBridge` with guest device routing — commands targeting a connected QEMU guest are transparently routed through the real ADB binary instead of local execution
- Added guest device registry (`registerGuestDevice`/`unregisterGuestDevice`) with static set — only populated by QEMU connect/disconnect flow with validated `localhost:<port>` serials
- Enhanced `syntheticDeviceList()` to merge ADB-connected guest devices into the device list, enabling existing `adb_multi_shell`, `adb_multi_install`, and `adb_multi_compare` tools to operate transparently across host + guest VMs
- Zero changes to any of the 42 tool modules — multi-device integration is entirely bridge-level

### Security Hardening

- Bearer token strength validation at startup: warns if `DA_AUTH_TOKEN` is shorter than 32 characters, has low character diversity, uses repeated characters, or matches common weak patterns (e.g., "password", "changeme", "test")
- Updated SECURITY.md with explicit minimum token length requirement (32 characters), `node -e` alternative for environments without openssl, and token strength guidance

### Dependency Security Patch

- Patched 6 moderate vulnerabilities in transitive dependencies of `@modelcontextprotocol/sdk`:
  - `hono` 4.12.9 → 4.12.12: cookie name validation bypass (GHSA-26pp-8wgv-hjvm), cookie name prefix bypass (GHSA-r5rp-j6wh-rvv4), IPv4-mapped IPv6 bypass in ipRestriction (GHSA-xpcf-pg52-r92g), path traversal in toSSG (GHSA-xf4j-xp2r-rqqx), middleware bypass via repeated slashes (GHSA-wmmm-f939-6g9c)
  - `@hono/node-server` 1.19.11 → 1.19.13: middleware bypass via repeated slashes in serveStatic (GHSA-92pp-h63x-v22m)
- Lockfile-only change — no API changes
- Full dependency audit: 0 vulnerabilities
- Updated `@types/node` 25.5.0 → 25.5.2, `path-to-regexp` 8.4.0 → 8.4.2 (transitive)
- Updated future roadmap documentation to reflect current state

---

## v1.0.5 — Transport Security & Auth Documentation

- Bearer token authentication (`DA_AUTH_TOKEN`) documented in README and SECURITY.md — env var table, usage examples, deployment configurations, and plaintext-over-HTTP warning
- Token comparison hardened with `crypto.timingSafeEqual()` to prevent timing-based side-channel attacks; uses pre-computed buffer with byte-length comparison to handle multi-byte UTF-8 tokens correctly
- Non-loopback binding warning: startup alerts operators when network transports bind to non-`127.0.0.1` addresses without `DA_AUTH_TOKEN` set, referencing common MCP security findings
- Auth status logged at startup for network transports (token enabled vs. no auth configured)
- CORS headers updated to allow `Authorization` header across all transports (HTTP/SSE, WebSocket, GraphQL) with OPTIONS preflight handling
- Added HTTPS via reverse proxy guidance to SECURITY.md (Caddy and SSH tunnel examples)
- Upgraded `@modelcontextprotocol/sdk` from 1.28.0 to 1.29.0
- Upgraded dev dependencies: TypeScript 5.9.3 → 6.0.2, @types/node 22.x → 25.5.0; added `"types": ["node"]` to tsconfig.json for TypeScript 6.0 compatibility
- Removed unused `checkAuth` import from WebSocket transport
- Code consistency: non-loopback check uses `isAuthEnabled()` instead of duplicating env var logic

---

## v1.0.4 — Dependency Security Patch

- Fix CVE-2026-4926 (CVSS 8.7 High): ReDoS vulnerability in `path-to-regexp@8.3.0` — updated to `8.4.0` via lockfile refresh
- Upgraded `@modelcontextprotocol/sdk` from 1.27.1 to 1.28.0
- Full dependency audit: 0 vulnerabilities, all transitive dependencies current

---

## v1.0.3 — Security Hardening

- Audit logging (`DA_AUDIT_LOG`) now enabled by default — all commands logged to stderr with credential redaction. Set `DA_AUDIT_LOG=false` to disable.
- Added `SECURITY.md` documenting threat model, security architecture, recommended configurations for personal/shared/network-exposed deployments, version pinning guidance, AT command safety, and vulnerability reporting process
- Fixed `package-lock.json` version — was stuck at 1.0.0 across prior releases, now synced to 1.0.3

### Test Suite Improvements (203 on-device / 183 ADB-mode)

- New `test-boundaries.mjs` suite (28 tests): Zod parameter bounds enforcement, `adb_input` injection validation, error path handling, previously untested tools (`adb_clear_data`, `adb_extract_apks`, `adb_snapshot_restore_settings`, `adb_market_search`, `adb_registry_search`), and sensitive data protection checks
- Harness: added `testNotContains()` and `testMatch()` assertion methods
- `run-all.mjs`: now tracks and displays skipped test counts in per-suite and total summary
- `test-qemu.mjs`: fixed missing `process.exit()` that silently swallowed failures

---

## v1.0.2 — Version Reporting Fix

- Read version from package.json at runtime instead of hardcoding across 4 files
- New `VERSION` export in config.ts — single source of truth for McpServer, HTTP/SSE, WebSocket, and GraphQL transports
- Future version bumps only require editing package.json

---

## v1.0.1 — Code Quality Patch

- Fix unused `bridge` parameter in GraphQL `buildResolvers()`
- Fix unused `deviceManager` parameter in GraphQL `buildFieldResolvers()`
- Remove unnecessary `async` from 8 synchronous GraphQL field resolvers
- Add `pretest` script to package.json so `npm test` auto-builds first

---

## v1.0.0 — Full Release

**147 tools, 4 resources, 4 prompts across 41 modules.**
**Triple transport (stdio + HTTP/SSE + WebSocket) + GraphQL API.**
**Dual-mode: ADB (PC) and on-device (Termux) with automatic detection.**
**175/175 tests passing on hardware (Pixel 6a, Android 16).**

### Highlights
- 22-pass comprehensive security and code quality audit (75 findings resolved)
- On-device mode via LocalBridge with automatic privilege escalation
- QEMU/KVM virtualization for on-device guest VM management
- Zero shell injection vectors across all 147 tools
- Every numeric parameter bounded with Zod `.min()/.max()` constraints
- Centralized process cleanup registry for all child process modules

---

## v0.9.0 — Firmware Intelligence & Ecosystem

6 new tools, 2 new modules. Total: 133 tools across 37 modules.

- **Modem Firmware Analysis** — Multi-family baseband version parsing (Shannon, Qualcomm MPSS, MediaTek MOLY, Unisoc, HiSilicon, Intel XMM), bootloader parsing, RIL implementation parsing, comprehensive diffing and version history tracking
- **Workflow Marketplace** — Community sharing for workflow definitions with SHA-256 integrity verification
- **GraphQL API** — Composed device queries via optional HTTP endpoint (requires `graphql` package)

## v0.8.0 — Intelligence & Monitoring

12 new tools, 4 new modules, 1 new transport. Total: 127 tools across 35 modules.

- **Automated Test Generation** — Generate test workflows from live UI hierarchy or package intent registrations
- **OTA Update Monitoring** — Track system fingerprint across sessions, detect firmware changes
- **RIL Message Interception** — Passive radio interface layer monitoring with category-based filtering
- **Device Profile Library** — Hardware-specific knowledge base with auto-detection
- **WebSocket Transport** — Bidirectional streaming MCP transport (optional `ws` package)

## v0.7.0 — Advanced Tooling

17 new tools, 5 new modules. Total: 115 tools across 31 modules.

- **AT Command Interface** — Direct modem AT command passthrough with multi-chipset auto-detection (Shannon, Qualcomm, MediaTek, Unisoc)
- **Screenshot Diffing** — Pixel-level visual regression detection with PNG decoding and tolerance thresholds
- **Workflow Orchestration** — Declarative JSON workflow engine with variables, conditionals, and loops
- **Split APK Management** — App bundle installation, split inspection, APEX module listing
- **Device Mirroring** — Live screen mirroring via scrcpy integration

## v0.6.0 — Security & Cloud Testing

12 new tools, 4 new modules. Total: 98 tools across 26 modules.

- **Accessibility Auditing** — WCAG checks for touch targets, labels, focusability
- **Regression Detection** — Performance baseline capture and comparison
- **Device Farm Integration** — Firebase Test Lab via gcloud CLI
- **Plugin Registry** — Community plugin search, install, and management
- **HTTP/SSE Transport** — Browser-based MCP client support

## v0.5.0 — Baseband/Modem Integration

6 new tools, 1 new module. Total: 86 tools across 22 modules.

- **Baseband Tools** — Modem firmware ID, cell identity, signal measurements, neighboring cells, carrier config, modem logs

## v0.4.0 — Advanced Features

14 new tools, 5 new modules. Total: 80 tools across 21 modules.

- **Multi-Device Orchestration** — Parallel shell, install, and compare across devices
- **Snapshot/Restore** — Comprehensive device state capture and diffing
- **Network Capture** — tcpdump packet capture with pcap pull
- **CI/CD Integration** — Boot wait, readiness check, instrumented test runner
- **Plugin Architecture** — Dynamic ESM module loading

## v0.3.0 — Resources, Prompts & Security

8 new tools, 4 resources, 4 prompts, 3 new modules. Total: 66 tools across 16 modules.

- **Screen Recording** — Start/stop video capture with mp4 pull
- **Emulator Management** — AVD list, start, stop
- **Test Sessions** — Numbered step capture with screenshots and logcat
- **MCP Resources** — Device list, info, battery, telephony
- **MCP Prompts** — debug-crash, deploy-and-test, telephony-snapshot, airplane-cycle-test
- **Security Middleware** — Command filtering, rate limiting, audit logging

## v0.2.0 — Extended Core

14 new tools, 1 new module. Total: 58 tools across 13 modules.

- **Port Forwarding** — Forward, reverse, list
- **App Lifecycle** — Force stop, start, restart
- **Intent Resolution** — Discover registered activities, services, receivers
- **Bug Report** — Full bugreport zip capture
- **Settings** — Read/write any Android setting with verification

## v0.1.0 — Initial Release

44 tools across 12 modules. Core ADB integration.

- Device discovery, shell execution, package management, file operations
- Logcat snapshots and persistent watchers, diagnostics (dumpsys, telephony, battery)
- UI screenshots, input events, activity inspection
- Device control (airplane, WiFi, data, location, screen)
- Wireless debugging, build tools, health check
- ADB bridge with transient retry and device caching
