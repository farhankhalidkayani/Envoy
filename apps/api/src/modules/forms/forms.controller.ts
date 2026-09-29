import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequireFeature } from "../core/auth/decorators/require-feature.decorator.js";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { FeatureGuard } from "../core/auth/guards/feature.guard.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import { TenantLockGuard } from "../billing/guards/tenant-lock.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { FormsService } from "./forms.service.js";

const CreateFormDto = z.object({ name: z.string().min(1).max(120) });
// `schema` is validated in the service against FormSchema so the error can list every issue path.
const UpdateFormDto = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(["draft", "live"]).optional(),
  schema: z.unknown().optional(),
});

const GUARDS = [JwtAuthGuard, TenantScopeGuard, TenantLockGuard, FeatureGuard] as const;

@Controller("forms")
@UseGuards(...GUARDS)
@RequireFeature("forms")
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.forms.list(user.tenantId!);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(CreateFormDto)) body: z.infer<typeof CreateFormDto>) {
    return this.forms.create(user.tenantId!, body.name);
  }

  @Get(":id")
  get(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.forms.get(user.tenantId!, id);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateFormDto)) body: z.infer<typeof UpdateFormDto>,
  ) {
    return this.forms.update(user.tenantId!, id, body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.forms.remove(user.tenantId!, id);
  }

  @Get(":id/submissions")
  submissions(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.forms.listSubmissions(user.tenantId!, id);
  }
}
