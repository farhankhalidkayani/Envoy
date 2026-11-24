import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { BillingModule } from "../../billing/billing.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { FeatureGuard } from "./guards/feature.guard.js";
import { JwtAuthGuard } from "./guards/jwt-auth.guard.js";
import { RolesGuard } from "./guards/roles.guard.js";
import { TenantScopeGuard } from "./guards/tenant-scope.guard.js";
import { JwtStrategy } from "./jwt.strategy.js";
import { ApiTokenAuditInterceptor } from "./tokens/api-token-audit.interceptor.js";
import { TokensController } from "./tokens/tokens.controller.js";
import { TokensService } from "./tokens/tokens.service.js";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: "15m" },
    }),
    BillingModule,
  ],
  controllers: [AuthController, TokensController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    TenantScopeGuard,
    RolesGuard,
    FeatureGuard,
    TokensService,
    { provide: APP_INTERCEPTOR, useClass: ApiTokenAuditInterceptor },
  ],
  exports: [AuthService, JwtAuthGuard, TenantScopeGuard, RolesGuard, FeatureGuard, JwtModule],
})
export class AuthModule {}
