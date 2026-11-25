import { Body, Controller, ForbiddenException, Get, Header, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { publicApiUrl, twilioSignature, verifyUnsubscribeToken } from "./contact.js";
import { WorkflowsService } from "./workflows.service.js";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
  `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1c2024"><h1 style="font-size:1.3rem">${escapeHtml(title)}</h1>${body}</body>`;

/** The two public doors messaging needs: the unsubscribe link in every email, and Twilio's inbound-SMS webhook. */
@Controller()
export class PublicMessagingController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly prisma: PrismaService,
  ) {}

  private async businessName(tenantId: string) {
    return (await this.prisma.client.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name ?? "this sender";
  }

  /**
   * GET only shows a confirmation: email scanners and link previewers fetch every URL in a message, and must not be
   * able to unsubscribe people by doing so. The button (or a mail client's one-click POST) does the work.
   */
  @Get("public/unsubscribe/:token")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async confirm(@Param("token") token: string, @Res() res: Response) {
    const parsed = verifyUnsubscribeToken(token);
    if (!parsed) return res.status(400).send(page("This link isn't valid", "<p>It may have been copied incompletely. Use the link in the most recent email.</p>"));
    const name = await this.businessName(parsed.tenantId);
    return res.send(
      page(`Unsubscribe from ${name}?`, `<p>You'll stop getting follow-up emails from ${escapeHtml(name)} at ${escapeHtml(parsed.email)}.</p><form method="post"><button style="font:inherit;padding:.6rem 1.2rem">Unsubscribe</button></form>`),
    );
  }

  @Post("public/unsubscribe/:token")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async unsubscribe(@Param("token") token: string, @Res() res: Response) {
    const parsed = verifyUnsubscribeToken(token);
    if (!parsed) return res.status(400).send(page("This link isn't valid", "<p>Use the link in the most recent email.</p>"));
    await this.workflows.unsubscribeEmail(parsed.tenantId, parsed.email);
    return res.send(page("You're unsubscribed", `<p>${escapeHtml(await this.businessName(parsed.tenantId))} won't email you follow-ups at ${escapeHtml(parsed.email)} again.</p>`));
  }

  /**
   * Twilio posts inbound texts here. The request is verified with Twilio's signature when TWILIO_AUTH_TOKEN is set; without
   * it only local development may accept unsigned requests (never in production), like the Stripe webhook.
   */
  @Post("webhooks/sms")
  @HttpCode(200)
  @Header("Content-Type", "text/xml")
  async inbound(@Req() req: Request, @Body() body: Record<string, string>) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (authToken) {
      const expected = Buffer.from(twilioSignature(authToken, `${publicApiUrl()}/webhooks/sms`, body ?? {}));
      const given = Buffer.from(String(req.headers["x-twilio-signature"] ?? ""));
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ForbiddenException("Invalid signature");
    } else if (!(process.env.SMS_WEBHOOK_ALLOW_UNSIGNED === "true" && process.env.NODE_ENV !== "production")) {
      throw new ForbiddenException("SMS webhook is not configured");
    }
    if (typeof body?.From === "string" && typeof body?.Body === "string") await this.workflows.handleInboundSms(body.From, body.Body);
    return "<Response></Response>";
  }
}
