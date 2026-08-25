import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { JwtPayload } from "../types.js";

/** Injects the authenticated principal into a controller method: `@CurrentUser() user: JwtPayload`. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): JwtPayload => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
