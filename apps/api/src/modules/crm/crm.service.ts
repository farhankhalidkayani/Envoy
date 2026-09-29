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
   * property name) and pushes via the active provider. Source-agnostic —
   * pushConversation/pushFormSubmission load the data and persist the
   * outcome on their own row.
   */
  private async pushRecord(tenantId: string, capturedData: Record<string, unknown>): Promise<CrmPushResult> {
    const connection = await this.getConnection(tenantId);
    if (!connection) return { success: false, error: "Tenant has no CRM connection" };

    const fieldMapping = (connection.fieldMapping as Record<string, string>) ?? {};
    const mappedRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(capturedData)) {
      mappedRecord[fieldMapping[key] ?? key] = value;
    }
    return this.provider.pushRecord(decryptToken(connection.oauthTokens), mappedRecord);
  }

  private statusUpdate(result: CrmPushResult) {
    // Persisted so the dashboard can show "pushed to CRM ✓" per record —
    // the ≥95%-pushed success metric needs this visible, not just logged.
    return result.success
      ? { crmPushedAt: new Date(), crmExternalId: result.externalId, crmPushError: null }
      : { crmPushError: result.error };
  }

  /**
   * Auto (CrmPushProcessor) and manual dashboard re-push share this path.
   * `tenantId` is passed by the manual route so a tenant can't trigger
   * pushes of another tenant's conversations by ID.
   */
  async pushConversation(conversationId: string, tenantId?: string): Promise<CrmPushResult> {
    const conversation = await this.prisma.client.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || (tenantId && conversation.tenantId !== tenantId)) {
      return { success: false, error: "Conversation not found" };
    }

    const result = await this.pushRecord(
      conversation.tenantId,
      (conversation.capturedData as Record<string, unknown>) ?? {},
    );
    await this.prisma.client.conversation.update({ where: { id: conversationId }, data: this.statusUpdate(result) });
    if (!result.success) this.logger.warn(`CRM push failed for conversation ${conversationId}: ${result.error}`);
    return result;
  }

  async pushFormSubmission(submissionId: string, tenantId?: string): Promise<CrmPushResult> {
    const submission = await this.prisma.client.formSubmission.findUnique({ where: { id: submissionId } });
    if (!submission || (tenantId && submission.tenantId !== tenantId)) {
      return { success: false, error: "Form submission not found" };
    }

    const result = await this.pushRecord(submission.tenantId, (submission.data as Record<string, unknown>) ?? {});
    await this.prisma.client.formSubmission.update({ where: { id: submissionId }, data: this.statusUpdate(result) });
    if (!result.success) this.logger.warn(`CRM push failed for form submission ${submissionId}: ${result.error}`);
    return result;
  }
}
