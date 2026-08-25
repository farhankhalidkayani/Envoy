import { createApiClient } from "@envoy/sdk";

export const TOKEN_STORAGE_KEY = "envoy_admin_token";
export const USER_STORAGE_KEY = "envoy_admin_user";

function handleUnauthorized() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
  // A hard redirect, not router.push: this fires from a plain module, outside
  // any component, whenever a real request comes back 401 (expired/revoked
  // token) — not just on mount, so it has to work from anywhere in the app.
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

export const api = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  getToken: () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN_STORAGE_KEY)),
  onUnauthorized: handleUnauthorized,
});
