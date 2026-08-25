import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Asserts the authenticated principal is bound to a tenant (i.e. not a
 * tenant-less platform_admin) before a tenant-scoped route runs, and exposes
 * that tenantId on the request for downstream handlers. Runs after
 * JwtAuthGuard.
 *
 * This does NOT by itself prevent cross-tenant reads — that guarantee comes
 * from every service method filtering by `req.tenantId` (sourced from the
 * verified token, never from a route param or request body). This guard's
 * job is to make "no tenant context" fail loudly and early.
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.tenantId) {
      throw new ForbiddenException("This route requires a tenant-scoped principal");
    }
    return true;
  }
}
