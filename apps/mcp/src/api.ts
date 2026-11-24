/**
 * A minimal client for the Envoy REST API, authenticated with an `envoy_sk_` API token. The MCP server has no
 * business logic of its own: every rule — tenant isolation, scopes, feature flags, the workspace lock, audit — is
 * enforced by the API, so an AI agent gets exactly the access its token grants and nothing a tool definition could widen.
 */
export class EnvoyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EnvoyApiError";
  }
}

export interface EnvoyApiOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

export class EnvoyApi {
  constructor(private readonly opts: EnvoyApiOptions) {}

  private async request<T>(method: string, path: string, init: { query?: Query; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const res = await (this.opts.fetch ?? fetch)(url, {
      method,
      headers: { Authorization: `Bearer ${this.opts.token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new EnvoyApiError(res.status, messageOf(text) || res.statusText);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get = <T>(path: string, query?: Query) => this.request<T>("GET", path, { query });
  post = <T>(path: string, body?: unknown, opts: { timeoutMs?: number } = {}) => this.request<T>("POST", path, { body: body ?? {}, ...opts });
  patch = <T>(path: string, body: unknown) => this.request<T>("PATCH", path, { body });
}

/** Nest errors are `{ message: string | string[] }`; validation errors carry a list. */
function messageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string | string[] };
    return Array.isArray(parsed.message) ? parsed.message.join("; ") : (parsed.message ?? text);
  } catch {
    return text.slice(0, 300);
  }
}
