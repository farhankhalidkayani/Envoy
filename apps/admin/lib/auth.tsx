"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AuthResult } from "@envoy/sdk";
import { TOKEN_STORAGE_KEY } from "./api.js";

type SessionUser = AuthResult["user"];

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  setSession: (result: AuthResult) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const USER_STORAGE_KEY = "envoy_admin_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const stored = localStorage.getItem(USER_STORAGE_KEY);
    if (stored) setUser(JSON.parse(stored));
    setLoading(false);
  }, []);

  function setSession(result: AuthResult) {
    // The operator console only makes sense for platform_admin — a tenant
    // owner successfully logging in here (same /auth/login endpoint,
    // shared with the portal) still shouldn't get an operator session.
    if (result.user.role !== "platform_admin") {
      throw new Error("This account does not have operator access.");
    }
    localStorage.setItem(TOKEN_STORAGE_KEY, result.accessToken);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(result.user));
    setUser(result.user);
  }

  function logout() {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    setUser(null);
    router.push("/login");
  }

  return (
    <AuthContext.Provider value={{ user, loading, setSession, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
