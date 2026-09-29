export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
}

// Refresh this long before actual expiry so a slow request never straddles the boundary.
const REFRESH_SKEW_MS = 60_000;
export const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

/** Stored JSON-stringified, then AES-256-GCM encrypted by crm/token-crypto.ts. */
export function packTokens(tokens: OAuthTokens): string {
  return JSON.stringify(tokens);
}

/**
 * Connections made before refresh support stored the bare access token
 * string. Those have no refresh token, so treat them as non-expiring: a
 * stale real token then fails at the provider with a clear "reconnect"
 * error, and mock tokens keep working.
 */
export function unpackTokens(packed: string): OAuthTokens {
  try {
    const parsed = JSON.parse(packed) as OAuthTokens;
    if (parsed && typeof parsed.accessToken === "string") return parsed;
  } catch {
    // legacy bare token
  }
  return { accessToken: packed, expiresAt: NEVER_EXPIRES };
}

export function tokensFromGrant(
  grant: { access_token: string; refresh_token?: string; expires_in: number },
  previousRefreshToken?: string,
): OAuthTokens {
  return {
    accessToken: grant.access_token,
    // Google never re-issues a refresh token on a refresh grant; HubSpot does. Keep whichever is newest.
    refreshToken: grant.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + grant.expires_in * 1000,
  };
}

/**
 * Returns new tokens if `tokens` is within a minute of expiring (standard
 * OAuth2 refresh_token grant — same shape for Google and HubSpot), or null
 * if they're still fresh. The caller persists the result.
 */
export async function refreshIfExpiring(
  tokens: OAuthTokens,
  cfg: { tokenUrl: string; clientId?: string; clientSecret?: string; providerName: string },
): Promise<OAuthTokens | null> {
  if (tokens.expiresAt > Date.now() + REFRESH_SKEW_MS) return null;
  if (!tokens.refreshToken) {
    throw new Error(`${cfg.providerName} access expired and no refresh token is stored — reconnect`);
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(`${cfg.providerName} OAuth is not configured on this server — cannot refresh access`);
  }
  const response = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: tokens.refreshToken,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`${cfg.providerName} token refresh failed (${response.status}): ${text} — reconnect if this persists`);
  }
  return tokensFromGrant(
    (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number },
    tokens.refreshToken,
  );
}
