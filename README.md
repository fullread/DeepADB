# DeepADB

MCP (Model Context Protocol) server providing full Android Debug Bridge (ADB) integration with Claude. Enables Claude to directly interact with connected Android devices — inspecting state, running commands, managing apps, capturing logs, controlling device settings, analyzing UI hierarchies, recording screens, managing emulators, running structured test sessions, orchestrating multi-device operations, capturing network traffic, running CI pipelines, auditing accessibility, detecting performance regressions, executing cloud device farm tests, debugging over WiFi, building projects, and managing community plugins.

**147 tools, 4 resources, and 4 prompts across 41 modules** — the most comprehensive ADB MCP server available, with triple transport (stdio + HTTP/SSE + WebSocket), optional GraphQL API, defense-in-depth security, modem firmware analysis, workflow marketplace, AT command interface with multi-chipset support, RIL message interception, device profiling, baseband/modem integration, automated test generation, OTA update monitoring, SELinux auditing, thermal/power profiling, network device discovery, visual regression detection, workflow orchestration, accessibility auditing, and contextual truncation.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   MCP Client                     │
│             (Claude Code / claude.ai)            │
└──────────────────────┬───────────────────────────┘
                       │ stdio (JSON-RPC) or HTTP/SSE or WebSocket
┌──────────────────────▼───────────────────────────┐
│               DeepADB Server                     │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │           Tool Modules (41)                 │ │
│  │  device │ shell │ packages │ files │ logs   │ │
│  │  diagnostics │ ui │ build │ health          │ │
│  │  wireless │ control │ logcat-watch          │ │
│  │  forwarding │ screen-record │ emulator      │ │
│  │  testing │ multi-device │ snapshot          │ │
│  │  network-capture │ ci │ plugins │ baseband  │ │
│  │  accessibility │ regression                 │ │
│  │  device-farm │ registry │ at-commands       │ │
│  │  screenshot-diff │ workflow                 │ │
│  │  split-apk │ mirroring │ test-gen           │ │
│  │  ota-monitor │ ril-intercept                │ │
│  │  device-profiles │ firmware-analysis        │ │
│  │  workflow-market │ selinux-audit            │ │
│  │  thermal-power │ network-discovery          │ │
│  ├─────────────────────────────────────────────┤ │
│  │  Resources (4) │ Prompts (4)                │ │
│  └───────────────────┬─────────────────────────┘ │
│                      │                           │
│  ┌───────────────────▼─────────────────────────┐ │
│  │          ToolContext (unified DI)           │ │
│  │  server │ bridge │ deviceManager            │ │
│  │  logger │ security │ config                 │ │
│  └───────────────────┬─────────────────────────┘ │
│                      │                           │
│  ┌───────────────────▼─────────────────────────┐ │
│  │           Middleware Layer                  │ │
│  │  OutputProcessor │ SecurityMiddleware       │ │
│  │  InputSanitizer │ Logger (stderr-safe)      │ │
│  └───────────────────┬─────────────────────────┘ │
│                      │                           │
│  ┌───────────────────▼─────────────────────────┐ │
│  │         Bridge Layer (auto-detect)          │ │
│  │                                             │ │
│  │  ┌─────────────┐    ┌────────────────────┐  │ │
│  │  │  ADB Bridge  │ OR │  Local Bridge      │ │ │
│  │  │  (PC mode)   │    │  (on-device mode)  │ │ │
│  │  │  via adb.exe │    │  via sh/su direct  │ │ │
│  │  └──────┬───────┘    └────────┬───────────┘ │ │
│  │         │                     │             │ │
│  │  Retry │ Timeout │ Cache │ Serial routing   │ │
│  └─────────┼─────────────────────┼─────────────┘ │
└────────────┼─────────────────────┼───────────────┘
             │                     │
     ┌───────▼───────┐    ┌───────▼───────┐
     │  ADB Binary   │    │   sh / su     │
     │  (USB/WiFi)   │    │   (local)     │
     └───────┬───────┘    └───────┬───────┘
             │                    │
       ┌─────▼────────────────────▼─────┐
       │          Android Device        │
       └────────────────────────────────┘
```

## Dual-Mode Architecture

DeepADB operates in two modes, auto-detected at startup:

### ADB Mode (default) — PC-side bridge
```
AI Agent (PC) ←→ MCP ←→ DeepADB (PC) ←→ ADB (USB) ←→ Android Device
```
Standard mode: DeepADB runs on a PC/Mac/Linux host and communicates with the device over USB via ADB. All 147 tools work through the ADB bridge with automatic retry on transient failures.

### On-Device Mode — direct local execution
```
AI Agent (Termux) ←→ MCP (stdio/HTTP) ←→ DeepADB (Termux) ←→ sh/su (local)
```
When DeepADB runs directly on the Android device (e.g., inside Termux), it auto-detects the environment and switches to `LocalBridge`. Commands execute directly via `sh`/`su` — no ADB server, no USB, no serialization overhead. All 147 tools work identically, with significantly lower latency.

**Validated on hardware:** 203/203 tests pass on-device (Pixel 6a, Android 16, Termux + Magisk + QEMU 10.2.1). Includes 20 QEMU/KVM virtualization tests covering setup detection, disk image lifecycle, resource budget reporting, Alpine Linux VM boot with KVM acceleration, big.LITTLE CPU topology detection, and clean VM shutdown. QEMU tests auto-skip in ADB mode (183 passed, 4 skipped).

**Privilege escalation:** In ADB mode, all shell commands run as uid=2000 (the `shell` user) which has system-level permissions. In Termux, commands run as a regular app user. LocalBridge automatically elevates privileged commands through `su` when root (Magisk) is available:
- **Command allowlist:** 16 system commands (`settings`, `dumpsys`, `am`, `input`, `screencap`, `screenrecord`, `uiautomator`, `app_process`, `getenforce`, `setenforce`, `cmd`, `pm`, `wm`, `svc`, `ip`, `ifconfig`) are routed through `su -c` to match ADB-mode behavior.
- **Path-based elevation:** Commands referencing `/sdcard`, `/storage`, or `/system/` paths are elevated to bypass Android scoped storage restrictions.
- **Root detection:** Cached after a single `su -c id` probe at first use. Graceful degradation when root is unavailable.
- The elevation allowlist is frozen (`ReadonlySet` + `Object.freeze`) — not configurable via environment variables or runtime API.

**Auto-detection:** Checks for `/system/build.prop` (present on all Android devices, never on hosts). Override with `DA_LOCAL=true` or `DA_LOCAL=false`.

**On-device setup (Termux):**
```bash
pkg install nodejs-lts git
git clone <deepadb-repo> && cd deepadb
npm install && npm run build
npm start                              # stdio — for local AI agents (Claude Code, OpenCode)
DA_HTTP_PORT=3000 npm start            # HTTP/SSE — for remote AI access over WiFi
```

## Quick Start

```bash
npm install
npm run build
npm run inspector   # Test with MCP Inspector
npm start           # Run directly (stdio mode)

# HTTP/SSE mode for browser-based clients
DA_HTTP_PORT=3000 npm start

# WebSocket mode (requires: npm install ws)
DA_WS_PORT=3001 npm start

# GraphQL API (requires: npm install graphql) — runs alongside any transport
DA_GRAPHQL_PORT=4000 npm start
```

## Claude Code Configuration

```json
{
  "mcpServers": {
    "deepadb": {
      "command": "node",
      "args": ["/path/to/DeepADB/build/index.js"]
    }
  }
}
```

## Available Tools (147)

### Health (1 tool)
- `adb_health_check` — Comprehensive toolchain validation: ADB binary, server, device connection, authorization, root access, and storage writability

### Device (3 tools)
- `adb_devices` — List all connected devices with state, model, and product info
- `adb_device_info` — Detailed device properties (model, OS, SDK, build, security patch, ABI)
- `adb_getprop` — Read a specific system property or dump all properties

### Shell (2 tools)
- `adb_shell` — Execute arbitrary shell commands with configurable timeout (security-checked)
- `adb_root_shell` — Execute commands as root via su (requires rooted device, security-checked)

### Packages (10 tools)
- `adb_install` — Install APK with replace/downgrade options
- `adb_uninstall` — Remove package with optional data retention
- `adb_list_packages` — List packages filtered by name or type (all/system/third-party)
- `adb_package_info` — Detailed package info (version, permissions, paths)
- `adb_clear_data` — Clear all app data and cache
- `adb_grant_permission` — Grant runtime permissions
- `adb_force_stop` — Force-stop an app immediately
- `adb_start_app` — Launch an app by package name (resolves launcher activity)
- `adb_restart_app` — Force-stop then re-launch in one call (configurable delay)
- `adb_resolve_intents` — Discover registered activities, services, and receivers with intent filters

### Files (4 tools)
- `adb_push` — Push local file to device
- `adb_pull` — Pull file from device to local filesystem
- `adb_ls` — List device directory contents (simple or detailed)
- `adb_cat` — Read text file from device with optional line limit

### Logs — Snapshots (3 tools)
- `adb_logcat` — Filtered logcat snapshot with tag, priority, grep, and buffer selection
- `adb_logcat_clear` — Clear all logcat buffers
- `adb_logcat_crash` — Crash buffer log snapshot

### Logs — Persistent Watchers (4 tools)
- `adb_logcat_start` — Start a background logcat watcher with ring buffer accumulation
- `adb_logcat_poll` — Retrieve new lines since last poll from a running watcher
- `adb_logcat_stop` — Stop a watcher session (or all sessions)
- `adb_logcat_sessions` — List all active watcher sessions with stats

### Diagnostics (7 tools)
- `adb_dumpsys` — Run dumpsys for any service (or list all services)
- `adb_telephony` — Cell info, signal strength, and network registration (parallel query)
- `adb_battery` — Battery status, level, temperature, and charging info
- `adb_network` — WiFi, cellular, and IP connectivity (parallel query)
- `adb_top` — CPU and memory usage snapshot
- `adb_perf_snapshot` — Parallel memory, frame stats, and CPU profiling for a package
- `adb_bugreport` — Full bug report zip capture (device state, logs, system info)

### UI (8 tools)
- `adb_screencap` — Take screenshot with filename sanitization, saves locally
- `adb_current_activity` — Get focused activity and top window stack
- `adb_input` — Send tap, swipe, text, or keyevent input
- `adb_start_activity` — Launch activities by intent or component name
- `adb_ui_dump` — Dump full UI hierarchy with parsed element data, coordinates, and interaction flags
- `adb_ui_find` — Search UI hierarchy by text, resource-id, or content-description (returns tap coordinates)
- `adb_screenrecord_start` — Start recording the device screen (1-180s, stored on device)
- `adb_screenrecord_stop` — Stop recording and pull the mp4 video file locally

### Device Control (9 tools)
- `adb_airplane_mode` — Toggle airplane mode with broadcast and verification
- `adb_airplane_cycle` — Cycle airplane mode on/off to force cellular re-registration
- `adb_wifi` — Enable or disable WiFi
- `adb_mobile_data` — Enable or disable mobile data
- `adb_location` — Set location mode (off/sensors/battery/high)
- `adb_screen` — Wake, sleep, toggle, or unlock (swipe) the screen
- `adb_settings_get` — Read any Android setting from system/secure/global namespace
- `adb_settings_put` — Write any Android setting with read-back verification
- `adb_reboot` — Reboot device (normal, recovery, or bootloader mode)

### Wireless Debugging (4 tools)
- `adb_pair` — Pair with device over WiFi using pairing code
- `adb_connect` — Connect to device over WiFi/TCP
- `adb_disconnect` — Disconnect wireless device(s)
- `adb_tcpip` — Switch USB device to TCP/IP mode (auto-detects device IP)

### Port Forwarding (3 tools)
- `adb_forward` — Forward a local port to a device port (host → device)
- `adb_reverse` — Reverse-forward a device port to the host (device → host)
- `adb_forward_list` — List all active forward and reverse port mappings

### Emulator Management (3 tools)
- `adb_avd_list` — List available AVDs (PC mode) or detect KVM/QEMU virtualization capabilities (on-device mode)
- `adb_emulator_start` — Launch an AVD with headless, cold boot, and GPU options (PC mode) or report QEMU alternative (on-device mode)
- `adb_emulator_stop` — Gracefully shut down a running emulator

### QEMU/KVM Virtualization (5 tools)
- `adb_qemu_setup` — Check and install QEMU for on-device virtualization. Verifies KVM, reports host CPU/RAM, installs via Termux pkg
- `adb_qemu_images` — Manage VM disk images: list, create (qcow2/raw), delete. Path containment verification prevents traversal
- `adb_qemu_start` — Boot a KVM-accelerated VM with dynamic resource allocation. Auto-detects optimal CPUs (total minus 1, reserving one for host) and memory (65% of physical RAM). Supports kernel/initrd/append for Android boot, ADB port forwarding
- `adb_qemu_stop` — Stop a running VM (graceful SIGTERM or force SIGKILL). Reports running VMs if no name given
- `adb_qemu_status` — Full status: KVM/QEMU availability, host resource budget, running VMs with PID/resources/uptime/ports, image inventory

### Test Sessions (3 tools)
- `adb_test_session_start` — Start a named test session with organized output directory
- `adb_test_step` — Capture a numbered step with screenshot and logcat into the session
- `adb_test_session_end` — End session, write summary manifest, return directory path

### Multi-Device Orchestration (3 tools)
- `adb_multi_shell` — Execute a command on all/selected devices in parallel (security-checked)
- `adb_multi_install` — Install an APK across multiple devices simultaneously
- `adb_multi_compare` — Run a command on all devices and highlight output differences

### Snapshot/Restore (3 tools)
- `adb_snapshot_capture` — Save comprehensive device state (packages, settings, properties) to JSON
- `adb_snapshot_compare` — Diff current state against a saved snapshot (added/removed packages, changed settings)
- `adb_snapshot_restore_settings` — Restore global/secure settings from a saved snapshot

### Network Capture (3 tools)
- `adb_tcpdump_start` — Start background packet capture via tcpdump (requires root)
- `adb_tcpdump_stop` — Stop capture and pull pcap file locally for Wireshark analysis
- `adb_network_connections` — Show active TCP/UDP connections (ss/netstat with /proc/net fallback)

### CI/CD Integration (3 tools)
- `adb_ci_wait_boot` — Wait for device/emulator to fully boot with configurable timeout
- `adb_ci_device_ready` — Structured pass/fail readiness check (boot, PM, screen, network, disk)
- `adb_ci_run_tests` — Run instrumented tests via `am instrument` with parsed pass/fail results

### Baseband/Modem (6 tools)
- `adb_baseband_info` — Modem firmware, RIL implementation, chipset, SIM configuration (dual SIM detection with per-slot state), network registration. IMEI retrieval is opt-in only (`includeImei=true`)
- `adb_cell_identity` — Cell ID (CID), TAC/LAC, EARFCN, PCI, PLMN from dumpsys phone for cellular network analysis
- `adb_signal_detail` — RSRP, RSRQ, SINR, RSSI, timing advance — raw radio measurements for signal analysis
- `adb_neighboring_cells` — All visible LTE/5G/WCDMA/GSM cells with identities and signal strengths
- `adb_carrier_config` — Carrier configuration dump, carrier ID, preferred APN
- `adb_modem_logs` — RIL radio buffer, telephony framework, RILJ/RILC, kernel dmesg (root) modem logs

### Accessibility Auditing (3 tools)
- `adb_a11y_audit` — Automated WCAG audit: missing labels, undersized touch targets (<48dp), duplicate descriptions, unfocusable clickables
- `adb_a11y_touch_targets` — List all interactive elements with touch target dimensions in dp, flag undersized
- `adb_a11y_tree` — Accessibility-focused UI tree showing only screen-reader-relevant elements with roles, labels, and states

### Regression Detection (3 tools)
- `adb_regression_baseline` — Capture performance baseline (memory, CPU, frame stats, battery, network) to JSON
- `adb_regression_check` — Compare current performance against a saved baseline with configurable regression thresholds
- `adb_regression_history` — List all saved baselines with trends, optionally filtered by package

### Device Farm (3 tools)
- `adb_farm_run` — Run instrumented tests on Firebase Test Lab across multiple device models and API levels
- `adb_farm_results` — Retrieve results from a Test Lab run or list recent test matrices
- `adb_farm_matrix` — List available device models and Android versions on Firebase Test Lab

### Plugin Registry (3 tools)
- `adb_registry_search` — Search the community plugin registry, shows install status and available updates
- `adb_registry_install` — Download and install a plugin from the registry by name
- `adb_registry_installed` — List locally installed plugins with version and update availability

### Plugins (2 tools)
- `adb_plugin_list` — List all loaded plugins with paths and load times
- `adb_plugin_info` — Plugin system documentation and example plugin format

### Build (2 tools)
- `adb_gradle` — Run any Gradle task in a project directory
- `adb_build_and_install` — Build debug APK and install via ANDROID_SERIAL targeting

### AT Commands (4 tools)
- `adb_at_detect` — Auto-detect modem AT command device node by chipset family (Shannon, Qualcomm, MediaTek, Unisoc, generic). Probes known paths and returns the first responding node
- `adb_at_send` — Send a single AT command to the modem with response capture. Auto-detects port or accepts manual override. Dangerous command blocklist with force override
- `adb_at_batch` — Send multiple AT commands sequentially with per-command results. Configurable inter-command delay
- `adb_at_probe` — Run a standard diagnostic probe: modem ID, signal quality, network registration, SIM status, operator, functionality mode

### Screenshot Diffing (3 tools)
- `adb_screenshot_baseline` — Capture and save a named screenshot baseline with metadata (dimensions, SHA-256, timestamp)
- `adb_screenshot_diff` — Compare current screen against a saved baseline using pixel-level PNG decoding. Reports changed pixel count/percentage, bounding box of changed region, and supports a tolerance threshold for absorbing dynamic elements like clocks
- `adb_screenshot_history` — List all saved screenshot baselines with metadata

### Workflow Orchestration (3 tools)
- `adb_workflow_run` — Execute a JSON-defined workflow: sequential device operations with variable substitution, conditional steps, loops, and result capture. Actions: shell, root_shell, install, screenshot, logcat, getprop, sleep
- `adb_workflow_validate` — Validate workflow structure without executing. Shows execution plan
- `adb_workflow_list` — List saved workflow files in the workflows directory

### Split APK Management (4 tools)
- `adb_install_bundle` — Install split APKs (app bundles) via `install-multiple` with replace and downgrade options
- `adb_list_splits` — Show all APK split paths for a package with classification (base, config.density, config.language, etc.) and total size
- `adb_extract_apks` — Pull all splits for a package to a local directory for analysis or backup
- `adb_apex_list` — List installed APEX modules with version info

### Device Mirroring (3 tools)
- `adb_mirror_start` — Start live screen mirroring via scrcpy. Supports windowed and headless modes, recording, bitrate/FPS/resolution control, stay-awake, and screen-off
- `adb_mirror_stop` — Stop mirroring for a device or all devices
- `adb_mirror_status` — Check scrcpy availability and list active mirroring sessions

### Automated Test Generation (3 tools)
- `adb_test_gen_from_ui` — Analyze the current screen's interactive elements and generate a workflow that taps each one, screenshots, and checks for crashes
- `adb_test_gen_from_intents` — Analyze a package's registered activities and generate a workflow that launches each exported activity with crash detection
- `adb_test_gen_save` — Save a generated workflow JSON to the workflows directory for later execution

### OTA Update Monitoring (3 tools)
- `adb_ota_fingerprint` — Capture system fingerprint: build ID, Android version, security patch, bootloader, baseband firmware, kernel, A/B slot
- `adb_ota_check` — Compare current system state against a saved fingerprint to detect OTA updates. Identifies changed fields and recommends re-baselining
- `adb_ota_history` — List all saved fingerprints for a device with version progression over time

### RIL Message Interception (3 tools)
- `adb_ril_start` — Start capturing RIL messages from the radio logcat buffer. Categorizes registration, cell info, signal, network, security, handover, and NAS events
- `adb_ril_poll` — Retrieve captured RIL messages with optional category filtering. Shows category distribution
- `adb_ril_stop` — Stop a RIL capture session with category summary

### Device Profiles (3 tools)
- `adb_profile_detect` — Auto-detect and build a device profile: hardware ID, chipset family, modem nodes, root status, 5G support, dual SIM configuration. Matches against built-in library for known quirks
- `adb_profile_save` — Save a device profile to the profiles library
- `adb_profile_list` — List built-in and user-saved device profiles

### Modem Firmware Analysis (3 tools)
- `adb_firmware_probe` — Comprehensive firmware identification: parses baseband (Shannon/Qualcomm/MediaTek/Unisoc/HiSilicon/Intel), bootloader, and RIL implementation into structured components. Reports kernel, security patch, A/B slot, verified boot state, VBMeta, hypervisor, and OTA partition inventory
- `adb_firmware_diff` — Compare all firmware components (baseband, bootloader, kernel, security patch, build ID, Android version, RIL) between saved fingerprints or live device. Deep parsed diffs for baseband and bootloader when changes detected
- `adb_firmware_history` — Track firmware progression across all saved OTA fingerprints with multi-component change detection (baseband, bootloader, kernel, security patch, build ID, Android version) and parsed baseband diffs

### Workflow Marketplace (3 tools)
- `adb_market_search` — Search the workflow marketplace for community-shared workflow definitions with keyword and tag filtering. Shows install status
- `adb_market_install` — Download, validate (JSON structure + SHA-256 integrity), and install a marketplace workflow for immediate use with adb_workflow_run
- `adb_market_export` — Package a local workflow with marketplace metadata (author, version, tags, SHA-256) and generate a registry manifest entry for sharing

### SELinux & Permission Auditing (3 tools)
- `adb_selinux_status` — SELinux enforcement mode, policy version, shell context, recent AVC denial count. Root provides kernel dmesg denial stats
- `adb_selinux_denials` — List recent AVC denial messages with parsed source/target contexts, permission classes, and denied operations. Supports process filtering
- `adb_permission_audit` — Audit runtime permission grants for a package grouped by dangerous permission category (Camera, Location, Phone, SMS, etc.). Flags high-sensitivity grants

### Thermal & Power Profiling (3 tools)
- `adb_thermal_snapshot` — Capture all thermal zone temperatures, per-CPU frequencies/governors, cooling device states, battery temperature/current/voltage/power draw. Optional save as JSON baseline
- `adb_thermal_compare` — Compare current thermal state against a saved baseline with per-zone temperature deltas and battery current changes
- `adb_battery_drain` — Measure battery drain rate over a configurable duration (3-60s). Reports average mA, mW, estimated %/hour. Optional package-specific batterystats

### Network Discovery (3 tools)
- `adb_network_scan` — Scan the local network for ADB-enabled devices via ARP table and optional IP range sweep. Probes ports 5555-5558 with batched parallel TCP probes
- `adb_network_device_ip` — Get the WiFi IP of a connected device via multiple methods. Shows ADB TCP status and wireless connection instructions
- `adb_network_auto_connect` — One-step discover + connect: scans for ADB devices and automatically runs adb connect on each found listener

## MCP Resources (4)

Read-only device state surfaces accessible by MCP clients:

- `device://list` — List of all connected devices with state and model info
- `device://info/{serial}` — Device properties (model, OS, build, ABI)
- `device://battery/{serial}` — Parsed battery status (level, charging, temperature, voltage)
- `device://telephony/{serial}` — Telephony registry state for cellular analysis

## MCP Prompts (4)

Pre-built workflow templates for common multi-step debugging tasks:

- **`debug-crash`** — Clear logcat → restart app → wait for reproduction → capture crash buffer → analyze
- **`deploy-and-test`** — Build → install → clear logcat → start watcher → launch → screenshot → report
- **`telephony-snapshot`** — Capture telephony state, SIM/network operator, network type → summarize anomalies
- **`airplane-cycle-test`** — Start watcher → baseline telephony → cycle airplane mode → compare pre/post state

## Key Features

### Device Caching
Device discovery results are cached with a configurable TTL (default 5s), eliminating redundant `adb devices` subprocess calls during rapid tool sequences. Cache auto-invalidates on connection errors and after wireless connect/disconnect/pair operations.

### Transient Failure Retry
The ADB bridge automatically retries on transient failures (device offline, connection reset, protocol fault) with configurable retry count and exponential backoff. Diagnostic commands skip retries to surface real issues immediately.

### Output Protection
All ADB output passes through the OutputProcessor which normalizes line endings, enforces configurable character limits, and provides contextual truncation at logical boundaries (line breaks, section separators) rather than cutting mid-line. Includes structured parsers for battery, meminfo, and getprop output.

### Persistent Logcat Streaming
Background logcat watchers run as spawned processes with ring buffer accumulation. Each poll returns only new lines since the last read. Supports multiple concurrent sessions (up to 10) with independent filters. Process cleanup handlers prevent orphaned `adb logcat` processes on server exit.

### UI Hierarchy Analysis
Full view tree capture via `uiautomator dump` with parsed XML extraction. Returns structured element data including text, resource-id, content-description, class names, bounds coordinates with tap-ready center points, and interaction flags. Pre-compiled regex attribute extraction for efficient parsing.

### Security Middleware
Multi-layered security activated via `DA_SECURITY=true`. Provides command blocklist/allowlist filtering, rate limiting (commands per minute), and audit logging with automatic credential redaction. Security checks are integrated into `adb_shell`, `adb_root_shell`, `adb_multi_shell`, `adb_multi_compare`, `adb_input`, and `adb_start_activity`. Configurable via environment variables for different deployment scenarios.

### Input Sanitization
All tools that interpolate user-supplied parameters into shell command strings validate inputs against shell metacharacters before execution. Package names, property keys, service names, setting keys, test identifiers, network interface names, and tcpdump filters are all validated through a centralized `validateShellArg()` function that rejects `;`, `|`, `&`, `$`, backticks, parentheses, and other injection vectors. File paths use single-quoted shell escaping to prevent `$()` command substitution. The `adb_input` tool applies type-specific validation: `tap`/`swipe` accept only numeric coordinates, `keyevent` accepts only alphanumeric keycodes, and `text` is shell-escaped for literal delivery. Deserialized JSON from snapshot files is validated before shell interpolation. Every `z.number()` parameter across all 147 tools has explicit `.min()/.max()` Zod bounds to prevent resource exhaustion from extreme values. The LocalBridge has explicit handlers for every ADB subcommand used by tool modules, preventing unquoted fallthrough to the default shell handler. In on-device mode, privilege escalation uses a frozen 16-command allowlist and restricted-path regex — the elevation set is `ReadonlySet` + `Object.freeze`, not configurable at runtime. The HTTP/SSE transport denies cross-origin requests by default (configurable via `DA_HTTP_CORS_ORIGIN`), the plugin registry verifies SHA-256 integrity hashes and prevents path traversal via directory containment checks, and the workflow engine enforces step count (200), sleep duration (5 min), and repeat iteration (100) limits. Fetch helpers enforce a 5 MB response body limit. Getprop output parsing handles Windows `\r\n` line endings via `.trim()` before regex matching, and dual SIM slot counts are capped at 4 to prevent resource exhaustion from corrupted device properties.

### Multi-Device Orchestration
Run commands, install APKs, and compare outputs across multiple connected devices in parallel. Essential for comparative testing across Android versions and device models.

### Snapshot/Restore
Capture comprehensive device state snapshots (packages, settings across all namespaces, system properties) to JSON files. Compare current state against saved snapshots to detect drift. Restore settings from snapshots for reproducible test environments.

### Network Traffic Capture
On-device packet capture via tcpdump with pcap file pull for Wireshark analysis. Includes active connection listing via ss/netstat with /proc/net fallback for devices without those tools.

### CI/CD Integration
Purpose-built tools for automated pipelines: wait for device boot with polling, structured readiness checks, and instrumented test execution with parsed pass/fail results.

### Plugin Architecture
Dynamic tool module loading from a configurable plugins directory. Plugins are standard JavaScript ESM modules that export a `register(ctx)` function receiving the full ToolContext. Loaded at server startup, enabling community contributions without modifying core code.

### Community Plugin Registry
Search, install, and manage plugins from a configurable registry URL. Shows install status, version comparison, and available updates. Downloads plugin files with companion metadata into the plugins directory for loading on next restart. Security features include SHA-256 integrity verification (when provided by the registry manifest), path traversal protection, and `register()` export sanity checking.

### Baseband/Modem Integration
Deep cellular radio inspection tools for advanced Android development and research. Extracts modem firmware identification, cell identity parameters (CID, TAC, EARFCN, PCI), raw signal measurements (RSRP, RSRQ, SINR), neighboring cell surveys, carrier configuration, and multi-source modem logs (RIL radio buffer, telephony framework, kernel dmesg). Supports Shannon/Exynos, Qualcomm, MediaTek, and Unisoc chipset families via standard Android telephony APIs. Includes Google Tensor SoC detection (gs101/gs201/zuma/zumapro) for automatic Shannon modem path routing on Pixel 6–9 devices. Dual SIM detection reports per-slot SIM state, operator, network type, and country for DSDS, DSDA, and TSTS configurations.

### Accessibility Auditing
Automated WCAG accessibility checks on the live UI hierarchy. Detects missing labels on interactive elements, undersized touch targets below the 48dp guideline (density-aware), images without content-descriptions, clickable elements missing focusability, and duplicate content-descriptions. Generates structured reports with severity levels. Includes a dedicated accessibility tree view for screen reader debugging.

### Regression Detection
Capture performance baselines (memory, CPU, frame stats, battery, network state) and compare subsequent runs against them. Configurable regression thresholds for memory (+20%), CPU (+50%), and jank rate (+25%). Maintains a history of baselines for trend analysis across releases.

### Device Farm Integration
Cloud-based test execution via Firebase Test Lab through the gcloud CLI. Run instrumented tests across multiple device models and API levels, retrieve structured results, and list available test matrix configurations. Graceful fallback with setup instructions if gcloud is unavailable.

### HTTP/SSE Transport
Alternative to stdio for browser-based MCP clients. Set `DA_HTTP_PORT` to start an HTTP server with SSE streaming. Provides `/sse` (client subscription), `/message` (JSON-RPC), and `/health` endpoints. Cross-origin requests are denied by default — set `DA_HTTP_CORS_ORIGIN` to explicitly allow a specific origin.

### Test Session Management
Structured test workflows with numbered steps. Each step captures a screenshot and logcat snapshot into an organized directory with a Markdown manifest. Designed for reproducible test documentation.

### AT Command Interface
Direct AT command passthrough to the modem via root access, enabling raw interrogation beyond the Android telephony framework. Multi-chipset support auto-detects device nodes for Samsung Shannon/Exynos, Qualcomm Snapdragon, MediaTek, Unisoc/Spreadtrum, and generic USB modems. Input validation rejects shell metacharacters from both AT command strings and device node paths before root shell interpolation. A safety blocklist prevents accidental execution of dangerous commands (AT+CFUN=0, AT+EGMR, etc.) with an explicit force override.

### Screenshot Diffing
True pixel-level visual regression detection. Captures named screenshot baselines and compares the current screen state by decoding PNG pixel data (IHDR parsing, IDAT decompression, all 5 PNG filter types) and comparing actual RGB values. Reports changed pixel count and percentage, bounding box of the changed region with vertical screen position, and dimension/size deltas. Supports a `tolerancePercent` parameter (0–100) that absorbs minor dynamic changes like clock displays or notification badges — a 1% tolerance reliably absorbs nav bar clock changes (~0.5% of pixels) while catching any real UI regression. SHA-256 fast-path for exact matches. Zero external dependencies.

### Workflow Orchestration
Declarative JSON workflow engine for repeatable multi-step device operations. Supports variable substitution (`{{pkg}}`), conditional steps (`if` expressions with ==, !=, contains), loops (`repeat`, capped at 100 iterations), and result capture into variables for downstream steps. Actions map directly to ADB bridge operations with full security middleware enforcement. Workflow validation enforces a 200-step maximum and 5-minute sleep cap per step to prevent resource exhaustion from malicious or malformed workflow definitions.

### Split APK Management
Support for modern Android delivery formats. Install app bundles via `install-multiple`, inspect split APK structure (base + config splits for language, density, ABI), extract all splits locally for analysis, and list APEX modules.

### Device Mirroring
Live screen mirroring via scrcpy integration. Supports windowed mode for visual feedback and headless mode for recording-only workflows. Per-device session tracking enables simultaneous mirroring of multiple connected devices. Process cleanup handlers prevent orphaned scrcpy processes.

### Automated Test Generation
Analyzes live UI hierarchy and package intent registrations to auto-generate test workflow JSON compatible with the workflow orchestration engine. UI-based generation taps each interactive element, screenshots, and checks for crashes. Intent-based generation launches each exported activity with crash detection.

### OTA Update Monitoring
Tracks comprehensive system fingerprint (build ID, Android version, security patch, bootloader, baseband firmware, kernel version, A/B partition slot) across sessions. Compares current state against saved fingerprints to detect OTA updates. Identifies exactly which fields changed and recommends re-baselining performance metrics and screenshots after updates.

### RIL Message Interception
Persistent Radio Interface Layer message capture from the Android radio logcat buffer. Spawns a background process that accumulates and categorizes RIL messages into: registration, cell_info, signal, network, security, handover, data, radio_state, sms, and NAS events. Poll-based retrieval with category filtering. Useful for passive monitoring of baseband-framework communication for radio diagnostics and cellular network research. Session limit (5) and process cleanup handlers prevent resource exhaustion.

### Device Profile Library
Device-specific knowledge base containing hardware identification, chipset family, known modem device nodes, AT command compatibility, root requirements, dual SIM slot count, and quirks. Auto-detects profiles from connected devices and matches against a built-in library of known devices. Saved profiles persist across sessions and improve auto-detection accuracy for tools like `adb_at_detect`. Community-extensible through saved profile files.

### WebSocket Transport
Alternative to stdio and HTTP/SSE for MCP clients that benefit from true bidirectional streaming. Lower latency than SSE polling with better web framework compatibility. Requires the `ws` npm package as an optional peer dependency. Set `DA_WS_PORT` to enable.

### Modem Firmware Analysis
Comprehensive multi-component firmware identification, diffing, and history tracking. Parses baseband version strings for 6 chipset families: Shannon/Exynos (including Google Pixel/Tensor `g5123b-*` format and classic Samsung `S5123AP_CL*` format), Qualcomm MPSS branch/version/build, MediaTek MOLY branch/release/milestone, Unisoc/Spreadtrum SoC model/version, HiSilicon/Kirin model/carrier code, and Intel XMM model/branch. Also parses bootloader versions (Pixel codename/version/build, Samsung model/carrier/revision) and RIL implementation strings (Samsung S.LSI vendor/id/API/build date, Qualcomm, MediaTek). The firmware probe reports 8 sections: baseband, bootloader, RIL, kernel, security/build, partition/boot (A/B slot, secure boot, verified boot, flash lock), VBMeta integrity, and OTA partition inventory. The diff tool compares all firmware components between saved fingerprints or live device state, with deep parsed sub-diffs for baseband and bootloader. The history tool tracks multi-component firmware progression across OTA fingerprints.

### Workflow Marketplace
Community sharing layer for the workflow orchestration engine. Search a registry of community-contributed test workflows, diagnostic sequences, and audit procedures. Download and install workflows directly for immediate execution with `adb_workflow_run`. Export local workflows with marketplace metadata and auto-generated registry manifest entries for submission. SHA-256 integrity verification on download.

### GraphQL API
Optional HTTP endpoint serving a GraphQL API for composed device queries. Enables clients to fetch device info, battery, network, and arbitrary properties in a single request instead of multiple MCP tool calls. POST body size limited to 1 MB. Device properties are pre-fetched once per resolution to minimize subprocess calls. Requires the `graphql` npm package as an optional peer dependency. Set `DA_GRAPHQL_PORT` to enable.

### SELinux & Permission Auditing
Inspects SELinux enforcement mode, queries AVC denials from logcat and kernel audit logs, and audits runtime permission grants per package. Groups granted permissions by dangerous category (Camera, Location, Phone, SMS, etc.) and flags high-sensitivity grants like background location and manage-external-storage. Extends the security auditing surface to the OS permission layer.

### Thermal & Power Profiling
Captures thermal zone temperatures from sysfs, per-CPU frequency scaling states and governors, cooling device activity, and battery drain rates. Complements regression detection with thermal/power baselines for issues that manifest as heat or battery drain rather than frame drops. Includes timed drain measurement with mA/mW/estimated-%per-hour calculations.

### Network Device Discovery
Scans the local network for ADB-enabled devices via ARP table queries and optional IP range sweeps. Probes common ADB ports (5555-5558) with batched parallel TCP connection attempts. Extracts device WiFi IPs via multiple methods. Auto-connect mode discovers and connects to devices in one step. Streamlines wireless debugging workflows.

### QEMU/KVM Virtualization
On-device virtual machine management using QEMU with KVM hardware acceleration. Enables running guest Android VMs directly on the physical device — a capability unique to DeepADB. Dynamic resource allocation auto-detects host CPU cores and physical RAM, reserving 1 core and 35% of memory for the host OS to prevent starvation. Multi-VM support tracks resource consumption across concurrent VMs, refusing new VMs when the pool is exhausted rather than degrading host performance. Disk image management with qcow2 (sparse, snapshot-capable) and raw formats. ADB port forwarding to guest VMs enables DeepADB's full tool suite to target both host and guest devices simultaneously. Process lifecycle tracked via the centralized cleanup registry with SIGTERM/SIGKILL shutdown. Path containment verification on all image operations prevents directory traversal.

### ToolContext Architecture
All 41 tool modules receive a unified `ToolContext` dependency bundle containing server, bridge, deviceManager, logger, security, and config. Adding new cross-cutting dependencies requires no module signature changes.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DA_LOCAL` | Auto-detect | Force on-device mode (`true`/`false`). Auto-detects via `/system/build.prop` |
| `ADB_PATH` | Auto-detect | Path to ADB binary (ignored in on-device mode) |
| `DA_TIMEOUT` | `30000` | Default command timeout in milliseconds |
| `DA_MAX_OUTPUT` | `50000` | Max output characters before truncation |
| `DA_MAX_LOGCAT` | `500` | Max logcat lines per snapshot |
| `DA_DEVICE` | (auto) | Default device serial (auto-selects if single device) |
| `DA_TEMP_DIR` | OS temp | Temp directory for screenshots, pulled files, bug reports, test sessions, snapshots |
| `DA_CACHE_TTL` | `5000` | Device list cache TTL in milliseconds (0 = disabled) |
| `DA_RETRY_COUNT` | `1` | Number of retries for transient ADB failures |
| `DA_RETRY_DELAY` | `500` | Base retry delay in ms (doubles each attempt) |
| `DA_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `DA_SECURITY` | `false` | Enable security middleware (command filtering, rate limiting) |
| `DA_BLOCKED_COMMANDS` | (none) | Comma-separated list of blocked shell command substrings |
| `DA_ALLOWED_COMMANDS` | (none) | Comma-separated allowlist (if set, only matching commands run) |
| `DA_RATE_LIMIT` | `0` | Max commands per minute (0 = unlimited) |
| `DA_AUDIT_LOG` | `true` | Log all executed commands for audit trail (set to `false` to disable) |
| `DA_PLUGIN_DIR` | `{tempDir}/plugins` | Directory to scan for plugin .js modules at startup |
| `DA_REGISTRY_URL` | GitHub default | URL of the community plugin registry JSON manifest |
| `DA_HTTP_PORT` | (disabled) | Set to a port number to enable HTTP/SSE transport mode |
| `DA_HTTP_HOST` | `127.0.0.1` | Bind address for HTTP/SSE, WebSocket, and GraphQL servers |
| `DA_HTTP_CORS_ORIGIN` | (none — deny) | Allowed CORS origin for HTTP/SSE |
| `DA_WS_PORT` | (disabled) | Set to a port number to enable WebSocket transport mode (requires `npm install ws`) |
| `DA_WS_CORS_ORIGIN` | (none — deny) | Allowed CORS origin for WebSocket health endpoint |
| `DA_GRAPHQL_PORT` | (disabled) | Set to a port number to enable the GraphQL API endpoint (requires `npm install graphql`) |
| `DA_GRAPHQL_CORS_ORIGIN` | (none — deny) | Allowed CORS origin for GraphQL API |
| `DA_WORKFLOW_REGISTRY_URL` | (derived from DA_REGISTRY_URL) | URL of the workflow marketplace JSON manifest |

## Project Structure

```
DeepADB/
├── src/
│   ├── index.ts                # Entry point — stdio, HTTP/SSE, WebSocket, or GraphQL transport
│   ├── server.ts               # MCP server wiring, config, module registration (exports CreateServerResult)
│   ├── http-transport.ts       # HTTP/SSE transport server for browser clients
│   ├── ws-transport.ts         # WebSocket transport (optional `ws` peer dependency)
│   ├── graphql-api.ts          # GraphQL API endpoint (optional `graphql` peer dependency)
│   ├── tool-context.ts         # Unified dependency bundle (ToolContext interface)
│   ├── bridge/
│   │   ├── adb-bridge.ts       # Core ADB subprocess wrapper, retry logic, error types
│   │   ├── local-bridge.ts     # On-device direct execution bridge with privilege escalation (Termux/local mode)
│   │   └── device-manager.ts   # Device discovery, TTL cache, serial routing
│   ├── tools/
│   │   ├── health.ts           # Toolchain health check (1 tool)
│   │   ├── device.ts           # Device info and properties (3 tools)
│   │   ├── shell.ts            # Shell and root command execution (2 tools)
│   │   ├── packages.ts         # App lifecycle, install, permissions, intents (10 tools)
│   │   ├── files.ts            # Push, pull, ls, cat (4 tools)
│   │   ├── logs.ts             # Logcat snapshots — filtered (3 tools)
│   │   ├── logcat-watch.ts     # Persistent logcat with ring buffer and poll (4 tools)
│   │   ├── diagnostics.ts      # dumpsys, telephony, battery, network, perf, bugreport (7 tools)
│   │   ├── ui.ts               # Screenshots, input, activity, UI hierarchy (6 tools)
│   │   ├── screen-record.ts    # Screen video recording start/stop (2 tools)
│   │   ├── control.ts          # Airplane, WiFi, data, location, screen, settings, reboot (9 tools)
│   │   ├── wireless.ts         # WiFi pairing, connect, disconnect, TCP/IP (4 tools)
│   │   ├── forwarding.ts       # Port forwarding and reverse forwarding (3 tools)
│   │   ├── emulator.ts         # AVD list, start, stop with on-device KVM/QEMU detection (3 tools)
│   │   ├── qemu.ts             # QEMU/KVM VM management — setup, images, start, stop, status (5 tools)
│   │   ├── testing.ts          # Structured test sessions with numbered steps (3 tools)
│   │   ├── multi-device.ts     # Multi-device shell, install, compare (3 tools)
│   │   ├── snapshot.ts         # Device state capture, compare, restore (3 tools)
│   │   ├── network-capture.ts  # tcpdump start/stop, network connections (3 tools)
│   │   ├── ci.ts               # CI wait-boot, device-ready, run-tests (3 tools)
│   │   ├── plugins.ts          # Plugin loader and plugin info tools (2 tools)
│   │   ├── baseband.ts         # Modem/baseband inspection and radio diagnostics (6 tools)
│   │   ├── accessibility.ts    # Automated WCAG accessibility auditing (3 tools)
│   │   ├── regression.ts       # Performance baseline and regression detection (3 tools)
│   │   ├── device-farm.ts      # Firebase Test Lab integration via gcloud (3 tools)
│   │   ├── registry.ts         # Community plugin registry search/install (3 tools)
│   │   ├── at-commands.ts      # AT command modem interface, multi-chipset (4 tools)
│   │   ├── screenshot-diff.ts  # Visual regression — screenshot baseline/diff (3 tools)
│   │   ├── workflow.ts         # Declarative workflow orchestration engine (3 tools)
│   │   ├── split-apk.ts        # App bundles, split APKs, APEX modules (4 tools)
│   │   ├── mirroring.ts        # Live screen mirroring via scrcpy (3 tools)
│   │   ├── test-gen.ts         # Automated test workflow generation (3 tools)
│   │   ├── ota-monitor.ts      # OTA update monitoring and fingerprinting (3 tools)
│   │   ├── ril-intercept.ts    # RIL message interception from radio buffer (3 tools)
│   │   ├── device-profiles.ts  # Device profile library with built-in entries (3 tools)
│   │   ├── firmware-analysis.ts # Modem firmware version parsing and diffing (3 tools)
│   │   ├── workflow-market.ts  # Workflow marketplace — search, install, export (3 tools)
│   │   ├── selinux-audit.ts    # SELinux status, AVC denials, permission auditing (3 tools)
│   │   ├── thermal-power.ts    # Thermal zones, CPU frequency, battery drain (3 tools)
│   │   ├── network-discovery.ts # ADB-over-network scanning and auto-connect (3 tools)
│   │   ├── build.ts            # Gradle build and install (2 tools)
│   │   ├── resources.ts        # MCP Resources — device state surfaces (4 resources)
│   │   └── prompts.ts          # MCP Prompts — workflow templates (4 prompts)
│   ├── middleware/
│   │   ├── output-processor.ts # Contextual truncation, structured parsers, settledValue helper
│   │   ├── security.ts         # Command filtering, rate limiting, audit logging with redaction
│   │   ├── sanitize.ts         # Shell injection prevention — validateShellArg/validateShellArgs/shellEscape
│   │   ├── chipset.ts          # Shared chipset family detection, modem path mapping, SIM config detection
│   │   ├── fetch-utils.ts      # Shared HTTP helpers with 5 MB streaming response size limit
│   │   ├── ui-dump.ts          # Shared uiautomator XML capture with concurrent-safe paths, on-device /data/local/tmp routing, and cleanup
│   │   ├── cleanup.ts          # Centralized process cleanup registry for SIGINT/SIGTERM/exit
│   │   └── logger.ts           # stderr-safe logging (MCP-compliant)
│   └── config/
│       └── config.ts           # Configuration, env vars, startup validation
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
├── tests/
│   ├── run-all.mjs              # Run all test suites sequentially with summary (tracks skipped counts)
│   ├── test-hw.mjs              # Hardware core: health, identity, baseband, thermal, profiles (26 tests)
│   ├── test-shell-files.mjs     # Shell, filesystem, packages, diagnostics (24 tests)
│   ├── test-ui-control.mjs      # UI hierarchy, screenshots, settings, accessibility (15 tests)
│   ├── test-monitoring.mjs      # Logcat watchers, snapshots, OTA, regression, workflows (25 tests)
│   ├── test-security.mjs        # Input sanitization, shell injection, AT command safety (25 tests)
│   ├── test-lifecycle.mjs       # App lifecycle, file push/pull, input, port forwarding, screen recording, test sessions (22 tests)
│   ├── test-analysis.mjs        # Thermal/snapshot/regression comparison, firmware diff, screenshot diff, test gen, RIL intercept (18 tests)
│   ├── test-boundaries.mjs      # Zod bounds enforcement, input injection, error paths, sensitive data protection (28 tests)
│   ├── test-qemu.mjs            # QEMU/KVM setup, image management, VM status (10 on-device tests)
│   ├── test-qemu-boot.mjs       # QEMU Alpine VM boot, KVM acceleration, topology detection (10 on-device tests)
│   └── lib/
│       └── harness.mjs          # Shared test harness (stdio JSON-RPC transport, 6 assertion types)
└── docs/
    └── future-roadmap.md       # Feature history and future ideas
```

## Tech Stack

- **Runtime**: Node.js ≥22 (ES2024, ESM)
- **Language**: TypeScript 5.9 (strict mode, NodeNext module resolution)
- **MCP SDK**: `@modelcontextprotocol/sdk` ^1.24.0 (v1.x — v2 pre-alpha expected Q1 2026)
- **Validation**: Zod ^3.25.0
- **Transport**: stdio (JSON-RPC), HTTP/SSE, WebSocket (optional `ws`), GraphQL API (optional `graphql`)

## License

MIT
