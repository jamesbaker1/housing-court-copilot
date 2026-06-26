import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PERSISTENT_BANNER_SHORT } from "@/lib/disclaimers";
import HtmlLangSync from "./HtmlLangSync";

export const metadata: Metadata = {
  title: "Housing Court Copilot — a guide, not a lawyer",
  description:
    "Free, plain-language help for NYC tenants facing a nonpayment eviction case. " +
    "This is a guide that gives you information — not legal advice, and not a lawyer.",
  applicationName: "Housing Court Copilot",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Calm, trustworthy theme color (trust-600).
  themeColor: "#256d77",
};

/**
 * Persistent "guide, not a lawyer" banner. Rendered on every page as a trust
 * feature. Module engineers should NOT remove this — the framing is
 * non-negotiable and the product is never marketed as an "AI lawyer."
 */
function PersistentBanner() {
  return (
    <div className="hcc-banner" role="note" aria-label="Important: this is a guide, not a lawyer">
      <span aria-hidden="true" className="mr-1.5 font-semibold text-trust-900">
        ⚖️
      </span>
      <span className="font-medium">{PERSISTENT_BANNER_SHORT}</span>
    </div>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // SSR emits the en/ltr default (correct for unknown/no-JS tenants and the value
  // React renders, so there is no hydration mismatch on the <html> attributes).
  // <HtmlLangSync> then corrects lang/dir on the client to the tenant's chosen
  // language (S5a — WCAG 3.1.1 / 1.3.2).
  return (
    <html lang="en">
      <body>
        <HtmlLangSync />
        <PersistentBanner />
        <main className="mx-auto w-full max-w-2xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
