import { Injectable } from "@nestjs/common";
import type { HardRuleDef, ModelRole } from "@envoy/types";
import {
  LlmHttpError,
  type JudgeVerdict,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmProvider,
  type LlmToolRequest,
  type LlmToolResult,
  type LlmUsage,
} from "../agent/providers/llm/types.js";
import { currentModelContext, type ModelContext } from "./model-context.js";
import { ModelProviderFactory } from "./provider-factory.js";
import { ModelResolver, type TenantTarget } from "./model-resolver.js";
import { ModelUsageRecorder } from "./model-usage.recorder.js";

/** Statuses where trying the platform default can still give the visitor an answer (bad/expired key, no credit, rate limit, provider down). */
function isFailoverError(err: unknown): boolean {
  if (err instanceof LlmHttpError) return [401, 402, 403, 429].includes(err.status) || err.status >= 500;
  return true; // network error, timeout, DNS — not the visitor's fault
}

/**
 * The LlmProvider every call site already injects. With no model context (or
 * a tenant that configured nothing) it IS the platform provider; with one it
 * routes each call to the tenant's own key and model for that role, records
 * usage, and — when the tenant key fails and they allow it — answers from the
 * platform default instead of failing the visitor.
 */
@Injectable()
export class RoutedLlmProvider implements LlmProvider {
  readonly name = "routed";

  constructor(
    private readonly platform: LlmProvider,
    private readonly resolver: ModelResolver,
    private readonly factory: ModelProviderFactory,
    private readonly usage: ModelUsageRecorder,
  ) {}

  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    return this.route(req.purpose, (p) => p.complete(req));
  }

  completeWithTools(req: LlmToolRequest): Promise<LlmToolResult> {
    return this.route("chat", (p) => p.completeWithTools(req));
  }

  judge(candidateText: string, hardRules: HardRuleDef[]): Promise<JudgeVerdict> {
    return this.route("judge", (p) => p.judge(candidateText, hardRules));
  }

  private async route<T extends { usage?: LlmUsage }>(role: ModelRole, call: (p: LlmProvider) => Promise<T>): Promise<T> {
    const ctx = currentModelContext();
    if (!ctx) return call(this.platform);

    const target = await this.resolver.resolve(ctx, role);
    if (target.kind === "platform") {
      if (target.reason && !target.allowFallback) throw new Error(target.reason);
      return this.callPlatform(ctx, role, call);
    }

    const started = Date.now();
    try {
      const result = await call(this.factory.create(target.provider, target.apiKey, target.model, target.baseUrl));
      this.finish(ctx, role, target, started, true, result.usage);
      void this.resolver.touch(ctx, target.credentialId);
      return result;
    } catch (err) {
      this.finish(ctx, role, target, started, false);
      if (err instanceof LlmHttpError && (err.status === 401 || err.status === 403)) {
        await this.resolver.markInvalid(ctx, target.credentialId, err.message);
      }
      if (target.allowFallback && isFailoverError(err)) {
        return this.callPlatform(ctx, role, call, true);
      }
      throw err;
    }
  }

  private async callPlatform<T extends { usage?: LlmUsage }>(
    ctx: ModelContext,
    role: ModelRole,
    call: (p: LlmProvider) => Promise<T>,
    failedOver = false,
  ): Promise<T> {
    const started = Date.now();
    const model = this.platform.model ?? this.platform.name;
    ctx.lastRoute = { provider: this.platform.name, model, keySource: "platform", failedOver };
    try {
      const result = await call(this.platform);
      this.total(ctx, result.usage);
      this.usage.record({ tenantId: ctx.tenantId, role, provider: this.platform.name, model, keySource: "platform", usage: result.usage, latencyMs: Date.now() - started, ok: true });
      return result;
    } catch (err) {
      this.usage.record({ tenantId: ctx.tenantId, role, provider: this.platform.name, model, keySource: "platform", latencyMs: Date.now() - started, ok: false });
      throw err;
    }
  }

  private total(ctx: ModelContext, usage?: LlmUsage) {
    ctx.totals ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
    ctx.totals.calls += 1;
    ctx.totals.inputTokens += usage?.inputTokens ?? 0;
    ctx.totals.outputTokens += usage?.outputTokens ?? 0;
  }

  private finish(ctx: ModelContext, role: ModelRole, t: TenantTarget, started: number, ok: boolean, usage?: LlmUsage) {
    ctx.lastRoute = { provider: t.provider, model: t.model, keySource: "tenant" };
    this.total(ctx, usage);
    this.usage.record({
      tenantId: ctx.tenantId,
      credentialId: t.credentialId,
      role,
      provider: t.provider,
      model: t.model,
      keySource: "tenant",
      usage,
      latencyMs: Date.now() - started,
      ok,
    });
  }
}
