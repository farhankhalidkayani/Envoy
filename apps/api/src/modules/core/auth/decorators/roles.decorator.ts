import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "@envoy/types";

export const ROLES_KEY = "roles";

/** Restrict a route to one or more UserRole values, e.g. `@Roles("platform_admin")`. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
