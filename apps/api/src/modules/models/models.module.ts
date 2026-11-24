import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { LlmProviderModule } from "../agent/providers/llm/llm-provider.module.js";
import { CoreModule } from "../core/core.module.js";
import { ModelsController } from "./models.controller.js";
import { ModelsService } from "./models.service.js";

/** Bring-your-own-model keys: store, test, assign to roles, and report usage. Routing itself lives in LlmProviderModule. */
@Module({
  imports: [CoreModule, BillingModule, LlmProviderModule],
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
