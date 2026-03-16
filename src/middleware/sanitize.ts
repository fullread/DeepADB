/**
 * Input Sanitization — Shell injection prevention for ADB command construction.
 *
 * Tools that interpolate user-supplied parameters into shell command strings
 * must validate those parameters before passing them to bridge.shell().
 * This module provides validation for common parameter types.
 */

/** Characters that are dangerous in shell command interpolation. */
const SHELL_METACHARACTERS = /[;|&$`(){}<>!\n\r\\'"]/;

/**
 * Validate that a string is safe to interpolate into a shell command.
 * Rejects strings containing shell metacharacters that could enable injection.
 *
 * Use for: package names, property keys, service names, setting keys,
 * test class names, runner names, interface names — any identifier that
 * should never contain shell operators.
 *
 * Returns null if safe, or an error message string if unsafe.
 */
export function validateShellArg(value: string, paramName: string): string | null {
  if (SHELL_METACHARACTERS.test(value)) {
    return `Invalid ${paramName}: contains shell metacharacters. Value must not include: ; | & $ \` ( ) { } < > ! \\ ' "`;
  }
  return null;
}

/**
 * Escape a string for safe use inside single-quoted shell arguments.
 * Handles the only character that can break single-quote context: the quote itself.
 * Use for file paths, grep patterns, and any value interpolated into shell commands
 * within single quotes.
 */
export function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/**
 * Validate multiple arguments at once. Returns the first error found, or null if all pass.
 */
export function validateShellArgs(args: Array<[string, string]>): string | null {
  for (const [value, paramName] of args) {
    const error = validateShellArg(value, paramName);
    if (error) return error;
  }
  return null;
}
