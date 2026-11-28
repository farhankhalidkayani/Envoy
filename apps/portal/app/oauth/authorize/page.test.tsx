import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { oauth, auth, router } = vi.hoisted(() => ({
  oauth: { describe: vi.fn(), approve: vi.fn(), deny: vi.fn() },
  auth: { user: { role: "owner" } as { role: string } | null, loading: false },
  router: { replace: vi.fn() },
}));
vi.mock("../../../lib/api", () => ({ api: { oauth } }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import OAuthAuthorizePage from "./page";

const QUERY = "?response_type=code&client_id=c1&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcb&code_challenge=abc&code_challenge_method=S256&state=s1";
const info = { client: { id: "c1", name: "Claude Desktop" }, redirectHost: "127.0.0.1:3000", requestedScopes: ["agents:read", "agents:write"], unknownScopes: ["openid"] };
const assign = vi.fn();

describe("OAuth consent page", () => {
  beforeEach(() => {
    Object.values(oauth).forEach((m) => m.mockReset());
    router.replace.mockReset();
    assign.mockReset();
    auth.user = { role: "owner" };
    auth.loading = false;
    window.history.pushState({}, "", `/oauth/authorize${QUERY}`);
    Object.defineProperty(window, "location", { value: { ...window.location, assign, search: QUERY, pathname: "/oauth/authorize" }, writable: true, configurable: true });
    oauth.describe.mockResolvedValue(info);
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends someone who isn't signed in to log in, and back here afterwards", async () => {
    auth.user = null;
    render(<OAuthAuthorizePage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/oauth/authorize${QUERY}`)}`));
    expect(oauth.describe).not.toHaveBeenCalled();
  });

  it("shows which app, where it returns to, and the permissions it asked for — all ticked", async () => {
    render(<OAuthAuthorizePage />);
    expect(await screen.findByText("Connect “Claude Desktop” to Envoy?")).toBeInTheDocument();
    expect(oauth.describe).toHaveBeenCalledWith(expect.objectContaining({ client_id: "c1", state: "s1" }));
    expect(screen.getByText("127.0.0.1:3000")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /See agents/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Edit agents/ })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /subscription/ })).toBeNull(); // not asked for, not offered
    expect(screen.getByText(/openid, which Envoy doesn't have/)).toBeInTheDocument();
    expect(screen.getByText(/can never publish agents, change hard rules/)).toBeInTheDocument();
  });

  it("Allow grants exactly what's ticked and returns to the app", async () => {
    oauth.approve.mockResolvedValue({ redirect_to: "http://127.0.0.1:3000/cb?code=CODE&state=s1" });
    render(<OAuthAuthorizePage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Edit agents/ })); // untick
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:3000/cb?code=CODE&state=s1"));
    expect(oauth.approve).toHaveBeenCalledWith(expect.objectContaining({ client_id: "c1" }), ["agents:read"]);
  });

  it("can't allow with nothing ticked", async () => {
    render(<OAuthAuthorizePage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /See agents/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Edit agents/ }));
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
  });

  it("Deny returns to the app with a refusal", async () => {
    oauth.deny.mockResolvedValue({ redirect_to: "http://127.0.0.1:3000/cb?error=access_denied&state=s1" });
    render(<OAuthAuthorizePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:3000/cb?error=access_denied&state=s1"));
    expect(oauth.approve).not.toHaveBeenCalled();
  });

  it("shows an unknown app or a bad return address here, and never redirects", async () => {
    oauth.describe.mockRejectedValue(new Error(JSON.stringify({ error: "invalid_client", error_description: "This app isn't registered. Start the connection again from the app." })));
    render(<OAuthAuthorizePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This app isn't registered.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("hands a malformed request straight back to the app to explain", async () => {
    oauth.describe.mockResolvedValue({ redirect_to: "http://127.0.0.1:3000/cb?error=invalid_request&state=s1" });
    render(<OAuthAuthorizePage />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:3000/cb?error=invalid_request&state=s1"));
  });

  it("tells staff to ask the owner", async () => {
    auth.user = { role: "staff" };
    render(<OAuthAuthorizePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only the workspace owner can connect apps/);
    expect(oauth.describe).not.toHaveBeenCalled();
  });
});
