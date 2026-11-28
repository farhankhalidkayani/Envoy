import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ops } = vi.hoisted(() => ({ ops: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() } }));
vi.mock("../../../lib/api", () => ({ api: { admin: { operatorTokens: ops } } }));
vi.mock("../../../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import AiAccessPage from "./page";

const row = (over: Record<string, unknown> = {}) => ({ id: "o1", name: "Claude on my laptop", last4: "wxyz", scopes: ["admin:read"], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null, lastUsedAt: null, createdAt: "", createdBy: "a1", ...over });

describe("AI access (operator tokens)", () => {
  beforeEach(() => { Object.values(ops).forEach((m) => m.mockReset()); ops.list.mockResolvedValue([]); });

  it("says what the assistant can never do, and that nothing can reach the operator API without a token", async () => {
    render(<AiAccessPage />);
    expect(await screen.findByText(/None yet/)).toBeInTheDocument();
    expect(screen.getByText(/never change pricing, charge a tenant, delete a tenant or manage/)).toBeInTheDocument();
  });

  it("creates a read-only, one-week token by default and shows the secret with a ready MCP config once", async () => {
    ops.create.mockResolvedValue({ ...row(), token: "envoy_op_SECRET" });
    render(<AiAccessPage />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Claude on my laptop" } });
    expect(screen.getByRole("checkbox", { name: /admin:read/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /admin:write/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(ops.create).toHaveBeenCalledWith({ name: "Claude on my laptop", scopes: ["admin:read"], expiresInDays: 7 }));
    expect(await screen.findByText("envoy_op_SECRET")).toBeInTheDocument();
    expect(screen.getByLabelText("MCP config")).toHaveTextContent('"ENVOY_OPERATOR_TOKEN": "envoy_op_SECRET"');
    expect(screen.getByLabelText("MCP config")).toHaveTextContent("stdio-operator.js");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("envoy_op_SECRET")).toBeNull();
  });

  it("warns what write access means before it's granted", async () => {
    render(<AiAccessPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /admin:write/ }));
    expect(screen.getByText(/can pause a tenant, which stops all of that business/)).toBeInTheDocument();
  });

  it("can't create with no access ticked or no name", async () => {
    render(<AiAccessPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /admin:read/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Create token" })).toBeDisabled();
  });

  it("lists tokens with their status and revokes an active one", async () => {
    ops.list.mockResolvedValue([row(), row({ id: "o2", name: "Old", revokedAt: "2026-01-01" })]);
    ops.revoke.mockResolvedValue({ revoked: true });
    render(<AiAccessPage />);
    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke Old" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Claude on my laptop" }));
    await waitFor(() => expect(ops.revoke).toHaveBeenCalledWith("o1"));
  });

  it("shows the server's reason when creation is refused", async () => {
    ops.create.mockRejectedValue(new Error("At most 5 operator tokens can be active. Revoke one first."));
    render(<AiAccessPage />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
