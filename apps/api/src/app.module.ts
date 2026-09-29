import { Module } from "@nestjs/common";
import { AdminModule } from "./modules/admin/admin.module.js";
import { AgentModule } from "./modules/agent/agent.module.js";
import { BillingModule } from "./modules/billing/billing.module.js";
import { CoreModule } from "./modules/core/core.module.js";
import { CrmModule } from "./modules/crm/crm.module.js";
import { FormsModule } from "./modules/forms/forms.module.js";
import { IntegrationsModule } from "./modules/integrations/integrations.module.js";
import { PipelineModule } from "./modules/pipeline/pipeline.module.js";

@Module({
  imports: [CoreModule, AgentModule, BillingModule, AdminModule, PipelineModule, CrmModule, IntegrationsModule, FormsModule],
})
export class AppModule {}
