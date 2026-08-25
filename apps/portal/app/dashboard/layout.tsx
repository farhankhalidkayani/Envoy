"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ApiError } from "@envoy/sdk";
import { api } from "../../lib/api.js";
import { useAuth } from "../../lib/auth.js";

const NAV = [
  { href: "/dashboard", label: "Agents" },
  { href: "/dashboard/conversations", label: "Conversations" },
  { href: "/dashboard/crm", label: "CRM" },
  { href: "/dashboard/billing", label: "Billing" },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    api.billing
      .getSubscription()
      .then((sub) => setLocked(sub.status === "locked"))
      .catch(() => {});
  }, [user]);

  if (loading || !user) return null;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: 200,
          borderRight: "1px solid var(--line)",
          background: "var(--panel)",
          padding: "20px 16px",
          flexShrink: 0,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 24 }}>Envoy</div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                fontSize: 13.5,
                fontWeight: 500,
                textDecoration: "none",
                color: pathname === item.href ? "#fff" : "var(--ink-soft)",
                background: pathname === item.href ? "var(--accent)" : "transparent",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          onClick={logout}
          className="btn"
          style={{ marginTop: 24, width: "100%", fontSize: 13 }}
        >
          Sign out
        </button>
      </aside>

      <main style={{ flex: 1, padding: "28px 36px", maxWidth: 960 }}>
        {locked && (
          <div className="locked-banner">
            <strong>This account is locked pending payment.</strong> Your widget is showing a
            temporary-unavailable message to visitors, and configuration changes are disabled.{" "}
            <Link href="/dashboard/billing">Resolve billing</Link> to restore access — nothing
            has been deleted.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
