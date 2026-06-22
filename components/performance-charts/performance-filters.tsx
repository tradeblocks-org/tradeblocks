"use client";

import { MultiSelect } from "@/components/multi-select";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { Calendar, Filter } from "lucide-react";
import { useMemo } from "react";

interface PerformanceFiltersProps {
  className?: string;
}

const DATE_RANGE_OPTIONS = [
  { value: "all", label: "All Time" },
  { value: "ytd", label: "Year to Date" },
  { value: "1y", label: "Last 12 Months" },
  { value: "6m", label: "Last 6 Months" },
  { value: "3m", label: "Last 3 Months" },
  { value: "1m", label: "Last Month" },
];

export function PerformanceFilters({ className }: PerformanceFiltersProps) {
  const { data, dateRange, selectedStrategies, setDateRange, setSelectedStrategies } =
    usePerformanceStore();

  // Generate strategy options from trade data
  const strategyOptions = useMemo(() => {
    if (!data?.allTrades) return [];

    const uniqueStrategies = [
      ...new Set(data.allTrades.map((trade) => trade.strategy || "Unknown")),
    ];
    return uniqueStrategies.map((strategy) => ({
      label: strategy,
      value: strategy,
    }));
  }, [data?.allTrades]);

  const handleDateRangeChange = (preset: string) => {
    const today = new Date();
    let from: Date | undefined;
    let to: Date | undefined = today;

    switch (preset) {
      case "ytd":
        from = new Date(today.getFullYear(), 0, 1);
        break;
      case "1y":
        from = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
        break;
      case "6m":
        from = new Date(today.getFullYear(), today.getMonth() - 6, today.getDate());
        break;
      case "3m":
        from = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
        break;
      case "1m":
        from = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
        break;
      case "all":
      default:
        from = undefined;
        to = undefined;
        break;
    }

    setDateRange({
      from,
      to,
    });
  };

  const getFilterSummary = () => {
    const parts: string[] = [];

    if (dateRange.from || dateRange.to) {
      parts.push("Custom range");
    }

    if (selectedStrategies.length > 0) {
      if (selectedStrategies.length === 1) {
        parts.push(selectedStrategies[0]);
      } else {
        parts.push(`${selectedStrategies.length} strategies`);
      }
    }

    return parts.length > 0 ? parts.join(" • ") : "All data";
  };

  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          {/* Date Range Selector */}
          <div className="space-y-2">
            <Label htmlFor="date-range" className="flex items-center gap-1 text-sm font-medium">
              <Calendar className="h-4 w-4" />
              Date Range
            </Label>
            <Select value="all" onValueChange={handleDateRangeChange}>
              <SelectTrigger className="w-[150px]" id="date-range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Strategy Filter */}
          <div className="space-y-2 flex-1 min-w-[250px]">
            <Label className="flex items-center gap-1 text-sm font-medium">
              <Filter className="h-4 w-4" />
              Strategies
            </Label>
            <MultiSelect
              options={strategyOptions}
              onValueChange={setSelectedStrategies}
              placeholder="All strategies"
              maxCount={3}
              className="w-full"
              disabled={strategyOptions.length === 0}
            />
          </div>

          {/* Filter Summary */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-muted-foreground">Active Filters</Label>
            <div className="text-sm bg-muted px-3 py-2 rounded-md">{getFilterSummary()}</div>
          </div>

          {/* Trade Count */}
          {data && (
            <div className="space-y-2">
              <Label className="text-sm font-medium text-muted-foreground">Trades</Label>
              <div className="text-sm font-semibold px-3 py-2">{data.trades.length}</div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
