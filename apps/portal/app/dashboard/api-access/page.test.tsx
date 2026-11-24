import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tokens, auth } = vi.hoisted(() => ({
  tokens: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
  auth: { role: "owner" },
}));
vi.mock("../../../lib/api", () => ({ api: { tokens } }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock("../../../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import ApiAccessPage from "./page";

const row = (over: Record<string, unknown> = {}) => ({ id: "t1", name: "Claude desktop", last4: "ab12", scopes: ["agents:read"], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null, lastUsedAt: null, createdAt: "", ...over });

describe("API & MCP page", () => {
  beforeEach(() => { Object.values(tokens).forEach((m) => m.mockReset()); auth.role = "owner"; tokens.list.mockResolvedValue([]); });

  it("says plainly what a token can never do", async () => {
    render(<ApiAccessPage />);
    expect(await screen.findByText(/publish an agent to visitors, change its hard rules, approve a proposed improvement/)).toBeInTheDocument();
  });

  it("creates a token from a preset, then shows the secret and a ready-to-paste MCP config once", async () => {
    tokens.create.mockResolvedValue({ ...row(), token: "envoy_sk_SECRETVALUE1234" });
    render(<ApiAccessPage />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Claude desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Read only" }));
    fireEvent.change(screen.getByLabelText("Expires after"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(tokens.create).toHaveBeenCalled());
    expect(tokens.create.mock.calls[0]![0]).toEqual({
      name: "Claude desktop",
      scopes: ["agents:read", "conversations:read", "forms:read", "models:read", "billing:read", "integrations:read"],
      expiresInDays: 30,
    });
    expect(await screen.findByLabelText("New token")).toHaveTextContent("envoy_sk_SECRETVALUE1234");
    const config = JSON.parse(screen.getByLabelText("MCP configuration").textContent!);
    expect(config.mcpServers.envoy.env.ENVOY_API_TOKEN).toBe("envoy_sk_SECRETVALUE1234");
    expect(config.mcpServers.envoy.command).toBe("npx");

    fireEvent.click(screen.getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByLabelText("New token")).toBeNull(); // gone for good
  });

  it("only offers scopes that exist, and needs a name and at least one of them", async () => {
    render(<ApiAccessPage />);
    await screen.findByLabelText("Name");
    expect(screen.queryByText(/models:write|admin/)).toBeNull();
    const create = screen.getByRole("button", { name: "Create token" });
    expect(create).toBeDisabled(); // no name yet
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(create).toBeEnabled();
    for (const box of screen.getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) fireEvent.click(box);
    expect(create).toBeDisabled(); // nothing granted
  });

  it("lists tokens without secrets, marks revoked and expired ones, and revokes an active one", async () => {
    tokens.list.mockResolvedValue([
      row(),
      row({ id: "t2", name: "Old", revokedAt: new Date().toISOString() }),
      row({ id: "t3", name: "Stale", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ]);
    tokens.revoke.mockResolvedValue({ revoked: true });
    render(<ApiAccessPage />);
    expect(await screen.findByText("Claude desktop")).toBeInTheDocument();
    expect(screen.getAllByText(/envoy_sk_…ab12/)).toHaveLength(3);
    expect(screen.getByText("revoked")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Revoke/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Claude desktop" }));
    await waitFor(() => expect(tokens.revoke).toHaveBeenCalledWith("t1"));
  });

  it("gives staff an explanation and no controls, without calling the API", async () => {
    auth.role = "staff";
    render(<ApiAccessPage />);
    expect(await screen.findByText(/Only the workspace owner can create and revoke API tokens/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
    expect(tokens.list).not.toHaveBeenCalled();
  });

  it("shows the server's reason when creating fails", async () => {
    tokens.create.mockRejectedValue(new Error("You can have at most 20 active API tokens. Revoke one first."));
    render(<ApiAccessPage />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByText(/at most 20 active API tokens/)).toBeInTheDocument();
  });
});
