import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppRuntime } from "@/components/app-runtime";
import { BRAND } from "@/lib/site";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: BRAND,
  description: "Ask for it. The arm hands it over.",
  applicationName: BRAND,
  appleWebApp: { capable: true, title: BRAND, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under the notch and home bar; screens pad themselves with env(safe-area-inset-*).
  viewportFit: "cover",
  // Keep the bottom controls above the on-screen keyboard.
  interactiveWidget: "resizes-content",
  themeColor: "#f7f7f5",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The inline script may switch data-theme before React hydrates; the DOM's value wins.
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable} antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-svh">
        <AppRuntime />
        {children}
      </body>
    </html>
  );
}
