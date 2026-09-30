import { Module } from "@nestjs/common";
import { AuditService } from "./audit/audit.service.js";
import { AuthModule } from "./auth/auth.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RedisModule } from "./redis/redis.module.js";

@Module({
  imports: [PrismaModule, RedisModule, AuthModule],
  providers: [AuditService],
  exports: [PrismaModule, RedisModule, AuthModule, AuditService],
})
export class CoreModule {}
