import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { WidgetConfig } from "@envoy/types";
import { PrismaService } from "../core/prisma/prisma.service.js";

/**
 * Unauthenticated by design — this is what the embeddable widget calls with
 * only the publicToken from its embed snippet (`data-agent="pub_xxx"`) to
 * resolve the internal agentId + widgetConfig before opening the WS
 * session. Returns nothing tenant-sensitive: no script, no hardRules, no
 * requiredFields, no tenant identifiers.
 */
@Controller("agents/public")
export class PublicAgentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(":publicToken")
  async findByPublicToken(@Param("publicToken") publicToken: string) {
    const agent = await this.prisma.client.agent.findUnique({
      where: { publicToken },
      include: { tenant: true },
    });
    if (!agent || agent.status !== "live") {
      throw new NotFoundException("Agent not found");
    }
    const priceConfig = agent.tenant.priceConfig as { addOns?: { voice?: boolean } } | null;
    return {
      id: agent.id,
      publicToken: agent.publicToken,
      widgetConfig: WidgetConfig.parse(agent.widgetConfig ?? {}),
      locked: agent.tenant.subscriptionStatus === "locked",
      voiceEnabled: Boolean(priceConfig?.addOns?.voice),
    };
  }
}
