import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { EMAIL_CHANNEL, ResendEmailChannel, SMS_CHANNEL, createSmsChannel } from "./channels.js";
import { PublicMessagingController } from "./public-messaging.controller.js";
import { WorkflowEngine } from "./workflow-engine.service.js";
import { WorkflowQueueService } from "./workflow-queue.service.js";
import { WorkflowProcessor } from "./workflow.processor.js";
import { WorkflowsController } from "./workflows.controller.js";
import { WorkflowsService } from "./workflows.service.js";

/** Follow-up email and SMS sequences. The email and SMS channels are providers, so tests and development never send for real. */
@Module({
  imports: [CoreModule, BillingModule],
  controllers: [WorkflowsController, PublicMessagingController],
  providers: [
    WorkflowsService,
    WorkflowEngine,
    WorkflowQueueService,
    WorkflowProcessor,
    { provide: EMAIL_CHANNEL, useFactory: () => new ResendEmailChannel() },
    { provide: SMS_CHANNEL, useFactory: () => createSmsChannel() },
  ],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
