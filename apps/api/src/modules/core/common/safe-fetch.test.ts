import { describe, expect, it } from "vitest";
import { assertPublicUrl, safeFetch } from "./safe-fetch.js";

describe("assertPublicUrl", () => {
  it.each([
    "http://127.0.0.1:6379",
    "http://169.254.169.254/latest/meta-data",
    "http://10.1.2.3/",
    "http://192.168.0.10/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://localhost:5432/",
    "file:///etc/passwd",
  ])("rejects %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow();
  });

  it("accepts a public IP", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/x")).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetch", () => {
  // DNS-pinning routes the real connection through a custom undici dispatcher
  // (see resolveAndValidate/Agent in safe-fetch.ts) instead of plain fetch()
  // — this exercises that wiring against a real public address rather than
  // just the address-validation logic above.
  it("completes a real request through the DNS-pinned dispatcher", async () => {
    const res = await safeFetch("https://1.1.1.1/", { method: "GET" });
    expect(res.status).toBeGreaterThan(0);
  }, 15000);

  it("still rejects a private address before ever dispatching", async () => {
    await expect(safeFetch("http://127.0.0.1:1/")).rejects.toThrow();
  });
});
