import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { AdminController } from "./admin.controller.js";
import { AdminJobsService } from "./admin-jobs.service.js";
import { AdminService } from "./admin.service.js";

@Module({
  imports: [CoreModule, BillingModule],
  controllers: [AdminController],
  providers: [AdminService, AdminJobsService],
})
export class AdminModule {}
