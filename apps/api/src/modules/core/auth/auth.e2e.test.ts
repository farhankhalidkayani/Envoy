import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../app.module.js";
import { AgentGateway } from "../../agent/gateway/agent.gateway.js";

/** Pulls the named cookie's value out of a Set-Cookie header, ignoring attributes. */
function cookieValue(setCookie: string | null, name: string): string | undefined {
  if (!setCookie) return undefined;
  const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
  return match?.[1];
}

describe("auth sessions (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let redis: Redis;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    // The login rate limit shares Redis with dev/other test runs — clear any
    // leftover counters from this suite's own key prefixes before it starts,
    // so an earlier run can't cause a spurious early 429 here.
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    for (const pattern of ["ratelimit:login-ip:*", "ratelimit:login-email:*"]) {
      const keys = await redis.keys(pattern);
      if (keys.length) await redis.del(keys);
    }
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await redis.quit();
    await app.close();
  });

  async function register(emailOverride?: string) {
    const email = emailOverride ?? `auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: "Auth Test", email, password: "password123!" }),
    });
    const body = (await res.json()) as { accessToken: string; user: { tenantId: string } };
    tenantIds.push(body.user.tenantId);
    return {
      res,
      email,
      refreshToken: cookieValue(res.headers.get("set-cookie"), "envoy_rt_portal")!,
      accessToken: body.accessToken,
    };
  }

  it("sets an httpOnly, /auth-scoped refresh cookie on register", async () => {
    const { res, refreshToken } = await register();
    const setCookie = res.headers.get("set-cookie")!;
    expect(refreshToken).toBeTruthy();
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Path=\/auth/);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it("rotates the refresh token and issues a usable access token", async () => {
    const { refreshToken: rt1 } = await register();
    const res = await fetch(`${baseUrl}/auth/refresh`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${rt1}` } });
    expect(res.status).toBe(200);
    const rt2 = cookieValue(res.headers.get("set-cookie"), "envoy_rt_portal");
    const { accessToken: at2 } = (await res.json()) as { accessToken: string };
    expect(rt2).toBeTruthy();
    expect(rt2).not.toBe(rt1);
    // A same-second refresh can legitimately produce an identical JWT (iat has
    // 1s granularity, same claims) — what matters is it's a usable token.
    expect(typeof at2).toBe("string");
    expect((await fetch(`${baseUrl}/agents`, { headers: { Authorization: `Bearer ${at2}` } })).status).toBe(200);
  });

  it("keeps portal and admin sessions on separate cookies, each unusable for the other scope", async () => {
    const email = `auth-admin-${Date.now()}@test.dev`;
    const { res: portalRes } = await register(email);
    expect(portalRes.headers.get("set-cookie")).toMatch(/envoy_rt_portal=/);

    // Same account, logging in again but as the admin app — the response
    // must set envoy_rt_admin, and the portal cookie from above must not
    // work for a refresh sent with the admin header (no scope crossover).
    const adminRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Envoy-App": "admin" },
      body: JSON.stringify({ email, password: "password123!" }),
    });
    expect(adminRes.headers.get("set-cookie")).toMatch(/envoy_rt_admin=/);
    const portalRt = cookieValue(portalRes.headers.get("set-cookie"), "envoy_rt_portal")!;
    const crossed = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { Cookie: `envoy_rt_admin=${portalRt}`, "X-Envoy-App": "admin" },
    });
    expect(crossed.status).toBe(401);
  });

  it("detects reuse of an old refresh token outside the grace window and revokes every session for that user", async () => {
    const { refreshToken: rt1 } = await register();
    const r1 = await fetch(`${baseUrl}/auth/refresh`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${rt1}` } });
    const rt2 = cookieValue(r1.headers.get("set-cookie"), "envoy_rt_portal")!;

    // Within the grace window (near-simultaneous double-refresh, e.g. two
    // tabs), replaying rt1 must still succeed rather than being flagged as theft.
    const withinGrace = await fetch(`${baseUrl}/auth/refresh`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${rt1}` } });
    expect(withinGrace.status).toBe(200);

    // Push rt1's rotatedAt into the past to simulate presenting it again
    // long after it was rotated — that's theft, not a racing tab.
    await prisma.session.update({
      where: { tokenHash: createHash("sha256").update(rt1).digest("hex") },
      data: { rotatedAt: new Date(Date.now() - 60_000) },
    });
    const replay = await fetch(`${baseUrl}/auth/refresh`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${rt1}` } });
    expect(replay.status).toBe(401);

    // The legitimate rt2 must be dead too — the whole user's session set was revoked.
    const afterTheft = await fetch(`${baseUrl}/auth/refresh`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${rt2}` } });
    expect(afterTheft.status).toBe(401);
  });

  it("logout revokes the session so refresh stops working", async () => {
    const { refreshToken } = await register();
    const out = await fetch(`${baseUrl}/auth/logout`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${refreshToken}` } });
    expect(out.status).toBe(204);
    expect(cookieValue(out.headers.get("set-cookie"), "envoy_rt_portal")).toBe("");

    const after = await fetch(`${baseUrl}/auth/refresh`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${refreshToken}` } });
    expect(after.status).toBe(401);
  });

  it("refresh with no cookie, and login with a bad password, are both rejected without a session", async () => {
    const { email } = await register();
    expect((await fetch(`${baseUrl}/auth/refresh`, { method: "POST" })).status).toBe(401);
    const bad = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("rate limits repeated login attempts against a single email (brute force)", async () => {
    const { email } = await register();
    const login = () =>
      fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "wrong-password" }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await login()).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses[8]).toBe(429);

    // The correct password doesn't get a free pass once the limit is tripped.
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123!" }),
    });
    expect(res.status).toBe(429);
  });

  it("rate limits login attempts by source IP across many different emails", async () => {
    // Earlier tests in this file already made a few /auth/login calls from
    // the same source IP — reset the IP counter so this test's own count is
    // the only thing deciding when the limit trips.
    const keys = await redis.keys("ratelimit:login-ip:*");
    if (keys.length) await redis.del(keys);

    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `sprayed-${i}@nowhere.test`, password: "x" }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(401));
    expect(statuses[30]).toBe(429);

    // This test deliberately trips the IP-wide counter — leaving it tripped
    // would 429 every /auth/login call after this one, in this file and any
    // other e2e file sharing the same Redis and source IP.
    const dirty = await redis.keys("ratelimit:login-ip:*");
    if (dirty.length) await redis.del(dirty);
  });
});
