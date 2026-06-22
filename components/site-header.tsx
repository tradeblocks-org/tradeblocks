"use client";

import { usePathname } from "next/navigation";
import { useMemo } from "react";

import { ModeToggle } from "@/components/mode-toggle";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

const routeMeta: Record<string, { title: string; description: string; badge?: string }> = {
  "/blocks": {
    title: "Block Management",
    description: "Manage your trading data blocks and switch between datasets.",
  },
  "/block-stats": {
    title: "Block Stats & Analytics",
    description: "Measure the health of your active trading block at a glance.",
  },
  "/performance-blocks": {
    title: "Performance Blocks",
    description: "Equity curves, streaks, and drawdown coverage across time.",
  },
  "/risk-simulator": {
    title: "Risk Simulator",
    description: "Monte Carlo projections using your uploaded trade history.",
  },
  "/position-sizing": {
    title: "Position Sizing",
    description: "Dial in optimal size with Kelly, volatility caps, and constraints.",
  },
  "/correlation-matrix": {
    title: "Correlation Matrix",
    description: "Understand strategy overlap before deploying capital.",
  },
  "/tail-risk-analysis": {
    title: "Tail Risk Analysis",
    description: "Measure how strategies blow up together during market stress.",
  },
  "/trading-calendar": {
    title: "Trading Calendar",
    description: "Align and compare backtested vs reported trade data.",
  },
  "/walk-forward": {
    title: "Walk-Forward Analysis",
    description: "Validate performance across shifting regimes with rolling IS/OOS windows.",
  },
  "/static-datasets": {
    title: "Static Datasets",
    description: "Upload and manage time-series data to match against your trades.",
  },
  "/settings": {
    title: "Settings",
    description: "Configure account defaults, risk tolerances, and integrations.",
  },
};

export function SiteHeader() {
  const pathname = usePathname();

  const meta = useMemo(() => {
    if (!pathname) return routeMeta["/block-stats"];
    const base = `/${pathname.split("/")[1] ?? ""}` || "/block-stats";
    return routeMeta[base] ?? routeMeta["/block-stats"];
  }, [pathname]);

  return (
    <header className="flex h-(--header-height) shrink-0 items-center border-b bg-background/70 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6">
      <div className="flex w-full items-center gap-3">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="h-6" />
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold leading-tight md:text-lg">{meta.title}</h1>
            {meta.badge && (
              <Badge variant="secondary" className="text-[0.65rem] uppercase">
                {meta.badge}
              </Badge>
            )}
          </div>
          <p className="hidden text-sm text-muted-foreground sm:block">{meta.description}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}
