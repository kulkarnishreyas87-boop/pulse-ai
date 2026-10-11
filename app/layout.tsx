import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Pulse",
  description: "A weekly AI/ML research brief, organised by domain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
