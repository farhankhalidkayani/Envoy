import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequireFeature } from "../core/auth/decorators/require-feature.decorator.js";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { FeatureGuard } from "../core/auth/guards/feature.guard.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { IntegrationsService } from "./integrations.service.js";

const WebhookConfigDto = z.object({
  url: z.string().url(),
  method: z.enum(["POST", "PUT", "PATCH"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  payloadTemplate: z.string().optional(),
});

const EmailConfigDto = z.object({
  to: z.string().email(),
  subject: z.string(),
  bodyTemplate: z.string(),
});

const CalendarConfigDto = z.object({
  calendarId: z.string().optional(),
  titleTemplate: z.string(),
  descriptionTemplate: z.string().optional(),
  startField: z.string(),
  durationMinutes: z.number().int().positive().optional(),
});

const GUARDS = [JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard] as const;

@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  list(@CurrentUser() user: JwtPayload) {
    return this.integrations.getConnections(user.tenantId!);
  }

  @Post("webhook/connect")
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  connectWebhook(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(WebhookConfigDto)) config: z.infer<typeof WebhookConfigDto>,
  ) {
    return this.integrations.connectWebhook(user.tenantId!, config);
  }

  @Post("email/connect")
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  connectEmail(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(EmailConfigDto)) config: z.infer<typeof EmailConfigDto>,
  ) {
    return this.integrations.connectEmail(user.tenantId!, config);
  }

  @Post("calendar/connect")
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  connectCalendar(@CurrentUser() user: JwtPayload) {
    return this.integrations.initiateCalendarConnect(user.tenantId!);
  }

  @Patch(":type/config")
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  updateConfig(
    @CurrentUser() user: JwtPayload,
    @Param("type") type: "webhook" | "email" | "calendar",
    @Body() config: Record<string, unknown>,
  ) {
    const dto = type === "webhook" ? WebhookConfigDto : type === "email" ? EmailConfigDto : CalendarConfigDto;
    return this.integrations.updateConfig(user.tenantId!, type, dto.parse(config));
  }

  @Delete(":type")
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  disconnect(@CurrentUser() user: JwtPayload, @Param("type") type: "webhook" | "email" | "calendar") {
    return this.integrations.disconnect(user.tenantId!, type);
  }

  @Post(":type/push/:conversationId")
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  pushConversation(
    @CurrentUser() user: JwtPayload,
    @Param("type") type: "webhook" | "email" | "calendar",
    @Param("conversationId") conversationId: string,
  ) {
    return this.integrations.pushForTenant(user.tenantId!, type, { conversationId });
  }

  @Post(":type/push/submission/:submissionId")
  @UseGuards(...GUARDS)
  @RequireFeature("integrations")
  pushSubmission(
    @CurrentUser() user: JwtPayload,
    @Param("type") type: "webhook" | "email" | "calendar",
    @Param("submissionId") submissionId: string,
  ) {
    return this.integrations.pushForTenant(user.tenantId!, type, { formSubmissionId: submissionId });
  }

  /** Public — Google's OAuth redirect target, same pattern as CrmController#callback. */
  @Get("calendar/callback")
  async calendarCallback(@Query("code") code: string, @Query("state") tenantId: string) {
    await this.integrations.handleCalendarCallback(code, tenantId);
    return { connected: true };
  }
}
