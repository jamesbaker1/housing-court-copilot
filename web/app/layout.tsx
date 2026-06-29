import type { Metadata, Viewport } from "next";
import Link from "next/link";
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
      <body className="flex min-h-dvh flex-col">
        <HtmlLangSync />
        <PersistentBanner />

        {/* Wordmark — quiet product identity, links home. */}
        <header className="mx-auto w-full max-w-2xl px-4 pt-5">
          <Link
            href="/"
            className="inline-flex items-center gap-2 no-underline"
            aria-label="Housing Court Copilot — home"
          >
            <span className="hcc-icon-badge h-9 w-9 text-lg" aria-hidden="true">
              ⚖️
            </span>
            <span className="text-base font-semibold tracking-tight text-trust-900">
              Housing Court Copilot
            </span>
          </Link>
        </header>

        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">{children}</main>

        {/* Footer — reassurance + the always-on human escape hatch. */}
        <footer className="mx-auto w-full max-w-2xl px-4 pb-10 pt-2">
          <div className="hcc-card px-4 py-4 text-sm text-trust-700">
            <p>
              Free and private. A guide, not a lawyer &mdash; information, not
              legal advice.
            </p>
            <p className="mt-1.5">
              Need a person now? Call{" "}
              <a href="tel:311" className="font-semibold text-trust-700">
                311
              </a>{" "}
              and ask for tenant or eviction help &mdash; it&rsquo;s free.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
