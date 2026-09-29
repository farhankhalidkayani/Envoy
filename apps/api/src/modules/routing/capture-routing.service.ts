import { Injectable } from "@nestjs/common";
import { CrmQueueService } from "../crm/crm-queue.service.js";
import { CrmService } from "../crm/crm.service.js";
import { IntegrationsQueueService } from "../integrations/integrations-queue.service.js";
import { IntegrationsService } from "../integrations/integrations.service.js";
import type { PushSource } from "../integrations/types.js";

/**
 * Fans captured data out to every destination the tenant has connected —
 * CRM plus each integration, one queue job apiece so one failing never
 * blocks the others. Shared by conversation completion and form submission
 * so both always route to the same place.
 *
 * Gated purely on "is it connected", not on a feature flag: flags gate who
 * can view/edit the connection in the portal, a different concern.
 */
@Injectable()
export class CaptureRoutingService {
  constructor(
    private readonly crm: CrmService,
    private readonly crmQueue: CrmQueueService,
    private readonly integrations: IntegrationsService,
    private readonly integrationsQueue: IntegrationsQueueService,
  ) {}

  async route(tenantId: string, source: PushSource): Promise<void> {
    if (await this.crm.getConnection(tenantId)) {
      await this.crmQueue.enqueuePush(source);
    }
    for (const integration of await this.integrations.getConnections(tenantId)) {
      await this.integrationsQueue.enqueuePush({ integrationId: integration.id, ...source });
    }
  }
}
