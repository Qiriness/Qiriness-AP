import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

/*
 * Plus Jakarta Sans — a geometric-humanist sans chosen as the closest freely
 * licensable match to the north-star mock's Satoshi. next/font self-hosts it
 * and generates a metric-matched fallback, so there is no layout shift.
 * To adopt Satoshi later, swap this for next/font/local with the woff2 files.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  title: "Agent Setup · Qiriness Support OS",
  description:
    "Configure the knowledge, brand voice, and tone your Qiriness reply agent will use.",
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
    <html lang="en" className={jakarta.variable}>
      <body>{children}</body>
    </html>
  );
}
