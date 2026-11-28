import type { VoiceRole } from "@envoy/types";
import { LlmHttpError } from "../agent/providers/llm/types.js";
import type { SttProvider, SttTranscribeResult, TtsProvider, TtsSynthesizeResult } from "../agent/providers/voice/types.js";
import { currentModelContext } from "./model-context.js";
import { ModelProviderFactory } from "./provider-factory.js";
import { ModelResolver, type TenantTarget } from "./model-resolver.js";
import { ModelUsageRecorder } from "./model-usage.recorder.js";

const isFailoverError = (err: unknown) => !(err instanceof LlmHttpError) || [401, 402, 403, 429].includes(err.status) || err.status >= 500;

/**
 * Voice's version of RoutedLlmProvider: the workspace's (or agent's) own speech key when one is set, the platform's
 * voice otherwise, and the platform's voice again if the tenant key fails and fallback is allowed — so a dead key
 * never leaves a visitor talking to silence.
 */
async function route<P, T>(
  deps: { resolver: ModelResolver; usage: ModelUsageRecorder },
  role: VoiceRole,
  platform: P & { name: string },
  build: (t: TenantTarget) => P,
  call: (p: P) => Promise<T>,
): Promise<T> {
  const ctx = currentModelContext();
  if (!ctx) return call(platform);

  const record = (entry: { provider: string; model: string; keySource: "tenant" | "platform"; credentialId?: string; ok: boolean; started: number }) => {
    if (!ctx.unrecorded) deps.usage.record({ tenantId: ctx.tenantId, role, provider: entry.provider, model: entry.model, keySource: entry.keySource, credentialId: entry.credentialId, latencyMs: Date.now() - entry.started, ok: entry.ok });
  };
  const onPlatform = async () => {
    const started = Date.now();
    try {
      const out = await call(platform);
      record({ provider: platform.name, model: platform.name, keySource: "platform", ok: true, started });
      return out;
    } catch (err) {
      record({ provider: platform.name, model: platform.name, keySource: "platform", ok: false, started });
      throw err;
    }
  };

  const target = await deps.resolver.resolve(ctx, role);
  if (target.kind === "platform") {
    if (target.reason && !target.allowFallback) throw new Error(target.reason);
    return onPlatform();
  }
  const started = Date.now();
  try {
    const out = await call(build(target));
    record({ provider: target.provider, model: target.model, keySource: "tenant", credentialId: target.credentialId, ok: true, started });
    if (!ctx.unrecorded) void deps.resolver.touch(ctx, target.credentialId);
    return out;
  } catch (err) {
    record({ provider: target.provider, model: target.model, keySource: "tenant", credentialId: target.credentialId, ok: false, started });
    if (err instanceof LlmHttpError && (err.status === 401 || err.status === 403)) await deps.resolver.markInvalid(ctx, target.credentialId, err.message);
    if (target.allowFallback && isFailoverError(err)) return onPlatform();
    throw err;
  }
}

export class RoutedSttProvider implements SttProvider {
  readonly name = "routed";
  constructor(private readonly platform: SttProvider, private readonly resolver: ModelResolver, private readonly factory: ModelProviderFactory, private readonly usage: ModelUsageRecorder) {}

  transcribe(audioBase64: string, mimeType: string): Promise<SttTranscribeResult> {
    return route({ resolver: this.resolver, usage: this.usage }, "stt", this.platform, (t) => this.factory.createStt(t.provider, t.apiKey, t.model, t.baseUrl), (p) => p.transcribe(audioBase64, mimeType));
  }
}

export class RoutedTtsProvider implements TtsProvider {
  readonly name = "routed";
  constructor(private readonly platform: TtsProvider, private readonly resolver: ModelResolver, private readonly factory: ModelProviderFactory, private readonly usage: ModelUsageRecorder) {}

  synthesize(text: string): Promise<TtsSynthesizeResult> {
    return route({ resolver: this.resolver, usage: this.usage }, "tts", this.platform, (t) => this.factory.createTts(t.provider, t.apiKey, t.model, t.voice, t.baseUrl), (p) => p.synthesize(text));
  }
}
