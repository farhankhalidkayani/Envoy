import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { prisma, type PrismaClient } from "@envoy/db";

/**
 * Thin Nest wrapper around the shared @envoy/db client so it participates in
 * the Nest lifecycle (connect on boot, disconnect on shutdown) and can be
 * injected like any other provider.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient = prisma;

  async onModuleInit() {
    await this.client.$connect();
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
