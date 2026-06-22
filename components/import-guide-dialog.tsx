"use client";

/**
 * Import Guide Dialog
 *
 * A help dialog that explains CSV import format requirements,
 * available fields, and custom fields support.
 */

import { HelpCircle, Download, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

// Template CSVs
const COMPLETE_TEMPLATE_CSV = `Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees,Closing Commissions + Fees,Opening Short/Long Ratio,Closing Short/Long Ratio,Opening VIX,Closing VIX,Gap,Movement,Max Profit,Max Loss
2024-01-15,09:30:00,4535.25,SPX 15JAN24 4500P/4450P,2.50,1.25,2024-01-15,15:45:00,1.25,Profit Target,125.00,1,10125.00,1000.00,Bull Put Spread,1.50,1.50,0.5,0.5,14.25,13.80,0.25,-0.15,250.00,-1000.00
2024-01-16,10:15:00,4542.75,SPX 19JAN24 4600C/4650C,3.25,0.50,2024-01-18,14:30:00,0.50,Profit Target,275.00,1,10400.00,1200.00,Bear Call Spread,1.50,1.50,0.6,0.55,15.10,14.50,-0.10,0.20,325.00,-1200.00`;

const MINIMAL_TEMPLATE_CSV = `Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy
2024-01-15,09:30:00,4535.25,SPX 15JAN24 4500P/4450P,2.50,,,,,,125.00,1,10125.00,1000.00,Bull Put Spread
2024-01-16,09:30:00,4542.75,SPX 19JAN24 4600C/4650C,3.25,,,,,,275.00,1,10400.00,1200.00,Bear Call Spread`;

const DAILY_LOG_TEMPLATE_CSV = `Date,Net Liquidity,Current Funds,Withdrawn,Trading Funds,P/L,P/L %,Drawdown %
2024-01-15,50000.00,50125.00,0,10000.00,125.00,1.25,0
2024-01-16,50000.00,50400.00,0,10000.00,275.00,2.75,0
2024-01-17,50000.00,50150.00,0,10000.00,-250.00,-2.44,-0.50`;

const REPORTING_LOG_TEMPLATE_CSV = `Strategy,Date Opened,Time Opened,Opening Price,Legs,Initial Premium,No. of Contracts,P/L,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close
Bull Put Spread,2024-01-15,09:30:00,4535.25,SPX 15JAN24 4500P/4450P,2.50,1,125.00,1.25,2024-01-15,15:45:00,1.25,Profit Target
Bear Call Spread,2024-01-16,10:15:00,4542.75,SPX 19JAN24 4600C/4650C,3.25,2,275.00,0.50,2024-01-18,14:30:00,0.50,Profit Target`;

// Trade log fields
const REQUIRED_TRADE_FIELDS = [
  { name: "Date Opened", description: "Trade open date (YYYY-MM-DD or MM/DD/YY)" },
  { name: "Time Opened", description: "Trade open time (H:mm:ss or HH:mm:ss)" },
  { name: "Opening Price", description: "Underlying price at trade open" },
  { name: "Legs", description: "Option legs description (e.g., 'SPX 15JAN24 4500P/4450P')" },
  { name: "Premium", description: "Premium received/paid" },
  { name: "P/L", description: "Profit/Loss for the trade" },
  { name: "No. of Contracts", description: "Number of contracts traded" },
  { name: "Funds at Close", description: "Account funds after trade closed" },
  { name: "Margin Req.", description: "Margin requirement for the trade" },
  { name: "Strategy", description: "Strategy name (e.g., 'Bull Put Spread')" },
];

const OPTIONAL_TRADE_FIELDS = [
  { name: "Closing Price", description: "Underlying price at trade close" },
  { name: "Date Closed", description: "Trade close date" },
  { name: "Time Closed", description: "Trade close time" },
  { name: "Avg. Closing Cost", description: "Average cost to close the position" },
  { name: "Reason For Close", description: "Why the trade was closed" },
  { name: "Opening Commissions + Fees", description: "Commissions paid to open" },
  { name: "Closing Commissions + Fees", description: "Commissions paid to close" },
  { name: "Opening Short/Long Ratio", description: "Short/Long ratio at open" },
  { name: "Closing Short/Long Ratio", description: "Short/Long ratio at close" },
  { name: "Opening VIX", description: "VIX value at trade open" },
  { name: "Closing VIX", description: "VIX value at trade close" },
  { name: "Gap", description: "Gap measurement" },
  { name: "Movement", description: "Price movement" },
  { name: "Max Profit", description: "Maximum potential profit" },
  { name: "Max Loss", description: "Maximum potential loss" },
];

// Daily log fields
const REQUIRED_DAILY_FIELDS = [
  { name: "Date", description: "Date of the daily snapshot" },
  { name: "Net Liquidity", description: "Total account net liquidation value" },
  { name: "Current Funds", description: "Current available funds" },
  { name: "Trading Funds", description: "Funds allocated to trading" },
  { name: "P/L", description: "Daily profit/loss" },
  { name: "P/L %", description: "Daily P/L as percentage" },
  { name: "Drawdown %", description: "Current drawdown percentage (negative or zero)" },
];

const OPTIONAL_DAILY_FIELDS = [{ name: "Withdrawn", description: "Amount withdrawn (default: 0)" }];

// Reporting log fields
const REQUIRED_REPORTING_FIELDS = [
  { name: "Strategy", description: "Strategy name (e.g., 'Bull Put Spread')" },
  { name: "Date Opened", description: "Trade open date (YYYY-MM-DD or MM/DD/YY)" },
  { name: "Opening Price", description: "Underlying price at trade open" },
  { name: "Legs", description: "Option legs description (e.g., 'SPX 15JAN24 4500P/4450P')" },
  { name: "Initial Premium", description: "Initial premium received/paid" },
  { name: "No. of Contracts", description: "Number of contracts traded" },
  { name: "P/L", description: "Profit/Loss for the trade" },
];

const OPTIONAL_REPORTING_FIELDS = [
  { name: "Time Opened", description: "Trade open time" },
  { name: "Closing Price", description: "Underlying price at trade close" },
  { name: "Date Closed", description: "Trade close date" },
  { name: "Time Closed", description: "Trade close time" },
  { name: "Avg. Closing Cost", description: "Average cost to close the position" },
  { name: "Reason For Close", description: "Why the trade was closed" },
];

function downloadTemplate(type: "complete" | "minimal" | "daily-log" | "reporting-log") {
  let content: string;
  let filename: string;

  switch (type) {
    case "complete":
      content = COMPLETE_TEMPLATE_CSV;
      filename = "tradeblocks-tradelog-complete.csv";
      break;
    case "minimal":
      content = MINIMAL_TEMPLATE_CSV;
      filename = "tradeblocks-tradelog-minimal.csv";
      break;
    case "daily-log":
      content = DAILY_LOG_TEMPLATE_CSV;
      filename = "tradeblocks-dailylog-template.csv";
      break;
    case "reporting-log":
      content = REPORTING_LOG_TEMPLATE_CSV;
      filename = "tradeblocks-reporting-log-template.csv";
      break;
  }

  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ImportGuideDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <HelpCircle className="h-4 w-4" />
          <span className="hidden sm:inline">Import Guide</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>CSV Import Guide</DialogTitle>
          <DialogDescription>
            Format requirements for importing trade logs, daily logs, and reporting logs
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 pr-2 -mr-2">
          <div className="space-y-6">
            {/* Download Templates Section */}
            <div className="rounded-lg border bg-primary/5 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-sm">Download Templates</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Get started quickly with example CSV files
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Download className="w-4 h-4 mr-2" />
                      Download
                      <ChevronDown className="w-3 h-3 ml-1 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem onClick={() => downloadTemplate("minimal")}>
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">Trade Log - Minimal</span>
                        <span className="text-xs text-muted-foreground">Required fields only</span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => downloadTemplate("complete")}>
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">Trade Log - Complete</span>
                        <span className="text-xs text-muted-foreground">All standard fields</span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => downloadTemplate("daily-log")}>
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">Daily Log</span>
                        <span className="text-xs text-muted-foreground">
                          Portfolio daily values
                        </span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => downloadTemplate("reporting-log")}>
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">Reporting Log</span>
                        <span className="text-xs text-muted-foreground">
                          Backtest vs actual comparison
                        </span>
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Custom Fields Section */}
            <div className="rounded-lg border bg-blue-500/10 border-blue-500/20 p-4">
              <h3 className="font-semibold text-sm text-blue-600 dark:text-blue-400">
                Custom Numeric Fields
              </h3>
              <p className="text-sm text-muted-foreground mt-2">
                Add extra <span className="font-medium">numeric</span> columns to your CSV files for
                custom analysis. They&apos;ll be available for filtering and charting in the Report
                Builder.
              </p>
              <div className="mt-3 text-xs text-muted-foreground">
                <p className="font-medium">How it works:</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  <li>Only numeric values work for filtering and charts</li>
                  <li>
                    Trade log custom fields appear under &quot;Trade Custom Fields&quot; in the
                    field picker
                  </li>
                  <li>
                    Daily log custom fields appear under &quot;Daily Custom Fields&quot; in the
                    field picker
                  </li>
                </ul>
              </div>
              <p className="text-xs text-muted-foreground mt-2 italic">
                Example: Add a &quot;Day Open VIX&quot; column to your daily log CSV, then use it
                for filtering or charting in Report Builder.
              </p>
            </div>

            {/* Trade Log Section */}
            <div>
              <h3 className="text-sm font-semibold text-primary mb-3 sticky top-0 bg-background py-1">
                Trade Log Fields
              </h3>

              {/* Required Fields */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="destructive" className="text-xs">
                    Required
                  </Badge>
                  <span className="text-xs text-muted-foreground">Must have values</span>
                </div>
                <div className="space-y-2">
                  {REQUIRED_TRADE_FIELDS.map((field) => (
                    <div key={field.name} className="rounded-lg border bg-muted/30 p-2">
                      <div className="font-medium text-sm">{field.name}</div>
                      <p className="text-xs text-muted-foreground">{field.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Optional Fields */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="text-xs">
                    Optional
                  </Badge>
                  <span className="text-xs text-muted-foreground">Can be empty</span>
                </div>
                <div className="space-y-2">
                  {OPTIONAL_TRADE_FIELDS.map((field) => (
                    <div key={field.name} className="rounded-lg border bg-muted/30 p-2">
                      <div className="font-medium text-sm">{field.name}</div>
                      <p className="text-xs text-muted-foreground">{field.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Daily Log Section */}
            <div>
              <h3 className="text-sm font-semibold text-primary mb-3 sticky top-0 bg-background py-1">
                Daily Log Fields
              </h3>

              {/* Required Fields */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="destructive" className="text-xs">
                    Required
                  </Badge>
                  <span className="text-xs text-muted-foreground">Must have values</span>
                </div>
                <div className="space-y-2">
                  {REQUIRED_DAILY_FIELDS.map((field) => (
                    <div key={field.name} className="rounded-lg border bg-muted/30 p-2">
                      <div className="font-medium text-sm">{field.name}</div>
                      <p className="text-xs text-muted-foreground">{field.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Optional Fields */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="text-xs">
                    Optional
                  </Badge>
                  <span className="text-xs text-muted-foreground">Can be empty</span>
                </div>
                <div className="space-y-2">
                  {OPTIONAL_DAILY_FIELDS.map((field) => (
                    <div key={field.name} className="rounded-lg border bg-muted/30 p-2">
                      <div className="font-medium text-sm">{field.name}</div>
                      <p className="text-xs text-muted-foreground">{field.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Reporting Log Section */}
            <div>
              <h3 className="text-sm font-semibold text-primary mb-3 sticky top-0 bg-background py-1">
                Reporting Log Fields
              </h3>

              {/* Required Fields */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="destructive" className="text-xs">
                    Required
                  </Badge>
                  <span className="text-xs text-muted-foreground">Must have values</span>
                </div>
                <div className="space-y-2">
                  {REQUIRED_REPORTING_FIELDS.map((field) => (
                    <div key={field.name} className="rounded-lg border bg-muted/30 p-2">
                      <div className="font-medium text-sm">{field.name}</div>
                      <p className="text-xs text-muted-foreground">{field.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Optional Fields */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="text-xs">
                    Optional
                  </Badge>
                  <span className="text-xs text-muted-foreground">Can be empty</span>
                </div>
                <div className="space-y-2">
                  {OPTIONAL_REPORTING_FIELDS.map((field) => (
                    <div key={field.name} className="rounded-lg border bg-muted/30 p-2">
                      <div className="font-medium text-sm">{field.name}</div>
                      <p className="text-xs text-muted-foreground">{field.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Tips Section */}
            <div className="rounded-lg border bg-muted/50 p-4">
              <h3 className="font-semibold text-sm mb-2">Tips</h3>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• Date formats: YYYY-MM-DD or MM/DD/YY both work</li>
                <li>• Time formats: H:mm:ss or HH:mm:ss (e.g., 9:30:00 or 09:30:00)</li>
                <li>• Currency symbols ($) and commas are automatically removed from numbers</li>
                <li>• Open trades can have empty closing fields</li>
                <li>• Daily logs enable more accurate drawdown and Sharpe ratio calculations</li>
                <li>• Reporting logs are used to compare backtest results against actual trades</li>
              </ul>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ImportGuideDialog;
