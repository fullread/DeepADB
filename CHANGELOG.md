# Changelog

All notable changes to DeepADB are documented in this file.

## v1.0.3 — Security Hardening

- Audit logging (`DA_AUDIT_LOG`) now enabled by default — all commands logged to stderr with credential redaction. Set `DA_AUDIT_LOG=false` to disable.
- Added `SECURITY.md` documenting threat model, security architecture, recommended configurations for personal/shared/network-exposed deployments, version pinning guidance, AT command safety, and vulnerability reporting process

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
