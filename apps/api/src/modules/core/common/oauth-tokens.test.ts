import { afterEach, describe, expect, it, vi } from "vitest";
import { NEVER_EXPIRES, packTokens, refreshIfExpiring, unpackTokens } from "./oauth-tokens.js";

const cfg = { tokenUrl: "https://auth.example/token", clientId: "id", clientSecret: "secret", providerName: "Test" };

afterEach(() => vi.unstubAllGlobals());

describe("oauth tokens", () => {
  it("reads legacy bare-string tokens as non-expiring", () => {
    expect(unpackTokens("legacy_token")).toEqual({ accessToken: "legacy_token", expiresAt: NEVER_EXPIRES });
    const t = { accessToken: "a", refreshToken: "r", expiresAt: 5 };
    expect(unpackTokens(packTokens(t))).toEqual(t);
  });

  it("leaves fresh tokens alone", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await refreshIfExpiring({ accessToken: "a", expiresAt: Date.now() + 3_600_000 }, cfg)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when within a minute of expiry, keeping the old refresh token if none is returned", async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(String(init.body)).toContain("grant_type=refresh_token");
      expect(String(init.body)).toContain("refresh_token=old_refresh");
      return new Response(JSON.stringify({ access_token: "new_access", expires_in: 1800 }));
    });
    vi.stubGlobal("fetch", fetchSpy);
    const next = await refreshIfExpiring({ accessToken: "a", refreshToken: "old_refresh", expiresAt: Date.now() + 30_000 }, cfg);
    expect(next?.accessToken).toBe("new_access");
    expect(next?.refreshToken).toBe("old_refresh");
    expect(next!.expiresAt).toBeGreaterThan(Date.now() + 1_700_000);
  });

  it("uses a rotated refresh token when the provider returns one (HubSpot)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "n", refresh_token: "rotated", expires_in: 1800 })));
    const next = await refreshIfExpiring({ accessToken: "a", refreshToken: "old", expiresAt: 0 }, cfg);
    expect(next?.refreshToken).toBe("rotated");
  });

  it("fails with a reconnect message when it cannot refresh", async () => {
    await expect(refreshIfExpiring({ accessToken: "a", expiresAt: 0 }, cfg)).rejects.toThrow(/reconnect/);
    vi.stubGlobal("fetch", async () => new Response("invalid_grant", { status: 400 }));
    await expect(refreshIfExpiring({ accessToken: "a", refreshToken: "r", expiresAt: 0 }, cfg)).rejects.toThrow(/refresh failed \(400\)/);
  });
});
