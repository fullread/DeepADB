// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0

/** Only server-owned messages may cross the public error boundary. */
const CLIENT_MESSAGES = Object.freeze({
  INVALID_JSON: "Request body and variables must contain valid JSON",
  INVALID_REQUEST: "Invalid GraphQL request: query must be a string, variables an object, and operationName a string when provided",
  MISSING_QUERY: "Missing 'query' parameter",
  QUERY_TOO_LARGE: "GraphQL query exceeds 64 KiB",
  INVALID_QUERY: "Invalid GraphQL query syntax or parsing limit exceeded (4096 tokens)",
  DEPTH_LIMIT: "Query depth exceeds limit (10)",
  COMPLEXITY_LIMIT: "Query complexity exceeds limit (256 selections)",
  FRAGMENT_CYCLE: "Cyclic GraphQL fragments are not allowed",
  FIELD_LIMIT: "Query exceeds field (100) or alias (16) limit",
  PROPERTY_LIMIT: "properties keys exceeds limit (100)",
  DEVICE_LIMIT: "GraphQL device list exceeds limit (16); select a device by serial",
  OPERATION_LIMIT: "GraphQL device-operation budget exceeded (64)",
  REQUEST_CANCELLED: "GraphQL request cancelled or deadline exceeded",
  RESPONSE_TOO_LARGE: "GraphQL response exceeds 1 MiB",
});

/** Not identified by message/name/extensions: backend errors cannot opt in. */
export class GraphQLClientError extends Error {
  constructor(readonly code: keyof typeof CLIENT_MESSAGES) {
    super(CLIENT_MESSAGES[code]);
    this.name = "GraphQLClientError";
  }
}

export function publicGraphQLClientError(error: unknown) {
  if (!(error instanceof GraphQLClientError) || !Object.hasOwn(CLIENT_MESSAGES, error.code)) return undefined;
  // Read the closed message table, never a possibly overwritten Error.message.
  return { message: CLIENT_MESSAGES[error.code], extensions: { code: error.code } };
}
