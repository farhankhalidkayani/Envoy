import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { TenantLockGuard } from "../../billing/guards/tenant-lock.guard.js";
import { CurrentUser } from "../../core/auth/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../../core/auth/types.js";
import { ZodValidationPipe } from "../../core/common/zod-validation.pipe.js";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import { ConversationEngineService } from "./conversation-engine.service.js";
import { ConversationsService } from "./conversations.service.js";

const CompleteDto = z.object({ publicToken: z.string() });

/**
 * Two auth models on one controller, split at the method level: `complete`
 * is the public runtime API (scoped by the agent's publicToken, no JWT —
 * the widget calls this), while `findAll`/`findOne` are the portal's
 * JWT-authenticated, tenant-scoped dashboard reads.
 */
@Controller("conversations")
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly engine: ConversationEngineService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Secondary completion path — the primary one is the WS gateway detecting
   * the model's completion marker mid-conversation (agent.gateway.ts). This
   * exists for cases the socket can't cover cleanly: the visitor closes the
   * tab, or the widget wants to force-complete with whatever was captured
   * so far.
   */
  @Post(":id/complete")
  async complete(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CompleteDto)) body: z.infer<typeof CompleteDto>,
  ) {
    const conversation = await this.prisma.client.conversation.findUnique({
      where: { id },
      include: { agent: true },
    });
    if (!conversation || conversation.agent.publicToken !== body.publicToken) {
      throw new NotFoundException("Conversation not found");
    }
    if (conversation.status === "completed") {
      return conversation;
    }

    const history = await this.engine.getHistory(id);
    return this.conversations.complete({
      conversationId: id,
      capturedData: (conversation.capturedData as Record<string, unknown>) ?? {},
      history,
    });
  }

  @Get()
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard)
  findAll(@CurrentUser() user: JwtPayload, @Query("agentId") agentId?: string) {
    return this.conversations.findAllForTenant(user.tenantId!, agentId);
  }

  @Get(":id")
  @UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard)
  findOne(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.conversations.findOneForTenant(user.tenantId!, id);
  }
}
