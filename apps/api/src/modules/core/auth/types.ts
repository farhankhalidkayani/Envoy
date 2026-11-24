import type { UserRole } from "@envoy/types";

/** The shape encoded into the access JWT and attached to req.user by JwtAuthGuard. */
export interface JwtPayload {
  sub: string; // user id
  tenantId: string | null; // null for platform_admin
  role: UserRole;
}

/** Express Request augmented with the authenticated principal. */
export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
  /** Set only when the request authenticated with an API token (never for a signed-in person's JWT). */
  apiToken?: { id: string; name: string; scopes: string[] };
}
