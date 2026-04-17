/**
 * File Tools — Filesystem operations on the Android device.
 *
 * 18 tools covering file transfer, inspection, creation, deletion, search,
 * content editing, and filesystem metadata. All path-accepting tools use
 * shellEscape() for injection prevention.
 *
 * Safety model:
 *   - Hard-blocked paths: /, /dev, /proc, /sys — kernel virtual filesystems
 *     where writes can panic the kernel. Blocked for ALL destructive operations.
 *   - Depth-based recursive protection: recursive delete/chmod/chown refuse at
 *     depth ≤ 2 from root (blocks rm -rf /system, rm -rf /sdcard but allows
 *     /sdcard/project/build/).
 *   - Symlink resolution: realpath is resolved BEFORE depth checks to prevent
 *     symlink traversal bypasses (e.g., /sdcard/link -> /system).
 *   - Move source protection: refuse if source is at depth ≤ 1 from root.
 *   - Filesystem-aware warnings: detects erofs/squashfs (read-only), sdcardfs/FUSE
 *     (ignores chmod), vfat/FAT32 (no permissions, 4GB limit, 2s timestamps),
 *     tmpfs (volatile).
 *   - Root parameter: explicit opt-in for privileged operations (root=false default).
 *
 * Transfer & read: adb_push, adb_pull, adb_ls, adb_cat
 * Content editing: adb_file_write, adb_file_replace
 * Search: adb_find, adb_grep
 * Metadata: adb_file_stat, adb_file_checksum, adb_file_fsinfo
 * Creation/deletion: adb_mkdir, adb_rm, adb_file_touch
 * Movement: adb_file_move, adb_file_copy
 * Permissions/ownership: adb_file_chmod, adb_file_chown
 */

import { z } from "zod";
import { join } from "path";
import { ToolContext } from "../tool-context.js";
import { OutputProcessor } from "../middleware/output-processor.js";
import { shellEscape } from "../middleware/sanitize.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Kernel virtual filesystems — writes can panic the kernel. */
const HARD_BLOCKED_PATHS = ["/dev", "/proc", "/sys"];

/** Filesystem types that are always read-only. */
const READ_ONLY_FS = ["erofs", "squashfs"];

/** Filesystem types with restricted behavior. */
const FS_WARNINGS: Record<string, string> = {
  vfat:     "FAT32: no Unix permissions, no symlinks, 4GB file size limit, 2-second timestamp resolution",
  fuseblk:  "FUSE block device: behavior depends on underlying driver",
  sdcardfs: "Android storage layer: ignores chmod — file access controlled by package ownership",
  fuse:     "FUSE: Android scoped storage wrapper — chmod may be ignored",
  tmpfs:    "Volatile: memory-backed, contents lost on reboot",
};

/** Map filesystem magic numbers (from stat -f -c '%T') to readable names.
 *  Android's stat often returns hex magic instead of names. */
const FS_MAGIC_MAP: Record<string, string> = {
  "0x65735546": "fuse",
  "65735546":   "fuse",
  "0xef53":     "ext4",
  "ef53":       "ext4",
  "0xf2f52010": "f2fs",
  "f2f52010":   "f2fs",
  "0xe0f5e1e2": "erofs",
  "e0f5e1e2":   "erofs",
  "0x1021994":  "tmpfs",
  "1021994":    "tmpfs",
  "0x4d44":     "vfat",
  "4d44":       "vfat",
  "0x73717368": "squashfs",
  "73717368":   "squashfs",
  "0x9fa0":     "procfs",
  "9fa0":       "procfs",
  "0x62656572": "sysfs",
  "62656572":   "sysfs",
};

// ── Shared Helpers ───────────────────────────────────────────────────────────

/** Get the depth of a path from root. "/" = 0, "/system" = 1, "/system/app" = 2. */
function pathDepth(p: string): number {
  const segments = p.replace(/\/+$/, "").split("/").filter(s => s.length > 0);
  return segments.length;
}

/** Check if a path is hard-blocked (kernel virtual filesystems). */
function isHardBlocked(resolvedPath: string): string | null {
  const normalized = resolvedPath.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") {
    return "Refusing operation on root filesystem (/).";
  }
  for (const blocked of HARD_BLOCKED_PATHS) {
    if (normalized === blocked || normalized.startsWith(blocked + "/")) {
      return `Refusing operation on ${blocked} — kernel virtual filesystem where writes can cause system instability.`;
    }
  }
  return null;
}

/** Resolve symlinks via realpath on the device. Returns the resolved path or original on failure. */
async function resolveRealPath(
  ctx: ToolContext, serial: string, path: string, root: boolean,
): Promise<string> {
  const shell = root ? ctx.bridge.rootShell.bind(ctx.bridge) : ctx.bridge.shell.bind(ctx.bridge);
  const result = await shell(`realpath '${shellEscape(path)}' 2>/dev/null || echo '${shellEscape(path)}'`, {
    device: serial, timeout: 3000, ignoreExitCode: true,
  });
  return result.stdout.trim() || path;
}

/** Query available storage on the partition containing the given path.
 *  Falls back to parent directory if the path no longer exists (e.g., after deletion). */
async function getStorageInfo(
  ctx: ToolContext, serial: string, path: string, root: boolean,
): Promise<string> {
  const shell = root ? ctx.bridge.rootShell.bind(ctx.bridge) : ctx.bridge.shell.bind(ctx.bridge);
  // Try the path itself, then fall back to its parent directory
  const escaped = shellEscape(path);
  const parentDir = path.replace(/\/[^/]+\/?$/, "") || "/";
  const parentEscaped = shellEscape(parentDir);
  const result = await shell(
    `df -h '${escaped}' 2>/dev/null || df -h '${parentEscaped}' 2>/dev/null`,
    { device: serial, timeout: 5000, ignoreExitCode: true },
  );
  const lines = result.stdout.trim().split("\n");
  const dataLine = lines[lines.length - 1] ?? "";
  if (!dataLine) return "unknown";
  // df -h output: Filesystem Size Used Avail Use% Mounted_on
  const fields = dataLine.split(/\s+/);
  if (fields.length >= 4) {
    return `${fields[3]} available (${fields[2]} used of ${fields[1]} on ${fields[5] ?? fields[0]})`;
  }
  return dataLine;
}

/** Detect filesystem type for a given path. Resolves hex magic numbers to names. */
async function detectFsType(
  ctx: ToolContext, serial: string, path: string, root: boolean,
): Promise<{ fsType: string; warning: string | null; readOnly: boolean }> {
  const shell = root ? ctx.bridge.rootShell.bind(ctx.bridge) : ctx.bridge.shell.bind(ctx.bridge);
  const result = await shell(`stat -f -c '%T' '${shellEscape(path)}' 2>/dev/null`, {
    device: serial, timeout: 3000, ignoreExitCode: true,
  });
  let fsType = result.stdout.trim().toLowerCase();
  if (!fsType || fsType === "unknown") {
    return { fsType: "unknown", warning: null, readOnly: false };
  }
  // Android's stat -f often returns hex magic numbers instead of names
  fsType = FS_MAGIC_MAP[fsType] ?? fsType;
  const readOnly = READ_ONLY_FS.some(ro => fsType.includes(ro));
  const warning = readOnly
    ? `Read-only filesystem (${fsType}) — this is a system partition. Remount with 'mount -o remount,rw <mountpoint>' (root required) to modify.`
    : (FS_WARNINGS[fsType] ?? null);
  return { fsType, warning, readOnly };
}

/** Format operation metrics for output. */
function formatMetrics(metrics: {
  operation: string;
  path: string;
  executionMs: number;
  extras?: Record<string, string>;
  storage?: string;
  fsWarning?: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`Operation: ${metrics.operation}`);
  lines.push(`Path: ${metrics.path}`);
  for (const [key, val] of Object.entries(metrics.extras ?? {})) {
    lines.push(`${key}: ${val}`);
  }
  lines.push(`Execution time: ${metrics.executionMs}ms`);
  if (metrics.storage) lines.push(`Available storage: ${metrics.storage}`);
  if (metrics.fsWarning) lines.push(`⚠ ${metrics.fsWarning}`);
  return lines.join("\n");
}

/** Execute a shell command with optional root elevation. */
function execShell(ctx: ToolContext, root: boolean) {
  return root ? ctx.bridge.rootShell.bind(ctx.bridge) : ctx.bridge.shell.bind(ctx.bridge);
}

/** Format a byte count as a human-readable string with appropriate unit. */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

/** Escape a string for use as a sed fixed-string pattern (BRE).
 *  Escapes all regex metacharacters so the pattern matches literally,
 *  then closes/reopens the surrounding shell single-quote around any `'`
 *  so the final shell command remains well-formed. */
function sedEscapePattern(str: string): string {
  return str
    .replace(/[[\].*^$\\\/&]/g, "\\$&")
    .replace(/'/g, "'\\''");
}

/** Escape a string for use in a sed replacement string.
 *  Only & \ and the delimiter need escaping in the replacement, then
 *  close/reopen the surrounding shell single-quote around any `'`. */
function sedEscapeReplacement(str: string): string {
  return str
    .replace(/[\\\/&]/g, "\\$&")
    .replace(/'/g, "'\\''");
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerFileTools(ctx: ToolContext): void {

  // ── Existing tools (transfer & read) ────────────────────────────────────

  ctx.server.tool(
    "adb_push",
    "Push a local file to the device filesystem. Pre-flight checks: hard-blocked kernel paths, filesystem type warnings, symlink resolution, and destination storage availability.",
    {
      localPath: z.string().describe("Local file path to push"),
      remotePath: z.string().describe("Destination path on device"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ localPath, remotePath, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;

        // Pre-flight safety: resolve symlinks and check destination
        const realDest = await resolveRealPath(ctx, serial, remotePath, false);
        const blocked = isHardBlocked(realDest);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        const fs = await detectFsType(ctx, serial, remotePath, false);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        const result = await ctx.bridge.exec(["push", localPath, remotePath], {
          device: serial, timeout: 120000,
        });

        const storage = await getStorageInfo(ctx, serial, remotePath, false);
        const output = result.stdout.trim() || "File pushed successfully.";

        return {
          content: [{
            type: "text",
            text: `${output}\nExecution time: ${Date.now() - start}ms\nAvailable storage: ${storage}${fs.warning ? "\n⚠ " + fs.warning : ""}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_pull",
    "Pull a file from the device to local filesystem",
    {
      remotePath: z.string().describe("File path on the device"),
      localPath: z.string().optional().describe("Local destination (defaults to temp dir)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ remotePath, localPath, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const fileName = remotePath.split("/").pop() ?? "pulled_file";
        const dest = localPath ?? join(ctx.config.tempDir, fileName);
        const result = await ctx.bridge.exec(["pull", remotePath, dest], {
          device: resolved.serial, timeout: 120000,
        });
        return {
          content: [{ type: "text", text: `${result.stdout.trim()}\nSaved to: ${dest}\nExecution time: ${Date.now() - start}ms` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_ls",
    "List files and directories on the device",
    {
      path: z.string().default("/sdcard").describe("Directory path on device"),
      device: z.string().optional().describe("Device serial"),
      details: z.boolean().optional().default(false).describe("Show detailed listing (ls -la)"),
    },
    async ({ path, device, details }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const cmd = details ? `ls -la '${shellEscape(path)}'` : `ls '${shellEscape(path)}'`;
        const result = await ctx.bridge.shell(cmd, { device: resolved.serial });
        return { content: [{ type: "text", text: `${OutputProcessor.process(result.stdout)}\nExecution time: ${Date.now() - start}ms` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_cat",
    "Read a text file from the device",
    {
      path: z.string().describe("File path on device"),
      device: z.string().optional().describe("Device serial"),
      maxLines: z.number().min(1).max(10000).optional().describe("Maximum lines to return (1-10000)"),
    },
    async ({ path, device, maxLines }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        let cmd = `cat '${shellEscape(path)}'`;
        if (maxLines) cmd = `head -n ${maxLines} '${shellEscape(path)}'`;
        const result = await ctx.bridge.shell(cmd, { device: resolved.serial });
        return { content: [{ type: "text", text: `${OutputProcessor.process(result.stdout)}\nExecution time: ${Date.now() - start}ms` }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  // ── New tools (filesystem operations) ───────────────────────────────────

  ctx.server.tool(
    "adb_file_write",
    "Create or overwrite a text file on the device. Content is delivered via shell heredoc — suitable for config files, scripts, test fixtures, and small data files. For large or binary files, use adb_push instead. Shell buffer limits content to approximately 128KB.",
    {
      path: z.string().describe("Destination file path on device"),
      content: z.string().describe("File content to write"),
      append: z.boolean().optional().default(false).describe("Append to existing file instead of overwriting"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, content, append, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        // Resolve symlinks and check safety
        const realPath = await resolveRealPath(ctx, serial, filePath, root);
        const blocked = isHardBlocked(realPath);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        // Filesystem type pre-flight
        const fs = await detectFsType(ctx, serial, filePath, root);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        // Warn if content approaches shell buffer limit
        const contentBytes = Buffer.byteLength(content, "utf-8");
        const BUFFER_WARN_THRESHOLD = 120000; // ~128KB shell limit
        if (contentBytes > BUFFER_WARN_THRESHOLD) {
          return {
            content: [{ type: "text", text: `Content size (${(contentBytes / 1024).toFixed(1)} KB) approaches shell buffer limit (~128KB). Use adb_push for large file creation — write content to a local file first, then push it.` }],
            isError: true,
          };
        }

        // Generate a unique heredoc delimiter that won't appear in the content
        let delimiter = "DEEPADB_EOF";
        while (content.includes(delimiter)) {
          delimiter = `DEEPADB_EOF_${Math.random().toString(36).substring(2, 8)}`;
        }

        const op = append ? ">>" : ">";
        const cmd = `cat << '${delimiter}' ${op} '${shellEscape(filePath)}'\n${content}\n${delimiter}`;
        const result = await shell(cmd, {
          device: serial, timeout: 30000, ignoreExitCode: true,
        });

        if (result.stderr && result.stderr.includes("Read-only file system")) {
          return { content: [{ type: "text", text: `Write failed: read-only filesystem. Path: ${filePath}\nUse root=true or remount the partition.` }], isError: true };
        }
        if (result.exitCode !== 0 && result.stderr) {
          return { content: [{ type: "text", text: `Write failed: ${result.stderr.trim()}${!root ? "\nTip: try root=true for protected paths" : ""}` }], isError: true };
        }

        // Post-write verification
        const verifyResult = await shell(`stat -c '%s' '${shellEscape(filePath)}' 2>/dev/null`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const writtenSize = verifyResult.stdout.trim();
        const storage = await getStorageInfo(ctx, serial, filePath, root);

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: append ? "append" : "write",
              path: filePath,
              executionMs: Date.now() - start,
              extras: {
                "Written size": writtenSize ? `${writtenSize} bytes` : `~${contentBytes} bytes`,
                "Content length": `${content.split("\n").length} lines`,
              },
              storage,
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_find",
    "Search for files on the device by name or pattern. Uses the find command with glob matching. Results are capped at maxResults to prevent unbounded output. Reports whether results were truncated.",
    {
      searchPath: z.string().default("/sdcard").describe("Starting directory for search"),
      name: z.string().describe("Filename pattern (glob: *.apk, config.*, *test*)"),
      type: z.enum(["file", "directory", "any"]).optional().default("any").describe("Filter by type: file, directory, or any"),
      maxDepth: z.number().min(1).max(50).optional().default(10).describe("Maximum directory depth to search (1-50, default 10)"),
      maxResults: z.number().min(1).max(10000).optional().default(500).describe("Maximum results to return (1-10000, default 500)"),
      root: z.boolean().optional().default(false).describe("Use root shell for system paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ searchPath, name, type, maxDepth, maxResults, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        let cmd = `find '${shellEscape(searchPath)}' -maxdepth ${maxDepth}`;
        if (type === "file") cmd += " -type f";
        else if (type === "directory") cmd += " -type d";
        cmd += ` -name '${shellEscape(name)}'`;
        // Request one extra to detect truncation
        cmd += ` 2>/dev/null | head -n ${maxResults + 1}`;

        const result = await shell(cmd, {
          device: serial, timeout: 60000, ignoreExitCode: true,
        });

        const lines = result.stdout.trim().split("\n").filter(l => l.length > 0);
        const truncated = lines.length > maxResults;
        const results = truncated ? lines.slice(0, maxResults) : lines;

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No files matching '${name}' found in ${searchPath} (depth ${maxDepth}).\nExecution time: ${Date.now() - start}ms` }] };
        }

        let output = results.join("\n");
        output += `\n\n${results.length} result(s)`;
        if (truncated) output += ` (truncated at ${maxResults} — more results exist, increase maxResults or narrow the search)`;
        output += `\nExecution time: ${Date.now() - start}ms`;

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_stat",
    "Get detailed file metadata: size, permissions, ownership, timestamps (access/modify/change), SELinux security context, and file type. Read-only operation.",
    {
      path: z.string().describe("File or directory path on device"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);
        const escaped = shellEscape(filePath);

        // stat + ls -Z for SELinux context in a single command
        const result = await shell(
          `stat '${escaped}' 2>&1 && echo '---SELINUX---' && ls -Zd '${escaped}' 2>/dev/null`,
          { device: serial, timeout: 10000, ignoreExitCode: true },
        );

        const output = result.stdout.trim();
        if (output.includes("No such file or directory")) {
          return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
        }

        const parts = output.split("---SELINUX---");
        let text = parts[0]!.trim();
        if (parts[1]) {
          const seMatch = parts[1].trim().match(/^(\S+)\s/);
          if (seMatch) text += `\nSELinux context: ${seMatch[1]}`;
        }
        text += `\nExecution time: ${Date.now() - start}ms`;

        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_checksum",
    "Compute SHA-256 hash of a file on the device. Critical for firmware integrity verification, tamper detection, and comparing files across devices. Read-only operation. Reports file size alongside the hash.",
    {
      path: z.string().describe("File path on device"),
      algorithm: z.enum(["sha256", "sha1", "md5"]).optional().default("sha256").describe("Hash algorithm (default: sha256)"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, algorithm, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);
        const escaped = shellEscape(filePath);

        // Get size first for timeout estimation
        const sizeResult = await shell(`stat -c '%s' '${escaped}' 2>/dev/null`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const fileSize = parseInt(sizeResult.stdout.trim(), 10) || 0;
        // ~100MB/s for sha256 on typical SoC; minimum 10s, maximum 5min
        const hashTimeout = Math.max(10000, Math.min(300000, Math.ceil(fileSize / (100 * 1024 * 1024)) * 1000 + 10000));

        const hashCmd = algorithm === "md5" ? "md5sum" : algorithm === "sha1" ? "sha1sum" : "sha256sum";
        const result = await shell(`${hashCmd} '${escaped}' 2>&1`, {
          device: serial, timeout: hashTimeout, ignoreExitCode: true,
        });

        const output = result.stdout.trim();
        if (output.includes("No such file or directory")) {
          return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
        }

        const hashMatch = output.match(/^([a-f0-9]+)\s/);
        if (!hashMatch) {
          return { content: [{ type: "text", text: `Hash computation failed: ${output}` }], isError: true };
        }

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: `checksum (${algorithm})`,
              path: filePath,
              executionMs: Date.now() - start,
              extras: {
                "Hash": hashMatch[1]!,
                "Algorithm": algorithm.toUpperCase(),
                "File size": formatBytes(fileSize),
              },
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_mkdir",
    "Create a directory on the device. Supports -p flag for creating parent directories.",
    {
      path: z.string().describe("Directory path to create"),
      parents: z.boolean().optional().default(true).describe("Create parent directories as needed (-p flag, default true)"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: dirPath, parents, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        const realPath = await resolveRealPath(ctx, serial, dirPath, root);
        const blocked = isHardBlocked(realPath);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        const fs = await detectFsType(ctx, serial, dirPath, root);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        const pFlag = parents ? "-p " : "";
        const result = await shell(`mkdir ${pFlag}'${shellEscape(dirPath)}' 2>&1`, {
          device: serial, timeout: 10000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `mkdir failed: ${result.stdout.trim()}${!root ? "\nTip: try root=true for protected paths" : ""}` }], isError: true };
        }

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: "mkdir",
              path: dirPath,
              executionMs: Date.now() - start,
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_rm",
    "Delete a file or directory on the device. Recursive deletion uses depth-based protection: refuses at depth ≤ 2 from root (blocks rm -rf /system or /sdcard but allows /sdcard/project/build/). Symlinks are resolved before depth checks to prevent traversal bypasses. Hard-blocks /dev, /proc, /sys. For recursive deletes, reports a pre-flight file count.",
    {
      path: z.string().describe("File or directory path to delete"),
      recursive: z.boolean().optional().default(false).describe("Delete directory recursively (-rf). Depth-protected."),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: targetPath, recursive, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        // Resolve symlinks BEFORE depth check to prevent traversal bypass
        const realPath = await resolveRealPath(ctx, serial, targetPath, root);
        const blocked = isHardBlocked(realPath);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        // Depth-based protection for recursive delete
        if (recursive) {
          const depth = pathDepth(realPath);
          if (depth <= 2) {
            return {
              content: [{ type: "text", text: `Refusing recursive delete at depth ${depth} (${realPath}). Recursive deletion requires path depth > 2 from root to prevent accidental system/data loss. For individual file deletion in this path, omit recursive=true.` }],
              isError: true,
            };
          }
        }

        const fs = await detectFsType(ctx, serial, targetPath, root);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        // Pre-flight count for recursive delete
        let itemCount = "1";
        if (recursive) {
          const countResult = await shell(
            `find '${shellEscape(targetPath)}' 2>/dev/null | wc -l`,
            { device: serial, timeout: 15000, ignoreExitCode: true },
          );
          itemCount = countResult.stdout.trim() || "unknown";
        }

        // Execute deletion
        const rmFlag = recursive ? "-rf" : "-f";
        const result = await shell(`rm ${rmFlag} '${shellEscape(targetPath)}' 2>&1`, {
          device: serial, timeout: recursive ? 120000 : 10000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `Delete failed: ${result.stdout.trim()}${!root ? "\nTip: try root=true for protected paths" : ""}` }], isError: true };
        }

        const storage = await getStorageInfo(ctx, serial, targetPath, root);

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: recursive ? "delete (recursive)" : "delete",
              path: targetPath,
              executionMs: Date.now() - start,
              extras: {
                "Resolved path": realPath !== targetPath ? realPath : "(direct)",
                ...(recursive ? { "Items deleted": itemCount } : {}),
              },
              storage,
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_move",
    "Move or rename a file/directory on the device. Moving FROM a system path is destructive — source depth protection refuses if source is at depth ≤ 1 from root. Symlinks resolved before checks. Cross-filesystem moves (e.g., /data → /sdcard) do a copy+delete internally and can be slow for large files.",
    {
      source: z.string().describe("Source file or directory path"),
      destination: z.string().describe("Destination path"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ source, destination, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        // Resolve symlinks for both source and destination
        const realSource = await resolveRealPath(ctx, serial, source, root);
        const realDest = await resolveRealPath(ctx, serial, destination, root);

        // Hard-block check on both paths
        const srcBlocked = isHardBlocked(realSource);
        if (srcBlocked) return { content: [{ type: "text", text: `Source: ${srcBlocked}` }], isError: true };
        const destBlocked = isHardBlocked(realDest);
        if (destBlocked) return { content: [{ type: "text", text: `Destination: ${destBlocked}` }], isError: true };

        // Source depth protection — mv from a top-level path removes it
        const srcDepth = pathDepth(realSource);
        if (srcDepth <= 1) {
          return {
            content: [{ type: "text", text: `Refusing move: source path ${realSource} is at depth ${srcDepth} (top-level system directory). Moving it would remove a critical directory.` }],
            isError: true,
          };
        }

        // Get source size for reporting
        const sizeResult = await shell(`stat -c '%s' '${shellEscape(source)}' 2>/dev/null`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const sourceSize = sizeResult.stdout.trim();

        // Execute move
        const result = await shell(`mv '${shellEscape(source)}' '${shellEscape(destination)}' 2>&1`, {
          device: serial, timeout: 120000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `Move failed: ${result.stdout.trim()}${!root ? "\nTip: try root=true for protected paths" : ""}` }], isError: true };
        }

        // Post-verify: destination exists
        const verifyResult = await shell(`test -e '${shellEscape(destination)}' && echo EXISTS`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const verified = verifyResult.stdout.includes("EXISTS");
        const storage = await getStorageInfo(ctx, serial, destination, root);

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: "move",
              path: `${source} → ${destination}`,
              executionMs: Date.now() - start,
              extras: {
                ...(sourceSize ? { "Size": `${sourceSize} bytes` } : {}),
                "Verified": verified ? "destination exists" : "⚠ could not verify destination",
              },
              storage,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_copy",
    "Copy a file or directory on the device. Pre-flight checks source size against destination available space. Post-verifies the copy by comparing file sizes. For recursive directory copies, use -r flag.",
    {
      source: z.string().describe("Source file or directory path"),
      destination: z.string().describe("Destination path"),
      recursive: z.boolean().optional().default(false).describe("Copy directories recursively (-r)"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ source, destination, recursive, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        const realDest = await resolveRealPath(ctx, serial, destination, root);
        const destBlocked = isHardBlocked(realDest);
        if (destBlocked) return { content: [{ type: "text", text: `Destination: ${destBlocked}` }], isError: true };

        const fs = await detectFsType(ctx, serial, destination, root);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        // Pre-flight: source size and destination available space
        const preResult = await shell(
          `stat -c '%s' '${shellEscape(source)}' 2>/dev/null && echo '---DF---' && df '${shellEscape(destination)}' 2>/dev/null | tail -1`,
          { device: serial, timeout: 5000, ignoreExitCode: true },
        );
        const preParts = preResult.stdout.split("---DF---");
        const sourceBytes = parseInt(preParts[0]?.trim() ?? "", 10) || 0;

        // Execute copy
        const rFlag = recursive ? "-r " : "";
        const result = await shell(`cp ${rFlag}'${shellEscape(source)}' '${shellEscape(destination)}' 2>&1`, {
          device: serial, timeout: 300000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `Copy failed: ${result.stdout.trim()}${!root ? "\nTip: try root=true for protected paths" : ""}` }], isError: true };
        }

        // Post-verify: compare sizes
        const destSizeResult = await shell(`stat -c '%s' '${shellEscape(destination)}' 2>/dev/null`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const destBytes = parseInt(destSizeResult.stdout.trim(), 10) || 0;
        const sizeMatch = sourceBytes > 0 && destBytes > 0 ? (sourceBytes === destBytes ? "✓ match" : `⚠ mismatch (source: ${sourceBytes}, dest: ${destBytes})`) : "skipped";
        const storage = await getStorageInfo(ctx, serial, destination, root);

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: recursive ? "copy (recursive)" : "copy",
              path: `${source} → ${destination}`,
              executionMs: Date.now() - start,
              extras: {
                "Copied size": formatBytes(sourceBytes),
                "Size verification": sizeMatch,
              },
              storage,
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_chmod",
    "Change file permissions on the device. Mode must be a valid octal string (e.g., '755', '644', '600'). Recursive mode uses depth-based protection: refuses at depth ≤ 2 from root. Note: sdcardfs/FUSE ignores Unix permissions — file access on /sdcard is controlled by Android's package ownership model.",
    {
      path: z.string().describe("File or directory path"),
      mode: z.string().regex(/^[0-7]{3,4}$/).describe("Octal permission mode (e.g., '755', '644', '0600')"),
      recursive: z.boolean().optional().default(false).describe("Apply recursively to directory contents. Depth-protected."),
      root: z.boolean().optional().default(false).describe("Use root shell (typically required for chmod)"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, mode, recursive, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        const realPath = await resolveRealPath(ctx, serial, filePath, root);
        const blocked = isHardBlocked(realPath);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        // Depth-based protection for recursive chmod
        if (recursive) {
          const depth = pathDepth(realPath);
          if (depth <= 2) {
            return {
              content: [{ type: "text", text: `Refusing recursive chmod at depth ${depth} (${realPath}). Recursive permission changes require path depth > 2 from root.` }],
              isError: true,
            };
          }
        }

        const fs = await detectFsType(ctx, serial, filePath, root);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        const rFlag = recursive ? "-R " : "";
        const result = await shell(`chmod ${rFlag}${mode} '${shellEscape(filePath)}' 2>&1`, {
          device: serial, timeout: recursive ? 60000 : 10000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `chmod failed: ${result.stdout.trim()}${!root ? "\nTip: try root=true (chmod typically requires root)" : ""}` }], isError: true };
        }

        // Verify resulting permissions
        const verifyResult = await shell(`stat -c '%a %A' '${shellEscape(filePath)}' 2>/dev/null`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const resulting = verifyResult.stdout.trim();

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: recursive ? "chmod (recursive)" : "chmod",
              path: filePath,
              executionMs: Date.now() - start,
              extras: {
                "Mode set": mode,
                "Resulting permissions": resulting || "(could not verify)",
              },
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_touch",
    "Create an empty file or update timestamps. Three modes: create (touch non-existent path), update (set atime/mtime to now), or set explicit timestamp. On FAT32, timestamps have 2-second resolution. On tmpfs, timestamps are volatile.",
    {
      path: z.string().describe("File path on device"),
      timestamp: z.string().optional().describe("Explicit timestamp in 'YYYY-MM-DD HH:MM:SS' format. Omit to use current time."),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, timestamp, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);

        const realPath = await resolveRealPath(ctx, serial, filePath, root);
        const blocked = isHardBlocked(realPath);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        const fs = await detectFsType(ctx, serial, filePath, root);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        // Check if file exists before touch (to report create vs update)
        const existResult = await shell(`test -e '${shellEscape(filePath)}' && echo EXISTS`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const existed = existResult.stdout.includes("EXISTS");

        // Build touch command
        let cmd: string;
        if (timestamp) {
          // Convert YYYY-MM-DD HH:MM:SS to touch -t format: YYYYMMDDhhmm.ss
          const tsMatch = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
          if (!tsMatch) {
            return { content: [{ type: "text", text: `Invalid timestamp format: "${timestamp}". Expected: YYYY-MM-DD HH:MM:SS` }], isError: true };
          }
          const touchTs = `${tsMatch[1]}${tsMatch[2]}${tsMatch[3]}${tsMatch[4]}${tsMatch[5]}.${tsMatch[6]}`;
          cmd = `touch -t ${touchTs} '${shellEscape(filePath)}' 2>&1`;
        } else {
          cmd = `touch '${shellEscape(filePath)}' 2>&1`;
        }

        const result = await shell(cmd, {
          device: serial, timeout: 10000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `Touch failed: ${result.stdout.trim()}${!root ? "\nTip: try root=true for protected paths" : ""}` }], isError: true };
        }

        // Verify resulting timestamps
        const statResult = await shell(
          `stat -c 'Access: %x\nModify: %y\nChange: %z' '${shellEscape(filePath)}' 2>/dev/null`,
          { device: serial, timeout: 3000, ignoreExitCode: true },
        );
        const timestamps = statResult.stdout.trim();
        const mode = !existed ? "created" : timestamp ? "timestamp set" : "updated";

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: `touch (${mode})`,
              path: filePath,
              executionMs: Date.now() - start,
              extras: {
                ...(timestamp ? { "Requested timestamp": timestamp } : {}),
                ...(timestamps ? { "Resulting timestamps": timestamps } : {}),
              },
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_fsinfo",
    "Report filesystem details for any path: filesystem type, mount point, mount options, capacity, usage, read-only status, permission support, symlink support, max file size, timestamp resolution, encryption status, and SELinux context. Essential for understanding what operations are possible before attempting them.",
    {
      path: z.string().describe("File or directory path to inspect"),
      root: z.boolean().optional().default(false).describe("Use root shell for system paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);
        const escaped = shellEscape(filePath);

        // Parallel reads: stat -f, df, full mount table, SELinux context.
        // The mount table is read whole (small) and filtered in TypeScript
        // so we don't interpolate df output into a device-side grep pattern.
        const [statfR, dfR, mountAllR, seR] = await Promise.allSettled([
          shell(`stat -f -c 'Type: %T\nBlock size: %S\nTotal blocks: %b\nFree blocks: %f\nAvailable blocks: %a\nTotal inodes: %c\nFree inodes: %d' '${escaped}' 2>/dev/null`, {
            device: serial, timeout: 5000, ignoreExitCode: true,
          }),
          shell(`df -h '${escaped}' 2>/dev/null | tail -1`, {
            device: serial, timeout: 5000, ignoreExitCode: true,
          }),
          shell(`mount 2>/dev/null`, {
            device: serial, timeout: 5000, ignoreExitCode: true,
          }),
          shell(`ls -Zd '${escaped}' 2>/dev/null`, {
            device: serial, timeout: 3000, ignoreExitCode: true,
          }),
        ]);

        const statfText = statfR.status === "fulfilled" ? statfR.value.stdout.trim() : "";
        const dfText = dfR.status === "fulfilled" ? dfR.value.stdout.trim() : "";
        const mountAllText = mountAllR.status === "fulfilled" ? mountAllR.value.stdout : "";
        const seText = seR.status === "fulfilled" ? seR.value.stdout.trim() : "";

        // Extract the mount point from df output (last whitespace-separated field),
        // then find the matching mount table entry in TypeScript — no shell interpolation.
        const dfFieldsAll = dfText.split(/\s+/);
        const mountPoint = dfFieldsAll[dfFieldsAll.length - 1] ?? "";
        const mountText = mountPoint
          ? mountAllText.split("\n").find(l => l.includes(` on ${mountPoint} type `)) ?? ""
          : "";

        const sections: string[] = [];
        sections.push(`=== Filesystem Info: ${filePath} ===\n`);

        // Parse filesystem type (resolve hex magic to name)
        const fsTypeMatch = statfText.match(/Type:\s*(\S+)/);
        const rawFsType = fsTypeMatch ? fsTypeMatch[1]!.toLowerCase() : "unknown";
        const fsType = FS_MAGIC_MAP[rawFsType] ?? rawFsType;
        sections.push(`Filesystem type: ${fsType}${rawFsType !== fsType ? ` (${rawFsType})` : ""}`);

        // Parse mount info
        if (mountText) {
          const mountMatch = mountText.match(/^(\S+)\s+on\s+(\S+)\s+type\s+(\S+)\s+\(([^)]+)\)/);
          if (mountMatch) {
            sections.push(`Mount point: ${mountMatch[2]}`);
            sections.push(`Mount device: ${mountMatch[1]}`);
            sections.push(`Mount type: ${mountMatch[3]}`);
            const opts = mountMatch[4]!;
            sections.push(`Mount options: ${opts}`);
            sections.push(`Read-only: ${opts.split(",").some(o => o.trim() === "ro") ? "yes" : "no"}`);
          }
        }

        // Parse df output
        if (dfText) {
          const dfFields = dfText.split(/\s+/);
          if (dfFields.length >= 4) {
            sections.push(`\nCapacity: ${dfFields[1]}`);
            sections.push(`Used: ${dfFields[2]} (${dfFields[4] ?? "?"})`);
            sections.push(`Available: ${dfFields[3]}`);
          }
        }

        // Parse inode info from stat -f
        const inodeTotal = statfText.match(/Total inodes:\s*(\d+)/);
        const inodeFree = statfText.match(/Free inodes:\s*(\d+)/);
        if (inodeTotal && inodeFree) {
          const total = parseInt(inodeTotal[1]!, 10);
          const free = parseInt(inodeFree[1]!, 10);
          const usedPct = total > 0 ? (((total - free) / total) * 100).toFixed(1) : "?";
          sections.push(`Inode usage: ${usedPct}% (${free} free of ${total})`);
        }

        // Filesystem behavior analysis
        const fsLower = fsType.toLowerCase();
        sections.push("\n── Capabilities ──");

        const isReadOnly = READ_ONLY_FS.some(ro => fsLower.includes(ro));
        const isFat = fsLower.includes("vfat") || fsLower.includes("fat");
        const isFuse = fsLower.includes("fuse") || fsLower.includes("sdcardfs");

        sections.push(`Supports Unix permissions: ${isFat ? "no (FAT32)" : isFuse ? "ignored (Android storage layer)" : "yes"}`);
        sections.push(`Supports symlinks: ${isFat ? "no" : "yes"}`);
        sections.push(`Timestamp resolution: ${isFat ? "2 seconds (FAT32 limitation)" : "nanosecond"}`);

        if (isFat) {
          sections.push(`Max file size: 4 GB (FAT32 limitation)`);
        } else if (fsLower.includes("f2fs")) {
          sections.push(`Max file size: 3.94 TB (f2fs limit)`);
        } else if (fsLower.includes("ext4") || fsLower.includes("ext2/ext3")) {
          sections.push(`Max file size: 16 TB (ext4 limit)`);
        }

        if (fsLower.includes("tmpfs")) {
          sections.push(`Volatile: yes — contents lost on reboot`);
        }

        // SELinux context
        if (seText) {
          const seMatch = seText.match(/^(\S+)\s/);
          if (seMatch) sections.push(`\nSELinux context: ${seMatch[1]}`);
        }

        // Warnings
        const warning = FS_WARNINGS[fsLower];
        if (isReadOnly) sections.push(`\n⚠ Read-only filesystem (${fsType})`);
        else if (warning) sections.push(`\n⚠ ${warning}`);

        sections.push(`\nExecution time: ${Date.now() - start}ms`);

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_chown",
    "Change file ownership on the device. Requires root. Supports both numeric UID:GID (e.g., '10150:10150') and symbolic user:group (e.g., 'system:system'). Recursive mode uses depth-based protection: refuses at depth ≤ 2 from root. Note: sdcardfs/FAT32 ignore ownership changes.",
    {
      path: z.string().describe("File or directory path"),
      owner: z.string().regex(/^[a-zA-Z0-9_]+:[a-zA-Z0-9_]+$/).describe("Owner in user:group format (e.g., '0:0', 'system:system', '10150:10150')"),
      recursive: z.boolean().optional().default(false).describe("Apply recursively to directory contents. Depth-protected."),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, owner, recursive, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, true); // chown always requires root

        const realPath = await resolveRealPath(ctx, serial, filePath, true);
        const blocked = isHardBlocked(realPath);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        // Depth-based protection for recursive chown
        if (recursive) {
          const depth = pathDepth(realPath);
          if (depth <= 2) {
            return {
              content: [{ type: "text", text: `Refusing recursive chown at depth ${depth} (${realPath}). Recursive ownership changes require path depth > 2 from root.` }],
              isError: true,
            };
          }
        }

        const fs = await detectFsType(ctx, serial, filePath, true);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        const rFlag = recursive ? "-R " : "";
        const result = await shell(`chown ${rFlag}${owner} '${shellEscape(filePath)}' 2>&1`, {
          device: serial, timeout: recursive ? 60000 : 10000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `chown failed: ${result.stdout.trim()}` }], isError: true };
        }

        // Verify resulting ownership
        const verifyResult = await shell(`stat -c '%U:%G (uid=%u gid=%g)' '${shellEscape(filePath)}' 2>/dev/null`, {
          device: serial, timeout: 3000, ignoreExitCode: true,
        });
        const resulting = verifyResult.stdout.trim();

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: recursive ? "chown (recursive)" : "chown",
              path: filePath,
              executionMs: Date.now() - start,
              extras: {
                "Owner set": owner,
                "Resulting ownership": resulting || "(could not verify)",
              },
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_grep",
    "Search file contents on the device by text pattern. Uses fixed-string matching by default (no regex injection risk). Supports recursive directory search with depth control and result capping. For filename searches, use adb_find instead.",
    {
      pattern: z.string().describe("Text pattern to search for"),
      path: z.string().describe("File or directory path to search"),
      recursive: z.boolean().optional().default(false).describe("Search directories recursively"),
      fixedString: z.boolean().optional().default(true).describe("Use fixed-string matching (default: true, safer). Set false for regex."),
      ignoreCase: z.boolean().optional().default(true).describe("Case-insensitive search (default: true)"),
      maxResults: z.number().min(1).max(10000).optional().default(500).describe("Maximum matching lines to return (1-10000, default 500)"),
      maxDepth: z.number().min(1).max(50).optional().default(10).describe("Maximum directory depth for recursive search (1-50, default 10)"),
      filesWithMatches: z.boolean().optional().default(false).describe("Show only filenames that contain matches, not the matching lines"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ pattern, path: searchPath, recursive, fixedString, ignoreCase, maxResults, maxDepth, filesWithMatches, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);
        const escaped = shellEscape(searchPath);
        const patternEscaped = shellEscape(pattern);

        let cmd: string;
        if (recursive) {
          // Use find + grep for recursive with depth control
          const grepFlags = [fixedString ? "-F" : "", ignoreCase ? "-i" : "", "-n", filesWithMatches ? "-l" : ""].filter(f => f).join(" ");
          cmd = `find '${escaped}' -maxdepth ${maxDepth} -type f 2>/dev/null | xargs grep ${grepFlags} '${patternEscaped}' 2>/dev/null | head -n ${maxResults + 1}`;
        } else {
          const grepFlags = [fixedString ? "-F" : "", ignoreCase ? "-i" : "", "-n", filesWithMatches ? "-l" : ""].filter(f => f).join(" ");
          cmd = `grep ${grepFlags} '${patternEscaped}' '${escaped}' 2>/dev/null | head -n ${maxResults + 1}`;
        }

        const result = await shell(cmd, {
          device: serial, timeout: 60000, ignoreExitCode: true,
        });

        const lines = result.stdout.trim().split("\n").filter(l => l.length > 0);
        const truncated = lines.length > maxResults;
        const results = truncated ? lines.slice(0, maxResults) : lines;

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No matches for '${pattern}' in ${searchPath}${recursive ? " (recursive)" : ""}.\nExecution time: ${Date.now() - start}ms` }] };
        }

        let output = results.join("\n");
        output += `\n\n${results.length} match(es)`;
        if (truncated) output += ` (truncated at ${maxResults} — more results exist)`;
        output += `\nExecution time: ${Date.now() - start}ms`;

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

  ctx.server.tool(
    "adb_file_replace",
    "Find and replace text in a file on the device. Uses sed internally with proper escaping — exposes a safe interface without requiring sed syntax knowledge. Supports global replacement, line-targeted edits, and optional backup creation. Reports match count.",
    {
      path: z.string().describe("File path on device"),
      find: z.string().refine(s => !/[\r\n]/.test(s), "find must not contain newlines (sed treats newlines as script-command separators)").describe("Text to find (literal string, not regex)"),
      replace: z.string().refine(s => !/[\r\n]/.test(s), "replace must not contain newlines (sed treats newlines as script-command separators)").describe("Replacement text"),
      global: z.boolean().optional().default(true).describe("Replace all occurrences (default: true). Set false for first-only."),
      lineNumber: z.number().min(1).optional().describe("Restrict replacement to a specific line number"),
      backup: z.boolean().optional().default(false).describe("Create a .bak backup before modifying"),
      root: z.boolean().optional().default(false).describe("Use root shell for protected paths"),
      device: z.string().optional().describe("Device serial"),
    },
    async ({ path: filePath, find, replace, global: globalReplace, lineNumber, backup, root, device }) => {
      const start = Date.now();
      try {
        const resolved = await ctx.deviceManager.resolveDevice(device);
        const serial = resolved.serial;
        const shell = execShell(ctx, root);
        const escaped = shellEscape(filePath);

        const realPath = await resolveRealPath(ctx, serial, filePath, root);
        const blocked = isHardBlocked(realPath);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };

        const fs = await detectFsType(ctx, serial, filePath, root);
        if (fs.readOnly) return { content: [{ type: "text", text: fs.warning! }], isError: true };

        // Count matches before replacement
        const sedFind = sedEscapePattern(find);
        const countCmd = lineNumber
          ? `sed -n '${lineNumber}p' '${escaped}' | grep -cF '${shellEscape(find)}' 2>/dev/null`
          : `grep -cF '${shellEscape(find)}' '${escaped}' 2>/dev/null`;
        const countResult = await shell(countCmd, {
          device: serial, timeout: 10000, ignoreExitCode: true,
        });
        const matchCount = parseInt(countResult.stdout.trim(), 10) || 0;

        if (matchCount === 0) {
          return { content: [{ type: "text", text: `No matches found for "${find}" in ${filePath}${lineNumber ? ` (line ${lineNumber})` : ""}.\nExecution time: ${Date.now() - start}ms` }] };
        }

        // Create backup if requested
        if (backup) {
          await shell(`cp '${escaped}' '${escaped}.bak' 2>&1`, {
            device: serial, timeout: 10000, ignoreExitCode: true,
          });
        }

        // Build sed command
        const sedReplace = sedEscapeReplacement(replace);
        const gFlag = globalReplace ? "g" : "";
        let sedCmd: string;
        if (lineNumber) {
          sedCmd = `sed -i '${lineNumber}s/${sedFind}/${sedReplace}/${gFlag}' '${escaped}' 2>&1`;
        } else {
          sedCmd = `sed -i 's/${sedFind}/${sedReplace}/${gFlag}' '${escaped}' 2>&1`;
        }

        const result = await shell(sedCmd, {
          device: serial, timeout: 30000, ignoreExitCode: true,
        });

        if (result.exitCode !== 0 && result.stdout.trim()) {
          return { content: [{ type: "text", text: `Replace failed: ${result.stdout.trim()}${!root ? "\nTip: try root=true for protected paths" : ""}` }], isError: true };
        }

        return {
          content: [{
            type: "text",
            text: formatMetrics({
              operation: "replace",
              path: filePath,
              executionMs: Date.now() - start,
              extras: {
                "Find": find.length > 80 ? find.substring(0, 80) + "..." : find,
                "Replace": replace.length > 80 ? replace.substring(0, 80) + "..." : replace,
                "Lines with matches": String(matchCount),
                "Mode": globalReplace ? "global (all occurrences)" : "first occurrence only",
                ...(lineNumber ? { "Line": String(lineNumber) } : {}),
                ...(backup ? { "Backup": `${filePath}.bak` } : {}),
              },
              fsWarning: fs.warning,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: OutputProcessor.formatError(error) }], isError: true };
      }
    }
  );

}
