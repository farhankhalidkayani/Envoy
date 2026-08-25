import { CanActivate, ExecutionContext, HttpException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../core/prisma/prisma.service.js";
import type { AuthenticatedRequest } from "../../core/auth/types.js";

// NestJS's HttpStatus enum doesn't include the WebDAV 423 (Locked) code.
const HTTP_STATUS_LOCKED = 423;

/**
 * Gates ordinary tenant-scoped business routes (agent config, conversation
 * dashboard, …) behind subscription status. Deliberately NOT applied to:
 * billing routes (must stay reachable to view/pay — see BillingController),
 * admin routes (operator always has full control), or the WS gateway (which
 * has its own equivalent check at session.start, allowing in-flight
 * conversations to finish per the build plan's resolved default).
 *
 * 423 Locked, not 403 — this is a temporary, resolvable state ("pay and
 * you're back in"), not a permission denial.
 */
@Injectable()
export class TenantLockGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.tenantId) return true; // platform_admin routes are never tenant-locked

    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: request.user.tenantId },
      select: { subscriptionStatus: true },
    });
    if (tenant?.subscriptionStatus === "locked") {
      throw new HttpException(
        "This account is locked pending payment. Visit billing to resolve.",
        HTTP_STATUS_LOCKED,
      );
    }
    return true;
  }
}
