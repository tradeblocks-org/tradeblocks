/**
 * Strategy Kelly table with inline sliders for position sizing
 */

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

interface StrategyData {
  name: string;
  tradeCount: number;
}

interface StrategyKellyTableProps {
  strategies: StrategyData[];
  kellyValues: Record<string, number>;
  selectedStrategies: Set<string>;
  onKellyChange: (strategy: string, value: number) => void;
  onSelectionChange: (strategy: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
}

export function StrategyKellyTable({
  strategies,
  kellyValues,
  selectedStrategies,
  onKellyChange,
  onSelectionChange,
  onSelectAll,
}: StrategyKellyTableProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter strategies based on search
  const filteredStrategies = useMemo(() => {
    if (!searchQuery.trim()) return strategies;
    const query = searchQuery.toLowerCase();
    return strategies.filter((s) => s.name.toLowerCase().includes(query));
  }, [strategies, searchQuery]);

  const allSelected =
    filteredStrategies.length > 0 &&
    filteredStrategies.every((s) => selectedStrategies.has(s.name));

  const totalTrades = strategies.reduce((sum, s) => sum + s.tradeCount, 0);

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search strategies..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Strategy table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={onSelectAll}
                  aria-label="Select all strategies"
                />
              </TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="w-72">Kelly %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredStrategies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {searchQuery ? "No strategies found" : "No strategies available"}
                </TableCell>
              </TableRow>
            ) : (
              filteredStrategies.map((strategy) => {
                const isSelected = selectedStrategies.has(strategy.name);
                const kellyValue = kellyValues[strategy.name] ?? 100;

                return (
                  <TableRow key={strategy.name}>
                    <TableCell>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) => onSelectionChange(strategy.name, !!checked)}
                        aria-label={`Select ${strategy.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium max-w-[200px]">
                      <div className="truncate" title={strategy.name}>
                        {strategy.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {strategy.tradeCount}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Slider
                          value={[kellyValue]}
                          onValueChange={(values) => onKellyChange(strategy.name, values[0])}
                          min={0}
                          max={200}
                          step={1}
                          className="flex-1"
                          aria-label={`Kelly percentage slider for ${strategy.name}`}
                        />
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            inputMode="numeric"
                            value={kellyValue}
                            onChange={(e) => onKellyChange(strategy.name, Number(e.target.value))}
                            onBlur={(e) => onKellyChange(strategy.name, Number(e.target.value))}
                            min={0}
                            max={200}
                            step={1}
                            className="h-9 w-20 text-right"
                            aria-label={`Kelly percentage input for ${strategy.name}`}
                          />
                          <span className="text-sm font-medium text-muted-foreground">%</span>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Summary footer */}
      {filteredStrategies.length > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {filteredStrategies.length} of {strategies.length}{" "}
            {strategies.length === 1 ? "strategy" : "strategies"}
          </span>
          <span>{totalTrades.toLocaleString()} total trades</span>
        </div>
      )}
    </div>
  );
}
