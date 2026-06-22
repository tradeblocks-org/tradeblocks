/**
 * Global Settings Store
 *
 * Manages saved report configurations for the Report Builder.
 * Settings are persisted to localStorage.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ReportConfig } from "../models/report-config.ts";

// ============================================================================
// Built-in Saved Reports (Flexible Chart Builder)
// ============================================================================

const BUILT_IN_SAVED_REPORTS: ReportConfig[] = [
  // Market Analysis
  {
    id: "builtin-vix-vs-pl",
    name: "VIX vs P/L %",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "openingVix", label: "Opening VIX" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "rom", label: "ROM %" },
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-slr-vs-pl",
    name: "S/L Ratio vs P/L %",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "openingShortLongRatio", label: "Opening S/L Ratio" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "rom", label: "ROM %" },
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-gap-vs-pl",
    name: "Gap vs P/L %",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "gap", label: "Gap %" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "rom", label: "ROM %" },
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-pl-distribution",
    name: "P/L % Distribution",
    filter: { conditions: [], logic: "and" },
    chartType: "histogram",
    xAxis: { field: "plPct", label: "P/L %" },
    yAxis: { field: "plPct", label: "" },
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-high-vix-analysis",
    name: "High VIX Trades",
    filter: {
      conditions: [
        {
          id: "high-vix-condition",
          field: "openingVix",
          operator: "gte",
          value: 25,
          enabled: true,
        },
      ],
      logic: "and",
    },
    chartType: "scatter",
    xAxis: { field: "openingVix", label: "Opening VIX" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "rom", label: "ROM %" },
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },

  // MFE/MAE Analysis
  {
    id: "builtin-mfe-vs-mae",
    name: "MFE vs MAE",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "maePercent", label: "MAE %" },
    yAxis: { field: "mfePercent", label: "MFE %" },
    colorBy: { field: "plPct", label: "P/L %" },
    category: "mfe-mae",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-mfe-distribution",
    name: "MFE% Distribution",
    filter: { conditions: [], logic: "and" },
    chartType: "histogram",
    xAxis: { field: "mfePercent", label: "MFE %" },
    yAxis: { field: "mfePercent", label: "" },
    category: "mfe-mae",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-profit-capture",
    name: "Profit Capture Analysis",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "mfePercent", label: "MFE %" },
    yAxis: { field: "profitCapturePercent", label: "Profit Capture %" },
    colorBy: { field: "plPct", label: "P/L %" },
    category: "mfe-mae",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-excursion-ratio",
    name: "Excursion Ratio Analysis",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "excursionRatio", label: "Excursion Ratio (MFE/MAE)" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "mfePercent", label: "MFE %" },
    category: "mfe-mae",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },

  // Return Metrics
  {
    id: "builtin-rom-analysis",
    name: "Return on Margin",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "openingVix", label: "Opening VIX" },
    yAxis: { field: "rom", label: "Return on Margin %" },
    colorBy: { field: "plPct", label: "P/L %" },
    category: "returns",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-rom-distribution",
    name: "ROM Distribution",
    filter: { conditions: [], logic: "and" },
    chartType: "histogram",
    xAxis: { field: "rom", label: "Return on Margin %" },
    yAxis: { field: "rom", label: "" },
    category: "returns",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-pl-over-trades",
    name: "P/L % Over Trade Sequence",
    filter: { conditions: [], logic: "and" },
    chartType: "line",
    xAxis: { field: "tradeNumber", label: "Trade #" },
    yAxis: { field: "plPct", label: "P/L %" },
    category: "returns",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-rom-over-trades",
    name: "ROM Over Trade Sequence",
    filter: { conditions: [], logic: "and" },
    chartType: "line",
    xAxis: { field: "tradeNumber", label: "Trade #" },
    yAxis: { field: "rom", label: "Return on Margin %" },
    category: "returns",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },

  // Timing Analysis
  {
    id: "builtin-pl-over-time",
    name: "P/L % Over Time",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "dateOpenedTimestamp", label: "Date Opened" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "isWinner", label: "Winner" },
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-vix-over-time",
    name: "VIX Over Time",
    filter: { conditions: [], logic: "and" },
    chartType: "line",
    xAxis: { field: "dateOpenedTimestamp", label: "Date Opened" },
    yAxis: { field: "openingVix", label: "Opening VIX" },
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-multi-axis-time",
    name: "P/L % + VIX + SLR Over Time",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "dateOpenedTimestamp", label: "Date Opened" },
    yAxis: { field: "plPct", label: "P/L %" },
    yAxis2: { field: "openingVix", label: "Opening VIX" },
    yAxis3: { field: "openingShortLongRatio", label: "S/L Ratio" },
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-duration-vs-pl",
    name: "Duration vs P/L %",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "durationHours", label: "Duration (hrs)" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "rom", label: "ROM %" },
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-duration-vs-mfe",
    name: "Duration vs MFE%",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "durationHours", label: "Duration (hrs)" },
    yAxis: { field: "mfePercent", label: "MFE %" },
    colorBy: { field: "plPct", label: "P/L %" },
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },

  // Risk Analysis
  {
    id: "builtin-r-multiple",
    name: "R-Multiple Distribution",
    filter: { conditions: [], logic: "and" },
    chartType: "histogram",
    xAxis: { field: "rMultiple", label: "R-Multiple" },
    yAxis: { field: "rMultiple", label: "" },
    category: "risk",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-exposure-vs-pl",
    name: "Exposure vs P/L %",
    filter: { conditions: [], logic: "and" },
    chartType: "scatter",
    xAxis: { field: "exposureOnOpen", label: "Portfolio Exposure %" },
    yAxis: { field: "plPct", label: "P/L %" },
    colorBy: { field: "rom", label: "ROM %" },
    category: "risk",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-exposure-breakdown",
    name: "Exposure Level Breakdown",
    filter: { conditions: [], logic: "and" },
    chartType: "table",
    xAxis: { field: "exposureOnOpen", label: "Portfolio Exposure %" },
    yAxis: { field: "plPct", label: "" },
    tableBuckets: [10, 20, 30, 40],
    tableColumns: ["count", "winRate", "plPct:avg", "rom:avg"],
    category: "risk",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },

  // Table Reports (grouped with Market Analysis)
  {
    id: "builtin-vix-table",
    name: "VIX Breakdown",
    filter: { conditions: [], logic: "and" },
    chartType: "table",
    xAxis: { field: "openingVix", label: "Opening VIX" },
    yAxis: { field: "plPct", label: "" },
    tableBuckets: [15, 20, 25, 30],
    tableColumns: ["count", "winRate", "plPct:avg", "rom:avg"],
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-slr-table",
    name: "S/L Ratio Breakdown",
    filter: { conditions: [], logic: "and" },
    chartType: "table",
    xAxis: { field: "openingShortLongRatio", label: "Opening S/L Ratio" },
    yAxis: { field: "plPct", label: "" },
    tableBuckets: [0.5, 0.75, 1.0, 1.25, 1.5],
    tableColumns: ["count", "winRate", "plPct:avg", "rom:avg"],
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },

  // Box Plot Analysis
  {
    id: "builtin-box-month",
    name: "P/L % by Month",
    filter: { conditions: [], logic: "and" },
    chartType: "box",
    xAxis: { field: "monthOfYear", label: "Month of Year" },
    yAxis: { field: "plPct", label: "P/L %" },
    boxBucketCount: 12,
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-box-weekday",
    name: "P/L % by Day of Week",
    filter: { conditions: [], logic: "and" },
    chartType: "box",
    xAxis: { field: "dayOfWeek", label: "Day of Week" },
    yAxis: { field: "plPct", label: "P/L %" },
    boxBucketCount: 7,
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-box-vix",
    name: "P/L % by VIX Range",
    filter: { conditions: [], logic: "and" },
    chartType: "box",
    xAxis: { field: "openingVix", label: "Opening VIX" },
    yAxis: { field: "plPct", label: "P/L %" },
    boxBucketCount: 5,
    category: "market",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-box-hour",
    name: "P/L % by Hour of Day",
    filter: { conditions: [], logic: "and" },
    chartType: "box",
    xAxis: { field: "hourOfDay", label: "Hour of Day" },
    yAxis: { field: "plPct", label: "P/L %" },
    boxBucketCount: 8,
    category: "timing",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },

  // Threshold Analysis
  {
    id: "builtin-slr-threshold",
    name: "S/L Ratio Threshold",
    filter: { conditions: [], logic: "and" },
    chartType: "threshold",
    xAxis: { field: "openingShortLongRatio", label: "Opening S/L Ratio" },
    yAxis: { field: "pl", label: "" },
    thresholdMetric: "plPct",
    category: "threshold",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "builtin-vix-threshold",
    name: "VIX Threshold",
    filter: { conditions: [], logic: "and" },
    chartType: "threshold",
    xAxis: { field: "openingVix", label: "Opening VIX" },
    yAxis: { field: "pl", label: "" },
    thresholdMetric: "plPct",
    category: "threshold",
    isBuiltIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
];

// ============================================================================
// Store Interface
// ============================================================================

interface SettingsStore {
  // State
  savedReports: ReportConfig[];
  isInitialized: boolean;

  // Actions - Saved Reports
  saveReport: (
    report: Omit<ReportConfig, "id" | "createdAt" | "updatedAt" | "isBuiltIn">,
  ) => string;
  updateReport: (id: string, updates: Partial<Omit<ReportConfig, "id" | "isBuiltIn">>) => void;
  deleteReport: (id: string) => void;

  // Getters
  getReportById: (id: string) => ReportConfig | undefined;

  // Initialization
  initialize: () => void;
  reset: () => void;
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      // Initial state
      savedReports: [],
      isInitialized: false,

      // Initialize with built-in reports on first load
      // Always merges built-in items to ensure they're present after updates
      initialize: () => {
        const state = get();

        // Get user-defined items (not built-in)
        const userReports = state.savedReports.filter((r) => !r.isBuiltIn);

        // Always set built-ins + user items (ensures new built-ins are added on app updates)
        set({
          savedReports: [...BUILT_IN_SAVED_REPORTS, ...userReports],
          isInitialized: true,
        });
      },

      // Saved Reports management
      saveReport: (report) => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        set((state) => ({
          savedReports: [
            ...state.savedReports,
            {
              ...report,
              id,
              isBuiltIn: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }));

        return id;
      },

      updateReport: (id, updates) => {
        const report = get().savedReports.find((r) => r.id === id);
        if (report?.isBuiltIn) return; // Cannot update built-in reports

        set((state) => ({
          savedReports: state.savedReports.map((r) =>
            r.id === id ? { ...r, ...updates, updatedAt: new Date().toISOString() } : r,
          ),
        }));
      },

      deleteReport: (id) => {
        const report = get().savedReports.find((r) => r.id === id);
        if (report?.isBuiltIn) return; // Cannot delete built-in reports

        set((state) => ({
          savedReports: state.savedReports.filter((r) => r.id !== id),
        }));
      },

      // Getters
      getReportById: (id) => {
        return get().savedReports.find((r) => r.id === id);
      },

      // Reset to defaults
      reset: () => {
        set({
          savedReports: BUILT_IN_SAVED_REPORTS,
          isInitialized: true,
        });
      },
    }),
    {
      name: "tradeblocks-settings",
      storage: createJSONStorage(() => localStorage),
      // Only persist specific fields
      partialize: (state) => ({
        savedReports: state.savedReports,
      }),
      // Handle rehydration
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isInitialized = false;
          // Initialize will be called by the app to merge built-ins
        }
      },
    },
  ),
);

// ============================================================================
// Selectors (for use with shallow comparison)
// ============================================================================

export const selectSavedReports = (state: SettingsStore) => state.savedReports;
