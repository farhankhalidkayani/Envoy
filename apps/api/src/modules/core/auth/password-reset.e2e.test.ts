import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { prisma } from "@envoy/db";
import { AppModule } from "../../../app.module.js";
import { AgentGateway } from "../../agent/gateway/agent.gateway.js";

describe("password reset + email verification (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    // Same reasoning as auth.e2e.test.ts: clear this suite's own rate-limit
    // keys so a previous run (or another file) can't leave a counter primed
    // to 429 before this run's own requests even start.
    const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const keys = await redis.keys("ratelimit:pwreset-*");
    if (keys.length) await redis.del(keys);
    await redis.quit();
  }, 20000);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await app.close();
  });

  function cookieValue(setCookie: string | null, name: string): string | undefined {
    if (!setCookie) return undefined;
    const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
    return match?.[1];
  }

  async function register() {
    const email = `pwreset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantName: "PW Reset Test", email, password: "password123!" }),
    });
    const body = (await res.json()) as { accessToken: string; user: { tenantId: string; emailVerified: boolean } };
    tenantIds.push(body.user.tenantId);
    return {
      email,
      accessToken: body.accessToken,
      emailVerified: body.user.emailVerified,
      refreshToken: cookieValue(res.headers.get("set-cookie"), "envoy_rt_portal")!,
    };
  }

  it("a fresh account is unverified, and registration queues a verification email (dev token exposed with no RESEND_API_KEY)", async () => {
    const { accessToken, emailVerified } = await register();
    expect(emailVerified).toBe(false);

    // No RESEND_API_KEY is set for this suite (see the local-only env used to run it),
    // so requesting again surfaces a dev token instead of only emailing a link.
    const res = await fetch(`${baseUrl}/auth/verify-email/request`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json()) as { requested: boolean; devToken?: string };
    expect(body.requested).toBe(true);
    expect(body.devToken).toBeTruthy();
  });

  it("confirms email verification with a valid token, and the token is single-use", async () => {
    const { accessToken } = await register();
    const { devToken } = (await (
      await fetch(`${baseUrl}/auth/verify-email/request`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } })
    ).json()) as { devToken: string };

    const confirm = await fetch(`${baseUrl}/auth/verify-email/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: devToken }),
    });
    expect(confirm.status).toBe(200);

    // Now verified — the next login reflects it.
    const replay = await fetch(`${baseUrl}/auth/verify-email/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: devToken }),
    });
    expect(replay.status).toBe(401);
  });

  it("rejects an unknown or garbage verification token", async () => {
    const res = await fetch(`${baseUrl}/auth/verify-email/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(res.status).toBe(401);
  });

  it("never reveals whether an email exists, and resets the password on a valid token", async () => {
    const { email } = await register();

    const unknown = await fetch(`${baseUrl}/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "no-such-account@test.dev" }),
    });
    const known = await fetch(`${baseUrl}/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(unknown.status).toBe(known.status);
    const unknownBody = (await unknown.json()) as { requested: boolean; devToken?: string };
    const knownBody = (await known.json()) as { requested: boolean; devToken?: string };
    expect(unknownBody.requested).toBe(true);
    expect(unknownBody.devToken).toBeUndefined(); // no user -> nothing to reset, no token minted
    expect(knownBody.devToken).toBeTruthy();

    const confirm = await fetch(`${baseUrl}/auth/password-reset/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: knownBody.devToken, password: "new-password-456!" }),
    });
    expect(confirm.status).toBe(200);

    const oldPw = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123!" }),
    });
    expect(oldPw.status).toBe(401);
    const newPw = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "new-password-456!" }),
    });
    expect(newPw.status).toBe(201); // POST /auth/login has no @HttpCode override — Nest's default for POST
  });

  it("resetting the password revokes the refresh session created at registration", async () => {
    const { email, refreshToken } = await register();

    const { devToken } = (await (
      await fetch(`${baseUrl}/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
    ).json()) as { devToken: string };
    await fetch(`${baseUrl}/auth/password-reset/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: devToken, password: "another-new-pw-789!" }),
    });

    // A password reset implies the old password may be compromised — every
    // existing refresh session, not just this one, must die with it.
    const afterReset = await fetch(`${baseUrl}/auth/refresh`, { method: "POST", headers: { Cookie: `envoy_rt_portal=${refreshToken}` } });
    expect(afterReset.status).toBe(401);
  });

  it("a password-reset token cannot be used to verify an email, and vice versa", async () => {
    const { email, accessToken } = await register();
    const { devToken: resetToken } = (await (
      await fetch(`${baseUrl}/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
    ).json()) as { devToken: string };
    const { devToken: verifyToken } = (await (
      await fetch(`${baseUrl}/auth/verify-email/request`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } })
    ).json()) as { devToken: string };

    expect(
      (await fetch(`${baseUrl}/auth/verify-email/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: resetToken }) })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/auth/password-reset/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: verifyToken, password: "whatever-12345" }),
        })
      ).status,
    ).toBe(401);
  });
});
