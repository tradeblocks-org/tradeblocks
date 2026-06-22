"use client";

import { IconArrowsShuffle, IconCheck } from "@tabler/icons-react";
import { useState } from "react";

import { BlockSwitchDialog } from "@/components/block-switch-dialog";
import { Button } from "@/components/ui/button";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from "@/components/ui/sidebar";
import { type Block } from "@tradeblocks/lib/stores";

export function SidebarActiveBlocks({ activeBlock }: { activeBlock: Block }) {
  const [isSwitchDialogOpen, setIsSwitchDialogOpen] = useState(false);

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden border-t border-sidebar-border/60">
      <SidebarGroupLabel>Active Block</SidebarGroupLabel>
      <SidebarGroupContent>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-sidebar-accent/40 px-2.5 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <IconCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="truncate text-sm font-semibold text-sidebar-foreground">
              {activeBlock.name}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            onClick={() => setIsSwitchDialogOpen(true)}
          >
            <IconArrowsShuffle className="size-3" />
            Switch
          </Button>
        </div>
      </SidebarGroupContent>

      <BlockSwitchDialog open={isSwitchDialogOpen} onOpenChange={setIsSwitchDialogOpen} />
    </SidebarGroup>
  );
}
