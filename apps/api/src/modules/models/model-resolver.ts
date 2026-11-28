import { Injectable, Logger } from "@nestjs/common";
import { ModelConfig, supportsVoiceRole, type ModelProviderKind, type ModelRole, type VoiceRole } from "@envoy/types";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { decryptToken } from "../crm/token-crypto.js";
import type { ModelContext } from "./model-context.js";

export interface TenantTarget {
  kind: "tenant";
  credentialId: string;
  provider: ModelProviderKind;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  /** TTS only: the voice to speak in. */
  voice?: string;
  allowFallback: boolean;
}
export interface PlatformTarget {
  kind: "platform";
  /** Why the platform default is serving this role, when a tenant choice existed but couldn't be used. */
  reason?: string;
  allowFallback: boolean;
}
export type ModelTarget = TenantTarget | PlatformTarget;

interface TenantModels {
  config: ModelConfig;
  credentials: Map<string, { id: string; provider: ModelProviderKind; encryptedKey: string; baseUrl: string | null; status: string }>;
}

@Injectable()
export class ModelResolver {
  private readonly logger = new Logger(ModelResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  private load(ctx: ModelContext): Promise<TenantModels> {
    ctx._tenant ??= (async () => {
      const [tenant, credentials] = await Promise.all([
        this.prisma.client.tenant.findUnique({ where: { id: ctx.tenantId }, select: { modelConfig: true } }),
        this.prisma.client.modelCredential.findMany({ where: { tenantId: ctx.tenantId } }),
      ]);
      const parsed = ModelConfig.safeParse(tenant?.modelConfig ?? {});
      return {
        config: parsed.success ? parsed.data : ModelConfig.parse({}),
        credentials: new Map(credentials.map((c) => [c.id, c])),
      } satisfies TenantModels;
    })();
    return ctx._tenant as Promise<TenantModels>;
  }

  /** The agent's override beats the workspace's; within a level a role's own choice beats `default`. */
  async resolve(ctx: ModelContext, role: ModelRole | VoiceRole): Promise<ModelTarget> {
    const { config, credentials } = await this.load(ctx);
    // Voice never falls back to `default`: that names a chat model, which can't listen or speak.
    const voice = role === "stt" || role === "tts";
    const choice = voice ? (ctx.agentModels?.[role] ?? config[role]) : (ctx.agentModels?.[role] ?? ctx.agentModels?.default ?? config[role] ?? config.default);
    const allowFallback = config.allowPlatformFallback;
    if (!choice) return { kind: "platform", allowFallback };

    // Looked up only among THIS tenant's credentials, so an agent spec naming someone else's credential id resolves to nothing.
    const credential = credentials.get(choice.credentialId);
    if (!credential) return { kind: "platform", reason: "The selected API key no longer exists.", allowFallback };
    if (credential.status !== "active") return { kind: "platform", reason: "The selected API key was rejected by its provider.", allowFallback };
    if (voice && !supportsVoiceRole(credential.provider, role)) return { kind: "platform", reason: `That provider can't do ${role === "stt" ? "speech-to-text" : "text-to-speech"}.`, allowFallback };

    return {
      kind: "tenant",
      credentialId: credential.id,
      provider: credential.provider,
      model: choice.model,
      apiKey: decryptToken(credential.encryptedKey),
      baseUrl: credential.baseUrl,
      voice: "voice" in choice ? (choice.voice as string | undefined) : undefined,
      allowFallback,
    };
  }

  /** Drops the memo after a credential's status changes mid-run, so the next call sees it. */
  invalidate(ctx: ModelContext) {
    ctx._tenant = undefined;
  }

  async markInvalid(ctx: ModelContext, credentialId: string, error: string) {
    await this.prisma.client.modelCredential
      .updateMany({ where: { id: credentialId, tenantId: ctx.tenantId }, data: { status: "invalid", lastError: error.slice(0, 300) } })
      .catch((err: Error) => this.logger.warn(`could not mark credential invalid: ${err.message}`));
    this.invalidate(ctx);
  }

  async touch(ctx: ModelContext, credentialId: string) {
    ctx._touched ??= new Set();
    if (ctx._touched.has(credentialId)) return;
    ctx._touched.add(credentialId);
    await this.prisma.client.modelCredential
      .updateMany({ where: { id: credentialId, tenantId: ctx.tenantId }, data: { lastUsedAt: new Date(), lastError: null } })
      .catch(() => {});
  }
}
