import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gather.photo — every guest's photos, in one place",
  description:
    "Collect every photo and video your guests capture at your event. One QR code. No app, no login.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0E0E13",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-ink">
      <body className="bg-ink text-ink-50 antialiased">{children}</body>
    </html>
  );
}
