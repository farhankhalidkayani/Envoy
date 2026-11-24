import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CreateApiTokenInput } from "@envoy/types";
import { CurrentUser } from "../decorators/current-user.decorator.js";
import { Roles } from "../decorators/roles.decorator.js";
import { JwtAuthGuard } from "../guards/jwt-auth.guard.js";
import { RolesGuard } from "../guards/roles.guard.js";
import { TenantScopeGuard } from "../guards/tenant-scope.guard.js";
import type { JwtPayload } from "../types.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { TokensService } from "./tokens.service.js";

/**
 * Only a signed-in workspace owner manages tokens. A token can never mint, list
 * or revoke tokens: "/tokens" is outside every area an API token may reach.
 */
@Controller("tokens")
@UseGuards(JwtAuthGuard, TenantScopeGuard, RolesGuard)
@Roles("owner")
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.tokens.list(user.tenantId!);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(CreateApiTokenInput)) body: CreateApiTokenInput) {
    return this.tokens.create(user.tenantId!, user.sub, body);
  }

  @Delete(":id")
  revoke(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.tokens.revoke(user.tenantId!, user.sub, id);
  }
}
