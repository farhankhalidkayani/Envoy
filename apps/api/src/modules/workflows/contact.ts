import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type Channel = "email" | "sms";

/** A recipient's identity on a channel, hashed — so an inbound reply can be matched to who we texted without keeping the number in the clear. */
export const contactHash = (channel: Channel, address: string) => createHash("sha256").update(`${channel}:${address}`).digest("hex");

/** Enough to recognise a recipient in a log, not enough to harvest: a***@x.com, +44…0123. */
export function maskAddress(channel: Channel, address: string): string {
  if (channel === "email") {
    const [local = "", domain = ""] = address.split("@");
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${address.slice(0, 3)}…${address.slice(-4)}`;
}

function secret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET ?? process.env.CRM_TOKEN_ENCRYPTION_KEY ?? process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error("UNSUBSCRIBE_SECRET (or JWT_ACCESS_SECRET) must be set to sign unsubscribe links");
  return s;
}
const sign = (payload: string) => createHmac("sha256", secret()).update(`unsubscribe:${payload}`).digest("base64url");

/** A link token that proves WE issued an unsubscribe for exactly this address in this workspace, without storing anything. */
export function createUnsubscribeToken(tenantId: string, email: string): string {
  const payload = Buffer.from(JSON.stringify([tenantId, email])).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyUnsubscribeToken(token: string): { tenantId: string; email: string } | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const [tenantId, email] = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as [unknown, unknown];
    return typeof tenantId === "string" && typeof email === "string" ? { tenantId, email } : null;
  } catch {
    return null;
  }
}

export const publicApiUrl = () => (process.env.PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
export const unsubscribeUrl = (tenantId: string, email: string) => `${publicApiUrl()}/public/unsubscribe/${createUnsubscribeToken(tenantId, email)}`;

/** Appended to every email to a lead: who we are, and a working way out. */
export function emailFooter(businessName: string, unsubscribe: string): string {
  return `\n\n--\nSent by ${businessName}.\nDon't want these emails? Unsubscribe: ${unsubscribe}`;
}

/** Twilio's request signature: HMAC-SHA1 over the full URL plus the POST params sorted by name, base64. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}
