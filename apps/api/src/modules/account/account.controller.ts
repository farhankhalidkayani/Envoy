import { Body, Controller, Delete, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { CurrentUser } from "../core/auth/decorators/current-user.decorator.js";
import { Roles } from "../core/auth/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard.js";
import { RolesGuard } from "../core/auth/guards/roles.guard.js";
import { TenantScopeGuard } from "../core/auth/guards/tenant-scope.guard.js";
import type { JwtPayload } from "../core/auth/types.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { AccountService } from "./account.service.js";

const DeleteAccountDto = z.object({ confirmName: z.string().min(1) });

/**
 * Tenant self-service data controls — owner-only (staff can't export or
 * delete the whole account), and deliberately NOT behind TenantLockGuard: a
 * locked/cancelled tenant must still be able to get their data out or gone.
 */
@Controller("account")
@UseGuards(JwtAuthGuard, TenantScopeGuard, RolesGuard)
@Roles("owner")
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  getInfo(@CurrentUser() user: JwtPayload) {
    return this.account.getInfo(user.tenantId!);
  }

  @Get("export")
  async exportData(@CurrentUser() user: JwtPayload, @Res({ passthrough: true }) res: Response) {
    const data = await this.account.exportData(user.tenantId!);
    res.set({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="envoy-data-export.json"',
    });
    return JSON.stringify(data, null, 2);
  }

  @Delete()
  deleteAccount(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(DeleteAccountDto)) body: z.infer<typeof DeleteAccountDto>,
  ) {
    return this.account.deleteAccount(user.tenantId!, user.sub, body.confirmName);
  }
}
