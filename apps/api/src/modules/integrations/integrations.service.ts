import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Integration, IntegrationType, Prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { RedisService } from "../core/redis/redis.service.js";
import { consumeOAuthState, issueOAuthState } from "../core/common/oauth-state.js";
import { sanitizeCapturedData } from "../core/common/sanitize-captured-data.js";
import { AuditService } from "../core/audit/audit.service.js";
import { decryptToken, encryptToken } from "../crm/token-crypto.js";
import { NEVER_EXPIRES, packTokens, refreshIfExpiring, tokensFromGrant, unpackTokens } from "../core/common/oauth-tokens.js";
import { CalendarSender } from "./senders/calendar.sender.js";
import { EmailSender } from "./senders/email.sender.js";
import { WebhookSender } from "./senders/webhook.sender.js";
import type { CalendarConfig, EmailConfig, IntegrationPushResult, PushSource, WebhookConfig } from "./types.js";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
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
  async connectWebhook(tenantId: string, actorUserId: string, config: WebhookConfig) {
    const integration = await this.prisma.client.integration.upsert({
      where: { tenantId_type: { tenantId, type: "webhook" } },
      create: { tenantId, type: "webhook", config: config as unknown as Prisma.InputJsonValue },
      update: { config: config as unknown as Prisma.InputJsonValue, enabled: true },
    });
    await this.audit.log(actorUserId, tenantId, "integration.webhook.connected", { url: config.url });
    return integration;
  }

  /** Email needs no per-tenant OAuth either — outbound via the app's own Resend account. */
  async connectEmail(tenantId: string, actorUserId: string, config: EmailConfig) {
    const integration = await this.prisma.client.integration.upsert({
      where: { tenantId_type: { tenantId, type: "email" } },
      create: { tenantId, type: "email", config: config as unknown as Prisma.InputJsonValue },
      update: { config: config as unknown as Prisma.InputJsonValue, enabled: true },
    });
    await this.audit.log(actorUserId, tenantId, "integration.email.connected", { to: config.to });
    return integration;
  }

  /** Mirrors CrmService.initiateConnect — mock mode when GOOGLE_CLIENT_ID isn't configured. */
  async initiateCalendarConnect(tenantId: string, actorUserId: string): Promise<{ mode: "mock" | "oauth"; authorizeUrl?: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      // Mock tokens never expire — there's no live Google account behind them to refresh against.
      const mockTokens = packTokens({ accessToken: "mock_access_token", expiresAt: NEVER_EXPIRES });
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
      await this.audit.log(actorUserId, tenantId, "integration.calendar.connected", { mode: "mock" });
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
    url.searchParams.set("state", await issueOAuthState(this.redis.client, tenantId, "google_calendar"));
    return { mode: "oauth", authorizeUrl: url.toString() };
  }

  async handleCalendarCallback(code: string, state: string | undefined) {
    const tenantId = await consumeOAuthState(this.redis.client, state, "google_calendar");
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

    const packed = packTokens(tokensFromGrant(tokens));
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

  /** Live access token for this calendar connection, refreshed and persisted when about to expire. */
  private async getFreshCalendarAccessToken(integration: Integration): Promise<string> {
    const tokens = unpackTokens(decryptToken(integration.oauthTokens ?? ""));
    const refreshed = await refreshIfExpiring(tokens, {
      tokenUrl: GOOGLE_TOKEN_URL,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      providerName: "Google Calendar",
    });
    if (!refreshed) return tokens.accessToken;
    await this.prisma.client.integration.update({
      where: { id: integration.id },
      data: { oauthTokens: encryptToken(packTokens(refreshed)) },
    });
    return refreshed.accessToken;
  }

  async updateConfig(tenantId: string, type: IntegrationType, config: Record<string, unknown>) {
    const connection = await this.getConnection(tenantId, type);
    if (!connection) throw new NotFoundException(`No ${type} integration for this tenant — connect first`);
    return this.prisma.client.integration.update({
      where: { id: connection.id },
      data: { config: config as Prisma.InputJsonValue },
    });
  }

  async disconnect(tenantId: string, actorUserId: string, type: IntegrationType) {
    await this.prisma.client.integration
      .delete({ where: { tenantId_type: { tenantId, type } } })
      .catch(() => {
        // Already disconnected — deleting a nonexistent connection is a no-op, not an error.
      });
    await this.audit.log(actorUserId, tenantId, `integration.${type}.disconnected`);
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

    const capturedData = sanitizeCapturedData(
      (("capturedData" in record ? record.capturedData : record.data) as Record<string, unknown>) ?? {},
    );
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
    // jsonb_set does the merge inside Postgres in one statement — unlike a
    // read-modify-write in application code, two integrations finishing at
    // the same instant can't clobber each other's entry, since there's no
    // window where either holds a stale in-memory copy of the column.
    const entry = JSON.stringify(result.success ? { pushedAt: new Date().toISOString() } : { error: result.error });
    const path = `{${integration.type}}`;
    if ("conversationId" in source) {
      await this.prisma.client.$executeRaw`
        UPDATE "conversations"
        SET "integrationStatus" = jsonb_set(COALESCE("integrationStatus", '{}'::jsonb), ${path}::text[], ${entry}::jsonb, true)
        WHERE id = ${source.conversationId}
      `;
    } else {
      await this.prisma.client.$executeRaw`
        UPDATE "form_submissions"
        SET "integrationStatus" = jsonb_set(COALESCE("integrationStatus", '{}'::jsonb), ${path}::text[], ${entry}::jsonb, true)
        WHERE id = ${source.formSubmissionId}
      `;
    }

    return result;
  }
}
