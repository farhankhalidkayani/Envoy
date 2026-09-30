import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { LeadsController } from "./leads.controller.js";
import { LeadsService } from "./leads.service.js";

@Module({
  imports: [CoreModule, BillingModule],
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
