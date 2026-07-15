import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RED AI — Founder Intelligence",
  description:
    "Internal founder and early-stage project research for agency teams.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
