import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Integration, IntegrationType, Prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { decryptToken, encryptToken } from "../crm/token-crypto.js";
import { packCalendarTokens, unpackCalendarTokens } from "./calendar-tokens.js";
import { CalendarSender } from "./senders/calendar.sender.js";
import { EmailSender } from "./senders/email.sender.js";
import { WebhookSender } from "./senders/webhook.sender.js";
import type { CalendarConfig, EmailConfig, IntegrationPushResult, PushSource, WebhookConfig } from "./types.js";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// Refresh this long before actual expiry so a slow request never straddles the boundary.
const TOKEN_REFRESH_SKEW_MS = 60_000;

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookSender: WebhookSender,
    private readonly emailSender: EmailSender,
    private readonly calendarSender: CalendarSender,
  ) {}

  async getConnections(tenantId: string) {
    return this.prisma.client.integration.findMany({ where: { tenantId, enabled: true } });
  }

  async getConnection(tenantId: string, type: IntegrationType) {
    return this.prisma.client.integration.findUnique({ where: { tenantId_type: { tenantId, type } } });
  }

  /** Webhook needs no OAuth — the config (URL, headers, payload template) IS the connection. */
  async connectWebhook(tenantId: string, config: WebhookConfig) {
    return this.prisma.client.integration.upsert({
      where: { tenantId_type: { tenantId, type: "webhook" } },
      create: { tenantId, type: "webhook", config: config as unknown as Prisma.InputJsonValue },
      update: { config: config as unknown as Prisma.InputJsonValue, enabled: true },
    });
  }

  /** Email needs no per-tenant OAuth either — outbound via the app's own Resend account. */
  async connectEmail(tenantId: string, config: EmailConfig) {
    return this.prisma.client.integration.upsert({
      where: { tenantId_type: { tenantId, type: "email" } },
      create: { tenantId, type: "email", config: config as unknown as Prisma.InputJsonValue },
      update: { config: config as unknown as Prisma.InputJsonValue, enabled: true },
    });
  }

  /** Mirrors CrmService.initiateConnect — mock mode when GOOGLE_CLIENT_ID isn't configured. */
  async initiateCalendarConnect(tenantId: string): Promise<{ mode: "mock" | "oauth"; authorizeUrl?: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      // Mock tokens never really expire — there's no live Google account behind them to refresh against.
      const mockTokens = packCalendarTokens({
        accessToken: "mock_access_token",
        expiresAt: Date.now() + 100 * 365 * 24 * 60 * 60_000,
      });
      await this.prisma.client.integration.upsert({
        where: { tenantId_type: { tenantId, type: "calendar" } },
        create: {
          tenantId,
          type: "calendar",
          oauthTokens: encryptToken(mockTokens),
          config: { titleTemplate: "New booking", startField: "startTime" } satisfies CalendarConfig as unknown as Prisma.InputJsonValue,
        },
        update: { oauthTokens: encryptToken(mockTokens), enabled: true },
      });
      this.logger.warn(`GOOGLE_CLIENT_ID not set — connected tenant ${tenantId} calendar in mock mode`);
      return { mode: "mock" };
    }

    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4000/integrations/calendar/callback";
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    // Google only returns a refresh_token on the FIRST consent for a given
    // client+user unless prompt=consent forces the dialog every time — force
    // it so reconnecting always yields a fresh refresh_token instead of a
    // silently-null one that breaks refresh once the access token expires.
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
    url.searchParams.set("state", tenantId);
    return { mode: "oauth", authorizeUrl: url.toString() };
  }

  async handleCalendarCallback(code: string, tenantId: string) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4000/integrations/calendar/callback";
    if (!clientId || !clientSecret) {
      throw new BadRequestException("Google OAuth is not configured on this server");
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!response.ok) {
      throw new BadRequestException(`Google token exchange failed: ${await response.text()}`);
    }
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!tokens.refresh_token) {
      // Shouldn't happen with prompt=consent&access_type=offline above, but
      // fail loudly rather than silently storing a connection that can't
      // outlive its first hour.
      throw new BadRequestException("Google did not return a refresh token — reconnect and re-approve access");
    }

    const packed = packCalendarTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
    await this.prisma.client.integration.upsert({
      where: { tenantId_type: { tenantId, type: "calendar" } },
      create: {
        tenantId,
        type: "calendar",
        oauthTokens: encryptToken(packed),
        config: { titleTemplate: "New booking", startField: "startTime" } satisfies CalendarConfig as unknown as Prisma.InputJsonValue,
      },
      update: { oauthTokens: encryptToken(packed), enabled: true },
    });
  }

  /**
   * Returns a live access token for this calendar connection, transparently
   * refreshing it against Google's token endpoint when it's within
   * TOKEN_REFRESH_SKEW_MS of expiring, and persisting the refreshed token
   * back so the next push doesn't refresh again.
   */
  private async getFreshCalendarAccessToken(integration: Integration): Promise<string> {
    const tokens = unpackCalendarTokens(decryptToken(integration.oauthTokens ?? ""));
    if (tokens.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      // Mock-mode tokens are packed with a 100-year expiry and never reach here.
      throw new Error("Calendar access token expired and no refresh token is stored — reconnect");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth is not configured on this server — cannot refresh calendar token");
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refreshToken,
      }),
    });
    if (!response.ok) {
      throw new Error(`Google token refresh failed: ${await response.text().catch(() => response.statusText)}`);
    }
    // Google does not re-issue a refresh_token on a refresh grant — keep the one we have.
    const refreshed = (await response.json()) as { access_token: string; expires_in: number };
    const packed = packCalendarTokens({
      accessToken: refreshed.access_token,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    });
    await this.prisma.client.integration.update({
      where: { id: integration.id },
      data: { oauthTokens: encryptToken(packed) },
    });
    return refreshed.access_token;
  }

  async updateConfig(tenantId: string, type: IntegrationType, config: Record<string, unknown>) {
    const connection = await this.getConnection(tenantId, type);
    if (!connection) throw new NotFoundException(`No ${type} integration for this tenant — connect first`);
    return this.prisma.client.integration.update({
      where: { id: connection.id },
      data: { config: config as Prisma.InputJsonValue },
    });
  }

  async disconnect(tenantId: string, type: IntegrationType) {
    await this.prisma.client.integration
      .delete({ where: { tenantId_type: { tenantId, type } } })
      .catch(() => {
        // Already disconnected — deleting a nonexistent connection is a no-op, not an error.
      });
  }

  /** Backs the portal's manual "re-push" buttons — resolves the integration by tenant+type first. */
  async pushForTenant(tenantId: string, type: IntegrationType, source: PushSource): Promise<IntegrationPushResult> {
    const integration = await this.getConnection(tenantId, type);
    if (!integration) return { success: false, error: `No ${type} integration connected` };
    return this.push(integration.id, source);
  }

  /** Called by the queue processor (auto) and pushForTenant (manual re-push). */
  async push(integrationId: string, source: PushSource): Promise<IntegrationPushResult> {
    const integration = await this.prisma.client.integration.findUnique({ where: { id: integrationId } });
    if (!integration || !integration.enabled) return { success: false, error: "Integration not connected" };

    const record =
      "conversationId" in source
        ? await this.prisma.client.conversation.findUnique({ where: { id: source.conversationId } })
        : await this.prisma.client.formSubmission.findUnique({ where: { id: source.formSubmissionId } });
    // The tenant check is what stops a tenant pushing someone else's
    // captured data to their own webhook/email by guessing an ID.
    if (!record || record.tenantId !== integration.tenantId) return { success: false, error: "Record not found" };

    const capturedData =
      (("capturedData" in record ? record.capturedData : record.data) as Record<string, unknown>) ?? {};
    const config = integration.config as unknown;

    let result: IntegrationPushResult;
    try {
      switch (integration.type) {
        case "webhook":
          result = await this.webhookSender.send(config as WebhookConfig, capturedData);
          break;
        case "email":
          result = await this.emailSender.send(config as EmailConfig, capturedData);
          break;
        case "calendar":
          result = await this.calendarSender.send(
            await this.getFreshCalendarAccessToken(integration),
            config as CalendarConfig,
            capturedData,
          );
          break;
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!result.success) {
      this.logger.warn(`${integration.type} push failed for ${JSON.stringify(source)}: ${result.error}`);
    }

    // Same visibility CRM push gets via crmPushedAt/crmPushError, generalized
    // to a per-type JSON map since up to three integrations run independently.
    // ponytail: read-modify-write on the JSON column; two integrations
    // finishing at the same instant can overwrite each other's entry. Switch
    // to a jsonb_set raw update if that shows up in practice.
    const status = (record.integrationStatus as Record<string, { pushedAt?: string; error?: string }>) ?? {};
    status[integration.type] = result.success ? { pushedAt: new Date().toISOString() } : { error: result.error };
    const data = { integrationStatus: status as Prisma.InputJsonValue };
    if ("conversationId" in source) {
      await this.prisma.client.conversation.update({ where: { id: source.conversationId }, data });
    } else {
      await this.prisma.client.formSubmission.update({ where: { id: source.formSubmissionId }, data });
    }

    return result;
  }
}
