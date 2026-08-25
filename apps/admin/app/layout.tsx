import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import "./globals.css";

export const metadata = {
  title: "Envoy Admin",
  description: "Operator console — tenants, access control, pricing, audit log.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
