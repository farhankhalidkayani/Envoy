import { Module } from "@nestjs/common";
import { CoreModule } from "../core/core.module.js";
import { AccountController } from "./account.controller.js";
import { AccountService } from "./account.service.js";
import { RetentionQueueService } from "./retention-queue.service.js";
import { RetentionProcessor } from "./retention.processor.js";
import { RetentionService } from "./retention.service.js";

@Module({
  imports: [CoreModule],
  controllers: [AccountController],
  providers: [AccountService, RetentionService, RetentionQueueService, RetentionProcessor],
})
export class AccountModule {}
