import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { ApiOptionsSource } from "@envoy/types";
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

const TestOptionsDto = z.object({ source: ApiOptionsSource, answers: z.record(z.string(), z.unknown()).default({}) });

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

  // Declared before ":id" routes so "options" is never read as a form id.
  @Post("options/test")
  @HttpCode(200)
  testOptions(@Body(new ZodValidationPipe(TestOptionsDto)) body: z.infer<typeof TestOptionsDto>) {
    return this.forms.fetchFromSource(body.source, body.answers);
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
    return this.forms.update(user.tenantId!, id, user.sub, body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.forms.remove(user.tenantId!, id, user.sub);
  }

  // Declared before ":id/submissions" so "export" is never read as a submission cursor's neighbor.
  @Get(":id/submissions/export")
  async exportSubmissions(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const csv = await this.forms.exportSubmissionsCsv(user.tenantId!, id);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="submissions.csv"' });
    return csv;
  }

  @Get(":id/submissions")
  submissions(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("take") take?: string,
  ) {
    return this.forms.listSubmissions(user.tenantId!, id, { cursor, take: take ? Number(take) : undefined });
  }

  @Delete(":id/submissions/:submissionId")
  deleteSubmission(@CurrentUser() user: JwtPayload, @Param("id") id: string, @Param("submissionId") submissionId: string) {
    return this.forms.deleteSubmission(user.tenantId!, id, submissionId);
  }
}
