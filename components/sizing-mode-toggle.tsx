"use client";

import { Switch } from "@/components/ui/switch";
import { cn } from "@tradeblocks/lib";

interface SizingModeToggleProps {
  id: string;
  label?: string;
  title: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}

export function SizingModeToggle({
  id,
  label = "Sizing Mode",
  title,
  checked,
  onCheckedChange,
  className,
}: SizingModeToggleProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <label
        htmlFor={id}
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
      >
        {label}
      </label>
      <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-transparent px-3 py-2 min-h-10 shadow-xs">
        <label
          htmlFor={id}
          className="text-sm font-normal cursor-pointer select-none flex-1 truncate"
        >
          {title}
        </label>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          className="flex-shrink-0"
        />
      </div>
    </div>
  );
}
