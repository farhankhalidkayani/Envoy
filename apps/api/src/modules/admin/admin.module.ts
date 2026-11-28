import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { AdminController } from "./admin.controller.js";
import { AdminJobsService } from "./admin-jobs.service.js";
import { AdminService } from "./admin.service.js";
import { OperatorTokensController, OperatorTokensService } from "./operator-tokens.controller.js";

@Module({
  imports: [CoreModule, BillingModule],
  controllers: [AdminController, OperatorTokensController],
  providers: [AdminService, AdminJobsService, OperatorTokensService],
})
export class AdminModule {}
