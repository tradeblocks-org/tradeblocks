import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { DatabaseResetHandler } from "@/components/database-reset-handler";
import { cn } from "@tradeblocks/lib";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "TradeBlocks",
    template: "%s | TradeBlocks",
  },
  description:
    "Modern analytics workspace for evaluating trading performance and building resilient strategies.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={cn(
          geistSans.variable,
          geistMono.variable,
          "antialiased min-h-screen bg-background text-foreground",
        )}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <DatabaseResetHandler />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
