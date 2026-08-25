"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { BotIcon, ChatIcon, SyncIcon, CardIcon, LogoMark } from "../../components/icons";

const NAV = [
  { href: "/dashboard", label: "Agents", icon: BotIcon },
  { href: "/dashboard/conversations", label: "Conversations", icon: ChatIcon },
  { href: "/dashboard/crm", label: "CRM", icon: SyncIcon },
  { href: "/dashboard/billing", label: "Billing", icon: CardIcon },
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

        <nav className="nav-section">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`}>
                <Icon size={17} />
                {item.label}
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

      <main className="app-main">
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
