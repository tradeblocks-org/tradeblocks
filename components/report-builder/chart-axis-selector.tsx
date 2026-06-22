"use client";

/**
 * Chart Axis Selector
 *
 * Dropdown component for selecting a field to use as an axis in charts.
 * Uses nested submenus organized by field category.
 * Supports both static fields and custom fields from trade/daily log CSVs.
 */

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  getFieldsByCategoryWithAll,
  getFieldInfo,
  getAllCategoryLabels,
  FieldCategory,
  CustomFieldCategory,
  StaticDatasetFieldInfo,
} from "@tradeblocks/lib";
import { EnrichedTrade } from "@tradeblocks/lib";

interface ChartAxisSelectorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allowNone?: boolean;
  className?: string;
  /** Enriched trades to extract custom fields from */
  trades?: EnrichedTrade[];
  /** Static datasets for field discovery */
  staticDatasets?: StaticDatasetFieldInfo[];
}

export function ChartAxisSelector({
  label,
  value,
  onChange,
  allowNone = false,
  className,
  trades = [],
  staticDatasets,
}: ChartAxisSelectorProps) {
  const [open, setOpen] = useState(false);
  const fieldsByCategory = useMemo(
    () => getFieldsByCategoryWithAll(trades, staticDatasets),
    [trades, staticDatasets],
  );
  const allCategoryLabels = getAllCategoryLabels();

  // Get the display label for the current value
  const currentField = value === "none" ? null : getFieldInfo(value);
  const displayValue = value === "none" ? "None" : currentField ? currentField.label : value;

  const handleSelect = (fieldValue: string) => {
    onChange(fieldValue);
    setOpen(false);
  };

  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <Label className="text-xs text-muted-foreground mb-1 block">{label}</Label>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 w-full justify-between font-normal">
            <span className="truncate">{displayValue}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {allowNone && (
            <DropdownMenuItem onClick={() => handleSelect("none")}>None</DropdownMenuItem>
          )}

          {Array.from(fieldsByCategory.entries()).map(([category, fields]) => {
            if (fields.length === 0) return null;

            // Use category label from known categories, or the category name itself (for static datasets)
            const categoryLabel =
              allCategoryLabels[category as FieldCategory | CustomFieldCategory] ?? category;

            return (
              <DropdownMenuSub key={category}>
                <DropdownMenuSubTrigger>{categoryLabel}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-52">
                  {fields.map((field) => (
                    <DropdownMenuItem key={field.field} onClick={() => handleSelect(field.field)}>
                      {field.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default ChartAxisSelector;
