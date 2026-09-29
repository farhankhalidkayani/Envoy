import type { Request, Response } from "express";
import type { SessionScope } from "@envoy/db";

/**
 * Portal and admin are separate apps talking to the same API; each gets its
 * own refresh cookie name AND its own Session.appScope (checked in
 * AuthService), so a cookie from one app is rejected outright under the
 * other app's scope — not just conventionally kept apart.
 */
export type AppScope = SessionScope;

export function appScopeOf(req: Request): AppScope {
  return req.headers["x-envoy-app"] === "admin" ? "admin" : "portal";
}

const cookieName = (scope: AppScope) => `envoy_rt_${scope}`;

export function readRefreshCookie(req: Request, scope: AppScope): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === cookieName(scope)) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

// httpOnly: never readable by page scripts (XSS can't lift a long-lived
// credential). SameSite=Lax: sent by the portal/admin (same site as the
// API), not by cross-site POSTs. Path=/auth: only refresh/logout see it.
const baseOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true",
  path: "/auth",
});

export function setRefreshCookie(res: Response, scope: AppScope, token: string, expiresAt: Date) {
  res.cookie(cookieName(scope), token, { ...baseOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response, scope: AppScope) {
  res.clearCookie(cookieName(scope), baseOptions());
}
