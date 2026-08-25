import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RedisModule } from "./redis/redis.module.js";

@Module({
  imports: [PrismaModule, RedisModule, AuthModule],
  exports: [PrismaModule, RedisModule, AuthModule],
})
export class CoreModule {}
