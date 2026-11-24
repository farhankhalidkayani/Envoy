import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { MODEL_CATALOG, ModelConfig, ModelProviderKind, PROVIDER_LABELS } from "@envoy/types";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { Roles } from "../core/auth/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { RolesGuard } from "../core/auth/guards/roles.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { ModelsService } from "./models.service.js";

const AddCredentialDto = z.object({
  provider: ModelProviderKind,
  label: z.string().trim().min(1).max(60),
  apiKey: z.string().trim().min(8).max(500),
  baseUrl: z.string().url().max(300).optional(),
  testModel: z.string().trim().min(1).max(100).optional(),
});
const TestDto = z.object({ model: z.string().trim().min(1).max(100).optional() });

/**
 * Anyone in the workspace can see which model is serving their agents (so the
 * "shared default" notice and badges work for staff); only the owner can
 * add, test, remove or re-assign keys.
 */
@Controller("models")
@UseGuards(JwtAuthGuard, TenantScopeGuard, TenantLockGuard, RolesGuard)
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get("catalog")
  catalog() {
    return {
      providers: Object.entries(PROVIDER_LABELS).map(([id, label]) => ({
        id,
        label,
        models: id === "openai_compatible" ? [] : MODEL_CATALOG[id as keyof typeof MODEL_CATALOG],
      })),
    };
  }

  @Get("status")
  status(@CurrentUser() user: JwtPayload) {
    return this.models.getStatus(user.tenantId!);
  }

  @Get("credentials")
  list(@CurrentUser() user: JwtPayload) {
    return this.models.listCredentials(user.tenantId!);
  }

  @Post("credentials")
  @Roles("owner")
  add(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(AddCredentialDto)) body: z.infer<typeof AddCredentialDto>) {
    return this.models.addCredential(user.tenantId!, user.sub, body);
  }

  @Post("credentials/:id/test")
  @Roles("owner")
  test(@CurrentUser() user: JwtPayload, @Param("id") id: string, @Body(new ZodValidationPipe(TestDto)) body: z.infer<typeof TestDto>) {
    return this.models.testCredential(user.tenantId!, id, body.model);
  }

  @Delete("credentials/:id")
  @Roles("owner")
  async remove(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    await this.models.deleteCredential(user.tenantId!, user.sub, id);
    return { deleted: true };
  }

  @Get("config")
  config(@CurrentUser() user: JwtPayload) {
    return this.models.getConfig(user.tenantId!);
  }

  @Put("config")
  @Roles("owner")
  setConfig(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(ModelConfig)) body: ModelConfig) {
    return this.models.setConfig(user.tenantId!, user.sub, body);
  }

  @Get("usage")
  usage(@CurrentUser() user: JwtPayload, @Query("days") days?: string) {
    return this.models.getUsage(user.tenantId!, Math.min(Math.max(Number(days) || 30, 1), 365));
  }
}
