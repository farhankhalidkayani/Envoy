"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "../../lib/auth";
import { BuildingIcon, ClockListIcon, LogoMark } from "../../components/icons";

const NAV = [
  { href: "/tenants", label: "Tenants", icon: BuildingIcon },
  { href: "/audit-log", label: "Audit Log", icon: ClockListIcon },
];

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) return null;

  const initial = user.email.charAt(0).toUpperCase();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand">
          <span className="app-sidebar-brand-mark">
            <LogoMark />
          </span>
          <span className="app-sidebar-brand-name">Envoy</span>
        </div>
        <div className="app-sidebar-brand-tag">Operator Console</div>

        <nav className="nav-section">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname?.startsWith(item.href) ?? false;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={17} />
                <span className="nav-link-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="app-sidebar-footer">
          <div className="app-sidebar-user">
            <span className="app-sidebar-avatar">{initial}</span>
            <span className="app-sidebar-user-email">{user.email}</span>
          </div>
          <button onClick={logout} className="btn">
            Sign out
          </button>
        </div>
      </aside>

      <main className="app-main">{children}</main>
    </div>
  );
}
