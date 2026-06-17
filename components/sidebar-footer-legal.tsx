"use client";

import { AlertTriangle, Github, ShieldQuestion } from "lucide-react";
import Link from "next/link";

import { useIsMobile } from "@/hooks/use-mobile";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DialogTitle } from "@radix-ui/react-dialog";

const disclaimerSections = [
  {
    title: "Educational & Research Purposes Only",
    body: "TradeBlocks is designed for educational exploration and research analysis of trading strategies. Nothing within this platform constitutes investment advice, trading recommendations, or financial guidance of any kind.",
    accent: "text-destructive",
  },
  {
    title: "Your Data, Your Responsibility",
    body: "All calculations, metrics, and insights are generated from the historical data you provide. We make no guarantees about data accuracy, completeness, or the validity of your trading logs. Quality analysis requires quality data — imperfect inputs will produce unreliable results.",
    accent: "text-primary",
  },
  {
    title: "Software & Technical Limitations",
    body: "Like all software, TradeBlocks may contain errors, bugs, or unexpected behaviors. Our algorithms make assumptions that may not align with your specific trading circumstances. Historical performance analysis cannot predict future market outcomes.",
    accent: "text-secondary",
  },
  {
    title: "Financial Risk Acknowledgment",
    body: "Trading and investing carry substantial risk of loss. You may lose part or all of your investment capital. Before making any financial decisions, consult with qualified financial professionals who understand your individual situation.",
    accent: "text-destructive",
  },
  {
    title: "Privacy & Data Handling",
    body: "TradeBlocks operates entirely in your browser using local storage, indexDB, and session cookies to maintain your data and preferences. We do not transmit, store, or access your trading data on external servers.",
    accent: "text-muted-foreground",
  },
];

export function SidebarFooterLegal() {
  const isMobile = useIsMobile();

  // Shared dialog content
  const dialogContent = (
    <DialogContent className="max-h-[80vh] overflow-y-auto border-none bg-gradient-to-b from-background to-muted/40 p-0 sm:max-w-2xl">
      <DialogTitle className="sr-only">Full Disclaimer</DialogTitle>
      <div className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-card p-6 shadow-2xl sm:p-8">
        <DialogHeader className="gap-2 text-left">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
            Important Disclaimer
          </div>
          <DialogDescription className="flex items-center gap-2 text-sm text-muted-foreground">
            Please read before building your analytics
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-sm leading-relaxed text-foreground">
          {disclaimerSections.map((section) => (
            <section key={section.title} className="space-y-1.5">
              <h3 className={`text-base font-semibold ${section.accent}`}>
                {section.title}
              </h3>
              <p>{section.body}</p>
            </section>
          ))}
        </div>
        <div className="flex items-center justify-center gap-2 rounded-2xl bg-muted px-4 py-3 text-sm font-semibold italic text-muted-foreground">
          <ShieldQuestion className="h-4 w-4" aria-hidden />
          Remember: TradeBlocks builds insights, not investment advice.
        </div>
        {/* Attribution links in dialog for mobile */}
        {isMobile && (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border/40 pt-4 text-[0.7rem] text-muted-foreground">
            <a
              href="https://www.buymeacoffee.com/davidromeo"
              target="_blank"
              rel="noopener noreferrer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
                alt="Buy Me A Coffee"
                className="h-8 w-auto"
              />
            </a>
            <span className="text-muted-foreground/50">•</span>
            <Link
              href="https://github.com/tradeblocks-org/tradeblocks"
              target="_blank"
              className="inline-flex items-center gap-1 transition hover:text-foreground"
            >
              <Github className="h-3.5 w-3.5" aria-hidden />
              <span className="font-medium">GitHub</span>
            </Link>
          </div>
        )}
      </div>
    </DialogContent>
  );

  // Mobile compact version - minimal footer that stays fixed at bottom
  if (isMobile) {
    return (
      <div className="border-t border-sidebar-border/80 px-3 py-2">
        <Dialog>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-center gap-1.5 px-2 py-1.5 text-[0.65rem] text-muted-foreground hover:text-foreground"
            >
              <AlertTriangle className="h-3 w-3 text-amber-500" />
              <span>Disclaimer</span>
            </Button>
          </DialogTrigger>
          {dialogContent}
        </Dialog>
      </div>
    );
  }

  // Desktop compact version
  return (
    <div className="space-y-2.5 border-t border-sidebar-border/80 px-3 pb-4 pt-3 text-[0.72rem] leading-relaxed text-muted-foreground">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
        <AlertTriangle
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-[0.7rem] leading-tight text-foreground">
            Educational use only • Not financial advice
          </p>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                variant="link"
                size="sm"
                className="h-auto w-fit p-0 text-[0.68rem] font-medium text-primary"
              >
                Full Disclaimer →
              </Button>
            </DialogTrigger>
            {dialogContent}
          </Dialog>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
        <a
          href="https://www.buymeacoffee.com/davidromeo"
          target="_blank"
          rel="noopener noreferrer"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
            alt="Buy Me A Coffee"
            className="h-8 w-auto"
          />
        </a>
        <span className="text-muted-foreground/50">•</span>
        <Link
          href="https://github.com/tradeblocks-org/tradeblocks"
          target="_blank"
          className="inline-flex items-center gap-1.5 transition hover:text-foreground"
        >
          <Github className="h-4 w-4" aria-hidden />
          <span className="font-medium">GitHub</span>
        </Link>
      </div>
    </div>
  );
}
