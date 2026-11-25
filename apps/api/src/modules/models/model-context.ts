import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelConfig, ModelKeySourceName } from "./types.js";

export interface ModelRoute {
  provider: string;
  model: string;
  keySource: ModelKeySourceName;
  /** True when a tenant key failed and the platform default answered instead. */
  failedOver?: boolean;
}

/**
 * Who a model call is for. Set once around a unit of work (one visitor turn,
 * one summary job); every LLM call made inside it — however deep — resolves
 * its provider and key from this, so no call site has to pass a tenant down.
 */
export interface ModelContext {
  tenantId: string;
  /** The agent's own overrides (AgentSpec.models), which win over the workspace config. */
  agentModels?: Partial<ModelConfig>;
  /** The route the most recent call took — read by the agent loop for its trace. */
  lastRoute?: ModelRoute;
  /** Don't write usage rows for this context (the experiment runner, whose "tenant" is not a real workspace). Totals are still counted. */
  unrecorded?: boolean;
  /** Running token/call totals for everything routed in this context — used to cost a scenario run. */
  totals?: { calls: number; inputTokens: number; outputTokens: number };
  /** Per-context memo so one turn costs one config read, not one per model call. */
  _tenant?: Promise<unknown>;
  _touched?: Set<string>;
}

const storage = new AsyncLocalStorage<ModelContext>();

export const runWithModelContext = <T>(ctx: ModelContext, fn: () => T): T => storage.run(ctx, fn);
export const currentModelContext = (): ModelContext | undefined => storage.getStore();
