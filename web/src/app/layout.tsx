import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SignumLogo } from "@/components/SignumLogo";

export const metadata: Metadata = {
  title: "Signum Testnet Rewards",
  description:
    "Live status of the Signum testnet forging reward programme: what is owed, what has been paid, and when the next payout runs.",
};

export const viewport: Viewport = {
  themeColor: "#050810",
};

/**
 * The masthead lives in the layout rather than the page so it survives the
 * error boundary: a page that has lost its data should still look like this
 * site, not a bare paragraph on a black background.
 */
function SiteHeader() {
  return (
    <header className="flex items-center gap-3 pt-2">
      {/* Decorative — the heading beside it already says "Signum". */}
      <SignumLogo size={40} title="" className="shrink-0 text-[var(--blue2)]" />
      <div>
        <h1
          className="text-lg font-semibold uppercase tracking-[4px]"
          style={{ color: "var(--blue3)", textShadow: "var(--glow-b)" }}
        >
          Signum Testnet Rewards
        </h1>
        <p className="text-[10px] uppercase tracking-[2px] text-[var(--muted)]">
          Forge on testnet · paid in SIGNA on mainnet
        </p>
      </div>
    </header>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="page-layout">
          <SiteHeader />
          <main className="page-stack">{children}</main>
        </div>
      </body>
    </html>
  );
}
