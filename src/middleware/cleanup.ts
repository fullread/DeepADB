/**
 * Process Cleanup Registry — Centralized signal handler for child process cleanup.
 *
 * Multiple modules (logcat-watch, ril-intercept, mirroring) spawn long-running
 * child processes that must be killed on server exit. Instead of each module
 * independently registering SIGINT/SIGTERM/exit handlers (which creates
 * ordering dependencies and redundant process.exit() calls), all modules
 * register their cleanup functions here.
 *
 * One set of signal handlers runs all registered cleanups in order.
 */

type CleanupFn = () => void;

const registry: Map<string, CleanupFn> = new Map();
let registered = false;

function runAllCleanups(): void {
  for (const [, fn] of registry) {
    try {
      fn();
    } catch {
      // Cleanup must not throw during shutdown
    }
  }
}

function ensureHandlers(): void {
  if (registered) return;
  registered = true;

  process.on("exit", runAllCleanups);
  process.on("SIGINT", () => {
    runAllCleanups();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    runAllCleanups();
    process.exit(0);
  });
}

/**
 * Register a cleanup function that will be called on process exit/SIGINT/SIGTERM.
 * Each module should register under a unique key. Re-registering the same key
 * replaces the previous function.
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
