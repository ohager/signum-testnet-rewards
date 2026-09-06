import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signum Testnet Rewards",
  description:
    "Live status of the Signum testnet forging reward programme: what is owed, what has been paid, and when the next payout runs.",
};

export const viewport: Viewport = {
  themeColor: "#050810",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
