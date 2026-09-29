import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // cloud metadata lives here
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export class UnsafeUrlError extends Error {}

/**
 * Tenant-supplied URLs (webhooks, API-sourced dropdowns) are fetched by our
 * server, so without this a tenant could aim them at internal services or
 * the cloud metadata endpoint. Resolves the host and rejects private,
 * loopback, link-local and multicast addresses (IPv4-mapped IPv6 included —
 * BlockList checks those against the IPv4 rules).
 *
 * ponytail: resolve-then-fetch leaves a DNS-rebinding window between the
 * check and undici's own lookup. Pin the resolved IP via a custom undici
 * Agent `connect.lookup` if this ever faces a determined attacker.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http(s) URLs are allowed");
  }
  if (process.env.ALLOW_PRIVATE_FETCH === "true") return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const { address, family } of addresses) {
    if (blocked.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new UnsafeUrlError(`${url.hostname} resolves to a private or reserved address`);
    }
  }
  return url;
}

/** fetch() for tenant-supplied URLs: SSRF-checked, no redirects (a 3xx could bounce inward), 10s timeout. */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const url = await assertPublicUrl(raw);
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
}
