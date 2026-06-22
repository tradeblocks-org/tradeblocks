"use client";

/**
 * Filter Condition Row
 *
 * A single filter condition editor with field, operator, and value inputs.
 * Supports both static fields and custom fields from trade/daily log CSVs.
 */

import { useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"; // Still used for operator selector
import { Switch } from "@/components/ui/switch";
import {
  FILTER_OPERATOR_LABELS,
  FilterCondition,
  FilterOperator,
  FieldCategory,
  CustomFieldCategory,
  StaticDatasetFieldInfo,
  getFieldInfo,
  getFieldsByCategoryWithAll,
  getAllCategoryLabels,
} from "@tradeblocks/lib";
import { EnrichedTrade } from "@tradeblocks/lib";
import { ChevronDown, X } from "lucide-react";

interface FilterConditionRowProps {
  condition: FilterCondition;
  onChange: (condition: FilterCondition) => void;
  onRemove: () => void;
  /** Enriched trades to extract custom fields from */
  trades?: EnrichedTrade[];
  /** Static datasets for field discovery */
  staticDatasets?: StaticDatasetFieldInfo[];
}

export function FilterConditionRow({
  condition,
  onChange,
  onRemove,
  trades = [],
  staticDatasets,
}: FilterConditionRowProps) {
  const [valueInput, setValueInput] = useState(condition.value.toString());
  const [value2Input, setValue2Input] = useState(condition.value2?.toString() ?? "");
  const [fieldDropdownOpen, setFieldDropdownOpen] = useState(false);

  const fieldsByCategory = useMemo(
    () => getFieldsByCategoryWithAll(trades, staticDatasets),
    [trades, staticDatasets],
  );
  const allCategoryLabels = getAllCategoryLabels();

  // Get the display label for the current field
  const currentField = getFieldInfo(condition.field);
  const fieldDisplayValue = currentField?.label ?? condition.field;

  const handleFieldChange = (field: string) => {
    onChange({ ...condition, field });
  };

  const handleOperatorChange = (operator: string) => {
    onChange({ ...condition, operator: operator as FilterOperator });
  };

  const handleValueBlur = () => {
    const val = parseFloat(valueInput);
    if (!isNaN(val)) {
      onChange({ ...condition, value: val });
    } else {
      setValueInput(condition.value.toString());
    }
  };

  const handleValue2Blur = () => {
    if (value2Input === "") {
      onChange({ ...condition, value2: undefined });
      return;
    }
    const val = parseFloat(value2Input);
    if (!isNaN(val)) {
      onChange({ ...condition, value2: val });
    } else {
      setValue2Input(condition.value2?.toString() ?? "");
    }
  };

  const handleEnabledChange = (enabled: boolean) => {
    onChange({ ...condition, enabled });
  };

  const isBetween = condition.operator === "between";

  return (
    <div
      className={`p-2 rounded-md border space-y-2 ${
        condition.enabled ? "bg-background" : "bg-muted/50 opacity-60"
      }`}
    >
      {/* Row 1: Toggle, Field selector, Remove button */}
      <div className="flex items-center gap-2">
        <Switch
          checked={condition.enabled}
          onCheckedChange={handleEnabledChange}
          className="data-[state=checked]:bg-primary shrink-0"
        />

        <DropdownMenu open={fieldDropdownOpen} onOpenChange={setFieldDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 min-w-0 h-8 justify-between font-normal text-sm"
            >
              <span className="truncate">{fieldDisplayValue}</span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
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
                      <DropdownMenuItem
                        key={field.field}
                        onClick={() => {
                          handleFieldChange(field.field);
                          setFieldDropdownOpen(false);
                        }}
                      >
                        {field.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onRemove}>
          <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
        </Button>
      </div>

      {/* Row 2: Operator and Value(s) */}
      <div className="flex items-center gap-2 pl-12">
        <Select value={condition.operator} onValueChange={handleOperatorChange}>
          <SelectTrigger className="w-[70px] h-8 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(FILTER_OPERATOR_LABELS).map(([op, label]) => (
              <SelectItem key={op} value={op}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="number"
          value={valueInput}
          onChange={(e) => setValueInput(e.target.value)}
          onBlur={handleValueBlur}
          onKeyDown={(e) => e.key === "Enter" && handleValueBlur()}
          className="flex-1 h-8 text-sm bg-background"
          placeholder="0"
        />

        {isBetween && (
          <>
            <span className="text-xs text-muted-foreground shrink-0">to</span>
            <Input
              type="number"
              value={value2Input}
              onChange={(e) => setValue2Input(e.target.value)}
              onBlur={handleValue2Blur}
              onKeyDown={(e) => e.key === "Enter" && handleValue2Blur()}
              className="flex-1 h-8 text-sm bg-background"
              placeholder="0"
            />
          </>
        )}
      </div>
    </div>
  );
}

export default FilterConditionRow;
