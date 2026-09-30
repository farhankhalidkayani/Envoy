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

// Applies a stored theme choice before first paint — without this the page
// would flash light, then snap to dark once React hydrates and reads
// localStorage. suppressHydrationWarning on <html> because the server can't
// know this value; only the data-theme attribute this script sets differs.
const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("envoy-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
