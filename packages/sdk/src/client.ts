import type { ApiOptionsSource, FeatureAccess, FormOption, FormSchema, PriceConfig } from "@envoy/types";
import type {
  AdminTenant,
  AdminTenantDetail,
  Agent,
  AuditLogEntry,
  AuthResult,
  BillingUsage,
  CalendarIntegrationConfig,
  Conversation,
  CrmConnection,
  EmailIntegrationConfig,
  Form,
  FormSubmission,
  Integration,
  Lead,
  PublicForm,
  Subscription,
  WebhookIntegrationConfig,
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
  /** Which app this is — portal and admin keep separate refresh cookies. */
  app?: "portal" | "admin";
  /**
   * Called with the new session after a silent refresh, BEFORE the failed
   * request is retried — store the access token here so getToken() returns it.
   */
  onSession?: (result: AuthResult) => void;
}

/**
 * Thin typed fetch wrapper shared by the portal and admin Next.js apps —
 * see the build plan's packages/sdk. No caching, no retries: just the API
 * surface, typed. Both frontends call the SAME methods identically, which
 * is the point of having one client instead of two ad-hoc fetch layers.
 */
export function createApiClient(config: ApiClientConfig) {
  let refreshing: Promise<boolean> | null = null;

  /** One refresh at a time: concurrent 401s all wait on the same attempt. */
  function refreshSession(): Promise<boolean> {
    refreshing ??= fetch(new URL("/auth/refresh", config.baseUrl), {
      method: "POST",
      credentials: "include",
      headers: { "X-Envoy-App": config.app ?? "portal" },
    })
      .then(async (res) => {
        if (!res.ok) return false;
        config.onSession?.((await res.json()) as AuthResult);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | undefined>;
      /** "blob" for a file download (CSV export) — everything else is parsed as JSON. */
      responseType?: "json" | "blob";
    } = {},
    retried = false,
  ): Promise<T> {
    const url = new URL(path, config.baseUrl);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }

    const isAuthRoute = path.startsWith("/auth/");
    const token = config.getToken?.();
    const res = await fetch(url, {
      method: options.method ?? "GET",
      // The refresh cookie is scoped to /auth, so only those calls need credentials.
      credentials: isAuthRoute ? "include" : "same-origin",
      headers: {
        "X-Envoy-App": config.app ?? "portal",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      if (res.status === 401 && token && !isAuthRoute) {
        // Access token expired: refresh silently and retry once before giving up.
        if (!retried && (await refreshSession())) return request<T>(path, options, true);
        config.onUnauthorized?.();
      }
      const text = await res.text().catch(() => res.statusText);
      throw new ApiError(res.status, text || res.statusText);
    }
    if (options.responseType === "blob") return (await res.blob()) as T;
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
      /** Revokes this browser's session (or all of the user's sessions) and clears the refresh cookie. */
      logout: (everywhere = false) =>
        request<void>("/auth/logout", { method: "POST", query: { everywhere: everywhere ? "true" : undefined } }),
      /** Always resolves — the response never reveals whether the email exists. `devToken` is only set in local dev (no email provider configured). */
      requestPasswordReset: (email: string) =>
        request<{ requested: true; devToken?: string }>("/auth/password-reset/request", { method: "POST", body: { email } }),
      confirmPasswordReset: (token: string, password: string) =>
        request<{ reset: true }>("/auth/password-reset/confirm", { method: "POST", body: { token, password } }),
      requestEmailVerification: () =>
        request<{ requested: true; devToken?: string }>("/auth/verify-email/request", { method: "POST" }),
      confirmEmailVerification: (token: string) =>
        request<{ verified: true }>("/auth/verify-email/confirm", { method: "POST", body: { token } }),
    },

    agents: {
      list: () => request<Agent[]>("/agents"),
      get: (id: string) => request<Agent>(`/agents/${id}`),
      create: (input: CreateAgentInput) => request<Agent>("/agents", { method: "POST", body: input }),
      update: (
        id: string,
        input: Partial<CreateAgentInput> & { status?: Agent["status"]; leadFormId?: string | null },
      ) => request<Agent>(`/agents/${id}`, { method: "PATCH", body: input }),
    },

    conversations: {
      list: (agentId?: string, opts: { cursor?: string; take?: number } = {}) =>
        request<{ rows: Conversation[]; nextCursor?: string }>("/conversations", {
          query: { agentId, cursor: opts.cursor, take: opts.take?.toString() },
        }),
      get: (id: string) => request<Conversation>(`/conversations/${id}`),
      getStats: (agentId?: string) =>
        request<{ total: number; completed: number }>("/conversations/stats", { query: { agentId } }),
    },

    billing: {
      getSubscription: () => request<Subscription>("/billing/subscription"),
      checkout: () => request<{ mode: "mock" | "stripe"; url?: string }>("/billing/checkout", { method: "POST" }),
      portal: () => request<{ mode: "mock" | "stripe"; url?: string }>("/billing/portal", { method: "POST" }),
      getUsage: () => request<BillingUsage>("/billing/usage"),
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
      pushSubmission: (submissionId: string) =>
        request<{ success: boolean; externalId?: string; error?: string }>(`/crm/push/submission/${submissionId}`, {
          method: "POST",
        }),
    },

    integrations: {
      list: () => request<Integration[]>("/integrations"),
      connectWebhook: (config: WebhookIntegrationConfig) =>
        request<Integration>("/integrations/webhook/connect", { method: "POST", body: config }),
      connectEmail: (config: EmailIntegrationConfig) =>
        request<Integration>("/integrations/email/connect", { method: "POST", body: config }),
      connectCalendar: () =>
        request<{ mode: "mock" | "oauth"; authorizeUrl?: string }>("/integrations/calendar/connect", {
          method: "POST",
        }),
      updateConfig: (
        type: "webhook" | "email" | "calendar",
        config: WebhookIntegrationConfig | EmailIntegrationConfig | CalendarIntegrationConfig,
      ) => request<Integration>(`/integrations/${type}/config`, { method: "PATCH", body: config }),
      disconnect: (type: "webhook" | "email" | "calendar") =>
        request<void>(`/integrations/${type}`, { method: "DELETE" }),
      pushConversation: (type: "webhook" | "email" | "calendar", conversationId: string) =>
        request<{ success: boolean; error?: string }>(`/integrations/${type}/push/${conversationId}`, {
          method: "POST",
        }),
      pushSubmission: (type: "webhook" | "email" | "calendar", submissionId: string) =>
        request<{ success: boolean; error?: string }>(`/integrations/${type}/push/submission/${submissionId}`, {
          method: "POST",
        }),
    },

    forms: {
      list: () => request<Form[]>("/forms"),
      get: (id: string) => request<Form>(`/forms/${id}`),
      create: (name: string) => request<Form>("/forms", { method: "POST", body: { name } }),
      update: (id: string, input: { name?: string; status?: Form["status"]; schema?: FormSchema }) =>
        request<Form>(`/forms/${id}`, { method: "PATCH", body: input }),
      remove: (id: string) => request<void>(`/forms/${id}`, { method: "DELETE" }),
      submissions: (id: string, opts: { cursor?: string; take?: number } = {}) =>
        request<{ rows: FormSubmission[]; nextCursor?: string }>(`/forms/${id}/submissions`, {
          query: { cursor: opts.cursor, take: opts.take?.toString() },
        }),
      deleteSubmission: (id: string, submissionId: string) =>
        request<void>(`/forms/${id}/submissions/${submissionId}`, { method: "DELETE" }),
      exportSubmissionsCsv: (id: string) =>
        request<Blob>(`/forms/${id}/submissions/export`, { responseType: "blob" }),
      testOptions: (source: ApiOptionsSource, answers: Record<string, unknown> = {}) =>
        request<FormOption[]>("/forms/options/test", { method: "POST", body: { source, answers } }),
    },

    leads: {
      list: (limit?: number) =>
        request<{ leads: Lead[]; hasMore: boolean }>("/leads", { query: { limit: limit?.toString() } }),
      getStats: () =>
        request<{ totalForms: number; liveForms: number; totalSubmissions: number; totalLeadConversations: number }>(
          "/leads/stats",
        ),
    },

    account: {
      getInfo: () => request<{ name: string }>("/account"),
      exportData: () => request<Blob>("/account/export", { responseType: "blob" }),
      deleteAccount: (confirmName: string) =>
        request<void>("/account", { method: "DELETE", body: { confirmName } }),
    },

    /** Unauthenticated — used by the hosted form page. */
    publicForms: {
      get: (token: string) => request<PublicForm>(`/public/forms/${token}`),
      submit: (token: string, data: Record<string, unknown>) =>
        request<{ successMessage: string }>(`/public/forms/${token}/submit`, { method: "POST", body: data }),
      options: (token: string, fieldKey: string, answers: Record<string, unknown>) =>
        request<FormOption[]>(`/public/forms/${token}/options/${fieldKey}`, { method: "POST", body: answers }),
    },

    admin: {
      listTenants: (opts: { cursor?: string; take?: number } = {}) =>
        request<{ rows: AdminTenant[]; nextCursor?: string }>("/admin/tenants", {
          query: { cursor: opts.cursor, take: opts.take?.toString() },
        }),
      getTenantStats: () =>
        request<{ total: number; active: number; attention: number; mrrCents: number }>("/admin/tenants/stats"),
      getTenant: (id: string) => request<AdminTenantDetail>(`/admin/tenants/${id}`),
      pauseTenant: (id: string) => request<void>(`/admin/tenants/${id}/pause`, { method: "PATCH" }),
      resumeTenant: (id: string) => request<void>(`/admin/tenants/${id}/resume`, { method: "PATCH" }),
      revokeTenant: (id: string) => request<void>(`/admin/tenants/${id}`, { method: "DELETE" }),
      hardDeleteTenant: (id: string, confirmName: string) =>
        request<void>(`/admin/tenants/${id}/hard`, { method: "DELETE", body: { confirmName } }),
      billOverage: (id: string) =>
        request<{ mode: "mock" | "stripe"; charged: boolean; amountCents?: number }>(`/admin/tenants/${id}/bill-overage`, {
          method: "POST",
        }),
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
      listFailedJobs: () =>
        request<
          Array<{
            queue: string;
            id: string;
            name: string;
            data: Record<string, unknown>;
            failedReason: string;
            attemptsMade: number;
            timestamp: number;
          }>
        >("/admin/jobs/failed"),
      retryJob: (queue: string, id: string) => request<void>(`/admin/jobs/${queue}/${id}/retry`, { method: "POST" }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
