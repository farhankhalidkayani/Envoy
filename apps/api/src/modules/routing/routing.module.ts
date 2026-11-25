import { Module } from "@nestjs/common";
import { CrmModule } from "../crm/crm.module.js";
import { IntegrationsModule } from "../integrations/integrations.module.js";
import { WorkflowsModule } from "../workflows/workflows.module.js";
import { CaptureRoutingService } from "./capture-routing.service.js";

@Module({
  imports: [CrmModule, IntegrationsModule, WorkflowsModule],
  providers: [CaptureRoutingService],
  exports: [CaptureRoutingService],
})
export class RoutingModule {}
