import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "./safe-fetch.js";

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
