import { describe, expect, it } from "vitest";
import { decideTokenAccess } from "./api-tokens.js";
import { CreateOperatorTokenInput, decideOperatorAccess } from "./operator-tokens.js";

const R = ["admin:read"];
const RW = ["admin:read", "admin:write"];

describe("operator token policy", () => {
  it.each([
    ["GET", "/admin/tenants"], ["GET", "/admin/tenants?cursor=x"], ["GET", "/admin/tenants/stats"], ["GET", "/admin/tenants/t1"], ["GET", "/admin/audit-log?tenantId=t1"], ["GET", "/admin/jobs/failed"], ["GET", "/token-info"],
  ])("admin:read may %s %s", (m, p) => expect(decideOperatorAccess(m, p, R).allowed).toBe(true));

  it.each([
    ["POST", "/admin/jobs/pipeline/42/retry"], ["PATCH", "/admin/tenants/t1/users/u1/access"], ["PATCH", "/admin/tenants/t1/pause"], ["PATCH", "/admin/tenants/t1/resume"],
  ])("writes need admin:write: %s %s", (m, p) => {
    expect(decideOperatorAccess(m, p, R)).toEqual({ allowed: false, reason: 'This operator token doesn\'t have the "admin:write" scope.' });
    expect(decideOperatorAccess(m, p, RW).allowed).toBe(true);
  });

  it.each([
    ["PATCH", "/admin/tenants/t1/pricing", /pricing/],
    ["POST", "/admin/tenants/t1/bill-overage", /Charging/],
    ["DELETE", "/admin/tenants/t1", /Deleting/],
    ["DELETE", "/admin/tenants/t1/hard", /Deleting/],
    ["POST", "/admin/operator-tokens", /can't manage operator tokens/],
    ["GET", "/admin/operator-tokens", /can't manage operator tokens/],
  ])("even with every scope, a person must %s %s", (m, p, reason) => {
    const d = decideOperatorAccess(m, p, RW);
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toMatch(reason);
  });

  it("can't reach anything outside the operator API, and workspace tokens can't reach the operator API", () => {
    for (const [m, p] of [["GET", "/agents"], ["GET", "/tokens"], ["POST", "/auth/login"], ["GET", "/conversations"]]) {
      expect(decideOperatorAccess(m!, p!, RW)).toEqual({ allowed: false, reason: "Operator tokens only reach the operator API." });
    }
    expect(decideTokenAccess("GET", "/admin/tenants", ["agents:read", "agents:write", "billing:read"]).allowed).toBe(false);
    expect(decideOperatorAccess("GET", "/admin/tenants/t1/users", RW).allowed).toBe(false); // not on the list = not allowed
  });

  it("tokens default to read-only for a week, and never last more than 30 days", () => {
    expect(CreateOperatorTokenInput.parse({ name: "Ops AI" })).toEqual({ name: "Ops AI", scopes: ["admin:read"], expiresInDays: 7 });
    expect(CreateOperatorTokenInput.safeParse({ name: "x", expiresInDays: 31 }).success).toBe(false);
    expect(CreateOperatorTokenInput.safeParse({ name: "x", scopes: ["agents:read"] }).success).toBe(false);
  });
});
