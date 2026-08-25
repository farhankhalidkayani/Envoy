import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FeatureKey } from "@envoy/types";
import { PrismaService } from "../../prisma/prisma.service.js";
import { REQUIRE_FEATURE_KEY } from "../decorators/require-feature.decorator.js";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Checks the authenticated user's featureAccess map. Deliberately NOT read
 * from the JWT — admins toggle this live from the admin panel, so a cached
 * access token would lag. Loaded per-request; add a Redis cache here if this
 * ever shows up as a hot path.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(REQUIRE_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.prisma.client.user.findUnique({
      where: { id: request.user.sub },
      select: { featureAccess: true },
    });

    const access = (user?.featureAccess ?? {}) as Partial<Record<FeatureKey, boolean>>;
    if (!access[feature]) {
      throw new ForbiddenException(`Feature "${feature}" is not enabled for this account`);
    }
    return true;
  }
}
