import { Body, Controller, Get, HttpCode, Ip, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { enforceRateLimit } from "../core/common/rate-limit.js";
import { ZodValidationPipe } from "../core/common/zod-validation.pipe.js";
import { RedisService } from "../core/redis/redis.service.js";
import { FormsService } from "./forms.service.js";

const AnswersDto = z.record(z.string(), z.unknown());

/**
 * Unauthenticated by design — the hosted/iframe form calls these with only
 * the form's publicToken. Rate-limited per IP+form since submit writes rows
 * and fans out pushes, and the options proxy makes outbound requests.
 *
 * req.ip reflects the real client address only when TRUST_PROXY is set
 * (see main.ts) to match the deployment's actual proxy hop count.
 */
@Controller("public/forms")
export class PublicFormsController {
  constructor(
    private readonly forms: FormsService,
    private readonly redis: RedisService,
  ) {}

  @Get(":token")
  get(@Param("token") token: string) {
    return this.forms.getPublic(token);
  }

  @Post(":token/submit")
  @HttpCode(200)
  async submit(@Ip() ip: string, @Param("token") token: string, @Body(new ZodValidationPipe(AnswersDto)) body: Record<string, unknown>) {
    await enforceRateLimit(this.redis.client, `form-submit:${token}:${ip}`, 10, 60);
    return this.forms.submit(token, body);
  }

  @Post(":token/options/:fieldKey")
  @HttpCode(200)
  async options(
    @Ip() ip: string,
    @Param("token") token: string,
    @Param("fieldKey") fieldKey: string,
    @Body(new ZodValidationPipe(AnswersDto)) answers: Record<string, unknown>,
  ) {
    await enforceRateLimit(this.redis.client, `form-options:${token}:${ip}`, 60, 60);
    return this.forms.fetchOptions(token, fieldKey, answers);
  }
}
