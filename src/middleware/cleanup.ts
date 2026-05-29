// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Process Cleanup Registry — Centralized signal handler for child process cleanup.
 *
 * Multiple modules (logcat-watch, ril-intercept, mirroring, emulator, qemu)
 * spawn long-running child processes that must be killed on server exit.
 * Instead of each module independently registering SIGINT/SIGTERM/exit
 * handlers (which creates ordering dependencies and redundant
 * process.exit() calls), all modules register their cleanup functions here.
 *
 * One set of signal handlers runs all registered cleanups in order.
 *
 * Cleanup functions may return a Promise; the SIGINT/SIGTERM handlers
 * await them. The synchronous 'exit' handler is best-effort — it fires
 * the cleanups but cannot wait for async work to complete.
 */

import type { ChildProcess } from "child_process";

// K4 fix: explicit type alias for the sync vs async tiers. Cleanup
// functions registered here may return void (sync) or Promise<void>
// (async). SIGINT/SIGTERM handlers AWAIT all cleanups; the synchronous
// 'exit' handler invokes them best-effort and discards any returned
// promise (logging a warning the first time so developers see the gap).
// Practical guidance:
//   - If your cleanup is fully sync (proc.kill, file writes), prefer
//     `() => void` — works in all shutdown paths.
//   - If your cleanup is async (gracefulKill with SIGKILL fallback,
//     async file flush, network teardown), it WILL complete on SIGINT/
//     SIGTERM but may be cut off on 'exit'. That's acceptable for
//     best-effort cleanup; the OS will reap orphans either way.
type CleanupFn = () => void | Promise<void>;

const registry: Map<string, CleanupFn> = new Map();
let registered = false;

async function runAllCleanups(): Promise<void> {
  for (const [key, fn] of registry) {
    try {
      await fn();
    } catch (err) {
      // K7 fix: log the failing cleanup's key + error to stderr so
      // operators can diagnose process-zombification (the previous
      // empty catch made this invisible).
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[cleanup] "${key}" failed: ${detail}\n`);
    }
  }
}

let warnedAsyncOnExit = false;
function runAllCleanupsSync(): void {
  // Used by the 'exit' event handler, which cannot await. Async cleanups
  // are still invoked but their promises are discarded — best-effort.
  // K4 fix: log a one-shot stderr warning the first time we discard an
  // async cleanup so developers see "this cleanup may be cut short on
  // abnormal exit; for guaranteed completion route shutdown through
  // SIGINT or SIGTERM."
  for (const [key, fn] of registry) {
    try {
      const ret = fn();
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        if (!warnedAsyncOnExit) {
          warnedAsyncOnExit = true;
          process.stderr.write(
            `[cleanup] async cleanup "${key}" invoked from 'exit' handler — promise discarded. Async work may be cut short on abnormal exit; SIGINT/SIGTERM awaits all cleanups.\n`
          );
        }
      }
    } catch {
      // Cleanup must not throw during shutdown
    }
  }
}

function ensureHandlers(): void {
  if (registered) return;
  registered = true;

  process.on("exit", runAllCleanupsSync);
  // K3 fix: SIGINT/SIGTERM handlers exit with the conventional Unix
  // signal-based code (128 + signum) instead of always 0, so wrapper
  // scripts checking $? can distinguish "completed normally" from
  // "interrupted by user".
  //   SIGINT  = signum 2  → exit 130
  //   SIGTERM = signum 15 → exit 143
  process.on("SIGINT", async () => {
    await runAllCleanups();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await runAllCleanups();
    process.exit(143);
  });
  // K1 fix: cover additional shutdown paths that previously leaked child
  // processes — SIGHUP (terminal disconnect), SIGBREAK (Windows Ctrl+Break),
  // and catastrophic JS errors (uncaughtException, unhandledRejection).
  // Without these, closing a parent terminal without Ctrl+C left orphan
  // emulator/scrcpy/logcat children. Process.on for unsupported signals on
  // a given platform is a no-op, so this is safe cross-platform.
  process.on("SIGHUP", async () => {
    await runAllCleanups();
    process.exit(129); // 128 + SIGHUP(1)
  });
  process.on("SIGBREAK", async () => {
    await runAllCleanups();
    process.exit(149); // 128 + SIGBREAK(21) on Windows
  });
  process.on("uncaughtException", async (err) => {
    process.stderr.write(`[cleanup] uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    await runAllCleanups();
    process.exit(1);
  });
  process.on("unhandledRejection", async (reason) => {
    process.stderr.write(`[cleanup] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
    await runAllCleanups();
    process.exit(1);
  });
}

/**
 * Register a cleanup function that will be called on process exit/SIGINT/SIGTERM.
 * Each module should register under a unique key. Re-registering the same key
 * replaces the previous function. The function may return a Promise.
 */
export function registerCleanup(key: string, fn: CleanupFn): void {
  ensureHandlers();
  registry.set(key, fn);
}

/**
 * Remove a cleanup function by key (e.g., if the module's sessions are all stopped).
 */
export function unregisterCleanup(key: string): void {
  registry.delete(key);
}

/**
 * Kill a child process with two-stage SIGTERM → SIGKILL fallback.
 *
 * Sends SIGTERM, waits up to `graceMs` for the child to exit voluntarily,
 * then escalates to SIGKILL if it's still running. Resolves when the
 * child has exited OR after the SIGKILL has been sent.
 *
 * This closes audit findings AC3 (emulator) and AK8 (mirroring) — and
 * matches the same hazard in logcat-watch.ts and ril-intercept.ts where
 * a bare `proc.kill()` could leave a hung child orphaned if it ignored
 * SIGTERM (common with mid-snapshot Android emulators, hung video pipes
 * in scrcpy, and stuck logcat readers on a wedged device).
 *
 * Default `graceMs` = 1500: enough for a healthy child to clean up,
 * short enough that shutdown stays responsive.
 *
 * Safe to call on an already-exited child (no-op). Safe to call from
 * SIGINT/SIGTERM contexts via async cleanups registered with
 * `registerCleanup` — the registry awaits each cleanup before exiting.
 */
export async function gracefulKill(
  child: ChildProcess,
  graceMs: number = 1500
): Promise<void> {
  // No-op if already dead or never started.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  // Stage 1: Send SIGTERM.
  try {
    child.kill("SIGTERM");
  } catch {
    // Child may have died between the check and the kill — treat as success.
    return;
  }

  // Wait for the child to exit, OR for graceMs to elapse.
  const exited = await new Promise<boolean>((resolve) => {
    let resolved = false;
    const finish = (didExit: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(didExit);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), graceMs);
    child.once("exit", onExit);
  });

  // Stage 2: If still alive, escalate to SIGKILL.
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Child raced us — already dead.
    }
  }
}

/**
 * Convenience: gracefully kill multiple children in parallel.
 * All children get SIGTERM concurrently; each gets SIGKILL after graceMs
 * if still running. Resolves when all have settled.
 */
export async function gracefulKillAll(
  children: Iterable<ChildProcess>,
  graceMs: number = 1500
): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  for (const c of children) tasks.push(gracefulKill(c, graceMs));
  await Promise.all(tasks);
}
