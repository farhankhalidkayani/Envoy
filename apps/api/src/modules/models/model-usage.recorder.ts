import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../core/prisma/prisma.service.js";
import type { LlmUsage } from "../agent/providers/llm/types.js";
import type { ModelKeySourceName } from "./types.js";

export interface UsageEntry {
  tenantId: string;
  credentialId?: string;
  role: string;
  provider: string;
  model: string;
  keySource: ModelKeySourceName;
  usage?: LlmUsage;
  latencyMs: number;
  ok: boolean;
}

/** Fire-and-forget: accounting must never slow or break a visitor's reply. */
@Injectable()
export class ModelUsageRecorder {
  private readonly logger = new Logger(ModelUsageRecorder.name);

  constructor(private readonly prisma: PrismaService) {}

  record(entry: UsageEntry): void {
    this.prisma.client.modelUsage
      .create({
        data: {
          tenantId: entry.tenantId,
          credentialId: entry.credentialId,
          role: entry.role,
          provider: entry.provider,
          model: entry.model,
          keySource: entry.keySource,
          inputTokens: entry.usage?.inputTokens,
          outputTokens: entry.usage?.outputTokens,
          latencyMs: entry.latencyMs,
          ok: entry.ok,
        },
      })
      .catch((err: Error) => this.logger.debug(`usage not recorded: ${err.message}`));
  }
}
