import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { IntegrationsController } from "./integrations.controller.js";
import { IntegrationsPushProcessor } from "./integrations-push.processor.js";
import { IntegrationsQueueService } from "./integrations-queue.service.js";
import { IntegrationsService } from "./integrations.service.js";
import { CalendarSender } from "./senders/calendar.sender.js";
import { EmailSender } from "./senders/email.sender.js";
import { WebhookSender } from "./senders/webhook.sender.js";

/**
 * Google Calendar event, outbound email, and custom webhook — all
 * push-on-complete, gated behind the "integrations" feature flag. Mirrors
 * CrmModule's shape (see crm.module.ts) exactly.
 */
@Module({
  imports: [CoreModule, BillingModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    IntegrationsQueueService,
    IntegrationsPushProcessor,
    WebhookSender,
    EmailSender,
    CalendarSender,
  ],
  exports: [IntegrationsService, IntegrationsQueueService],
})
export class IntegrationsModule {}
