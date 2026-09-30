import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

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

interface Resolved {
  url: URL;
  /** The specific address validated as public — reused for the actual connection so a second, unvalidated lookup can't land somewhere else (DNS rebinding). Absent only when ALLOW_PRIVATE_FETCH bypasses resolution entirely. */
  address?: string;
  family?: 4 | 6;
}

async function resolveAndValidate(raw: string): Promise<Resolved> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http(s) URLs are allowed");
  }
  if (process.env.ALLOW_PRIVATE_FETCH === "true") return { url };

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const { address, family } of addresses) {
    if (blocked.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new UnsafeUrlError(`${url.hostname} resolves to a private or reserved address`);
    }
  }
  const first = addresses[0];
  return { url, address: first?.address, family: (first?.family as 4 | 6) ?? 4 };
}

/**
 * Tenant-supplied URLs (webhooks, API-sourced dropdowns) are fetched by our
 * server, so without this a tenant could aim them at internal services or
 * the cloud metadata endpoint. Resolves the host and rejects private,
 * loopback, link-local and multicast addresses (IPv4-mapped IPv6 included —
 * BlockList checks those against the IPv4 rules).
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  return (await resolveAndValidate(raw)).url;
}

/**
 * fetch() for tenant-supplied URLs: SSRF-checked, no redirects (a 3xx could
 * bounce inward), 10s timeout, and DNS-pinned — the connection is forced to
 * the exact address resolveAndValidate already checked, via a custom
 * dispatcher, so undici's own internal lookup (which would otherwise
 * re-resolve the hostname right before connecting) can't be handed a
 * different, unvalidated address by a DNS server that flips its answer
 * between the check and the connect.
 */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const { url, address, family } = await resolveAndValidate(raw);
  const dispatcher = address
    ? new Agent({
        connect: {
          lookup: (_hostname, _options, callback) => callback(null, address, family ?? 4),
        },
      })
    : undefined;
  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
  } as RequestInit);
}
