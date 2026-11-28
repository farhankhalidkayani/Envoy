import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../guards/jwt-auth.guard.js";
import type { AuthenticatedRequest } from "../types.js";

/** "Is this credential still good, and what may it do?" The MCP server asks before each request, so an expired token gets a proper 401. */
@Controller("token-info")
@UseGuards(JwtAuthGuard)
export class TokenInfoController {
  @Get()
  info(@Req() req: AuthenticatedRequest) {
    return req.apiToken ? { kind: "api_token", name: req.apiToken.name, scopes: req.apiToken.scopes } : { kind: "person" };
  }
}
