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
  // Daylight paper — matches the ScreenShell background so browser chrome
  // blends into the app on mobile.
  themeColor: "#F4E9CE",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-daylight-paper">
      <body className="bg-daylight-paper text-daylight-ink antialiased">{children}</body>
    </html>
  );
}
