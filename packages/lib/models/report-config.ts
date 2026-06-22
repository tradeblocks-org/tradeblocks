/**
 * Report Configuration Types
 *
 * Defines the structure for flexible report configurations including
 * filter conditions and chart settings.
 */

/**
 * Filter operators for comparing trade field values
 */
export type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between";

/**
 * Human-readable labels for filter operators
 */
export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
};

/**
 * A single filter condition
 */
export interface FilterCondition {
  id: string;
  field: string; // Field name from Trade
  operator: FilterOperator;
  value: number; // Primary value
  value2?: number; // Second value for 'between' operator
  enabled: boolean;
}

/**
 * Filter configuration with multiple conditions
 */
export interface FilterConfig {
  conditions: FilterCondition[];
  logic: "and" | "or"; // How to combine conditions (AND only for now)
}

/**
 * Chart axis configuration
 */
export interface ChartAxisConfig {
  field: string; // Field name from Trade
  label?: string; // Custom display label
  scale?: "linear" | "log"; // Axis scale type
}

/**
 * Supported chart types
 */
export type ChartType = "scatter" | "line" | "bar" | "histogram" | "box" | "table" | "threshold";

/**
 * Human-readable labels for chart types
 */
export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  scatter: "Scatter Plot",
  line: "Line Chart",
  bar: "Bar Chart",
  histogram: "Histogram",
  box: "Box Plot",
  table: "Table",
  threshold: "Threshold Analysis",
};

/**
 * Metric options for threshold analysis secondary Y-axis
 */
export type ThresholdMetric = "pl" | "plPct" | "rom";

/**
 * Human-readable labels for threshold metrics
 */
export const THRESHOLD_METRIC_LABELS: Record<ThresholdMetric, string> = {
  pl: "Avg P/L ($)",
  plPct: "Avg P/L (%)",
  rom: "Avg ROM (%)",
};

/**
 * Categories for organizing preset reports
 */
export type ReportCategory = "market" | "mfe-mae" | "returns" | "timing" | "risk" | "threshold";

/**
 * Human-readable labels for report categories
 */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  market: "Market Analysis",
  "mfe-mae": "MFE/MAE Analysis",
  returns: "Return Metrics",
  timing: "Timing Analysis",
  risk: "Risk Analysis",
  threshold: "Threshold Analysis",
};

/**
 * Full report configuration combining filters and chart settings
 */
export interface ReportConfig {
  id: string;
  name: string;
  filter: FilterConfig;
  chartType: ChartType;
  xAxis: ChartAxisConfig;
  yAxis: ChartAxisConfig;
  yAxis2?: ChartAxisConfig; // Secondary Y-axis (right side) for scatter/line charts
  yAxis3?: ChartAxisConfig; // Tertiary Y-axis (far right) for scatter/line charts
  colorBy?: ChartAxisConfig; // Optional color encoding
  sizeBy?: ChartAxisConfig; // Optional size encoding (scatter only)
  tableBuckets?: number[]; // Bucket thresholds for table type (e.g., [15, 20, 25, 30])
  tableColumns?: string[]; // Selected columns for table type (e.g., ['count', 'winRate', 'pl:avg'])
  thresholdMetric?: ThresholdMetric; // Secondary Y-axis metric for threshold chart (default: 'pl')
  boxBucketCount?: number; // Number of buckets for box plot (default: 4)
  category?: ReportCategory; // Category for grouping preset reports in menus
  isBuiltIn?: boolean; // True for preset reports
  createdAt: string;
  updatedAt: string;
}

/**
 * Available fields that can be used for filtering and chart axes
 * Combines base Trade fields with derived EnrichedTrade fields
 */
export type ReportField =
  // Market conditions
  | "openingVix"
  | "closingVix"
  | "openingShortLongRatio"
  | "closingShortLongRatio"
  | "gap"
  | "movement"
  // Performance metrics (base)
  | "pl"
  | "premium"
  | "marginReq"
  | "openingPrice"
  | "closingPrice"
  | "numContracts"
  | "openingCommissionsFees"
  | "closingCommissionsFees"
  | "maxProfit"
  | "maxLoss"
  // Derived: MFE/MAE metrics
  | "mfePercent"
  | "maePercent"
  | "profitCapturePercent"
  | "excursionRatio"
  | "shortLongRatioChange"
  | "shortLongRatioChangePct"
  // Derived: Return metrics
  | "rom"
  | "plPct"
  | "netPlPct"
  // Derived: Timing
  | "durationHours"
  | "dayOfWeek"
  | "hourOfDay"
  | "timeOfDayMinutes"
  | "dayOfMonth"
  | "monthOfYear"
  | "weekOfYear"
  | "dateOpenedTimestamp"
  // Derived: Costs & Net
  | "totalFees"
  | "netPl"
  // Derived: VIX changes
  | "vixChange"
  | "vixChangePct"
  // Derived: Risk metrics
  | "rMultiple"
  | "isWinner"
  // Derived: Sequential
  | "tradeNumber"
  // Derived: Portfolio context
  | "exposureOnOpen"
  | "exposureOnOpenDollars";

/**
 * Field category for organizing fields in UI
 */
export type FieldCategory = "market" | "returns" | "risk" | "trade" | "timing";

/**
 * Human-readable labels for field categories
 */
export const FIELD_CATEGORY_LABELS: Record<FieldCategory, string> = {
  market: "Market",
  returns: "Returns",
  risk: "Risk (MFE/MAE)",
  trade: "Trade Details",
  timing: "Timing",
};

/**
 * Order for field categories in dropdowns
 */
export const FIELD_CATEGORY_ORDER: FieldCategory[] = [
  "market",
  "returns",
  "risk",
  "trade",
  "timing",
];

/**
 * Field metadata for UI display
 */
export interface FieldInfo {
  field: ReportField;
  label: string;
  category: FieldCategory;
  unit?: string;
  description?: string;
  formula?: string;
}

/**
 * All available fields with their metadata
 * Includes base Trade fields and derived EnrichedTrade fields
 */
export const REPORT_FIELDS: FieldInfo[] = [
  // Market conditions
  {
    field: "openingVix",
    label: "Opening VIX",
    category: "market",
    description: "VIX level when the trade was opened",
  },
  {
    field: "closingVix",
    label: "Closing VIX",
    category: "market",
    description: "VIX level when the trade was closed",
  },
  {
    field: "vixChange",
    label: "VIX Change",
    category: "market",
    description: "How much VIX moved during the trade",
    formula: "Closing VIX - Opening VIX",
  },
  {
    field: "vixChangePct",
    label: "VIX Change %",
    category: "market",
    unit: "%",
    description: "Percentage change in VIX during the trade",
    formula: "((Closing VIX - Opening VIX) / Opening VIX) × 100",
  },
  {
    field: "openingShortLongRatio",
    label: "Opening S/L Ratio",
    category: "market",
    description: "Short/Long ratio at trade entry - measures market sentiment",
  },
  {
    field: "closingShortLongRatio",
    label: "Closing S/L Ratio",
    category: "market",
    description: "Short/Long ratio at trade exit",
  },
  {
    field: "shortLongRatioChange",
    label: "S/L Ratio Change",
    category: "market",
    description: "How S/L ratio changed during the trade",
    formula: "Closing S/L Ratio / Opening S/L Ratio",
  },
  {
    field: "shortLongRatioChangePct",
    label: "S/L Ratio Change %",
    category: "market",
    unit: "%",
    description: "Percentage change in S/L ratio",
    formula: "((Closing - Opening) / Opening) × 100",
  },
  {
    field: "gap",
    label: "Gap",
    category: "market",
    description: "Opening gap in points from previous close",
  },
  {
    field: "movement",
    label: "Movement",
    category: "market",
    description: "Underlying price movement during the trade",
  },

  // Return metrics
  {
    field: "pl",
    label: "Profit/Loss",
    category: "returns",
    unit: "$",
    description: "Trade profit or loss in dollars (before fees)",
  },
  {
    field: "netPl",
    label: "Net P/L",
    category: "returns",
    unit: "$",
    description: "Profit/loss after subtracting all fees",
    formula: "P/L - Total Fees",
  },
  {
    field: "plPct",
    label: "P/L %",
    category: "returns",
    unit: "%",
    description: "Return as a percentage of premium collected",
    formula: "(P/L / Premium) × 100",
  },
  {
    field: "netPlPct",
    label: "Net P/L %",
    category: "returns",
    unit: "%",
    description: "Net return as a percentage of premium",
    formula: "(Net P/L / Premium) × 100",
  },
  {
    field: "rom",
    label: "Return on Margin",
    category: "returns",
    unit: "%",
    description: "Return relative to margin required - measures capital efficiency",
    formula: "(P/L / Margin Required) × 100",
  },
  {
    field: "isWinner",
    label: "Is Winner",
    category: "returns",
    description: "Binary flag: 1 if trade was profitable, 0 if it was a loss",
  },

  // Risk metrics (MFE/MAE)
  {
    field: "mfePercent",
    label: "MFE %",
    category: "risk",
    unit: "%",
    description:
      "Maximum Favorable Excursion - the best unrealized profit during the trade as % of premium",
    formula: "(Max Unrealized Profit / Premium) × 100",
  },
  {
    field: "maePercent",
    label: "MAE %",
    category: "risk",
    unit: "%",
    description:
      "Maximum Adverse Excursion - the worst unrealized loss during the trade as % of premium",
    formula: "(Max Unrealized Loss / Premium) × 100",
  },
  {
    field: "profitCapturePercent",
    label: "Profit Capture %",
    category: "risk",
    unit: "%",
    description: "How much of the peak profit was captured at exit",
    formula: "(P/L / MFE) × 100",
  },
  {
    field: "excursionRatio",
    label: "Excursion Ratio",
    category: "risk",
    description: "Reward/risk ratio - how much upside vs downside the trade experienced",
    formula: "MFE / MAE",
  },
  {
    field: "rMultiple",
    label: "R-Multiple",
    category: "risk",
    description: 'Risk-adjusted return - how many "R" (risk units) were won or lost',
    formula: "P/L / MAE",
  },

  // Trade details
  {
    field: "premium",
    label: "Premium",
    category: "trade",
    unit: "$",
    description: "Premium collected per contract when opening the trade",
  },
  {
    field: "marginReq",
    label: "Margin Required",
    category: "trade",
    unit: "$",
    description: "Margin/buying power required to hold the position",
  },
  {
    field: "openingPrice",
    label: "Opening Price",
    category: "trade",
    unit: "$",
    description: "Price of the position when opened",
  },
  {
    field: "closingPrice",
    label: "Closing Price",
    category: "trade",
    unit: "$",
    description: "Price of the position when closed",
  },
  {
    field: "numContracts",
    label: "Contracts",
    category: "trade",
    description: "Number of contracts traded",
  },
  {
    field: "totalFees",
    label: "Total Fees",
    category: "trade",
    unit: "$",
    description: "All commissions and fees paid",
    formula: "Opening Fees + Closing Fees",
  },
  {
    field: "openingCommissionsFees",
    label: "Opening Fees",
    category: "trade",
    unit: "$",
    description: "Commissions and fees paid when opening",
  },
  {
    field: "closingCommissionsFees",
    label: "Closing Fees",
    category: "trade",
    unit: "$",
    description: "Commissions and fees paid when closing",
  },
  {
    field: "maxProfit",
    label: "Max Profit",
    category: "trade",
    unit: "%",
    description: "Maximum unrealized profit as % of premium during the trade",
  },
  {
    field: "maxLoss",
    label: "Max Loss",
    category: "trade",
    unit: "%",
    description: "Maximum unrealized loss as % of premium during the trade",
  },

  // Timing
  {
    field: "tradeNumber",
    label: "Trade #",
    category: "timing",
    description: "Sequential trade number (1 = first trade)",
  },
  {
    field: "dateOpenedTimestamp",
    label: "Date Opened",
    category: "timing",
    description: "When the trade was opened (useful for time-series charts)",
  },
  {
    field: "durationHours",
    label: "Duration (hrs)",
    category: "timing",
    unit: "hrs",
    description: "How long the position was held",
    formula: "Close Time - Open Time",
  },
  {
    field: "dayOfWeek",
    label: "Day of Week",
    category: "timing",
    description: "Day of week when opened: 0=Sunday through 6=Saturday",
  },
  {
    field: "hourOfDay",
    label: "Hour of Day",
    category: "timing",
    description: "Hour of day when opened (0-23 in Eastern Time)",
  },
  {
    field: "timeOfDayMinutes",
    label: "Time of Day",
    category: "timing",
    description:
      "Exact time when opened as minutes since midnight (e.g., 11:45 = 705). Useful for scatter plots to analyze floating-time or multiple-entry trades",
  },
  {
    field: "dayOfMonth",
    label: "Day of Month",
    category: "timing",
    description: "Day of month when opened (1-31)",
  },
  {
    field: "monthOfYear",
    label: "Month of Year",
    category: "timing",
    description: "Month when opened (1=January through 12=December)",
  },
  {
    field: "weekOfYear",
    label: "Week of Year",
    category: "timing",
    description: "ISO week number when opened (1-52)",
  },

  // Portfolio context
  {
    field: "exposureOnOpen",
    label: "Portfolio Exposure %",
    category: "risk",
    unit: "%",
    description:
      "Portfolio margin exposure as % of equity at the exact moment this trade opened - shows how much risk was deployed when entering",
  },
  {
    field: "exposureOnOpenDollars",
    label: "Portfolio Exposure $",
    category: "risk",
    unit: "$",
    description:
      "Portfolio margin exposure in dollars at the exact moment this trade opened - shows total margin at risk when entering",
  },
];

/**
 * Get field info by field name
 * Checks static REPORT_FIELDS first, then looks for custom field patterns
 */
export function getFieldInfo(field: string): FieldInfo | undefined {
  // Check static fields first
  const staticField = REPORT_FIELDS.find((f) => f.field === field);
  if (staticField) return staticField;

  // Check if it's a custom trade field (custom.fieldName)
  if (field.startsWith("custom.")) {
    const customFieldName = field.slice(7); // Remove 'custom.' prefix
    return {
      field: field as ReportField,
      label: customFieldName,
      category: "trade",
      description: `Custom field from trade CSV: ${customFieldName}`,
    };
  }

  // Check if it's a daily custom field (daily.fieldName)
  if (field.startsWith("daily.")) {
    const dailyFieldName = field.slice(6); // Remove 'daily.' prefix
    return {
      field: field as ReportField,
      label: `Daily: ${dailyFieldName}`,
      category: "market",
      description: `Custom field from daily log CSV: ${dailyFieldName}`,
    };
  }

  // Check if it's a static dataset field (datasetName.columnName)
  // Static dataset fields contain a dot but don't start with 'custom.' or 'daily.'
  if (field.includes(".")) {
    const dotIndex = field.indexOf(".");
    const datasetName = field.substring(0, dotIndex);
    const columnName = field.substring(dotIndex + 1);
    return {
      field: field as ReportField,
      label: `${datasetName}.${columnName}`,
      category: "market",
      description: `Static dataset field: ${columnName} from ${datasetName}`,
    };
  }

  return undefined;
}

/**
 * Get fields grouped by category, ordered by FIELD_CATEGORY_ORDER
 * Includes only static fields (no custom fields)
 */
export function getFieldsByCategory(): Map<FieldCategory, FieldInfo[]> {
  const grouped = new Map<FieldCategory, FieldInfo[]>();

  // Initialize in the correct order
  for (const category of FIELD_CATEGORY_ORDER) {
    grouped.set(category, []);
  }

  // Add fields to their categories
  for (const field of REPORT_FIELDS) {
    grouped.get(field.category)?.push(field);
  }

  return grouped;
}

/**
 * Custom field category for organizing custom fields in UI
 * Note: Static datasets use their dataset name as the category dynamically
 */
export type CustomFieldCategory = "custom" | "dailyCustom";

/**
 * Labels for custom field categories
 */
export const CUSTOM_FIELD_CATEGORY_LABELS: Record<CustomFieldCategory, string> = {
  custom: "Custom (Trade)",
  dailyCustom: "Custom (Daily)",
};

/**
 * Extracts unique custom field names from an array of trades
 * Returns both trade custom fields and daily custom fields
 */
export interface ExtractedCustomFields {
  /** Custom fields from trade CSV (keys are field names without prefix) */
  tradeFields: string[];
  /** Custom fields from daily log CSV (keys are field names without prefix) */
  dailyFields: string[];
}

/**
 * Extract custom field names from enriched trades
 */
export function extractCustomFieldNames(
  trades: Array<{
    customFields?: Record<string, number | string>;
    dailyCustomFields?: Record<string, number | string>;
  }>,
): ExtractedCustomFields {
  const tradeFieldSet = new Set<string>();
  const dailyFieldSet = new Set<string>();

  for (const trade of trades) {
    if (trade.customFields) {
      for (const key of Object.keys(trade.customFields)) {
        tradeFieldSet.add(key);
      }
    }
    if (trade.dailyCustomFields) {
      for (const key of Object.keys(trade.dailyCustomFields)) {
        dailyFieldSet.add(key);
      }
    }
  }

  // Return fields in insertion order (preserves CSV column order from first trade)
  // Using Set preserves insertion order in modern JavaScript
  return {
    tradeFields: Array.from(tradeFieldSet),
    dailyFields: Array.from(dailyFieldSet),
  };
}

/**
 * Get fields grouped by category, including custom fields from trades
 * This is the dynamic version that includes custom fields discovered in the data
 */
export function getFieldsByCategoryWithCustom(
  trades: Array<{
    customFields?: Record<string, number | string>;
    dailyCustomFields?: Record<string, number | string>;
  }>,
): Map<FieldCategory | CustomFieldCategory, FieldInfo[]> {
  // Start with static fields
  const grouped = new Map<FieldCategory | CustomFieldCategory, FieldInfo[]>();

  // Initialize in the correct order
  for (const category of FIELD_CATEGORY_ORDER) {
    grouped.set(category, []);
  }

  // Add static fields to their categories
  for (const field of REPORT_FIELDS) {
    grouped.get(field.category)?.push(field);
  }

  // Extract custom fields from trades
  const { tradeFields, dailyFields } = extractCustomFieldNames(trades);

  // Add custom trade fields category if there are any
  if (tradeFields.length > 0) {
    const customFieldInfos: FieldInfo[] = tradeFields.map((fieldName) => ({
      field: `custom.${fieldName}` as ReportField,
      label: fieldName,
      category: "trade" as FieldCategory, // Will be shown in 'custom' category
      description: `Custom field from trade CSV`,
    }));
    grouped.set("custom", customFieldInfos);
  }

  // Add daily custom fields category if there are any
  if (dailyFields.length > 0) {
    const dailyFieldInfos: FieldInfo[] = dailyFields.map((fieldName) => ({
      field: `daily.${fieldName}` as ReportField,
      label: fieldName,
      category: "market" as FieldCategory, // Will be shown in 'dailyCustom' category
      description: `Custom field from daily log CSV`,
    }));
    grouped.set("dailyCustom", dailyFieldInfos);
  }

  return grouped;
}

/**
 * Get all field category labels including custom categories
 */
export function getAllCategoryLabels(): Record<FieldCategory | CustomFieldCategory, string> {
  return {
    ...FIELD_CATEGORY_LABELS,
    ...CUSTOM_FIELD_CATEGORY_LABELS,
  };
}

/**
 * Static dataset info for field discovery
 */
export interface StaticDatasetFieldInfo {
  datasetName: string;
  columns: string[];
}

/**
 * Get fields grouped by category, including custom fields AND static dataset fields
 * This is the full dynamic version for Report Builder
 * Static datasets each get their own category named after the dataset
 */
export function getFieldsByCategoryWithAll(
  trades: Array<{
    customFields?: Record<string, number | string>;
    dailyCustomFields?: Record<string, number | string>;
  }>,
  staticDatasets?: StaticDatasetFieldInfo[],
): Map<string, FieldInfo[]> {
  // Start with the version that includes custom fields
  const grouped: Map<string, FieldInfo[]> = getFieldsByCategoryWithCustom(trades);

  // Add static dataset fields - each dataset becomes its own category
  if (staticDatasets && staticDatasets.length > 0) {
    for (const dataset of staticDatasets) {
      const datasetFields: FieldInfo[] = dataset.columns.map((column) => ({
        field: `${dataset.datasetName}.${column}` as ReportField,
        label: column,
        category: "market" as FieldCategory,
        description: `${column} from static dataset "${dataset.datasetName}"`,
      }));

      if (datasetFields.length > 0) {
        grouped.set(dataset.datasetName, datasetFields);
      }
    }
  }

  return grouped;
}

/**
 * Create an empty filter config
 */
export function createEmptyFilterConfig(): FilterConfig {
  return {
    conditions: [],
    logic: "and",
  };
}

/**
 * Create a new filter condition with defaults
 */
export function createFilterCondition(field: ReportField = "openingVix"): FilterCondition {
  return {
    id: crypto.randomUUID(),
    field,
    operator: "gt",
    value: 0,
    enabled: true,
  };
}

/**
 * Create a default report config
 */
export function createDefaultReportConfig(): Omit<ReportConfig, "id" | "createdAt" | "updatedAt"> {
  return {
    name: "New Report",
    filter: createEmptyFilterConfig(),
    chartType: "scatter",
    xAxis: { field: "openingVix", label: "Opening VIX" },
    yAxis: { field: "pl", label: "Profit/Loss" },
  };
}

// ============================================================================
// Table Column Configuration
// ============================================================================

/**
 * Aggregation types for table columns
 */
export type AggregationType = "avg" | "sum" | "min" | "max" | "count" | "winRate";

/**
 * Table column option for MultiSelect
 */
export interface TableColumnOption {
  value: string; // Format: "field:aggregation" or special like "count", "winRate"
  label: string;
}

/**
 * Table column group for MultiSelect
 */
export interface TableColumnGroup {
  heading: string;
  options: TableColumnOption[];
}

/**
 * Predefined table column options grouped by category
 * Value format: "field:aggregation" (e.g., "pl:avg") or special values ("count", "winRate")
 */
export const TABLE_COLUMN_OPTIONS: TableColumnGroup[] = [
  {
    heading: "Core",
    options: [
      { value: "count", label: "Trades" },
      { value: "winRate", label: "Win Rate" },
    ],
  },
  {
    heading: "P&L ($)",
    options: [
      { value: "pl:avg", label: "Avg P&L ($)" },
      { value: "pl:sum", label: "Total P&L ($)" },
      { value: "netPl:avg", label: "Avg Net P&L ($)" },
      { value: "netPl:sum", label: "Total Net P&L ($)" },
    ],
  },
  {
    heading: "P&L (%)",
    options: [
      { value: "plPct:avg", label: "Avg P&L (%)" },
      { value: "netPlPct:avg", label: "Avg Net P&L (%)" },
      { value: "rom:avg", label: "Avg ROM (%)" },
    ],
  },
  {
    heading: "Risk",
    options: [
      { value: "mfePercent:avg", label: "Avg MFE (%)" },
      { value: "maePercent:avg", label: "Avg MAE (%)" },
      { value: "profitCapturePercent:avg", label: "Avg Profit Capture (%)" },
      { value: "excursionRatio:avg", label: "Avg Excursion Ratio" },
      { value: "rMultiple:avg", label: "Avg R-Multiple" },
    ],
  },
  {
    heading: "Position",
    options: [
      { value: "premium:avg", label: "Avg Premium ($)" },
      { value: "marginReq:avg", label: "Avg Margin ($)" },
      { value: "numContracts:avg", label: "Avg Contracts" },
      { value: "totalFees:avg", label: "Avg Fees ($)" },
      { value: "totalFees:sum", label: "Total Fees ($)" },
    ],
  },
  {
    heading: "Timing",
    options: [{ value: "durationHours:avg", label: "Avg Duration (hrs)" }],
  },
  {
    heading: "Market",
    options: [
      { value: "openingVix:avg", label: "Avg Opening VIX" },
      { value: "closingVix:avg", label: "Avg Closing VIX" },
      { value: "vixChange:avg", label: "Avg VIX Change" },
      { value: "vixChangePct:avg", label: "Avg VIX Change (%)" },
      { value: "gap:avg", label: "Avg Gap (%)" },
    ],
  },
];

/**
 * Default selected table columns
 */
export const DEFAULT_TABLE_COLUMNS: string[] = [
  "count",
  "winRate",
  "pl:avg",
  "plPct:avg",
  "rom:avg",
];

/**
 * Get all table column options as a flat array
 */
export function getAllTableColumnOptions(): TableColumnOption[] {
  return TABLE_COLUMN_OPTIONS.flatMap((group) => group.options);
}

/**
 * Parse a column value into field and aggregation
 * Special values: "count" -> { field: 'count', aggregation: 'count' }
 *                "winRate" -> { field: 'isWinner', aggregation: 'winRate' }
 * Regular values: "pl:avg" -> { field: 'pl', aggregation: 'avg' }
 */
export function parseColumnValue(value: string): { field: string; aggregation: AggregationType } {
  if (value === "count") {
    return { field: "count", aggregation: "count" };
  }
  if (value === "winRate") {
    return { field: "isWinner", aggregation: "winRate" };
  }
  const [field, aggregation] = value.split(":");
  return {
    field: field || value,
    aggregation: (aggregation as AggregationType) || "avg",
  };
}

/**
 * Get label for a column value
 */
export function getColumnLabel(value: string): string {
  const option = getAllTableColumnOptions().find((opt) => opt.value === value);
  return option?.label ?? value;
}

/**
 * Get unit for formatting a column value
 */
export function getColumnUnit(value: string): string | undefined {
  const { field } = parseColumnValue(value);
  if (field === "count") return undefined;
  if (field === "isWinner") return "%";
  const fieldInfo = getFieldInfo(field);
  return fieldInfo?.unit;
}
