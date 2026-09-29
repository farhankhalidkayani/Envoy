import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { CoreModule } from "../core/core.module.js";
import { RoutingModule } from "../routing/routing.module.js";
import { FormsController } from "./forms.controller.js";
import { FormsService } from "./forms.service.js";
import { PublicFormsController } from "./public-forms.controller.js";

@Module({
  imports: [CoreModule, BillingModule, RoutingModule],
  controllers: [FormsController, PublicFormsController],
  providers: [FormsService],
})
export class FormsModule {}
