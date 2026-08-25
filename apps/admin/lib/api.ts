import { createApiClient } from "@envoy/sdk";

export const TOKEN_STORAGE_KEY = "envoy_admin_token";

export const api = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  getToken: () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN_STORAGE_KEY)),
});
