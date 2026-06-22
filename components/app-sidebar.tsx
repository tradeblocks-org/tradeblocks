"use client";

import {
  IconCalendar,
  IconChartHistogram,
  IconDatabase,
  IconGauge,
  IconLayoutDashboard,
  IconReportAnalytics,
  IconRouteSquare,
  IconSparkles,
  IconStack2,
  IconTimelineEvent,
  IconTrendingDown,
} from "@tabler/icons-react";
import { Blocks } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useBlockStore } from "@tradeblocks/lib/stores";

import { NavMain } from "@/components/nav-main";
import { SidebarActiveBlocks } from "@/components/sidebar-active-blocks";
import { SidebarFooterLegal } from "@/components/sidebar-footer-legal";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const navData = {
  navMain: [
    {
      title: "Block Management",
      href: "/blocks",
      icon: IconStack2,
    },
    {
      title: "Static Datasets",
      href: "/static-datasets",
      icon: IconDatabase,
    },
    {
      title: "Block Stats",
      href: "/block-stats",
      icon: IconLayoutDashboard,
    },
    {
      title: "Performance Blocks",
      href: "/performance-blocks",
      icon: IconReportAnalytics,
    },

    {
      title: "Position Sizing",
      href: "/position-sizing",
      icon: IconGauge,
    },
    {
      title: "Risk Simulator",
      href: "/risk-simulator",
      icon: IconRouteSquare,
    },
    {
      title: "Correlation Matrix",
      href: "/correlation-matrix",
      icon: IconChartHistogram,
    },
    {
      title: "Tail Risk Analysis",
      href: "/tail-risk-analysis",
      icon: IconTrendingDown,
    },
    {
      title: "Walk-Forward",
      href: "/walk-forward",
      icon: IconTimelineEvent,
    },
    {
      title: "Trading Calendar",
      href: "/trading-calendar",
      icon: IconCalendar,
    },
    {
      title: "TradeBlocks Assistant",
      href: "/assistant",
      icon: IconSparkles,
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const blocks = useBlockStore((state) => state.blocks);
  const activeBlockId = useBlockStore((state) => state.activeBlockId);
  const isInitialized = useBlockStore((state) => state.isInitialized);
  const loadBlocks = useBlockStore((state) => state.loadBlocks);
  const activeBlock = blocks.find((block) => block.id === activeBlockId) || null;
  const hasActiveBlock = activeBlock !== null;

  // Load blocks from IndexedDB on mount
  React.useEffect(() => {
    if (!isInitialized) {
      loadBlocks().catch(console.error);
    }
  }, [isInitialized, loadBlocks]);

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-2">
              <Link href="/block-stats" className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <Blocks className="h-8 w-8 text-primary" />
                </div>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold leading-tight">TradeBlocks</span>
                  <span className="text-xs text-muted-foreground">Analytics Platform</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navData.navMain} />
      </SidebarContent>
      {hasActiveBlock && activeBlock && <SidebarActiveBlocks activeBlock={activeBlock} />}
      <SidebarFooter>
        <SidebarFooterLegal />
      </SidebarFooter>
    </Sidebar>
  );
}
