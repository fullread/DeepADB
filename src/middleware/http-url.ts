// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** URL authority formatting is distinct from the unbracketed listen address. */
export function httpBaseUrl(host: string, port?: number): string {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}${port === undefined ? "" : `:${port}`}`;
}
