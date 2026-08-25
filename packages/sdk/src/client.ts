import type { FeatureAccess, PriceConfig } from "@envoy/types";
import type {
  AdminTenant,
  AdminTenantDetail,
  Agent,
  AuditLogEntry,
  AuthResult,
  Conversation,
  CrmConnection,
  Subscription,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CreateAgentInput {
  name: string;
  script?: string;
  requiredFields?: unknown;
  hardRules?: unknown;
  widgetConfig?: unknown;
}

export interface ApiClientConfig {
  baseUrl: string;
  /** Read fresh on every call — lets the caller store the token however it likes (localStorage, cookie, memory). */
  getToken?: () => string | null | undefined;
  /**
   * Called when an authenticated request (one that actually attached a
   * token) comes back 401 — the token expired or was revoked server-side.
   * NOT called for a plain login/register attempt with a wrong password,
   * since those requests never attach a token in the first place. The
   * caller is expected to clear its stored session and redirect to login.
   */
  onUnauthorized?: () => void;
}

/**
 * Thin typed fetch wrapper shared by the portal and admin Next.js apps —
 * see the build plan's packages/sdk. No caching, no retries: just the API
 * surface, typed. Both frontends call the SAME methods identically, which
 * is the point of having one client instead of two ad-hoc fetch layers.
 */
export function createApiClient(config: ApiClientConfig) {
  async function request<T>(
    path: string,
    options: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(path, config.baseUrl);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }

    const token = config.getToken?.();
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      if (res.status === 401 && token) config.onUnauthorized?.();
      const text = await res.text().catch(() => res.statusText);
      throw new ApiError(res.status, text || res.statusText);
    }
    // A void-returning Nest handler sends 200 with an EMPTY body, not 204 —
    // res.json() throws a SyntaxError on that ("Unexpected end of JSON
    // input"), which silently broke every admin mutation (pause/resume/etc.)
    // that doesn't return a payload. Read as text first and only parse if
    // there's actually something there.
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    auth: {
      register: (input: { tenantName: string; email: string; password: string }) =>
        request<AuthResult>("/auth/register", { method: "POST", body: input }),
      login: (input: { email: string; password: string }) =>
        request<AuthResult>("/auth/login", { method: "POST", body: input }),
    },

    agents: {
      list: () => request<Agent[]>("/agents"),
      get: (id: string) => request<Agent>(`/agents/${id}`),
      create: (input: CreateAgentInput) => request<Agent>("/agents", { method: "POST", body: input }),
      update: (id: string, input: Partial<CreateAgentInput> & { status?: Agent["status"] }) =>
        request<Agent>(`/agents/${id}`, { method: "PATCH", body: input }),
    },

    conversations: {
      list: (agentId?: string) =>
        request<Conversation[]>("/conversations", { query: { agentId } }),
      get: (id: string) => request<Conversation>(`/conversations/${id}`),
    },

    billing: {
      getSubscription: () => request<Subscription>("/billing/subscription"),
    },

    crm: {
      getConnection: () => request<CrmConnection | undefined>("/crm/connection"),
      connect: () => request<{ mode: "mock" | "oauth"; authorizeUrl?: string }>("/crm/connect", { method: "POST" }),
      updateMapping: (mapping: Record<string, string>) =>
        request<CrmConnection>("/crm/mapping", { method: "PATCH", body: mapping }),
      disconnect: () => request<void>("/crm/connection", { method: "DELETE" }),
      pushConversation: (conversationId: string) =>
        request<{ success: boolean; externalId?: string; error?: string }>(`/crm/push/${conversationId}`, {
          method: "POST",
        }),
    },

    admin: {
      listTenants: () => request<AdminTenant[]>("/admin/tenants"),
      getTenant: (id: string) => request<AdminTenantDetail>(`/admin/tenants/${id}`),
      pauseTenant: (id: string) => request<void>(`/admin/tenants/${id}/pause`, { method: "PATCH" }),
      resumeTenant: (id: string) => request<void>(`/admin/tenants/${id}/resume`, { method: "PATCH" }),
      revokeTenant: (id: string) => request<void>(`/admin/tenants/${id}`, { method: "DELETE" }),
      updateUserAccess: (tenantId: string, userId: string, access: FeatureAccess) =>
        request<void>(`/admin/tenants/${tenantId}/users/${userId}/access`, {
          method: "PATCH",
          body: access,
        }),
      // Partial — the server's Zod schema fills in defaults (currency, addOns) for
      // whatever the caller omits; requiring the full shape client-side would force
      // every caller to know about fields it isn't changing.
      updatePricing: (tenantId: string, priceConfig: Partial<PriceConfig>) =>
        request<void>(`/admin/tenants/${tenantId}/pricing`, { method: "PATCH", body: priceConfig }),
      listAuditLog: (tenantId?: string) =>
        request<AuditLogEntry[]>("/admin/audit-log", { query: { tenantId } }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
