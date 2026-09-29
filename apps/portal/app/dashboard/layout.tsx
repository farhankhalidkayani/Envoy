"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { BotIcon, ChatIcon, SyncIcon, CardIcon, PlugIcon, FormIcon, LogoMark } from "../../components/icons";

const NAV = [
  { href: "/dashboard", label: "Agents", icon: BotIcon },
  { href: "/dashboard/conversations", label: "Conversations", icon: ChatIcon },
  { href: "/dashboard/forms", label: "Lead forms", icon: FormIcon },
  { href: "/dashboard/crm", label: "CRM", icon: SyncIcon },
  { href: "/dashboard/integrations", label: "Integrations", icon: PlugIcon },
  { href: "/dashboard/billing", label: "Billing", icon: CardIcon },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [locked, setLocked] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  const [devToken, setDevToken] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  async function resendVerification() {
    setResendState("sending");
    try {
      const result = await api.auth.requestEmailVerification();
      setDevToken(result.devToken ?? null);
    } finally {
      setResendState("sent");
    }
  }

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
            const active = item.href === "/dashboard" ? pathname === item.href : pathname.startsWith(item.href);
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

      <main className="app-main">
        {!user.emailVerified && (
          <div className="locked-banner">
            <strong>Please verify your email.</strong>{" "}
            {resendState === "sent" ? (
              devToken ? (
                <>
                  No email provider is configured locally —{" "}
                  <Link href={`/verify-email?token=${devToken}`}>use this link directly</Link>.
                </>
              ) : (
                "Check your inbox for the verification link."
              )
            ) : (
              <>
                We sent a link when you signed up.{" "}
                <button
                  className="btn"
                  style={{ fontSize: 12.5, padding: "2px 10px" }}
                  onClick={resendVerification}
                  disabled={resendState === "sending"}
                >
                  {resendState === "sending" ? "Sending…" : "Resend email"}
                </button>
              </>
            )}
          </div>
        )}
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
