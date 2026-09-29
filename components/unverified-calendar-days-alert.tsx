"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@tradeblocks/lib";
import { useBlockStore, type Block } from "@tradeblocks/lib/stores";
import { AlertTriangle } from "lucide-react";
import { usePathname } from "next/navigation";

const COLLECTIONS = [
  { key: "trades", label: "Trade log", fileName: (block: Block) => block.tradeLog.fileName },
  { key: "dailyLogs", label: "Daily log", fileName: (block: Block) => block.dailyLog?.fileName },
  {
    key: "reportingLogs",
    label: "Reporting log",
    fileName: (block: Block) => block.reportingLog?.fileName,
  },
] as const;

/**
 * Prompt to re-import the files whose dates the v7 storage upgrade could not confirm. Renders
 * nothing for a block without unverified dates.
 */
export function UnverifiedCalendarDaysAlert({
  block,
  showBlockName = false,
  className,
}: {
  block: Block;
  showBlockName?: boolean;
  className?: string;
}) {
  const counts = block.unverifiedCalendarDays;
  const files = COLLECTIONS.flatMap((collection) => {
    const count = counts?.[collection.key] ?? 0;
    if (count <= 0) return [];
    const fileName = collection.fileName(block);
    return [
      {
        key: collection.key,
        text: `${collection.label}${fileName ? ` (${fileName})` : ""}: ${count.toLocaleString()} ${count === 1 ? "date" : "dates"}`,
      },
    ];
  });
  if (files.length === 0) return null;

  return (
    <Alert className={cn("flex gap-3 border-amber-500/50 bg-amber-500/5", className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden={true} />
      <div className="space-y-1">
        <AlertTitle className="text-amber-700 dark:text-amber-400">
          {showBlockName
            ? `Some dates in ${block.name} may be off by one day`
            : "Some dates may be off by one day"}
        </AlertTitle>
        <AlertDescription>
          These dates were imported before a TradeBlocks update and could not be confirmed.
          Re-import the file{files.length === 1 ? "" : "s"} below to fix them.
        </AlertDescription>
        <ul className="list-inside list-disc text-sm text-muted-foreground">
          {files.map((file) => (
            <li key={file.key}>{file.text}</li>
          ))}
        </ul>
      </div>
    </Alert>
  );
}

/** The active block's prompt on every analysis page; the block list shows it on each block. */
export function ActiveBlockCalendarDaysAlert() {
  const pathname = usePathname();
  const activeBlock = useBlockStore((state) =>
    state.activeBlockId
      ? state.blocks.find((block) => block.id === state.activeBlockId)
      : undefined,
  );
  if (!activeBlock || pathname === "/blocks") return null;
  return <UnverifiedCalendarDaysAlert block={activeBlock} showBlockName />;
}
