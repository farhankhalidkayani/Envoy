import type { ReactNode } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/Toast";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata = {
  title: "Envoy Admin",
  description: "Operator console — tenants, access control, pricing, audit log.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
