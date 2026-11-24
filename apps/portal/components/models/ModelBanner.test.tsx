import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
let pathname = "/dashboard";
vi.mock("../../lib/api", () => ({ api: { models: { status: () => status() } } }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ModelBanner } from "./ModelBanner";

const base = { hasInvalidCredential: false, credentialCount: 0, roles: {}, config: { allowPlatformFallback: true } };

describe("ModelBanner", () => {
  beforeEach(() => { status.mockReset(); pathname = "/dashboard"; });

  it("strongly recommends connecting a key while on the shared default", async () => {
    status.mockResolvedValue({ ...base, usingPlatformDefault: true });
    render(<ModelBanner />);
    expect(await screen.findByText(/running on the shared default model/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect your own model/i })).toHaveAttribute("href", "/dashboard/models");
  });

  it("warns, instead, when a stored key was rejected", async () => {
    status.mockResolvedValue({ ...base, usingPlatformDefault: true, hasInvalidCredential: true, credentialCount: 1 });
    render(<ModelBanner />);
    expect(await screen.findByText(/was rejected by its provider/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /fix api key/i })).toBeInTheDocument();
  });

  it("disappears once a working key serves the workspace", async () => {
    status.mockResolvedValue({ ...base, usingPlatformDefault: false, credentialCount: 1 });
    const { container } = render(<ModelBanner />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("stays out of the way on the models page itself, and when status can't load", async () => {
    status.mockResolvedValue({ ...base, usingPlatformDefault: true });
    pathname = "/dashboard/models";
    const first = render(<ModelBanner />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(first.container).toBeEmptyDOMElement();

    status.mockRejectedValue(new Error("offline"));
    pathname = "/dashboard";
    const second = render(<ModelBanner />);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });
});
