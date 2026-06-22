"use client";

/**
 * Filter Panel
 *
 * Left panel of the Report Builder with flexible filter conditions.
 * Wrapped in React.memo for performance - only re-renders when props actually change.
 */

import { memo } from "react";
import { Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import {
  FilterConfig,
  FilterCondition,
  StaticDatasetFieldInfo,
  createFilterCondition,
} from "@tradeblocks/lib";
import { FlexibleFilterResult } from "@tradeblocks/lib";
import { EnrichedTrade } from "@tradeblocks/lib";
import { FilterConditionRow } from "./filter-condition-row";

interface FilterPanelProps {
  filterConfig: FilterConfig;
  onFilterChange: (config: FilterConfig) => void;
  filterResult: FlexibleFilterResult | null;
  /** Enriched trades to extract custom fields from */
  trades?: EnrichedTrade[];
  /** Static datasets for field discovery */
  staticDatasets?: StaticDatasetFieldInfo[];
  /** Whether to keep filters when loading reports */
  keepFilters: boolean;
  onKeepFiltersChange: (value: boolean) => void;
}

export const FilterPanel = memo(function FilterPanel({
  filterConfig,
  onFilterChange,
  filterResult,
  trades = [],
  staticDatasets,
  keepFilters,
  onKeepFiltersChange,
}: FilterPanelProps) {
  // Add a new filter condition
  const handleAddCondition = () => {
    const newCondition = createFilterCondition();
    onFilterChange({
      ...filterConfig,
      conditions: [...filterConfig.conditions, newCondition],
    });
  };

  // Update an existing condition
  const handleConditionChange = (updatedCondition: FilterCondition) => {
    onFilterChange({
      ...filterConfig,
      conditions: filterConfig.conditions.map((c) =>
        c.id === updatedCondition.id ? updatedCondition : c,
      ),
    });
  };

  // Remove a condition
  const handleRemoveCondition = (conditionId: string) => {
    onFilterChange({
      ...filterConfig,
      conditions: filterConfig.conditions.filter((c) => c.id !== conditionId),
    });
  };

  // Clear all conditions
  const handleClearAll = () => {
    onFilterChange({
      ...filterConfig,
      conditions: [],
    });
  };

  const hasConditions = filterConfig.conditions.length > 0;
  const activeConditions = filterConfig.conditions.filter((c) => c.enabled);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Filters</CardTitle>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={keepFilters ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => onKeepFiltersChange(!keepFilters)}
                  className="h-7 gap-1.5 px-2"
                >
                  {keepFilters ? (
                    <>
                      <Lock className="h-3.5 w-3.5" />
                      <span className="text-xs">Locked</span>
                    </>
                  ) : (
                    <LockOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>
                  {keepFilters
                    ? "Filters locked - loading reports won't change filters"
                    : "Lock to keep filters when loading reports"}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filter conditions */}
        {filterConfig.conditions.length > 0 ? (
          <div className="space-y-2">
            {filterConfig.conditions.map((condition) => (
              <FilterConditionRow
                key={condition.id}
                condition={condition}
                onChange={handleConditionChange}
                onRemove={() => handleRemoveCondition(condition.id)}
                trades={trades}
                staticDatasets={staticDatasets}
              />
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No filters applied - showing all trades
          </div>
        )}

        {/* Add filter button */}
        <Button variant="outline" size="sm" className="w-full" onClick={handleAddCondition}>
          <Plus className="h-4 w-4 mr-2" />
          Add Filter
        </Button>

        <Separator />

        {/* Filter summary */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Results</div>
          {filterResult && (
            <div className="text-sm">
              <span className="font-medium">{filterResult.matchCount}</span>
              <span className="text-muted-foreground">
                {" "}
                of {filterResult.totalCount} trades ({filterResult.matchPercent.toFixed(1)}%)
              </span>
            </div>
          )}
          {activeConditions.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {activeConditions.length} active filter{activeConditions.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>

        {/* Clear button */}
        {hasConditions && (
          <Button variant="outline" size="sm" className="w-full" onClick={handleClearAll}>
            <Trash2 className="h-4 w-4 mr-2" />
            Clear All Filters
          </Button>
        )}
      </CardContent>
    </Card>
  );
});

export default FilterPanel;
