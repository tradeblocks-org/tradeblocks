"use client";

import { ChevronDown, ChevronRight, ExternalLink, FileJson, Info, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { NoActiveBlock } from "@/components/no-active-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  PortfolioStatsCalculator,
  getBlock,
  getDailyLogsByBlock,
  getTradesByBlockWithOptions,
  buildPerformanceSnapshot,
  downloadJson,
  generateExportFilename,
  CHART_EXPORTS,
  getChartExportsByTab,
  getMultipleChartsJson,
  TAB_ORDER,
} from "@tradeblocks/lib";
import type { PortfolioStats, StrategyStats, SnapshotChartData, Trade } from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";

const GPT_URL = "https://chatgpt.com/g/g-6919e4fab91c8191a77967240ab4f3e8-tradeblocks-assistant";
export default function AssistantPage() {
  const [includeBlockStats, setIncludeBlockStats] = useState(true);
  const [selectedCharts, setSelectedCharts] = useState<Set<string>>(
    new Set(CHART_EXPORTS.map((c) => c.id)),
  );
  const [chartsExpanded, setChartsExpanded] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Block store
  const activeBlock = useBlockStore((state) => {
    const activeBlockId = state.activeBlockId;
    return activeBlockId ? state.blocks.find((block) => block.id === activeBlockId) : null;
  });
  const isInitialized = useBlockStore((state) => state.isInitialized);
  const loadBlocks = useBlockStore((state) => state.loadBlocks);

  // Local data state
  const [portfolioStats, setPortfolioStats] = useState<PortfolioStats | null>(null);
  const [strategyStats, setStrategyStats] = useState<Record<string, StrategyStats>>({});
  const [trades, setTrades] = useState<Trade[]>([]);
  const [chartData, setChartData] = useState<SnapshotChartData | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);

  const chartsByTab = getChartExportsByTab();

  // Load blocks if not initialized
  useEffect(() => {
    if (!isInitialized) {
      loadBlocks().catch(console.error);
    }
  }, [isInitialized, loadBlocks]);

  // Fetch trades and daily logs when active block changes
  useEffect(() => {
    if (!activeBlock) {
      setPortfolioStats(null);
      setStrategyStats({});
      setTrades([]);
      setChartData(null);
      return;
    }

    const blockId = activeBlock.id;

    const fetchData = async () => {
      setIsLoadingData(true);
      try {
        const processedBlock = await getBlock(blockId);
        const combineLegGroups = processedBlock?.analysisConfig?.combineLegGroups ?? false;

        const [blockTrades, blockDailyLogs] = await Promise.all([
          getTradesByBlockWithOptions(blockId, { combineLegGroups }),
          getDailyLogsByBlock(blockId),
        ]);

        // Calculate stats and chart data
        if (blockTrades.length > 0) {
          const snapshot = await buildPerformanceSnapshot({
            trades: blockTrades,
            dailyLogs: blockDailyLogs,
            normalizeTo1Lot: false,
          });
          setPortfolioStats(snapshot.portfolioStats);
          setChartData(snapshot.chartData);
          setTrades(snapshot.filteredTrades);

          const calculator = new PortfolioStatsCalculator();
          const strategies = calculator.calculateStrategyStats(snapshot.filteredTrades);
          setStrategyStats(strategies);
        }
      } catch (error) {
        console.error("Failed to fetch block data:", error);
      } finally {
        setIsLoadingData(false);
      }
    };

    fetchData();
  }, [activeBlock]);

  const toggleChart = (chartId: string) => {
    setSelectedCharts((prev) => {
      const next = new Set(prev);
      if (next.has(chartId)) {
        next.delete(chartId);
      } else {
        next.add(chartId);
      }
      return next;
    });
  };

  const selectAllCharts = () => {
    setSelectedCharts(new Set(CHART_EXPORTS.map((c) => c.id)));
  };

  const clearAllCharts = () => {
    setSelectedCharts(new Set());
  };

  const handleExportForGPT = async () => {
    if (!activeBlock) return;
    if (!includeBlockStats && selectedCharts.size === 0) return;

    setIsExporting(true);

    try {
      const exportData: Record<string, unknown> = {
        exportedAt: new Date().toISOString(),
        block: {
          id: activeBlock.id,
          name: activeBlock.name,
        },
      };

      // Export block stats
      if (includeBlockStats && portfolioStats) {
        exportData.blockStats = {
          portfolioStats: {
            totalTrades: portfolioStats.totalTrades,
            totalPl: portfolioStats.totalPl,
            netPl: portfolioStats.netPl,
            winRate: portfolioStats.winRate,
            avgWin: portfolioStats.avgWin,
            avgLoss: portfolioStats.avgLoss,
            maxWin: portfolioStats.maxWin,
            maxLoss: portfolioStats.maxLoss,
            profitFactor: portfolioStats.profitFactor,
            initialCapital: portfolioStats.initialCapital,
            cagr: portfolioStats.cagr,
            sharpeRatio: portfolioStats.sharpeRatio,
            sortinoRatio: portfolioStats.sortinoRatio,
            calmarRatio: portfolioStats.calmarRatio,
            maxDrawdown: portfolioStats.maxDrawdown,
            timeInDrawdown: portfolioStats.timeInDrawdown,
            kellyPercentage: portfolioStats.kellyPercentage,
            maxWinStreak: portfolioStats.maxWinStreak,
            maxLossStreak: portfolioStats.maxLossStreak,
            monthlyWinRate: portfolioStats.monthlyWinRate,
            weeklyWinRate: portfolioStats.weeklyWinRate,
            totalCommissions: portfolioStats.totalCommissions,
          },
          strategyBreakdown: Object.values(strategyStats).map((stat) => ({
            strategy: stat.strategyName,
            trades: stat.tradeCount,
            totalPl: stat.totalPl,
            winRate: stat.winRate,
            avgWin: stat.avgWin,
            avgLoss: stat.avgLoss,
            profitFactor: stat.profitFactor,
          })),
          // Expose per-trade margin + P/L so GPT exports always carry ROM inputs
          trades: trades.map((t, idx) => ({
            tradeNumber: idx + 1,
            dateOpened: t.dateOpened instanceof Date ? t.dateOpened.toISOString() : t.dateOpened,
            pl: t.pl,
            marginReq: t.marginReq,
            numContracts: t.numContracts,
            strategy: t.strategy,
            rom: t.marginReq && t.marginReq !== 0 ? (t.pl / t.marginReq) * 100 : null,
          })),
        };
      }

      // Export performance charts
      if (selectedCharts.size > 0 && chartData) {
        exportData.performanceCharts = getMultipleChartsJson(chartData, Array.from(selectedCharts));
      }

      // Download the combined export
      const filename = generateExportFilename(activeBlock.name, "gpt-export", "json");
      downloadJson(exportData, filename);
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  const openGPT = () => {
    window.open(GPT_URL, "_blank");
  };

  const canExport = activeBlock && !isLoadingData && (includeBlockStats || selectedCharts.size > 0);

  // Show loading state
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            TradeBlocks Assistant
          </h1>
          <p className="text-muted-foreground mt-1">
            AI-powered analysis of your trading performance
          </p>
        </div>
        <Button onClick={openGPT} className="gap-2">
          <ExternalLink className="h-4 w-4" />
          Open Assistant
        </Button>
      </div>

      {/* Main content */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Export panel */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Export Data for Analysis</CardTitle>
            <CardDescription>
              Select the data you want to export, then upload the JSON file to the assistant.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!activeBlock ? (
              <NoActiveBlock description="Select a block from the sidebar to export its data." />
            ) : isLoadingData ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                <span className="ml-2 text-muted-foreground">Loading block data...</span>
              </div>
            ) : (
              <>
                <div className="text-sm text-muted-foreground mb-4">
                  Exporting data for:{" "}
                  <span className="font-medium text-foreground">{activeBlock.name}</span>
                </div>

                <ScrollArea className="h-[320px] pr-4">
                  <div className="space-y-4">
                    {/* Block Stats */}
                    <div className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50">
                      <Checkbox
                        id="block-stats"
                        checked={includeBlockStats}
                        onCheckedChange={(checked) => setIncludeBlockStats(!!checked)}
                        className="mt-0.5"
                      />
                      <label htmlFor="block-stats" className="flex-1 cursor-pointer">
                        <div className="font-medium text-sm">Block Stats</div>
                        <div className="text-xs text-muted-foreground">
                          Portfolio metrics, win rate, Sharpe, drawdowns, strategy breakdown
                        </div>
                      </label>
                    </div>

                    {/* Performance Charts - Collapsible */}
                    <Collapsible open={chartsExpanded} onOpenChange={setChartsExpanded}>
                      <div className="rounded-lg border">
                        <CollapsibleTrigger asChild>
                          <div className="flex items-start gap-3 p-3 hover:bg-muted/50 cursor-pointer">
                            <div className="mt-0.5">
                              {chartsExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </div>
                            <div className="flex-1">
                              <div className="font-medium text-sm flex items-center gap-2">
                                Performance Charts
                                <span className="text-xs text-muted-foreground font-normal">
                                  ({selectedCharts.size} selected)
                                </span>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Equity curve, monthly returns, rolling metrics, MFE/MAE, and more
                              </div>
                            </div>
                          </div>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="border-t px-3 py-2 bg-muted/30">
                            <div className="flex gap-2 mb-3">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={selectAllCharts}
                                className="h-7 text-xs"
                              >
                                Select All
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={clearAllCharts}
                                className="h-7 text-xs"
                              >
                                Clear
                              </Button>
                            </div>
                            <div className="space-y-4">
                              {TAB_ORDER.map((tab) => {
                                const charts = chartsByTab[tab];
                                if (!charts || charts.length === 0) return null;

                                return (
                                  <div key={tab}>
                                    <h4 className="text-xs font-medium text-muted-foreground mb-2">
                                      {tab}
                                    </h4>
                                    <div className="space-y-1">
                                      {charts.map((chart) => (
                                        <div
                                          key={chart.id}
                                          className="flex items-center gap-2 py-1"
                                        >
                                          <Checkbox
                                            id={`chart-${chart.id}`}
                                            checked={selectedCharts.has(chart.id)}
                                            onCheckedChange={() => toggleChart(chart.id)}
                                          />
                                          <label
                                            htmlFor={`chart-${chart.id}`}
                                            className="text-xs cursor-pointer"
                                          >
                                            {chart.name}
                                          </label>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  </div>
                </ScrollArea>

                {/* Note about other exports */}
                <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    For other analysis, export directly from:{" "}
                    <Link href="/risk-simulator" className="underline hover:text-foreground">
                      Risk Simulator
                    </Link>
                    {", "}
                    <Link href="/walk-forward" className="underline hover:text-foreground">
                      Walk-Forward
                    </Link>
                    {", "}
                    <Link href="/correlation-matrix" className="underline hover:text-foreground">
                      Correlation
                    </Link>
                    .
                  </div>
                </div>

                <Button
                  onClick={handleExportForGPT}
                  disabled={!canExport || isExporting}
                  className="w-full gap-2"
                  variant="outline"
                >
                  <FileJson className="h-4 w-4" />
                  {isExporting ? "Exporting..." : "Download JSON for GPT"}
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  If ChatGPT has trouble with the file, try selecting fewer charts to reduce the
                  export size.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Right: Instructions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">How It Works</CardTitle>
            <CardDescription>
              Get AI-powered insights about your trading performance
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4 text-sm">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                  1
                </span>
                <div>
                  <div className="font-medium">Select a block</div>
                  <div className="text-muted-foreground">
                    Choose the trading block you want to analyze from the sidebar.
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                  2
                </span>
                <div>
                  <div className="font-medium">Export your data</div>
                  <div className="text-muted-foreground">
                    Select Block Stats and/or specific charts, then download the JSON.
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                  3
                </span>
                <div>
                  <div className="font-medium">Upload to the assistant</div>
                  <div className="text-muted-foreground">
                    Open the TradeBlocks Assistant and upload your JSON file.
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                  4
                </span>
                <div>
                  <div className="font-medium">Ask questions</div>
                  <div className="text-muted-foreground">
                    Get insights like &quot;What does my MFE/MAE tell me?&quot; or &quot;Summarize
                    my strategy breakdown.&quot;
                  </div>
                </div>
              </li>
            </ol>

            <div className="mt-6 p-4 rounded-lg bg-muted/50">
              <div className="text-sm font-medium mb-2">Example questions:</div>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• What patterns do you see in my monthly returns?</li>
                <li>• What does my MFE/MAE data reveal about trade management?</li>
                <li>• Summarize my strategy breakdown by win rate and profit factor</li>
                <li>• What does my drawdown timeline show?</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
