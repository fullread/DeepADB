/**
 * Local Bridge — On-device execution without ADB.
 *
 * Drop-in replacement for AdbBridge when DeepADB runs directly on the Android
 * device (e.g., inside Termux). All commands execute locally via sh/su instead
 * of routing through adb over USB.
 *
 * Extends AdbBridge so it is type-compatible with the entire tool suite —
 * no tool module changes required. The override of exec() is the single
 * interception point; shell() and rootShell() flow through it automatically.
 *
 * Environment detection: see config.ts isOnDevice().
 */

import { execFile, ExecFileOptions, spawn, ChildProcess } from "child_process";
import { AdbBridge, AdbResult, AdbExecOptions, AdbError } from "./adb-bridge.js";
import { config } from "../config/config.js";
import { Logger } from "../middleware/logger.js";
import { shellEscape } from "../middleware/sanitize.js";

export class LocalBridge extends AdbBridge {
  private localLogger: Logger;
  private deviceInfoCache: string | null = null;

  /**
   * Cached root availability. null = not yet checked, true/false = checked.
   * Probed lazily on first command that needs elevation.
   */
  private rootAvailable: boolean | null = null;

  /**
   * Android system commands that require shell-user (uid=2000) or root privileges.
   * In ADB mode, all shell commands run as uid=2000 automatically.
   * In on-device mode (Termux app user), these need su elevation.
   *
   * SECURITY: This is a FROZEN allowlist — hardcoded and immutable.
   * Not configurable via environment variables or runtime API.
   * Only commands explicitly listed here get routed through su.
   */
  private static readonly ELEVATED_COMMANDS: ReadonlySet<string> = Object.freeze(new Set([
    "settings",      // Requires INTERACT_ACROSS_USERS permission
    "dumpsys",       // Requires DUMP permission
    "am",            // Requires activity manager permissions (force-stop, broadcast)
    "input",         // Requires INJECT_EVENTS permission
    "screencap",     // Requires framebuffer access + system linker context on Android 16
    "screenrecord",  // Requires framebuffer access + system linker context
    "uiautomator",   // Requires instrumentation privileges + system linker context
    "app_process",   // Used by uiautomator — requires system linker context
    "getenforce",    // Requires SELinux status read access
    "setenforce",    // Requires SELinux policy write access
    "cmd",           // Generic binder command — most subcommands need shell user
    "pm",            // Package manager — install, dump, grant need shell-level access
    "wm",            // Window manager — display size/density need shell user
    "svc",           // Service control — wifi, data, power need shell user
    "ip",            // Network route/addr queries require netlink socket access
    "ifconfig",      // Network interface info requires similar privileges to ip
  ]));

  constructor(logger: Logger) {
    super(logger);
    this.localLogger = logger;
  }

  /** Quote a string for safe use as a shell argument (wraps in single quotes with escaping). */
  private shellQuote(str: string): string {
    return `'${shellEscape(str)}'`;
  }

  /**
   * Check if root (su) is available. Result is cached after first probe.
   * Uses a fast, side-effect-free check: `su -c id`.
   */
  private async checkRootAvailable(): Promise<boolean> {
    if (this.rootAvailable !== null) return this.rootAvailable;

    try {
      const result = await this.execLocal("su -c id", { timeout: 5000, ignoreExitCode: true });
      this.rootAvailable = result.stdout.includes("uid=0");
      if (this.rootAvailable) {
        this.localLogger.info("LocalBridge: root (su) available — privileged commands will be elevated");
      } else {
        this.localLogger.info("LocalBridge: root (su) not available — running in unprivileged mode");
      }
    } catch {
      this.rootAvailable = false;
      this.localLogger.info("LocalBridge: root (su) probe failed — running in unprivileged mode");
    }
    return this.rootAvailable;
  }

  /**
   * Wrap a command in `su -c '...'` for privilege elevation.
   * Uses shellEscape() to safely handle single quotes in the inner command.
   * This is the same escaping path used by AdbBridge.rootShell().
   */
  private elevate(command: string): string {
    return `su -c '${shellEscape(command)}'`;
  }

  /**
   * Android filesystem paths that require elevated access in on-device mode.
   * Commands referencing these paths need su to bypass scoped storage restrictions.
   * In ADB mode (uid=2000), these paths are accessible by default.
   */
  private static readonly RESTRICTED_PATH_PATTERNS = /\/sdcard\b|\/storage\b|\/system\//;

  /**
   * Check if a shell command needs privilege elevation.
   * Two criteria (either triggers elevation):
   * 1. Command name is in the frozen ELEVATED_COMMANDS allowlist (system tools)
   * 2. Command references restricted filesystem paths (scoped storage bypass)
   *
   * Security note: all commands reaching this point have already been validated
   * by validateShellArg/shellEscape at the tool layer. The su -c '...' wrapper
   * uses shellEscape() to prevent injection within the single-quote context.
   */
  private commandNeedsElevation(command: string): boolean {
    // Check command name against system tool allowlist
    const firstToken = command.trimStart().split(/\s+/)[0] ?? "";
    // Handle absolute paths: "/system/bin/am" → "am"
    const cmdName = firstToken.includes("/") ? firstToken.split("/").pop() ?? "" : firstToken;
    if (LocalBridge.ELEVATED_COMMANDS.has(cmdName)) return true;

    // Check if command references restricted paths that need scoped storage bypass
    if (LocalBridge.RESTRICTED_PATH_PATTERNS.test(command)) return true;

    return false;
  }

  /**
   * Execute an "ADB command" locally by translating the subcommand.
   * This is the single interception point — shell(), rootShell(), and all
   * tool calls to exec() flow through here.
   */
  override async exec(args: string[], options: AdbExecOptions = {}): Promise<AdbResult> {
    const subcommand = args[0];
    const hasRoot = await this.checkRootAvailable();

    switch (subcommand) {
      case "shell":
        // args = ["shell", "<command>"] — execute the command directly
        // If the command requires system-level privileges and root is available,
        // route through su to match ADB mode behavior (which runs as uid=2000).
        {
          const command = args.slice(1).join(" ");
          if (hasRoot && this.commandNeedsElevation(command)) {
            return this.execLocal(this.elevate(command), options);
          }
          return this.execLocal(command, options);
        }

      case "devices":
        return this.syntheticDeviceList();

      case "version":
        return this.makeResult("DeepADB Local Bridge (on-device mode)");

      case "push":
        // Local → device path. Elevate to write to restricted paths like /sdcard/.
        {
          const pushCmd = `cp -f ${this.shellQuote(args[1])} ${this.shellQuote(args[2])}`;
          return this.execLocal(hasRoot ? this.elevate(pushCmd) : pushCmd, options);
        }

      case "pull":
        // Device → local path. Use su-cat with redirect so the LOCAL file is
        // owned by the Termux user (not root), enabling Node.js to read it back.
        // The > redirect is evaluated by the outer sh (uid=Termux), so the
        // created file inherits the Termux user's ownership.
        if (hasRoot) {
          const pullCmd = `su -c 'cat ${shellEscape(args[1])}' > ${this.shellQuote(args[2])}`;
          return this.execLocal(pullCmd, options);
        }
        return this.execLocal(`cp -f ${this.shellQuote(args[1])} ${this.shellQuote(args[2])}`, options);

      case "install":
        // args = ["install", ...flags, path] → pm install
        // Flags are hardcoded (-r, -d), only the last arg (APK path) needs quoting
        {
          const installCmd = `pm install ${args.slice(1, -1).join(" ")} ${this.shellQuote(args[args.length - 1])}`;
          return this.execLocal(hasRoot ? this.elevate(installCmd) : installCmd, options);
        }

      case "install-multiple":
        // args = ["install-multiple", ...flags, ...paths] → pm install-multiple
        // Flags are hardcoded (-r, -d), paths need quoting
        {
          const imArgs = args.slice(1);
          const flags = imArgs.filter(a => a.startsWith("-"));
          const paths = imArgs.filter(a => !a.startsWith("-"));
          const imCmd = `pm install-multiple ${flags.join(" ")} ${paths.map(p => this.shellQuote(p)).join(" ")}`;
          return this.execLocal(hasRoot ? this.elevate(imCmd) : imCmd, options);
        }

      case "uninstall":
        // args = ["uninstall", ...flags, package] → pm uninstall
        // Package name is validated by validateShellArg before reaching here
        {
          const uninstallCmd = `pm uninstall ${args.slice(1).join(" ")}`;
          return this.execLocal(hasRoot ? this.elevate(uninstallCmd) : uninstallCmd, options);
        }

      case "logcat":
        // args = ["logcat", ...flags] → direct logcat
        return this.execLocal(`logcat ${args.slice(1).join(" ")}`, options);

      case "reboot":
        {
          const rebootCmd = `reboot ${args.slice(1).join(" ")}`.trim();
          return this.execLocal(hasRoot ? this.elevate(rebootCmd) : rebootCmd, options);
        }

      case "forward":
      case "reverse":
        if (args.includes("--list")) {
          return this.makeResult("");  // Empty list — no ADB server
        }
        return this.makeResult(`${subcommand}: not available in on-device mode (no ADB server)`);

      case "connect":
      case "disconnect":
      case "pair":
      case "tcpip":
      case "emu":
        return this.makeResult(`${subcommand}: not applicable in on-device mode (already local)`);

      case "bugreport":
        // ADB mode: "adb bugreport <localPath>" runs bugreportz on-device and pulls to localPath.
        // On-device: bugreportz doesn't accept an output path — it generates a zip at an
        // internal location and prints "OK:<path>" on stdout. We run it, parse the output
        // path, then copy the zip to the requested destination.
        {
          const destPath = args[1]; // The local path the tool expects the zip at
          const bugreportCmd = "bugreportz";
          const bzResult = await this.execLocal(
            hasRoot ? this.elevate(bugreportCmd) : bugreportCmd,
            { ...options, ignoreExitCode: true }
          );
          const okMatch = bzResult.stdout.match(/OK:(.+)/);
          if (okMatch && destPath) {
            const generatedPath = okMatch[1].trim();
            const cpCmd = `cp -f ${this.shellQuote(generatedPath)} ${this.shellQuote(destPath)}`;
            const rmCmd = `rm -f ${this.shellQuote(generatedPath)}`;
            await this.execLocal(hasRoot ? this.elevate(cpCmd) : cpCmd, { ignoreExitCode: true });
            await this.execLocal(hasRoot ? this.elevate(rmCmd) : rmCmd, { ignoreExitCode: true });
          }
          return bzResult;
        }

      default:
        // Unknown subcommand — attempt direct execution
        this.localLogger.warn(`LocalBridge: unknown ADB subcommand "${subcommand}", executing as shell`);
        return this.execLocal(args.join(" "), options);
    }
  }

  /** Execute a command directly on the local device via sh. */
  private execLocal(command: string, options: AdbExecOptions = {}): Promise<AdbResult> {
    const timeout = options.timeout || config.commandTimeout;

    this.localLogger.debug(`local: sh -c ${command.substring(0, 200)}`);

    return new Promise<AdbResult>((resolve, reject) => {
      const execOptions: ExecFileOptions = {
        timeout,
        maxBuffer: config.maxOutputSize * 2,
        env: { ...process.env, PATH: `${process.env.PATH}:/system/bin:/vendor/bin` },
      };

      execFile("sh", ["-c", command], execOptions, (error, stdout, stderr) => {
        const bufferExceeded = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          || error?.message?.includes("maxBuffer") === true;
        const timedOut = error?.killed === true && !bufferExceeded;

        const exitCode = error?.code != null
          ? (typeof error.code === "number" ? error.code : 1)
          : 0;

        const result: AdbResult = {
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode,
          timedOut,
          bufferExceeded,
          device: "local",
        };

        if (timedOut) {
          reject(new AdbError(`Command timed out after ${timeout}ms: ${command.substring(0, 100)}`, result));
          return;
        }

        if (bufferExceeded) {
          resolve(result);
          return;
        }

        if (exitCode !== 0 && !options.ignoreExitCode) {
          reject(new AdbError(
            `Command failed (exit ${exitCode}): ${result.stderr || result.stdout}`.trim(),
            result
          ));
          return;
        }

        resolve(result);
      });
    });
  }

  /**
   * Synthesize an `adb devices -l` response for DeviceManager.
   * Reads device properties once and caches them.
   */
  private async syntheticDeviceList(): Promise<AdbResult> {
    if (!this.deviceInfoCache) {
      try {
        const [modelRes, productRes] = await Promise.allSettled([
          this.execLocal("getprop ro.product.model", { ignoreExitCode: true, timeout: 3000 }),
          this.execLocal("getprop ro.product.device", { ignoreExitCode: true, timeout: 3000 }),
        ]);

        const model = modelRes.status === "fulfilled" ? modelRes.value.stdout.trim().replace(/\s+/g, "_") : "Android";
        const product = productRes.status === "fulfilled" ? productRes.value.stdout.trim() : "unknown";

        this.deviceInfoCache = `List of devices attached\nlocal          device product:${product} model:${model} transport_id:0\n`;
      } catch {
        this.deviceInfoCache = "List of devices attached\nlocal          device product:unknown model:Android transport_id:0\n";
      }
    }
    return this.makeResult(this.deviceInfoCache);
  }

  /** Create a successful AdbResult from a string. */
  private makeResult(stdout: string): AdbResult {
    return {
      stdout,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      bufferExceeded: false,
      device: "local",
    };
  }

  /** Always reachable — we are the device. */
  override async ping(): Promise<boolean> {
    return true;
  }

  /** Return local version info. */
  override async version(): Promise<string> {
    try {
      const result = await this.execLocal("getprop ro.build.version.release", { timeout: 3000 });
      return `DeepADB Local Bridge — Android ${result.stdout.trim()}`;
    } catch {
      return "DeepADB Local Bridge — on-device mode";
    }
  }

  /**
   * Spawn a long-running streaming command locally.
   * In ADB mode the args are ["logcat", ...flags] prefixed with "adb -s serial".
   * Here we strip the ADB layer and spawn the command directly.
   */
  override spawnStreaming(args: string[], _device?: string): ChildProcess {
    // args[0] is the ADB subcommand (logcat, shell, etc.)
    // For logcat: args = ["logcat", "-b", "radio", "-v", "time"]
    // For shell: args = ["shell", "logcat", ...]
    const subcommand = args[0];

    let cmd: string;
    let cmdArgs: string[];

    if (subcommand === "shell") {
      // "shell", "logcat", ...flags → spawn "logcat" with flags
      cmd = args[1];
      cmdArgs = args.slice(2);
    } else {
      // "logcat", ...flags → spawn directly
      cmd = subcommand;
      cmdArgs = args.slice(1);
    }

    this.localLogger.debug(`spawn local: ${cmd} ${cmdArgs.join(" ")}`);

    return spawn(cmd, cmdArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${process.env.PATH}:/system/bin:/vendor/bin` },
    });
  }
}
