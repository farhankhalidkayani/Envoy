import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import {
  MODEL_CATALOG,
  MODEL_ROLES,
  ModelConfig,
  VOICE_ROLES,
  supportsVoiceRole,
  type ModelProviderKind,
  type ModelRole,
} from "@envoy/types";
import { AuditService } from "../core/audit/audit.service.js";
import { assertPublicUrl } from "../core/common/safe-fetch.js";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { decryptToken, encryptToken } from "../crm/token-crypto.js";
import { LlmHttpError } from "../agent/providers/llm/types.js";
import { ModelProviderFactory } from "./provider-factory.js";

const MAX_CREDENTIALS_PER_TENANT = 10;
/** Every place in a model config that can point at a stored key. */
const SLOTS = ["default", ...MODEL_ROLES, ...VOICE_ROLES] as const;

export interface AddCredentialInput {
  provider: ModelProviderKind;
  label: string;
  apiKey: string;
  baseUrl?: string;
  /** Model used for the connection test (and shown as the suggested default). */
  testModel?: string;
}

/** Plain-language reason a provider call failed — never includes the key or raw provider body. */
export function describeProviderFailure(err: unknown): string {
  if (err instanceof LlmHttpError) {
    if (err.status === 401 || err.status === 403) return "The provider rejected this API key. Check it was copied correctly and has access to the model.";
    if (err.status === 404) return "The provider doesn't recognise that model name. Check the model id.";
    if (err.status === 402 || err.status === 429) return "The key looks valid but the provider refused the request (rate limit or no credit). Check your plan and billing with the provider.";
    if (err.status >= 500) return "The provider returned an error. Try again in a moment.";
    return `The provider rejected the test request (HTTP ${err.status}).`;
  }
  const message = err instanceof Error ? err.message : "";
  if (/resolves to a private|Only http/i.test(message)) return "That base URL isn't allowed: it must be a public http(s) address.";
  return "Couldn't reach the provider. Check the base URL and your network.";
}

function defaultTestModel(provider: ModelProviderKind): string | undefined {
  if (provider === "openai_compatible") return undefined;
  const models = MODEL_CATALOG[provider];
  return (models.find((m) => m.tier === "fast") ?? models[0])?.id;
}

@Injectable()
export class ModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly factory: ModelProviderFactory,
  ) {}

  private view(c: { id: string; provider: ModelProviderKind; label: string; last4: string; baseUrl: string | null; status: string; lastUsedAt: Date | null; lastError: string | null; createdAt: Date }) {
    // The encrypted key is deliberately not selected into this shape.
    return { id: c.id, provider: c.provider, label: c.label, last4: c.last4, baseUrl: c.baseUrl, status: c.status, lastUsedAt: c.lastUsedAt, lastError: c.lastError, createdAt: c.createdAt };
  }

  async listCredentials(tenantId: string) {
    const rows = await this.prisma.client.modelCredential.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => this.view(r));
  }

  /** Makes one tiny real call, so a typo'd key is caught at save time, not mid-conversation. */
  private async testKey(provider: ModelProviderKind, apiKey: string, model: string, baseUrl?: string | null): Promise<void> {
    try {
      await this.factory
        .create(provider, apiKey, model, baseUrl)
        .complete({ purpose: "chat", messages: [{ role: "user", content: "Reply with the single word OK." }], maxTokens: 16 });
    } catch (err) {
      throw new BadRequestException(describeProviderFailure(err));
    }
  }

  async addCredential(tenantId: string, actorUserId: string, input: AddCredentialInput) {
    if ((await this.prisma.client.modelCredential.count({ where: { tenantId } })) >= MAX_CREDENTIALS_PER_TENANT) {
      throw new BadRequestException(`You can store at most ${MAX_CREDENTIALS_PER_TENANT} API keys.`);
    }
    if (input.provider === "openai_compatible" && !input.baseUrl) {
      throw new BadRequestException("A base URL is required for an OpenAI-compatible endpoint.");
    }
    if (input.baseUrl) {
      try {
        await assertPublicUrl(input.baseUrl);
      } catch (err) {
        throw new BadRequestException(describeProviderFailure(err));
      }
    }
    const model = input.testModel ?? defaultTestModel(input.provider);
    if (!model) throw new BadRequestException("Enter a model name to test this endpoint with.");

    await this.testKey(input.provider, input.apiKey, model, input.baseUrl);

    const created = await this.prisma.client.modelCredential.create({
      data: {
        tenantId,
        provider: input.provider,
        label: input.label,
        encryptedKey: encryptToken(input.apiKey),
        last4: input.apiKey.slice(-4),
        baseUrl: input.baseUrl ?? null,
      },
    });
    await this.audit.log(actorUserId, tenantId, "model_credential.added", { credentialId: created.id, provider: input.provider, label: input.label });
    return this.view(created);
  }

  private async owned(tenantId: string, id: string) {
    const credential = await this.prisma.client.modelCredential.findFirst({ where: { id, tenantId } });
    if (!credential) throw new NotFoundException("API key not found");
    return credential;
  }

  /** Re-tests a stored key (e.g. after the tenant fixes billing) and updates its status. */
  async testCredential(tenantId: string, id: string, model?: string) {
    const credential = await this.owned(tenantId, id);
    const testModel = model ?? defaultTestModel(credential.provider);
    if (!testModel) throw new BadRequestException("Enter a model name to test this endpoint with.");
    try {
      await this.factory
        .create(credential.provider, decryptToken(credential.encryptedKey), testModel, credential.baseUrl)
        .complete({ purpose: "chat", messages: [{ role: "user", content: "Reply with the single word OK." }], maxTokens: 16 });
    } catch (err) {
      const message = describeProviderFailure(err);
      const rejected = err instanceof LlmHttpError && (err.status === 401 || err.status === 403);
      await this.prisma.client.modelCredential.update({
        where: { id },
        data: { ...(rejected ? { status: "invalid" as const } : {}), lastError: message },
      });
      return { ok: false as const, error: message };
    }
    await this.prisma.client.modelCredential.update({ where: { id }, data: { status: "active", lastError: null } });
    return { ok: true as const };
  }

  async deleteCredential(tenantId: string, actorUserId: string, id: string) {
    const credential = await this.owned(tenantId, id);
    await this.prisma.client.modelCredential.delete({ where: { id } });
    // Don't leave the workspace config pointing at a key that no longer exists.
    const config = await this.getConfig(tenantId);
    const cleaned: Record<string, unknown> = { ...config };
    for (const slot of SLOTS) {
      if ((cleaned[slot] as { credentialId?: string } | undefined)?.credentialId === id) delete cleaned[slot];
    }
    await this.prisma.client.tenant.update({ where: { id: tenantId }, data: { modelConfig: cleaned as Prisma.InputJsonValue } });
    await this.audit.log(actorUserId, tenantId, "model_credential.removed", { credentialId: id, provider: credential.provider, label: credential.label });
  }

  async getConfig(tenantId: string): Promise<ModelConfig> {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id: tenantId }, select: { modelConfig: true } });
    const parsed = ModelConfig.safeParse(tenant?.modelConfig ?? {});
    return parsed.success ? parsed.data : ModelConfig.parse({});
  }

  async setConfig(tenantId: string, actorUserId: string, config: ModelConfig): Promise<ModelConfig> {
    const referenced = new Set(
      SLOTS.map((slot) => (config as unknown as Record<string, { credentialId?: string } | undefined>)[slot]?.credentialId).filter((v): v is string => !!v),
    );
    if (referenced.size > 0) {
      const found = await this.prisma.client.modelCredential.findMany({ where: { tenantId, id: { in: [...referenced] } }, select: { id: true, provider: true } });
      // A credential id from another tenant looks identical to a missing one.
      if (found.length !== referenced.size) throw new BadRequestException("One of the selected API keys doesn't exist.");
      for (const role of VOICE_ROLES) {
        const choice = config[role];
        const provider = choice && found.find((c) => c.id === choice.credentialId)?.provider;
        if (provider && !supportsVoiceRole(provider, role)) {
          throw new BadRequestException(`That key can't be used for ${role === "stt" ? "speech-to-text" : "text-to-speech"}: ${provider} doesn't offer it.`);
        }
      }
    }
    await this.prisma.client.tenant.update({ where: { id: tenantId }, data: { modelConfig: config as Prisma.InputJsonValue } });
    await this.audit.log(actorUserId, tenantId, "model_config.updated", { roles: [...referenced].length });
    return config;
  }

  /** What serves each role right now, and whether the tenant is still on the shared default. Drives the portal's banner and badges. */
  async getStatus(tenantId: string) {
    const [config, credentials] = await Promise.all([this.getConfig(tenantId), this.listCredentials(tenantId)]);
    const active = new Map(credentials.filter((c) => c.status === "active").map((c) => [c.id, c]));
    const roles = Object.fromEntries(
      MODEL_ROLES.map((role: ModelRole) => {
        const choice = config[role] ?? config.default;
        const credential = choice ? active.get(choice.credentialId) : undefined;
        return [role, credential && choice ? { source: "tenant" as const, provider: credential.provider, model: choice.model } : { source: "platform" as const }];
      }),
    ) as Record<ModelRole, { source: "tenant" | "platform"; provider?: ModelProviderKind; model?: string }>;
    // Voice: set individually, never inherited from `default`.
    const voice = Object.fromEntries(
      VOICE_ROLES.map((role) => {
        const choice = config[role];
        const credential = choice ? active.get(choice.credentialId) : undefined;
        return [role, credential && choice ? { source: "tenant" as const, provider: credential.provider, model: choice.model, ...(role === "tts" && config.tts?.voice ? { voice: config.tts.voice } : {}) } : { source: "platform" as const }];
      }),
    ) as Record<"stt" | "tts", { source: "tenant" | "platform"; provider?: ModelProviderKind; model?: string; voice?: string }>;
    return {
      usingPlatformDefault: !Object.values(roles).some((r) => r.source === "tenant"),
      voice,
      hasInvalidCredential: credentials.some((c) => c.status === "invalid"),
      credentialCount: credentials.length,
      roles,
      config,
    };
  }

  async getUsage(tenantId: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const groups = await this.prisma.client.modelUsage.groupBy({
      by: ["keySource", "provider", "model", "role"],
      where: { tenantId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, latencyMs: true },
    });
    const failures = await this.prisma.client.modelUsage.groupBy({
      by: ["keySource", "provider", "model", "role"],
      where: { tenantId, createdAt: { gte: since }, ok: false },
      _count: { _all: true },
    });
    const failed = new Map(failures.map((f) => [`${f.keySource}|${f.provider}|${f.model}|${f.role}`, f._count._all]));
    return {
      days,
      rows: groups.map((g) => ({
        keySource: g.keySource,
        provider: g.provider,
        model: g.model,
        role: g.role,
        calls: g._count._all,
        failures: failed.get(`${g.keySource}|${g.provider}|${g.model}|${g.role}`) ?? 0,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        avgLatencyMs: g._count._all ? Math.round((g._sum.latencyMs ?? 0) / g._count._all) : 0,
      })),
    };
  }
}
