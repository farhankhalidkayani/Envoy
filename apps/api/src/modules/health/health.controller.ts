import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { RedisService } from "../core/redis/redis.service.js";

/**
 * Unauthenticated by design — a load balancer/uptime monitor hits this
 * before a session exists. Checks the two things a request can't work
 * without (Postgres, Redis) rather than just "the process is alive," since
 * a process that's up but can't reach its DB is not actually healthy.
 */
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    const [db, redis] = await Promise.allSettled([
      this.prisma.client.$queryRaw`SELECT 1`,
      this.redis.client.ping(),
    ]);
    const body = {
      status: db.status === "fulfilled" && redis.status === "fulfilled" ? "ok" : "error",
      db: db.status === "fulfilled" ? "ok" : "error",
      redis: redis.status === "fulfilled" ? "ok" : "error",
    };
    if (body.status === "error") throw new ServiceUnavailableException(body);
    return body;
  }
}
