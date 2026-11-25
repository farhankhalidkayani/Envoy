import { Logger } from "@nestjs/common";

/**
 * How a message actually leaves the building. Email and SMS each sit behind an interface so the workflow engine
 * never knows which vendor is behind it, and tests and local development use mocks: no API keys, no real sends.
 */
export interface SendOutcome {
  ok: boolean;
  /** The provider's message id, when it gave one. */
  id?: string;
  error?: string;
  /** Retrying can't help (a malformed or unreachable address). Absent on failures that might clear up (outage, rate limit). */
  permanent?: boolean;
  /** The provider says this person has opted out at the carrier — record it so no workflow tries again. */
  optedOut?: boolean;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  /** The same key sent twice is delivered once (where the provider supports it) — guards against a retried step double-sending. */
  idempotencyKey?: string;
}

export interface EmailChannel {
  send(message: EmailMessage): Promise<SendOutcome>;
}

export interface SmsChannel {
  readonly name: string;
  send(message: { to: string; body: string }): Promise<SendOutcome>;
}

export const EMAIL_CHANNEL = "EMAIL_CHANNEL";
export const SMS_CHANNEL = "SMS_CHANNEL";

const transient = (status: number) => status === 429 || status >= 500;

/** Resend over plain fetch. Without RESEND_API_KEY it logs and reports success, like every other mailer here. */
export class ResendEmailChannel implements EmailChannel {
  private readonly logger = new Logger("ResendEmailChannel");

  async send(message: EmailMessage): Promise<SendOutcome> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      this.logger.warn(`RESEND_API_KEY not set — would have emailed ${message.to}: "${message.subject}"`);
      return { ok: true, id: "mock" };
    }
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL ?? "envoy@resend.dev", to: message.to, subject: message.subject, text: message.text, headers: message.headers }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, error: `Email provider unreachable: ${(err as Error).message}` };
    }
    if (response.ok) return { ok: true, id: ((await response.json().catch(() => ({}))) as { id?: string }).id };
    return { ok: false, error: `Resend error ${response.status}`, permanent: !transient(response.status) };
  }
}

/** Twilio's Messages API. Code-complete against the documented shape; not live-tested (no Twilio account here). */
export class TwilioSmsChannel implements SmsChannel {
  readonly name = "twilio";

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
  ) {}

  async send({ to, body }: { to: string; body: string }): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: this.from, Body: body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, error: `SMS provider unreachable: ${(err as Error).message}` };
    }
    const data = (await response.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (response.ok) return { ok: true, id: data.sid };
    // 21610: the recipient replied STOP to our number at the carrier level — that is an opt-out whatever our records say.
    if (data.code === 21610) return { ok: false, error: "Recipient has opted out", permanent: true, optedOut: true };
    return { ok: false, error: `Twilio error ${data.code ?? response.status}`, permanent: !transient(response.status) };
  }
}

/** Logs instead of texting. A body containing FORCE_FAILURE fails (permanently), to exercise the failure path. */
export class MockSmsChannel implements SmsChannel {
  readonly name = "mock";
  private readonly logger = new Logger("MockSmsChannel");

  async send({ to, body }: { to: string; body: string }): Promise<SendOutcome> {
    if (body.includes("FORCE_FAILURE")) return { ok: false, error: "Simulated SMS failure", permanent: true };
    this.logger.log(`mock SMS to ${to}: ${body.replace(/\n/g, " ⏎ ")}`);
    return { ok: true, id: `mock_sms_${Math.random().toString(36).slice(2, 10)}` };
  }
}

export function createSmsChannel(): SmsChannel {
  switch (process.env.SMS_PROVIDER ?? "mock") {
    case "twilio": {
      const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
      if (!sid || !token || !from) throw new Error("SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM");
      return new TwilioSmsChannel(sid, token, from);
    }
    case "mock":
      return new MockSmsChannel();
    default:
      throw new Error(`Unknown SMS_PROVIDER "${process.env.SMS_PROVIDER}" (expected mock|twilio)`);
  }
}
