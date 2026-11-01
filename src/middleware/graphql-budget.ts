// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
import type { DocumentNode, SelectionSetNode, ValueNode } from "graphql";
import { GraphQLClientError } from "./graphql-errors.js";

/** Bound expanded selections, including repeated fragments, before any I/O. */
export function checkGraphQLBudget(document: DocumentNode, variables: Record<string, unknown>): void {
  const fragments = new Map(document.definitions.filter(d => d.kind === "FragmentDefinition").map(d => [d.name.value, d]));
  let fields = 0, aliases = 0, nodes = 0;
  const value = (node: ValueNode): unknown => node.kind === "Variable" ? variables[node.name.value]
    : node.kind === "ListValue" ? node.values.map(value) : undefined;
  const walk = (set: SelectionSetNode, depth: number, active: Set<string>): void => {
    if (depth > 10) throw new GraphQLClientError("DEPTH_LIMIT");
    for (const selection of set.selections) {
      if (++nodes > 256) throw new GraphQLClientError("COMPLEXITY_LIMIT");
      if (selection.kind === "FragmentSpread") {
        const name = selection.name.value;
        if (active.has(name)) throw new GraphQLClientError("FRAGMENT_CYCLE");
        const fragment = fragments.get(name);
        if (fragment) walk(fragment.selectionSet, depth, new Set([...active, name]));
      } else if (selection.kind === "InlineFragment") {
        walk(selection.selectionSet, depth, active);
      } else {
        if (++fields > 100 || (selection.alias && ++aliases > 16)) throw new GraphQLClientError("FIELD_LIMIT");
        if (selection.name.value === "properties") {
          const keys = selection.arguments?.find(a => a.name.value === "keys");
          const requested = keys && value(keys.value);
          if (Array.isArray(requested) && requested.length > 100) throw new GraphQLClientError("PROPERTY_LIMIT");
        }
        if (selection.selectionSet) walk(selection.selectionSet, depth + 1, active);
      }
    }
  };
  for (const definition of document.definitions) {
    if (definition.kind === "OperationDefinition") {
      // Account for defaults too, not only JSON variable values.
      for (const variable of definition.variableDefinitions ?? []) {
        if (variables[variable.variable.name.value] === undefined && variable.defaultValue) {
          variables = { ...variables, [variable.variable.name.value]: value(variable.defaultValue) };
        }
      }
      walk(definition.selectionSet, 1, new Set());
    }
  }
}

/** Shared across requests; slots stay occupied until the actual I/O finishes. */
export class GraphQLWorkPool {
  private running = 0;
  private queue: Array<() => void> = [];
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= 4) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.running++;
    try { return await work(); }
    finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }
}

export class GraphQLRequestBudget {
  private remaining = 64;
  private deadline = Date.now() + 30_000;
  cancelled = false;
  constructor(private pool: GraphQLWorkPool) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (--this.remaining < 0) throw new GraphQLClientError("OPERATION_LIMIT");
    return this.pool.run(async () => {
      if (this.cancelled || Date.now() >= this.deadline) throw new GraphQLClientError("REQUEST_CANCELLED");
      return work();
    });
  }
}
