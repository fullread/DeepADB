// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from "./sanitize.js";

/** Only the OS-owned user root may be an Android compatibility symlink. */
export function packageDirectoryGuard(packageName: string, userRoot = "/data/user/0"): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) throw new Error("Invalid package name");
  return [
    `da_root=$(readlink -f ${shellQuote(userRoot)})`,
    `test -n "$da_root"`,
    `da_package="$da_root/${packageName}"`,
    `da_expected="$da_package/databases"`,
    `! test -L "$da_package"`,
    `! test -L "$da_expected"`,
    `cd -P "$da_expected"`,
    `test "$(pwd -P)" = "$da_expected"`,
  ].join(" && ");
}

/** Pin the opened descriptor and verify its kernel path before emitting bytes. */
export function packageFileRead(packageName: string, filename: string, optional = false, userRoot?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(filename)) throw new Error("Invalid database filename");
  const file = shellQuote(`./${filename}`);
  return [
    `${packageDirectoryGuard(packageName, userRoot)} || { echo 'Unsafe package database directory' >&2; exit 1; }`,
    ...(optional ? [`if ! test -e ${file} && ! test -L ${file}; then exit 0; fi`] : []),
    `test -f ${file} && ! test -L ${file} || { echo 'Linked or non-regular database refused' >&2; exit 1; }`,
    `exec 3<${file}`,
    `test -f /proc/$$/fd/3 && test "$(readlink /proc/$$/fd/3)" = "$da_expected/${filename}" || { echo 'Database changed or escaped package directory' >&2; exit 1; }`,
    `test "$(stat -Lc '%h' /proc/$$/fd/3)" = 1 || { echo 'Hard-linked database refused' >&2; exit 1; }`,
    `cat <&3`,
  ].join("\n");
}
