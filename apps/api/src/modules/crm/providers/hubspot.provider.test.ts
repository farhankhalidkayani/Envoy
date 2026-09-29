import { afterEach, describe, expect, it, vi } from "vitest";
import { HubSpotCrmProvider } from "./hubspot.provider.js";

afterEach(() => vi.unstubAllGlobals());

describe("HubSpotCrmProvider", () => {
  it("upserts by email so repeat visitors don't create duplicates", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ status: "COMPLETE", results: [{ id: "501" }] }));
    });
    const result = await new HubSpotCrmProvider().pushRecord("tok", { email: " ada@example.com ", firstname: "Ada" });
    expect(result).toEqual({ success: true, externalId: "501" });
    expect(calls[0]!.url).toMatch(/\/contacts\/batch\/upsert$/);
    expect(calls[0]!.body).toEqual({
      inputs: [{ idProperty: "email", id: "ada@example.com", properties: { email: " ada@example.com ", firstname: "Ada" } }],
    });
  });

  it("creates a contact when there is no email to dedupe on", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: "77" }));
    });
    expect(await new HubSpotCrmProvider().pushRecord("tok", { phone: "123" })).toEqual({ success: true, externalId: "77" });
    expect(urls[0]).toMatch(/\/contacts$/);
  });

  it("surfaces API errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("expired", { status: 401 }));
    const result = await new HubSpotCrmProvider().pushRecord("tok", { email: "a@b.co" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("401");
  });
});
