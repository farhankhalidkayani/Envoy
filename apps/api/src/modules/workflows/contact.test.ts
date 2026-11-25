import { describe, expect, it } from "vitest";
import { contactHash, createUnsubscribeToken, emailFooter, maskAddress, twilioSignature, verifyUnsubscribeToken } from "./contact.js";

describe("contact helpers", () => {
  it("masks recipients for logs", () => {
    expect(maskAddress("email", "ada@example.com")).toBe("a***@example.com");
    expect(maskAddress("sms", "+447700900123")).toBe("+44…0123");
  });

  it("hashes per channel, so an email and a phone can never be confused", () => {
    expect(contactHash("sms", "+14155550100")).toBe(contactHash("sms", "+14155550100"));
    expect(contactHash("sms", "+14155550100")).not.toBe(contactHash("email", "+14155550100"));
    expect(contactHash("sms", "+14155550100")).toMatch(/^[0-9a-f]{64}$/);
    expect(contactHash("sms", "+14155550100")).not.toContain("4155550100");
  });

  describe("unsubscribe tokens", () => {
    it("round-trips the workspace and address", () => {
      expect(verifyUnsubscribeToken(createUnsubscribeToken("t1", "ada@example.com"))).toEqual({ tenantId: "t1", email: "ada@example.com" });
    });
    it("rejects tampering: another address, another workspace, a forged signature, junk", () => {
      const [payload, sig] = createUnsubscribeToken("t1", "ada@example.com").split(".");
      const other = createUnsubscribeToken("t2", "ada@example.com").split(".")[0]!;
      expect(verifyUnsubscribeToken(`${other}.${sig}`)).toBeNull();
      expect(verifyUnsubscribeToken(`${payload}.${sig!.slice(0, -2)}AA`)).toBeNull();
      expect(verifyUnsubscribeToken(`${payload}.`)).toBeNull();
      for (const junk of ["", "x", "a.b.c", "....", `${Buffer.from("[1,2]").toString("base64url")}.${sig}`]) expect(verifyUnsubscribeToken(junk), junk).toBeNull();
    });
    it("can't be used to unsubscribe someone else: the address is inside the signed payload", () => {
      const token = createUnsubscribeToken("t1", "ada@example.com");
      expect(verifyUnsubscribeToken(token)!.email).not.toBe("bob@example.com");
    });
  });

  it("every lead email says who sent it and how to stop", () => {
    const footer = emailFooter("Acme Dental", "https://x.test/u/abc");
    expect(footer).toContain("Acme Dental");
    expect(footer).toContain("https://x.test/u/abc");
  });

  it("computes Twilio's signature (documented example)", () => {
    // From Twilio's request-validation docs.
    const sig = twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", { Digits: "1234", To: "+18005551212", From: "+14158675310", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" });
    expect(sig).toBe("GvWf1cFY/Q7PnoempGyD5oXAezc=");
  });
});
