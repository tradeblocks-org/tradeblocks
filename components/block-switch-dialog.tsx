"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BlockDialog } from "@/components/block-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { Search, Check, Activity, Calendar, Plus, Settings } from "lucide-react";

interface BlockSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BlockSwitchDialog({ open, onOpenChange }: BlockSwitchDialogProps) {
  const { blocks, setActiveBlock } = useBlockStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [isBlockDialogOpen, setIsBlockDialogOpen] = useState(false);
  const router = useRouter();

  const filteredBlocks = blocks.filter(
    (block) =>
      block.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      block.description?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleSelectBlock = (blockId: string) => {
    setActiveBlock(blockId);
    onOpenChange(false);
  };

  const handleManageBlocks = () => {
    router.push("/blocks");
    onOpenChange(false);
  };

  const handleCreateBlock = () => {
    setIsBlockDialogOpen(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Switch Active Block</DialogTitle>
          <DialogDescription>
            Select a trading block to activate for analysis across all pages.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
            <Input
              placeholder="Search blocks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Block List */}
          <div className="max-h-96 overflow-y-auto space-y-2">
            {filteredBlocks.map((block) => (
              <div
                key={block.id}
                className={`
                  relative p-4 rounded-lg border cursor-pointer transition-all hover:shadow-md
                  ${
                    block.isActive
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-border/80"
                  }
                `}
                onClick={() => handleSelectBlock(block.id)}
              >
                {block.isActive && (
                  <div className="absolute top-2 right-2">
                    <Badge className="bg-primary">
                      <Check className="w-3 h-3 mr-1" />
                      Active
                    </Badge>
                  </div>
                )}

                <div className="space-y-3">
                  {/* Block Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{block.name}</h3>
                      </div>
                      {block.description && (
                        <p className="text-sm text-muted-foreground mt-1">{block.description}</p>
                      )}
                    </div>
                  </div>

                  {/* File Indicators */}
                  <div className="flex gap-2">
                    <Badge variant="secondary" className="text-xs">
                      <Activity className="w-3 h-3 mr-1" />
                      Trade Log ({block.tradeLog.rowCount})
                    </Badge>
                    {block.dailyLog && (
                      <Badge variant="outline" className="text-xs">
                        <Calendar className="w-3 h-3 mr-1" />
                        Daily Log ({block.dailyLog.rowCount})
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {filteredBlocks.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No blocks found matching your search.</p>
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="flex gap-2 pt-4 border-t">
            <Button variant="outline" className="flex-1" onClick={handleCreateBlock}>
              <Plus className="w-4 h-4 mr-2" />
              Create New Block
            </Button>
            <Button variant="outline" className="flex-1" onClick={handleManageBlocks}>
              <Settings className="w-4 h-4 mr-2" />
              Manage All Blocks
            </Button>
          </div>
        </div>
      </DialogContent>

      <BlockDialog
        open={isBlockDialogOpen}
        onOpenChange={setIsBlockDialogOpen}
        mode="new"
        block={null}
      />
    </Dialog>
  );
}
