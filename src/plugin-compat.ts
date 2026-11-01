// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Preserve the documented v1 plugin registration surface on the v2 server. */
import type { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { objectFromShape, getObjectShape, safeParseAsync, getParseErrorMessage, type AnySchema, type ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  McpServer, ResourceTemplate, SdkError, SdkErrorCode,
  type ServerContext, type ResourceMetadata, type StandardSchemaWithJSON,
  type Request, type RequestOptions,
  type ToolCallback as SdkToolCallback, type PromptCallback as SdkPromptCallback,
  type ReadResourceCallback, type ReadResourceTemplateCallback,
} from "@modelcontextprotocol/server";

export type PluginRequestContext = ServerContext & {
  signal: AbortSignal;
  requestId: ServerContext["mcpReq"]["id"];
  _meta: ServerContext["mcpReq"]["_meta"];
  authInfo: NonNullable<ServerContext["http"]>["authInfo"];
  requestInfo?: { headers: Record<string, string>; url: URL };
  sendNotification: ServerContext["mcpReq"]["notify"];
  sendRequest: <T>(request: Request, schema: { parseAsync(value: unknown): Promise<T> }, options?: RequestOptions) => Promise<T>;
  closeSSEStream?: () => void;
  closeStandaloneSSEStream?: () => void;
};

// Reuse the public v1 overloads, including raw-schema handle updates, rather
// than duplicating a subtly different plugin type contract.
export type LegacyPluginMethods = Pick<V1McpServer,
  "tool" | "prompt" | "resource" | "registerTool" | "registerPrompt" | "registerResource">;

// Overload order matters: original ToolContext users must infer v1 callback
// fields and handle updates. NativePluginToolContext exposes the v2 type view.
export type PluginServer = LegacyPluginMethods & McpServer;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawShape(value: unknown): value is ZodRawShapeCompat {
  return record(value) && Object.values(value).every(field => record(field) && ("_zod" in field || ("_def" in field && typeof field.safeParseAsync === "function")));
}

/** V1 handles expose the original schema object, or a Zod object for a raw shape. */
function publicSchema(value: unknown): unknown {
  return rawShape(value) ? objectFromShape(value) : value;
}

function schema(value: unknown): StandardSchemaWithJSON | undefined {
  if (value === undefined) return undefined;
  if (rawShape(value)) value = objectFromShape(value);
  if (record(value) && record(value["~standard"]) && record(value["~standard"].jsonSchema)) {
    return value as unknown as StandardSchemaWithJSON;
  }
  if (record(value) && ("_zod" in value || ("_def" in value && typeof value.safeParseAsync === "function"))) {
    const legacy = value as unknown as AnySchema;
    // Preserve both JSON Schema conversion and actual Zod validation. Replacing
    // this with JSON Schema validation would lose refinements and transforms.
    return { "~standard": {
      version: 1, vendor: "deepadb-legacy-zod",
      validate: async input => {
        const result = await safeParseAsync(legacy, input);
        return result.success ? { value: result.data } : { issues: [{ message: getParseErrorMessage(result.error) }] };
      },
      jsonSchema: {
        input: () => toJsonSchemaCompat(legacy, { target: "draft-7", pipeStrategy: "input" }),
        output: () => toJsonSchemaCompat(legacy, { target: "draft-7", pipeStrategy: "output" }),
      },
    } };
  }
  throw new TypeError("Plugin schema must be a Zod schema/shape or a Standard Schema with JSON Schema support");
}

/** Retain completion metadata without changing the original schema's validation. */
function promptSchema(value: unknown): StandardSchemaWithJSON | undefined {
  const converted = schema(value);
  if (!converted) return undefined;
  const shape = rawShape(value) ? value : getObjectShape(value as AnySchema);
  if (!shape) return converted;

  // v2 discovers prompt completers through .shape. Zod Mini lacks that public
  // property, and the Standard Schema adapter for Zod 3 would otherwise lose it.
  // The SDK's optional-field introspection is v4-specific, so unwrap optional
  // fields in this completion-only view for both versions. Validation and the
  // required/optional wire metadata still come from the untouched schema.
  const completionShape = Object.fromEntries(Object.entries(shape).map(([name, field]) => {
    const candidate = field as unknown as Record<string, unknown>;
    const def = record(candidate._zod) ? candidate._zod.def : candidate._def;
    const optional = record(def) && (def.type === "optional" || def.typeName === "ZodOptional");
    return [name, optional ? def.innerType : field];
  }));
  const adapted = { "~standard": converted["~standard"], shape: completionShape };
  return adapted;
}

/** Supply both the old flat extra fields and the v2 context to plugin callbacks. */
function pluginContext(ctx: ServerContext): PluginRequestContext {
  // SDK v1 stopped request-scoped sends after cancellation/disconnection. The
  // v2 helpers can otherwise target the server's *current* client, even when
  // retained by an older handler. Guard both public context shapes.
  const guardRequest = <T extends (...args: never[]) => Promise<unknown>>(fn: T): T => new Proxy(fn, {
    apply(target, receiver, args) {
      if (ctx.mcpReq.signal.aborted) return Promise.reject(new SdkError(SdkErrorCode.ConnectionClosed, "Request was cancelled"));
      return Reflect.apply(target, receiver, args);
    },
  });
  const guardNotification = <T extends (...args: never[]) => Promise<void>>(fn: T): T => new Proxy(fn, {
    apply(target, receiver, args) {
      if (ctx.mcpReq.signal.aborted) return Promise.resolve();
      return Reflect.apply(target, receiver, args);
    },
  });
  const mcpReq = {
    ...ctx.mcpReq,
    send: guardRequest(ctx.mcpReq.send),
    notify: guardNotification(ctx.mcpReq.notify),
    log: guardNotification(ctx.mcpReq.log),
    requestSampling: guardRequest(ctx.mcpReq.requestSampling),
    elicitInput: guardRequest(ctx.mcpReq.elicitInput),
  };
  return {
    ...ctx,
    mcpReq,
    signal: ctx.mcpReq.signal,
    requestId: ctx.mcpReq.id,
    _meta: ctx.mcpReq._meta,
    authInfo: ctx.http?.authInfo,
    requestInfo: ctx.http?.req ? {
      headers: Object.fromEntries(ctx.http.req.headers),
      url: new URL(ctx.http.req.url),
    } : undefined,
    sendNotification: notification => mcpReq.notify(notification),
    // Keep v1's explicit result-schema validation, including foreign Zod copies.
    sendRequest: async (request, resultSchema, options) => {
      if (ctx.mcpReq.signal.aborted) throw new McpError(ErrorCode.ConnectionClosed, "Request was cancelled");
      const passthrough = { "~standard": { version: 1 as const, vendor: "deepadb-compat", validate: (value: unknown) => ({ value }) } };
      return resultSchema.parseAsync(await mcpReq.send(request, passthrough, options));
    },
    closeSSEStream: ctx.http?.closeSSE,
    closeStandaloneSSEStream: ctx.http?.closeStandaloneSSE,
  };
}

type Callback = (...args: unknown[]) => unknown;
function callback(value: unknown): Callback {
  if (typeof value !== "function") throw new TypeError("Plugin registration requires a callback");
  return value as Callback;
}

function wrapCallback(value: unknown): Callback {
  const cb = callback(value);
  return (...args) => cb(...args.slice(0, -1), pluginContext(args.at(-1) as ServerContext));
}

/** Convert a v1 ResourceTemplate (possibly from another SDK copy) structurally. */
function template(value: unknown): ResourceTemplate {
  if (!record(value) || !record(value.uriTemplate) || typeof value.completeCallback !== "function") {
    throw new TypeError("Invalid plugin resource template");
  }
  const pattern = String(value.uriTemplate);
  const variables = new Set(Array.from(pattern.matchAll(/\{[+#./;?&]?([^}]+)\}/g))
    .flatMap(match => match[1].split(",").map(name => name.replace(/[:*].*$/, ""))));
  const complete: Record<string, NonNullable<ReturnType<ResourceTemplate["completeCallback"]>>> = {};
  for (const name of variables) {
    const cb = value.completeCallback(name);
    if (cb !== undefined) complete[name] = cb;
  }
  return new ResourceTemplate(pattern, {
    list: value.listCallback === undefined ? undefined : wrapCallback(value.listCallback) as NonNullable<ResourceTemplate["listCallback"]>,
    complete,
  });
}

/**
 * The proxy is only handed to plugins. Built-ins use native v2 registrations.
 * Methods are bound to the real server so SDK private state is never proxied.
 * This is an API adapter, not a sandbox: plugins retain their existing trust model.
 */
export function createPluginServer(server: McpServer): PluginServer {
  const wrapHandle = <T extends object>(handle: T, kind: "tool" | "prompt" | "resource", view: Record<string, unknown>): T => {
    const original = (handle as { update: (updates: Record<string, unknown>) => void }).update;
    const schemaFields: Record<string, string> = kind === "tool" ? { paramsSchema: "inputSchema", outputSchema: "outputSchema" }
      : kind === "prompt" ? { argsSchema: "argsSchema" } : {};
    const callbackField = kind === "tool" ? "handler" : kind === "prompt" ? "callback" : "readCallback";
    const update = (updates: Record<string, unknown>): void => {
      const next = { ...updates }, nextView: Record<string, unknown> = {};
      for (const [field, exposed] of Object.entries(schemaFields)) {
        if (next[field] !== undefined) {
          nextView[exposed] = publicSchema(next[field]);
          next[field] = kind === "prompt" ? promptSchema(nextView[exposed]) : schema(nextView[exposed]);
        }
      }
      if (next.template !== undefined) {
        nextView.resourceTemplate = next.template;
        next.template = template(next.template);
      }
      if (next.callback !== undefined) {
        nextView[callbackField] = callback(next.callback);
        next.callback = wrapCallback(next.callback);
      }
      original.call(handle, next);
      // Publish the legacy view only after conversion and the SDK update succeed.
      Object.assign(view, nextView);
    };
    const fieldUpdates = Object.fromEntries(Object.entries(schemaFields).map(([updateKey, field]) => [field, updateKey]));
    fieldUpdates[callbackField] = "callback";
    if (Object.hasOwn(view, "resourceTemplate")) fieldUpdates.resourceTemplate = "template";
    return new Proxy(handle, {
      get(target, key) {
        if (key === "update") return update;
        if (Object.hasOwn(view, key)) return Reflect.get(view, key);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, key, value) {
        if (typeof key === "string" && Object.hasOwn(fieldUpdates, key)) {
          update({ [fieldUpdates[key]]: value });
          return true;
        }
        return Reflect.set(target, key, value, target);
      },
      has: (target, key) => Object.hasOwn(view, key) || Reflect.has(target, key),
      ownKeys: target => [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(view)])],
      getOwnPropertyDescriptor: (target, key) => Object.hasOwn(view, key)
        ? { configurable: true, enumerable: true, writable: true, value: Reflect.get(view, key) }
        : Reflect.getOwnPropertyDescriptor(target, key),
    });
  };

  const registerTool = (name: string, config: Record<string, unknown>, cb: unknown) => {
    const inputSchema = publicSchema(config.inputSchema), outputSchema = publicSchema(config.outputSchema);
    return wrapHandle(server.registerTool(name, {
      ...config, inputSchema: schema(inputSchema), outputSchema: schema(outputSchema),
    }, wrapCallback(cb) as SdkToolCallback<StandardSchemaWithJSON>), "tool", { inputSchema, outputSchema, handler: callback(cb) });
  };
  const registerPrompt = (name: string, config: Record<string, unknown>, cb: unknown) => {
    const argsSchema = publicSchema(config.argsSchema);
    return wrapHandle(server.registerPrompt(name, {
      ...config, argsSchema: promptSchema(argsSchema),
    }, wrapCallback(cb) as SdkPromptCallback<StandardSchemaWithJSON>), "prompt", { argsSchema, callback: callback(cb) });
  };
  const registerResource = (name: string, uri: unknown, config: ResourceMetadata, cb: unknown) => {
    const view = { readCallback: callback(cb) };
    if (typeof uri === "string") return wrapHandle(server.registerResource(name, uri, config, wrapCallback(cb) as ReadResourceCallback), "resource", view);
    return wrapHandle(server.registerResource(name, template(uri), config, wrapCallback(cb) as ReadResourceTemplateCallback), "resource", { ...view, resourceTemplate: uri });
  };

  const methods = {
    registerTool, registerPrompt, registerResource,
    tool(name: string, ...rest: unknown[]) {
      const description = typeof rest[0] === "string" ? rest.shift() as string : undefined;
      const inputSchema = rest.length > 1 && rawShape(rest[0]) ? rest.shift() : undefined;
      const annotations = rest.length > 1 && record(rest[0]) ? rest.shift() : undefined;
      if (rest.length !== 1 || (record(annotations) && Object.values(annotations).some(record))) throw new TypeError("Invalid plugin tool registration");
      return registerTool(name, { description, inputSchema, annotations }, rest[0]);
    },
    prompt(name: string, ...rest: unknown[]) {
      const description = typeof rest[0] === "string" ? rest.shift() as string : undefined;
      const argsSchema = rest.length > 1 ? rest.shift() : undefined;
      if (rest.length !== 1) throw new TypeError("Invalid plugin prompt registration");
      return registerPrompt(name, { description, argsSchema }, rest[0]);
    },
    resource(name: string, uri: unknown, ...rest: unknown[]) {
      const metadata = rest.length > 1 ? rest.shift() : {};
      if (rest.length !== 1 || !record(metadata)) throw new TypeError("Invalid plugin resource registration");
      return registerResource(name, uri, metadata, rest[0]);
    },
  };
  return new Proxy(server, {
    get(target, key) {
      if (Object.hasOwn(methods, key)) return methods[key as keyof typeof methods];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PluginServer;
}
