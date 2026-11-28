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
  /** Set when a token (not a signed-in person) made the request. `operator` marks a platform operator token. */
  apiToken?: { id: string; name: string; scopes: string[]; operator?: boolean };
}
