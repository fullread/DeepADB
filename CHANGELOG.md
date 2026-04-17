# Changelog

All notable changes to DeepADB are documented in this file.

## v1.1.1 — Hardware Sensor Access

### New Tools (18 new tools, 1 new module — 198 tools across 44 modules)

**`adb_sensor_read`** — Read hardware sensor values from the device. Enumerates all available sensors from `dumpsys sensorservice` and returns their last-known readings with timestamps. Parses the full "Sensor List:" section for sensor inventory (name, vendor, type, mode, rate range, wake capability) and the "Recent Sensor events:" section for last-known values. Sensor availability is device-dependent — the tool reports what's present rather than assuming a fixed set. A Pixel 6a exposes 44 sensors (36 hardware + 8 AOSP virtual). Supports `category` filter (accelerometer, gyroscope, magnetometer, light, barometer, proximity, gravity, linear_accel, rotation, orientation, motion, step, temperature) and `listOnly` mode for fast discovery without reading values. Axis-labeled formatting for 3-axis sensors (accelerometer: `x=... y=... z=... m/s²`). Type map covers 21 standard Android sensor types with appropriate units. No root required.

**`adb_iio_read`** — Read raw hardware data from the Linux IIO (Industrial I/O) subsystem. Auto-discovers all IIO devices under `/sys/bus/iio/devices/` and classifies them by kernel driver name. On Tensor/Exynos devices, this exposes per-rail ODPM (On-Device Power Monitor) data from the S2MPG PMICs — real-time power consumption per SoC subsystem (CPU big/mid/little clusters, GPU, TPU, display, DDR, UFS, GPS, AOC, etc.) sorted by consumption with percentage breakdown. On other devices, may expose raw accelerometer, gyroscope, magnetometer, pressure, ADC, or temperature channels with automatic `raw * scale + offset` calibration. Supports `listOnly` mode for discovery. Root required (SELinux blocks sysfs access for non-root). Hardware-verified on Pixel 6a: 2 PMICs (s2mpg10 + s2mpg11), 16 monitored power rails, 125 Hz sampling, physically plausible readings (~5W under CPU load, ~0.4W sub-PMIC idle).

Both tools added to new `sensors.ts` module.

### File Tools Expansion (14 new tools in existing files.ts — 4 → 18 tools)

Expanded `files.ts` from 4 basic tools (push, pull, ls, cat) to 18 comprehensive file operations. Every new tool closes a specific security gap where MCP agents would otherwise fall back to `adb_shell`, bypassing the sanitization infrastructure.

**Safety model — consistent across all modifying tools:**
- Hard-blocked paths: `/`, `/dev`, `/proc`, `/sys` — kernel virtual filesystems
- Depth-based recursive protection: recursive delete/chmod/chown refuse at depth ≤ 2 from root
- Symlink resolution: `realpath` resolved BEFORE depth checks to prevent traversal bypass
- Filesystem-aware warnings: erofs/squashfs (read-only), sdcardfs/FUSE (ignores chmod), vfat/FAT32 (no perms, 4GB, 2s timestamps), tmpfs (volatile)
- Explicit root opt-in: `root=false` default, no auto-elevation
- Execution time and storage metrics on every operation

**Hardened existing tools:**
- `adb_push` — added hard-block, fs-type detection, symlink resolution, storage reporting, metrics
- `adb_pull`, `adb_ls`, `adb_cat` — added execution time metrics

**New tools (14):**
- `adb_file_write` — heredoc content delivery, buffer limit warning, append mode, post-verify
- `adb_find` — file search with maxResults/maxDepth caps, truncation detection
- `adb_file_stat` — metadata with SELinux context
- `adb_file_checksum` — SHA-256/SHA-1/MD5, size-based timeout estimation
- `adb_mkdir` — directory creation with hard-block and read-only detection
- `adb_rm` — depth-based recursive protection, symlink resolution, pre-flight count
- `adb_file_move` — source depth protection, post-verify
- `adb_file_copy` — pre-flight size+space check, post-verify size match
- `adb_file_chmod` — Zod-validated octal mode, depth-based recursive protection
- `adb_file_touch` — create/update/explicit timestamp with format validation
- `adb_file_fsinfo` — comprehensive filesystem report (type, mount, capacity, capabilities, SELinux)
- `adb_file_chown` — root required, depth-based recursive protection, Zod-validated owner format
- `adb_grep` — fixed-string default, recursive with depth control, result capping
- `adb_file_replace` — sed-backed find/replace with proper escaping, backup option, match counting

**Bugs found and fixed during implementation:**
- `stat -f -c '%T'` returns hex magic numbers on Android (e.g., `0x65735546`) instead of readable names — added `FS_MAGIC_MAP` lookup table for 8 common Android filesystems
- `df` on a deleted file fails — `getStorageInfo()` now falls back to parent directory
- grep flag construction: `.join("")` produced `-F-i-n` — fixed to `.join(" ")`

### Port Forward Cleanup (2 new tools in existing forwarding.ts — 3 → 5 tools)

- `adb_forward_remove` — remove a specific port forward or all forwards (`--remove` / `--remove-all`)
- `adb_reverse_remove` — remove a specific reverse forward or all reverse forwards
- Closes cleanup gap: test suites now properly clean up port forwards created during testing

### Bug Fixes

- Fixed event block boundary calculation in sensor value parser — the `-50` character offset was overshooting into preceding event data when sensor headers were close together, truncating multi-axis values (e.g., accelerometer showing 2 values instead of 3). Replaced with precise `headerStart` tracking.
- Fixed wake-up flag detection — `nextLine.includes("wakeUp")` matched both `wakeUp` and `non-wakeUp`, incorrectly tagging all sensors as wake-up. Fixed with word-boundary regex and explicit `non-wakeUp` exclusion.
- Fixed rate range display in `listOnly` mode — one-shot and special-trigger sensors showed ugly `—–—` double-dash, on-change sensors showed trailing `–—`. Now displays clean mode-only for sensors without rates, `up to X Hz` for max-only, and `X Hz` for min-only.
- Fixed ODPM power unit conversion — `in_powerN_scale` was being applied to `lpf_power` values that are already calibrated in μW by the ODPM driver, producing physically impossible readings (~51W total). Fixed: divide by 1000 for μW→mW without additional scale.

### Security

- Fixed printf format string injection in AT command passthrough (`at-commands.ts`). The AT command string was placed directly in `printf`'s format position (`printf '${cmd}\r'`), causing `%` characters in legitimate AT commands (e.g., `AT%RESTART`) to be misinterpreted as format specifiers. Fixed by separating format from data: `printf '%s\r' '${cmd}'`.
- Fixed sed shell injection in `adb_file_replace` (`files.ts`). `sedEscapePattern()` and `sedEscapeReplacement()` handled regex metacharacters but not single quotes, so a `find` or `replace` value containing `'` would close the surrounding shell single-quote and execute arbitrary commands (e.g., `find = "';rm -rf /sdcard/evil;echo '"`). Fixed by appending `'\''` closing/reopening logic to both escapers. Additionally, Zod `.refine()` now rejects newlines in `find` and `replace`, since sed treats embedded newlines as script-command separators. Regression test added with a canary-file pattern that proves the injection payload no longer executes.

### Code Quality

- **sensors.ts**: O(n) line offset index with binary search replaces O(n²) `substring+split` per sensor entry; self-describing key=value IIO reads (immune to `cat` alignment fragility); file reorganized into clean domain groups (HAL types/parsers/helpers → IIO types/parsers/helpers → tool registration); defense-in-depth validation on IIO device dirs (`^iio:device\d+$`) and sysfs attributes (`^[a-zA-Z0-9_]+$`).
- **at-commands.ts**: Extracted `autoDetectAtPort()` shared helper, replacing 4 copies of the 15-line modem probe pattern across `adb_at_send`, `adb_at_batch`, `adb_at_probe`, and `adb_at_cross_validate`. `adb_at_detect` retains its own implementation (reports all nodes, not just the first).

### Documentation

- README architecture diagram: updated module count from 43 to 44, added `sensors`, `input-gestures`, `wireless-firmware` to module name list
- README Available Tools: updated section header from 180 to 182, added `### Hardware Sensor Access (2 tools)` section with `adb_sensor_read` and `adb_iio_read` descriptions
- README project structure tree: added missing `input-gestures.ts` (18 tools), fixed `plugins.ts` description, fixed ASCII tree syntax (`└──` followed by `├──`)
- Tool count verified as 198 via comment/string-aware grep across all 44 modules (naive grep returns 200 due to 2 false positives in `plugins.ts` template literal examples)

### Housekeeping

- Added `.mcpregistry_*` credential files to `.gitignore`

### Test Suite

Validated on hardware (Pixel 6a, Android 16, Termux + Magisk + QEMU 10.2.1) across a four-cell matrix — 0 failures:

- **ADB mode, no PIN:** 383 passed / 10 skipped (393 total)
- **ADB mode, with PIN:** 387 passed / 6 skipped (393 total)
- **On-device mode, no PIN:** 419 passed / 4 skipped (423 total)
- **On-device mode, with PIN:** 420 passed / 3 skipped (423 total)

On-device delta (+30 tests) reflects the 5 QEMU tests, 1 shell round-trip, and 9 on-device-specific code paths in test-boundaries that are skipped on the host.

- New `test-sensors.mjs` suite (30 tests): sensor discovery (list, categories, total), full value read with calibrated data verification, category filters with device-specific sensor name assertions (11 categories), list-only with filter, accelerometer z-axis regression test, rate display formatting (one-shot clean output, continuous range), wake-up flag correctness (non-wake exclusion + wake inclusion), IIO device discovery (list, ODPM detection), and IIO power monitor output verification (power data, sampling rate, channels, totals, CPU subsystem, unit formatting)
- New `test-files-extended.mjs` suite (95 tests): push safety (hard-blocked /dev, /proc, /sys, /), existing tool metrics (ls, cat execution time), file write (create, append, verify, storage, refusals), find (locate, timing, maxResults, no results), stat (size, permissions, SELinux, nonexistent), checksum (SHA-256, MD5, size, nonexistent), mkdir (nested, timing, refusals), rm depth protection (8 tests: depth 1/2/4 boundaries, symlink resolution, /dev refusal), move (verify, depth protection, refusals), copy (size verification, storage), chmod (permissions, recursive depth, Zod validation), touch (create/update/explicit timestamp, format validation), fsinfo (type, capacity, capabilities, mount), chown (ownership, recursive depth, Zod validation), grep (case sensitivity, line numbers, recursive, no match), file replace (match count, content verification, backup, no match, refusal), **sed injection regression (canary-file pattern proving single-quote payload is neutralized, newline rejection in find/replace)**, end-to-end lifecycle (write → stat → checksum → copy → hash compare → rm), cleanup verification

### Post-Audit Additions

Work completed after the initial v1.1.1 scope landed, during a multi-pass security and test-quality audit:

**Additional security fixes (Passes 2–4):**
- **Shell injection in `adb_qemu_start` kernel `append` parameter** (`qemu.ts`, KVM path only). The `escapeQemuShellArg()` heuristic only quoted arguments containing `=`, `/`, `,`, or `:`, so payloads like `append: "; reboot"` slipped through unquoted into `su -c "..."` and executed. Fixed by extracting `escapeQemuShellArg()` as a module-level export and unconditionally wrapping every QEMU argv element in single quotes with `'\''` closing/reopening to neutralize embedded quotes. The non-KVM path was already safe since it uses `spawn(cmd, args)` with an argv array. 11 unit assertions plus 6 Unix shell round-trip tests verify the quoting property end-to-end.
- **Discarded validator return in `adb_heap_dump`** (`diagnostics.ts`). `validateShellArg(target, "target")` was called but its error result was never checked — subsequent `shellEscape()` made exploitation impractical, but the intent was to reject shell metacharacters. Fixed by capturing and returning the error properly. 4 injection-rejection tests added.
- 61 other interpolation sites verified safe across the codebase: 22 `shellEscape`-wrapped, 21 `validateShellArg`-gated, 8 numeric Zod bounds, 4 hardcoded values, 3 Zod enums, 3 free-form gated by `ctx.security.checkCommand()`.

**Test harness correctness fixes** (`tests/lib/harness.mjs`):
- `testContains` and `testNotContains` now throw on empty expected/forbidden string. Previously these were always-pass no-ops (`String.includes("")` is always true) and silently masked 7 misused assertions across the suite. Every misuse was converted to a meaningful check.
- `testRejects` no longer counts thrown exceptions as successful rejections. Previously, a tool crash or timeout would be silently tagged "correctly rejected" — now crashes/timeouts are correctly marked failures.
- `getText(response)` returns an empty string on RPC error instead of fabricating a `"[RPC ERROR] ..."` wrapper string. The fabricated text could leak into `testContains` assertions — a test checking for "error" substring would falsely match the wrapper. Callers use `isError()` to distinguish success from RPC failure.
- Server startup "Ready" substring match tightened. Previously matched the bare word "Ready" anywhere in stderr — a log line like "Preparing to be Ready..." would fire prematurely. Now matches specific phrases: `"Ready for connections"` (from `index.ts` post-initialization log) or `"tool modules, 4 resources"` (from `server.ts` init-complete log).
- Added `h.assert()` and `h.assertEq()` primitives for unit-style tests that feed into the suite's pass/fail counter.

**Test coverage additions:**
- Wireless ADB: 5 tests in `test-boundaries` (Zod port bounds, malformed-host graceful handling, idempotent disconnect, unreachable-pair rejection)
- Multi-device: 5 tests in `test-boundaries` (single-device shell with whoami, <2-device rejection for compare, firmware profile, listing profiles, custom commands)
- `adb_at_probe`: tolerant unit test accepting either success or clean rejection
- `adb_profile_save`: corrected schema (`{ name, profile }`) + invalid-JSON rejection
- `adb_tcpdump_stop`: no-active-capture rejection path
- `adb_network_auto_connect`: empty-range graceful handling with correct `ipRange` field

**Assertion quality (tightened loose substrings):**
- `test-shell-files`: `"sh"` → `"toybox"` (unambiguous Android system binary)
- `test-hw`: `"==="` (section-header prefix) → `"ANR Traces"` (actual crash_logs section header)
- `test-sensors`: `"W"` (matched any word with W) → `"mW"` (actual power unit emitted by sensors.ts)

**On-device mode-awareness** — LocalBridge legitimately stubs wireless ADB (`connect`, `disconnect`, `pair`, `tcpip`) and port forwarding (`forward`, `reverse`) since there is no ADB server to route through. Four test-boundaries/test-lifecycle assertions were originally written against ADB-mode semantics and would fail cleanly in on-device mode. Made mode-aware via `existsSync("/data/data/com.termux")`:
- `Connect to malformed host surfaces error` — ADB mode asserts the bad host appears in stdout; on-device asserts the stub's "not applicable" message appears.
- `Pair with unreachable host` — ADB mode uses `testRejects` with 45s timeout (adb pair blocks ~30s on unreachable hosts); on-device asserts the stub's "not applicable" message.
- `multi_shell on single device (whoami)` — ADB mode gets "shell" (uid=2000); on-device gets "root" or the Termux user depending on elevation path. Replaced with tool-executed-and-produced-output check.
- `Forward list (shows entries)` — ADB mode asserts the created forward appears; on-device skips since the forward creation is itself a stub.

**Alpine VM auto-fetch for `test-qemu-boot.mjs`:**
Previously required a pre-built Alpine image at a hardcoded path, so the boot test would fail on any fresh on-device install. Added setup phase between pre-flight and boot that:
- Computes `imageDir` from `process.env.HOME` to match the runtime `ctx.config.tempDir` resolution (avoiding a hardcoded path that mismatches when HOME is overridden by a test wrapper)
- Probes for cached `vmlinuz-virt`, `initramfs-virt`, and `alpine-test.qcow2`; skips downloads on repeat runs
- Fetches kernel (~10 MB) and initrd (~9 MB) from `https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/netboot/` via `curl --fail --location --silent --retry 2 --max-time 120`
- Atomic writes (`.tmp` → `mv`) prevent partial downloads from poisoning the cache
- Size sanity check (>1 MB per file) catches truncation or error-page situations
- Creates a 64 MB placeholder qcow2 via `qemu-img create` (required by `adb_qemu_start`'s image argument; VM actually boots from kernel+initrd)
- On any failure (no curl, no network, size check fail), all downstream boot tests skip with explicit reasons rather than crashing

No checksum verification — Alpine doesn't publish per-file sha256 for the netboot directory (only for the 425 MB full-release tarball). HTTPS + TLS chain to `dl-cdn.alpinelinux.org` is the integrity mechanism. Trade-off documented in the test file header.

## v1.1.0 — MCP Registry Integration

### MCP Registry Support
- Added `server.json` metadata file for the official MCP Registry (`registry.modelcontextprotocol.io`)
- Added `mcpName` field (`io.github.fullread/deepadb`) to `package.json` for npm package validation
- Server namespace: `io.github.fullread/deepadb` — authenticated via GitHub ownership
- Registry metadata points to the npm package for distribution, with stdio transport

### Housekeeping
- Updated `.gitignore` to exclude `mcp-publisher.exe` binary

## v1.0.9 — Input Completeness, UI Efficiency, Screen Control & Permission Management

### New Tools (6 new tools — 180 tools across 43 modules)

**`adb_input_fling`** — High-velocity fling gesture for triggering scroll momentum on lists, launchers, and paged views. Distinct from swipe by duration: 20–200ms (default 50ms) creates the velocity needed for momentum scrolling. Also available as a `fling` action type in `adb_batch_actions`. Added to `input-gestures.ts`.

**`adb_revoke_permission`** — Revoke a runtime permission from a package via `pm revoke`. Counterpart to the existing `adb_grant_permission`. Useful for resetting permission state to test first-run flows and denial handling. Input validated via `validateShellArgs` on both `packageName` and `permission`. Added to `packages.ts`.

**`adb_list_permissions`** — List all declared and granted permissions for a package. Parses `dumpsys package` install-time and runtime permission blocks with current grant state. Filterable by `all` / `granted` / `denied`. Reports granted count vs total and permission type (install/runtime) with ✓/✗ indicators. Added to `packages.ts`.

**`adb_screencap_annotated`** — Screenshot with UI element bounding boxes and numbered labels composited directly onto the PNG using a zero-dependency pure-TypeScript PNG pipeline (decode → draw → encode). Accepts `clickableOnly` (default true). Returns annotated PNG path plus a text legend. Color palette cycles through 8 distinguishable colors with auto-contrasted white/black digit labels. Added to `ui.ts`.

**`adb_screen_state`** — Combined screen state in one call: foreground activity, screen dimensions and density, orientation, battery level/status/temp, and a TSV node list of interactive elements. Replaces the common `adb_current_activity` + `adb_screen_size` + `adb_device_state` + `adb_ui_dump` sequence with a single round-trip. Uses `Promise.allSettled` for resilience. Added to `ui.ts`.

**`adb_input_pinch`** — Multi-touch pinch (zoom out) or spread (zoom in) gesture with layered injection architecture. Two fingers move symmetrically around a configurable center point with adjustable start/end radius, duration, axis angle, and interpolation steps. Primary method: parallel `input swipe` with shell backgrounding (universal, no root required). Advanced method: atomic binary writes of raw Linux Multi-Touch Type B protocol events (`ABS_MT_SLOT`, `ABS_MT_TRACKING_ID`, `ABS_MT_POSITION_X/Y`, `SYN_REPORT`) to the touchscreen device node via `xxd -r -p` (root required). Each frame's events are written as a single binary blob to ensure Android's `MultiTouchInputMapper` receives all slot updates atomically — individual `sendevent` calls are too slow (~5-10ms per fork) and cause the InputReader to miss the gesture. Auto-detection probes `getevent -p` to discover the touchscreen device node, coordinate ranges, slot count, and pressure range — cached for the session. `method` parameter: `auto` (default — uses sendevent when root available), `swipe` (force parallel swipes), `sendevent` (force raw MT). Also available as a `pinch` action type in `adb_batch_actions` (uses swipe method). Hardware-verified on Pixel 6a FTS touchscreen (1080×2400, 10-slot MT Type B) — both pinch/zoom-out and spread/zoom-in produce visible map zoom in Google Maps. Added to `input-gestures.ts`.

### Enhancements to Existing Tools

**`adb_screen`** — Added `lock` action, improved `unlock`, and added `pin` parameter for full credential-based unlock.

Lock: checks `mWakefulness` via `dumpsys power`. If already off, still checks keyguard state via `dumpsys window` and returns `"Screen: already locked (keyguard active)"`. If awake, sends `KEYCODE_SLEEP`, waits 1.5s for the sleep token to appear, then returns `"Screen: locked (keyguard active)"` or `"Screen: sleep sent"` depending on verified state.

Unlock: sends `KEYCODE_WAKEUP` then `wm dismiss-keyguard`. Reports honestly — `"Screen: unlocked (keyguard dismissed)"` or `"Screen: awake — keyguard still active (PIN/pattern/biometric required)"`. If `pin` is supplied and the keyguard survives dismiss, performs the full credential entry sequence: derives proportional swipe coordinates from `wm size`, swipes up to reveal the PIN keypad, types the PIN via `input text`, confirms with `KEYCODE_ENTER`, then re-checks keyguard state and returns `"Screen: unlocked (PIN accepted, keyguard dismissed)"` or `"Screen: PIN entered — keyguard still active (wrong PIN or biometric required)"`.

Key finding from live hardware research: `mWakefulness=Awake` and `mResumedActivity` are both unreliable keyguard indicators — the keyguard is a window overlay above the activity stack and the launcher can show as resumed while the keyguard is blocking everything. `dumpsys window | grep keyguard` (sleep token presence) is the correct signal for all lock/unlock state decisions. (`control.ts`)

**`adb_ui_dump`** — Added `format` parameter: `text` (default), `tsv` (compact tab-separated: `index\ttext\tresource_id\tcontent_desc\tcenter_x\tcenter_y\tclickable\tscrollable` — order-of-magnitude token reduction for automation loops), `xml` (raw uiautomator XML). Tabs in text/content_desc fields are escaped to spaces to preserve TSV structure. (`ui.ts`)

**`adb_batch_actions`** — Added `fling` as a supported action type. Args: `x1 y1 x2 y2 [durationMs]` — same as swipe but defaults to 50ms duration. Numeric-only validation, goes through existing security middleware. (`input-gestures.ts`)

### New Infrastructure

**`src/middleware/png-utils.ts`** — New shared middleware module providing zero-dependency PNG utilities:
- `decodePngPixels()` — moved and exported from `screenshot-diff.ts`; handles RGBA (colorType 6) and RGB (colorType 2), all 5 PNG filter types
- `encodePng()` — filter-0 (None) scanlines + level-1 deflate; CRC32 chunk integrity
- `drawRect()` — inward-thickness rectangle border on a pixel buffer
- `drawLabel()` — filled number label with 5×7 pixel font and ITU-R BT.601 auto-contrasted foreground
- `ELEMENT_COLORS` — 8-color cycling palette

**`src/tools/screenshot-diff.ts`** — Refactored to import `decodePngPixels` from `png-utils.ts`. Removed private copy and local `inflateSync` import. Zero behavioral change.

### Test Suite (235 ADB-mode / 257 on-device tests)
- `test-analysis.mjs`: Permission Management section — grant, list (all), list (granted filter), revoke, re-grant cleanup (5 tests)
- `test-ui-control.mjs`: Screen lock/wake/unlock cycle, unlock-without-PIN advisory path, UI Dump TSV/XML formats, annotated screenshot, fling gesture, fling batch action type, screen state, multi-touch pinch/spread/auto/horizontal-angle, batch pinch type, pre-flight keyguard guard for recovery from prior failed runs (14 new tests, 5 conditional on `DA_TEST_PIN` for the lock/unlock cycle)
- `test-boundaries.mjs`: Pinch Zod boundary validation — startRadius below min, durationMs above max, steps above max (3 new tests)
- Lock/wake/unlock tests skip cleanly when `DA_TEST_PIN` is not set. With PIN supplied, `adb_screen { action: "unlock", pin }` handles the full sequence internally — the test simply calls the tool and asserts `"PIN accepted"` in the response
- Wake assertions tightened from `"Screen:"` to `"wake sent"` for specificity
- Multi-touch tests open Google Maps at a known location to provide a zoomable surface for pinch/spread verification
- On-device validated: 257/257 with `DA_TEST_PIN` on Pixel 6a (Termux + Magisk + QEMU 10.2.1)

### Security Hardening
- **`adb_screen` PIN shell injection** (finding #76) — The `pin` parameter was passed unsanitized to `input text`, allowing shell injection via crafted PIN values. Fixed with three layers: Zod `.trim().regex(/^[a-zA-Z0-9]+$/)` rejects non-alphanumeric input at the schema level, `shellEscape()` wraps the value in the shell command, and `shellEscape` import added to `control.ts`. The `.trim()` handles cmd.exe trailing-space edge case when `DA_TEST_PIN` is set via `set VAR=value && command`.
- **`adb_input_pinch` event device node injection** (finding #76b) — The touchscreen device node path from `getevent -p` was used unvalidated and unquoted in the `xxd -r -p > <node>` shell command. While the value comes from system output (not user input), defense-in-depth requires validation. Fixed with `/dev/` prefix check, shell metacharacter rejection (`["'\`$\\!;|&(){}<>\n\r]`), path traversal (`..`) rejection, and single-quote wrapping in the shell command.
- **PNG decoder hardening** (3 findings in `png-utils.ts`) — (a) PNG signature only checked 2 of 8 bytes — a non-PNG binary starting with `\x89\x50` would pass validation. Fixed with full 8-byte magic number check. (b) No dimension bounds on IHDR width/height — a crafted PNG claiming extreme dimensions (e.g. 100000×100000) would trigger a multi-gigabyte `Buffer.alloc()` OOM crash. Fixed with `MAX_DIM = 10000` ceiling per axis. (c) `inflateSync` called without `maxOutputLength` — a decompression bomb (tiny compressed payload decompressing to gigabytes) would exhaust memory before the size check. Fixed with `maxOutputLength` computed from validated IHDR dimensions, aborting decompression immediately if output exceeds expected pixel data size.

## v1.0.8 — Input Gestures, UI Automation & Device Awareness

### Input Gestures, UI Automation, Efficiency, Device Awareness & Crash Analysis (18 new tools, 1 new module — 174 tools across 43 modules)

**Batch 1 — Input Gestures (7 tools):**
- **`adb_input_drag`** — Drag from point A to point B using Android's `draganddrop` command with swipe fallback for older devices. Configurable duration.
- **`adb_input_long_press`** — Long press at coordinates with configurable hold duration. Triggers context menus, selection mode, and drag handles.
- **`adb_input_double_tap`** — Double tap with configurable interval between taps. Triggers zoom, text selection, and double-tap gestures.
- **`adb_input_text`** — Dedicated text input with `%s` space encoding and shell escaping for special characters.
- **`adb_open_url`** — Open a URL on the device via `android.intent.action.VIEW` intent.
- **`adb_orientation`** — Get or set screen orientation: auto-rotate, portrait, landscape, reverse portrait, reverse landscape.
- **`adb_clipboard`** — Read or write the device clipboard. Multiple fallback methods for cross-version compatibility.

**Batch 2 — UI Automation Helpers (4 tools):**
- **`adb_tap_element`** — Find a UI element by text, resource-id, or content-description, then tap its center. Atomic search+tap in one call.
- **`adb_wait_element`** — Poll UI hierarchy until an element appears or disappears. Configurable timeout and polling interval.
- **`adb_wait_stable`** — Poll until consecutive UI dumps produce identical structure. Detects when screen transitions and animations are complete.
- **`adb_scroll_until`** — Scroll repeatedly until a target element is found in the UI hierarchy. Configurable direction, max scrolls, and optional auto-tap when found.

**Batch 3 — Efficiency Features (2 tools):**
- **`adb_screenshot_compressed`** — Capture screenshot with size/quality metadata for token-efficient LLM workflows.
- **`adb_batch_actions`** — Execute up to 50 input actions (tap, swipe, long_press, double_tap, keyevent, text, drag, back, home, sleep) in a single tool call. All actions validated through security middleware.

**Architecture:**
- Extracted `parseUiNodes` and `UiElement` to shared `ui-dump.ts` middleware — eliminates duplication between `ui.ts` and the new `input-gestures.ts` module.

**Device Awareness (3 tools):**
- **`adb_screen_size`** — Screen resolution and display density: physical width, height (pixels), DPI, aspect ratio, DP width. Detects override sizes/densities.
- **`adb_device_state`** — Combined snapshot in one call: battery level/status/temperature, network type, WiFi state, screen on/off, orientation lock, foreground activity. Uses `Promise.allSettled` for resilience.
- **`adb_notifications`** — Parse active notifications from `dumpsys notification --noredact`. Extracts package, title, text, importance, channel, flags, and timestamp. Supports package filter and max results.

**Crash Analysis & Debugging (2 tools):**
- **`adb_crash_logs`** — Read ANR (Application Not Responding) traces and tombstone crash dumps from the device. Supports ANR-only, tombstones-only, or both. Shows directory listing and most recent trace/tombstone content.
- **`adb_heap_dump`** — Capture a heap dump from a running process for memory analysis. Triggers `am dumpheap`, pulls the .hprof file locally, and cleans up the remote temp file.

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
