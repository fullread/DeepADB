// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Compile-only fixture: existing typed plugins keep their original ToolContext. */
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { ResourceTemplate, type RegisteredPrompt, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, NativePluginToolContext } from "../../src/tool-context.js";

export function register(ctx: ToolContext): void {
  const tool = ctx.server.tool("typed_plugin", "Legacy typed tool", { value: z.number().min(0).max(5) }, (args, extra) => {
    extra.signal.throwIfAborted();
    return { content: [{ type: "text", text: String(args.value) }] };
  });
  tool.update({ paramsSchema: { value: z.number().min(1).max(5) }, callback: args => ({ content: [{ type: "text", text: String(args.value) }] }) });
  ctx.server.tool("typed_zod3", { value: z3.string() }, args => ({ content: [{ type: "text", text: args.value }] }));
  ctx.server.resource("typed_resource", new ResourceTemplate("fixture://{name}", { list: undefined }), (uri, variables, extra) => {
    extra.signal.throwIfAborted();
    return { contents: [{ uri: uri.href, text: String(variables.name) }] };
  });
  ctx.server.registerTool("native_typed", { inputSchema: z.object({ value: z.string() }) }, args => ({ content: [{ type: "text", text: args.value }] }));
  const configured = ctx.server.registerTool("legacy_configured", { inputSchema: { value: z.string() } }, (args, extra) => {
    extra.signal.throwIfAborted();
    args.value.toUpperCase();
    // @ts-expect-error Schema inference must still reject the wrong argument type.
    args.value.toFixed();
    return { content: [{ type: "text", text: args.value }] };
  });
  configured.update({ paramsSchema: { value: z.number() }, callback: (args, extra) => {
    extra.signal.throwIfAborted();
    return { content: [{ type: "text", text: args.value.toFixed() }] };
  } });
  ctx.server.registerTool("legacy_object", { inputSchema: z.object({ value: z.string() }) }, (args, extra) => {
    extra.signal.throwIfAborted();
    return { content: [{ type: "text", text: args.value }] };
  });
  const prompt = ctx.server.registerPrompt("legacy_configured_prompt", { argsSchema: { value: z.string() } }, (args, extra) => {
    extra.signal.throwIfAborted();
    return { messages: [{ role: "user", content: { type: "text", text: args.value.toUpperCase() } }] };
  });
  // Public v1 handle fields must remain usable, not just the update() method.
  const savedPromptCallback: RegisteredPrompt["callback"] = prompt.callback;
  const savedToolHandler: RegisteredTool["handler"] = tool.handler;
  void savedPromptCallback; void savedToolHandler;
  if (tool.inputSchema && "safeParse" in tool.inputSchema) tool.inputSchema.safeParse({ value: 2 });
  if (prompt.argsSchema && "safeParse" in prompt.argsSchema) prompt.argsSchema.safeParse({ value: "text" });
  ctx.server.registerResource("legacy_configured_resource", "fixture://static", {}, (uri, extra) => {
    extra.signal.throwIfAborted();
    return { contents: [{ uri: uri.href, text: "static" }] };
  });
  ctx.server.registerResource("legacy_configured_template", new ResourceTemplate("fixture://configured/{name}", { list: undefined }), {}, (uri, variables, extra) => {
    extra.signal.throwIfAborted();
    return { contents: [{ uri: uri.href, text: String(variables.name) }] };
  });
}

/** New plugins can opt into native v2 callback types without losing inference. */
export function registerNative(ctx: NativePluginToolContext): void {
  ctx.server.registerTool("native_context", { inputSchema: z.object({ value: z.string() }) }, (args, context) => {
    context.mcpReq.signal.throwIfAborted();
    // @ts-expect-error Native schema inference must still reject the wrong type.
    args.value.toFixed();
    return { content: [{ type: "text", text: args.value.toUpperCase() }] };
  });
  ctx.server.registerPrompt("native_prompt", { argsSchema: z.object({ value: z.string() }) }, (args, context) => {
    context.mcpReq.signal.throwIfAborted();
    return { messages: [{ role: "user", content: { type: "text", text: args.value } }] };
  });
  ctx.server.registerResource("native_resource", "fixture://native", {}, (uri, context) => {
    context.mcpReq.signal.throwIfAborted();
    return { contents: [{ uri: uri.href, text: "native" }] };
  });
}
