"use client";

/**
 * Saved Reports Dropdown
 *
 * Dropdown to select and load saved report configurations.
 * Uses nested submenus to organize preset reports by category.
 */

import { useEffect, useMemo } from "react";
import {
  BarChart3,
  ChevronDown,
  LineChart,
  ScatterChart,
  SlidersHorizontal,
  Star,
  Table2,
  Trash2,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettingsStore } from "@tradeblocks/lib/stores";
import { ReportConfig, ReportCategory, ChartType, REPORT_CATEGORY_LABELS } from "@tradeblocks/lib";

// Map chart types to icons
const CHART_TYPE_ICONS: Record<ChartType, LucideIcon> = {
  scatter: ScatterChart,
  line: LineChart,
  histogram: BarChart3,
  bar: BarChart3,
  box: SlidersHorizontal,
  threshold: TrendingUp,
  table: Table2,
};

interface SavedReportsDropdownProps {
  onSelect: (report: ReportConfig) => void;
}

// Order for categories in the menu
const CATEGORY_ORDER: ReportCategory[] = [
  "market",
  "mfe-mae",
  "returns",
  "timing",
  "risk",
  "threshold",
];

export function SavedReportsDropdown({ onSelect }: SavedReportsDropdownProps) {
  const savedReports = useSettingsStore((state) => state.savedReports);
  const deleteReport = useSettingsStore((state) => state.deleteReport);
  const initialize = useSettingsStore((state) => state.initialize);

  // Initialize store to load built-in reports
  useEffect(() => {
    initialize();
  }, [initialize]);

  const builtInReports = savedReports.filter((r) => r.isBuiltIn);
  const userReports = savedReports.filter((r) => !r.isBuiltIn);

  // Group built-in reports by category
  const reportsByCategory = useMemo(() => {
    const grouped = new Map<ReportCategory, ReportConfig[]>();

    for (const report of builtInReports) {
      const category = report.category ?? "market";
      if (!grouped.has(category)) {
        grouped.set(category, []);
      }
      grouped.get(category)!.push(report);
    }

    return grouped;
  }, [builtInReports]);

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteReport(id);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          Load Report
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {/* Preset categories as submenus */}
        {CATEGORY_ORDER.map((category) => {
          const reports = reportsByCategory.get(category);
          if (!reports || reports.length === 0) return null;

          return (
            <DropdownMenuSub key={category}>
              <DropdownMenuSubTrigger className="gap-2">
                <Star className="h-3 w-3 text-yellow-500" />
                {REPORT_CATEGORY_LABELS[category]}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                {reports.map((report) => {
                  const Icon = CHART_TYPE_ICONS[report.chartType];
                  return (
                    <DropdownMenuItem
                      key={report.id}
                      onClick={() => onSelect(report)}
                      className="gap-2"
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {report.name}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}

        {/* User's custom reports */}
        {userReports.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              My Reports
            </div>
            {userReports.map((report) => {
              const Icon = CHART_TYPE_ICONS[report.chartType];
              return (
                <DropdownMenuItem
                  key={report.id}
                  onClick={() => onSelect(report)}
                  className="group flex justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {report.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100"
                    onClick={(e) => handleDelete(e, report.id)}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                  </Button>
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {savedReports.length === 0 && (
          <div className="px-2 py-4 text-sm text-muted-foreground text-center">
            No saved reports
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default SavedReportsDropdown;
