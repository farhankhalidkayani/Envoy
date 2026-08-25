import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { CRM_PROVIDER } from "./providers/crm-provider.module.js";
import type { CrmProvider, CrmPushResult } from "./providers/types.js";
import { decryptToken, encryptToken } from "./token-crypto.js";

const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_SCOPES = "crm.objects.contacts.write";

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CRM_PROVIDER) private readonly provider: CrmProvider,
  ) {}

  async getConnection(tenantId: string) {
    return this.prisma.client.crmConnection.findUnique({
      where: { tenantId_provider: { tenantId, provider: "hubspot" } },
    });
  }

  /**
   * Real HubSpot OAuth needs a registered app (HUBSPOT_CLIENT_ID/SECRET) —
   * unavailable here, same posture as Stripe/Groq/Gemini. Without it, this
   * connects immediately with a stand-in token (mirroring
   * BillingService.ensureSubscription's `local_<tenantId>` pattern) so the
   * push mechanism is testable end-to-end. With it, returns the real
   * HubSpot authorize URL for the client to redirect to.
   */
  async initiateConnect(tenantId: string): Promise<{ mode: "mock" | "oauth"; authorizeUrl?: string }> {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    if (!clientId) {
      await this.prisma.client.crmConnection.upsert({
        where: { tenantId_provider: { tenantId, provider: "hubspot" } },
        create: {
          tenantId,
          provider: "hubspot",
          oauthTokens: encryptToken("mock_access_token"),
          fieldMapping: {},
        },
        update: {},
      });
      this.logger.warn(`HUBSPOT_CLIENT_ID not set — connected tenant ${tenantId} in mock mode`);
      return { mode: "mock" };
    }

    const redirectUri = process.env.HUBSPOT_REDIRECT_URI ?? "http://localhost:4000/crm/callback";
    const url = new URL(HUBSPOT_AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", HUBSPOT_SCOPES);
    url.searchParams.set("state", tenantId);
    return { mode: "oauth", authorizeUrl: url.toString() };
  }

  /** OAuth callback — exchanges the authorization code for tokens. Code-complete, not live-tested. */
  async handleCallback(code: string, tenantId: string) {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
    const redirectUri = process.env.HUBSPOT_REDIRECT_URI ?? "http://localhost:4000/crm/callback";
    if (!clientId || !clientSecret) {
      throw new BadRequestException("HubSpot OAuth is not configured on this server");
    }

    const response = await fetch(HUBSPOT_TOKEN_URL, {
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
      throw new BadRequestException(`HubSpot token exchange failed: ${await response.text()}`);
    }
    const tokens = (await response.json()) as { access_token: string };

    await this.prisma.client.crmConnection.upsert({
      where: { tenantId_provider: { tenantId, provider: "hubspot" } },
      create: {
        tenantId,
        provider: "hubspot",
        oauthTokens: encryptToken(tokens.access_token),
        fieldMapping: {},
      },
      update: { oauthTokens: encryptToken(tokens.access_token) },
    });
  }

  async updateFieldMapping(tenantId: string, mapping: Record<string, string>) {
    const connection = await this.getConnection(tenantId);
    if (!connection) throw new NotFoundException("No CRM connection for this tenant — connect first");
    return this.prisma.client.crmConnection.update({
      where: { id: connection.id },
      data: { fieldMapping: mapping as Prisma.InputJsonValue },
    });
  }

  async disconnect(tenantId: string) {
    await this.prisma.client.crmConnection
      .delete({ where: { tenantId_provider: { tenantId, provider: "hubspot" } } })
      .catch(() => {
        // Already disconnected — deleting a nonexistent connection is a no-op, not an error.
      });
  }

  /**
   * Maps capturedData through the tenant's fieldMapping (envoy key -> CRM
   * property name), pushes via the active provider, and reports the
   * outcome. Called both automatically on conversation completion (see
   * CrmPushProcessor) and manually from the dashboard's re-push action —
   * same code path either way.
   */
  async pushConversation(conversationId: string): Promise<CrmPushResult> {
    const conversation = await this.prisma.client.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) return { success: false, error: "Conversation not found" };

    const connection = await this.getConnection(conversation.tenantId);
    if (!connection) return { success: false, error: "Tenant has no CRM connection" };

    const capturedData = (conversation.capturedData as Record<string, unknown>) ?? {};
    const fieldMapping = (connection.fieldMapping as Record<string, string>) ?? {};
    const mappedRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(capturedData)) {
      mappedRecord[fieldMapping[key] ?? key] = value;
    }

    const accessToken = decryptToken(connection.oauthTokens);
    const result = await this.provider.pushRecord(accessToken, mappedRecord);

    // Persisted so the dashboard can show "pushed to CRM ✓" per
    // conversation — the ≥95%-pushed success metric needs this to be
    // visible, not just logged.
    await this.prisma.client.conversation.update({
      where: { id: conversationId },
      data: result.success
        ? { crmPushedAt: new Date(), crmExternalId: result.externalId, crmPushError: null }
        : { crmPushError: result.error },
    });

    if (!result.success) {
      this.logger.warn(`CRM push failed for conversation ${conversationId}: ${result.error}`);
    }
    return result;
  }
}
