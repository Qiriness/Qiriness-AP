import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Setup · Qiriness Support OS",
  description:
    "Configure the knowledge, brand voice, and tone your Qiriness reply agent will use.",
  // One file serves both the tab icon and the brand mark in the app shell, so
  // the two cannot drift apart. `.png` paths are excluded from the middleware
  // matcher, which is what lets the sign-in page show it without a session.
  icons: { icon: { url: "/brand/q-qiriness.png", type: "image/png", sizes: "32x32" } },
};

export const viewport: Viewport = {
  themeColor: "#008080",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
