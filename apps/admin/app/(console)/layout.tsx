"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "../../lib/auth";

const NAV = [
  { href: "/tenants", label: "Tenants" },
  { href: "/audit-log", label: "Audit Log" },
];

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

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
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 2 }}>Envoy</div>
        <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, marginBottom: 24 }}>
          OPERATOR CONSOLE
        </div>
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
                color: pathname?.startsWith(item.href) ? "#fff" : "var(--ink-soft)",
                background: pathname?.startsWith(item.href) ? "var(--accent)" : "transparent",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button onClick={logout} className="btn" style={{ marginTop: 24, width: "100%", fontSize: 13 }}>
          Sign out
        </button>
      </aside>

      <main style={{ flex: 1, padding: "28px 36px", maxWidth: 1040 }}>{children}</main>
    </div>
  );
}
