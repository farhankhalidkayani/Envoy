import { createHash, randomBytes } from "node:crypto";
import { HttpException, Injectable } from "@nestjs/common";
import {
  API_TOKEN_PREFIX,
  API_TOKEN_SCOPES,
  AuthorizeRequest,
  OAUTH_ACCESS_TOKEN_TTL_SEC,
  OAUTH_CODE_TTL_SEC,
  OAUTH_DEFAULT_SCOPES,
  OAUTH_REFRESH_TOKEN_TTL_DAYS,
  ApproveAuthorizationInput,
  isValidPkceVerifier,
  parseScope,
  type RegisterClientInput,
} from "@envoy/types";
import { PrismaService } from "../../prisma/prisma.service.js";
import { hashToken } from "../tokens/api-token-auth.js";

/** Public URLs, read per call so a deployment (or a test) can set them. */
export const oauthUrls = () => ({
  issuer: (process.env.PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  portal: (process.env.PORTAL_URL ?? "http://localhost:3001").replace(/\/$/, ""),
  /** The MCP server's address: the only "resource" tokens are issued for. */
  resource: (process.env.MCP_PUBLIC_URL ?? "http://localhost:4100/mcp").replace(/\/$/, ""),
});

/** An RFC 6749 error body: `{ error, error_description }`, which is what OAuth clients parse. */
export class OAuthError extends HttpException {
  constructor(error: string, description: string, status = 400) {
    super({ error, error_description: description }, status);
  }
}

const REFRESH_PREFIX = "envoy_rt_";
const sha256url = (s: string) => createHash("sha256").update(s).digest("base64url");
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

function withParams(uri: string, params: Record<string, string | undefined>) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

@Injectable()
export class OAuthService {
  constructor(private readonly prisma: PrismaService) {}

  metadata() {
    const { issuer, portal } = oauthUrls();
    return {
      issuer,
      authorization_endpoint: `${portal}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...API_TOKEN_SCOPES],
    };
  }

  async register(input: RegisterClientInput) {
    const client = await this.prisma.client.oAuthClient.create({ data: { name: input.client_name ?? "An AI app", redirectUris: [...new Set(input.redirect_uris)] } });
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  /**
   * Checks an authorization request in the order the spec requires: until the client and redirect URI are known to
   * be genuine, problems are shown to the person and NEVER redirected (that would make us an open redirector).
   * After that, problems go back to the app as `error=` on its redirect URI.
   */
  private async check(raw: Record<string, unknown>) {
    const clientId = typeof raw.client_id === "string" ? raw.client_id : "";
    const redirectUri = typeof raw.redirect_uri === "string" ? raw.redirect_uri : "";
    const client = clientId ? await this.prisma.client.oAuthClient.findUnique({ where: { id: clientId } }) : null;
    if (!client) throw new OAuthError("invalid_client", "This app isn't registered. Start the connection again from the app.");
    if (!client.redirectUris.includes(redirectUri)) throw new OAuthError("invalid_request", "The app asked to return somewhere it didn't register. Start the connection again from the app.");

    const back = (error: string, description: string) => ({ redirect_to: withParams(redirectUri, { error, error_description: description, state: typeof raw.state === "string" ? raw.state : undefined }) });
    const parsed = AuthorizeRequest.safeParse(raw);
    if (!parsed.success) return { client, problem: back("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")) };
    if (parsed.data.resource !== undefined && parsed.data.resource.replace(/\/$/, "") !== oauthUrls().resource) {
      return { client, problem: back("invalid_target", "This server only issues access for the Envoy MCP server.") };
    }
    return { client, request: parsed.data };
  }

  /** What the consent page shows. */
  async describe(raw: Record<string, unknown>) {
    const { client, request, problem } = await this.check(raw);
    if (problem) return problem;
    const { scopes, unknown } = parseScope(request!.scope);
    return {
      client: { id: client.id, name: client.name },
      redirectHost: (() => { const u = new URL(request!.redirect_uri); return u.protocol.startsWith("http") ? u.host : u.protocol.replace(/:$/, ""); })(),
      requestedScopes: scopes.length ? scopes : [...OAUTH_DEFAULT_SCOPES],
      unknownScopes: unknown,
    };
  }

  async approve(tenantId: string, userId: string, raw: Record<string, unknown>) {
    const { client, request, problem } = await this.check(raw);
    if (problem) return problem;
    const ticked = ApproveAuthorizationInput.shape.scopes.safeParse(raw.scopes);
    if (!ticked.success) throw new OAuthError("invalid_request", "Choose at least one permission to grant.");
    const input = { scopes: ticked.data };
    const code = secret("");
    await this.prisma.client.oAuthCode.create({
      data: {
        codeHash: hashToken(code),
        clientId: client.id,
        tenantId,
        userId,
        redirectUri: request!.redirect_uri,
        codeChallenge: request!.code_challenge,
        scopes: [...new Set(input.scopes)],
        resource: request!.resource?.replace(/\/$/, "") ?? null,
        expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_SEC * 1000),
      },
    });
    await this.prisma.client.auditLog.create({ data: { adminUserId: userId, tenantId, action: "oauth.authorized", meta: { clientId: client.id, client: client.name, scopes: input.scopes } } });
    return { redirect_to: withParams(request!.redirect_uri, { code, state: request!.state, iss: oauthUrls().issuer }) };
  }

  async deny(raw: Record<string, unknown>) {
    const { request, problem } = await this.check(raw);
    if (problem) return problem;
    return { redirect_to: withParams(request!.redirect_uri, { error: "access_denied", error_description: "The user declined.", state: request!.state }) };
  }

  // ── token endpoint ──────────────────────────────────────

  async token(body: Record<string, unknown>) {
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const clientId = str("client_id");
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required.", 401);
    const client = await this.prisma.client.oAuthClient.findUnique({ where: { id: clientId } });
    if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);

    switch (str("grant_type")) {
      case "authorization_code":
        return this.exchangeCode(client, str("code"), str("redirect_uri"), body.code_verifier, str("resource"));
      case "refresh_token":
        return this.refresh(client, str("refresh_token"), str("scope"));
      default:
        throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    }
  }

  private async exchangeCode(client: { id: string; name: string }, code: string | undefined, redirectUri: string | undefined, verifier: unknown, resource: string | undefined) {
    if (!code || !redirectUri) throw new OAuthError("invalid_request", "code and redirect_uri are required.");
    if (!isValidPkceVerifier(verifier)) throw new OAuthError("invalid_request", "A valid code_verifier is required.");
    const row = await this.prisma.client.oAuthCode.findUnique({ where: { codeHash: hashToken(code) } });
    if (!row) throw new OAuthError("invalid_grant", "Invalid authorization code.");

    // A code used twice means it leaked: the token from its first use is revoked too.
    if (row.usedAt) {
      if (row.tokenId) await this.prisma.client.apiToken.updateMany({ where: { id: row.tokenId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new OAuthError("invalid_grant", "This authorization code was already used.");
    }
    const claimed = await this.prisma.client.oAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count === 0) throw new OAuthError("invalid_grant", "This authorization code was already used.");

    if (row.expiresAt.getTime() <= Date.now()) throw new OAuthError("invalid_grant", "The authorization code has expired.");
    if (row.clientId !== client.id) throw new OAuthError("invalid_grant", "The code was issued to a different client.");
    if (row.redirectUri !== redirectUri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request.");
    if (sha256url(verifier) !== row.codeChallenge) throw new OAuthError("invalid_grant", "code_verifier doesn't match the code_challenge.");
    if (resource !== undefined && row.resource !== null && resource.replace(/\/$/, "") !== row.resource) throw new OAuthError("invalid_target", "resource doesn't match the authorization request.");

    const user = await this.prisma.client.user.findUnique({ where: { id: row.userId }, select: { tenantId: true } });
    if (user?.tenantId !== row.tenantId) throw new OAuthError("invalid_grant", "The person who approved this no longer has access.");

    const access = secret(API_TOKEN_PREFIX);
    const refresh = secret(REFRESH_PREFIX);
    const token = await this.prisma.client.apiToken.create({
      data: {
        tenantId: row.tenantId,
        userId: row.userId,
        name: client.name.slice(0, 60),
        scopes: row.scopes,
        tokenHash: hashToken(access),
        last4: access.slice(-4),
        expiresAt: new Date(Date.now() + OAUTH_ACCESS_TOKEN_TTL_SEC * 1000),
        oauthClientId: client.id,
        refreshHash: hashToken(refresh),
        refreshExpiresAt: new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });
    await this.prisma.client.oAuthCode.update({ where: { id: row.id }, data: { tokenId: token.id } });
    await this.prisma.client.auditLog.create({ data: { adminUserId: row.userId, tenantId: row.tenantId, action: "oauth.connected", meta: { tokenId: token.id, client: client.name, scopes: row.scopes } } });
    return this.grant(access, refresh, row.scopes);
  }

  private async refresh(client: { id: string }, refresh: string | undefined, scope: string | undefined) {
    if (!refresh) throw new OAuthError("invalid_request", "refresh_token is required.");
    const hash = hashToken(refresh);
    const token = await this.prisma.client.apiToken.findUnique({ where: { refreshHash: hash }, include: { user: { select: { tenantId: true } } } });
    if (!token) {
      // An old refresh token coming back after it was rotated means two parties hold it: end the connection.
      const replayed = await this.prisma.client.apiToken.findUnique({ where: { previousRefreshHash: hash } });
      if (replayed && !replayed.revokedAt) {
        await this.prisma.client.apiToken.update({ where: { id: replayed.id }, data: { revokedAt: new Date() } });
        await this.prisma.client.auditLog.create({ data: { adminUserId: replayed.userId, tenantId: replayed.tenantId, action: "oauth.refresh_replayed", meta: { tokenId: replayed.id, name: replayed.name } } });
      }
      throw new OAuthError("invalid_grant", "Invalid refresh token.");
    }
    if (token.oauthClientId !== client.id) throw new OAuthError("invalid_grant", "The refresh token was issued to a different client.");
    if (token.revokedAt) throw new OAuthError("invalid_grant", "This connection was disconnected.");
    if (!token.refreshExpiresAt || token.refreshExpiresAt.getTime() <= Date.now()) throw new OAuthError("invalid_grant", "The refresh token has expired. Connect again.");
    if (token.user.tenantId !== token.tenantId) throw new OAuthError("invalid_grant", "The person who approved this no longer has access.");

    let scopes = token.scopes;
    if (scope !== undefined) {
      const { scopes: asked, unknown } = parseScope(scope);
      if (unknown.length || asked.some((s) => !token.scopes.includes(s))) throw new OAuthError("invalid_scope", "A refresh can only keep or narrow the approved scopes.");
      scopes = asked;
    }

    const access = secret(API_TOKEN_PREFIX);
    const next = secret(REFRESH_PREFIX);
    const rotated = await this.prisma.client.apiToken.updateMany({
      where: { id: token.id, refreshHash: hash, revokedAt: null },
      data: {
        tokenHash: hashToken(access),
        last4: access.slice(-4),
        scopes,
        expiresAt: new Date(Date.now() + OAUTH_ACCESS_TOKEN_TTL_SEC * 1000),
        previousRefreshHash: hash,
        refreshHash: hashToken(next),
        refreshExpiresAt: new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });
    if (rotated.count === 0) throw new OAuthError("invalid_grant", "Invalid refresh token.");
    return this.grant(access, next, scopes);
  }

  private grant(access: string, refresh: string, scopes: string[]) {
    return { access_token: access, token_type: "Bearer", expires_in: OAUTH_ACCESS_TOKEN_TTL_SEC, refresh_token: refresh, scope: scopes.join(" ") };
  }
}
