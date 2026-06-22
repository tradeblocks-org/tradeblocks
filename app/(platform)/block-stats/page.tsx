"use client";

import { MetricCard } from "@/components/metric-card";
import { MetricSection } from "@/components/metric-section";
import { MultiSelect } from "@/components/multi-select";
import { NoActiveBlock } from "@/components/no-active-block";
import { StrategyBreakdownTable } from "@/components/strategy-breakdown-table";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { SizingModeToggle } from "@/components/sizing-mode-toggle";
import {
  PortfolioStatsCalculator,
  getBlock,
  getDailyLogsByBlock,
  getTradesByBlockWithOptions,
  getPerformanceSnapshotCache,
  calculatePremiumEfficiencyPercent,
  computeTotalPremium,
  buildPerformanceSnapshot,
  downloadCsv,
  downloadJson,
  generateExportFilename,
  toCsvRow,
} from "@tradeblocks/lib";
import type { DailyLogEntry, PortfolioStats, StrategyStats, Trade } from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CalendarIcon,
  Download,
  Gauge,
  Target,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@tradeblocks/lib";
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { DateRange } from "react-day-picker";

// Strategy options will be dynamically generated from trades

const NORMALIZE_STORAGE_KEY_PREFIX = "block-stats:normalizeTo1Lot:";

export default function BlockStatsPage() {
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
  const [normalizeTo1Lot, setNormalizeTo1Lot] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  // Data fetching state
  const [trades, setTrades] = useState<Trade[]>([]);
  const [dailyLogs, setDailyLogs] = useState<DailyLogEntry[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // Calculated metrics state
  const [portfolioStats, setPortfolioStats] = useState<PortfolioStats | null>(null);
  const [strategyStats, setStrategyStats] = useState<Record<string, StrategyStats>>({});
  const [, setIsCalculating] = useState(false);
  const [filteredTrades, setFilteredTrades] = useState<Trade[]>([]);
  const [peakDailyExposurePercent, setPeakDailyExposurePercent] = useState<{
    date: string;
    exposure: number;
    exposurePercent: number;
  } | null>(null);

  // Get active block from store
  const activeBlock = useBlockStore((state) => {
    const activeBlockId = state.activeBlockId;
    return activeBlockId ? state.blocks.find((block) => block.id === activeBlockId) : null;
  });
  const isLoading = useBlockStore((state) => state.isLoading);
  const isInitialized = useBlockStore((state) => state.isInitialized);
  const loadBlocks = useBlockStore((state) => state.loadBlocks);

  // Load blocks if not initialized
  useEffect(() => {
    if (!isInitialized) {
      loadBlocks().catch(console.error);
    }
  }, [isInitialized, loadBlocks]);

  useEffect(() => {
    if (!activeBlock?.id || typeof window === "undefined") return;

    const storageKey = `${NORMALIZE_STORAGE_KEY_PREFIX}${activeBlock.id}`;
    const stored = window.localStorage.getItem(storageKey);
    if (stored !== null) {
      setNormalizeTo1Lot(stored === "true");
    } else {
      setNormalizeTo1Lot(false);
    }
  }, [activeBlock?.id]);

  useEffect(() => {
    if (!activeBlock?.id || typeof window === "undefined") return;

    const storageKey = `${NORMALIZE_STORAGE_KEY_PREFIX}${activeBlock.id}`;
    window.localStorage.setItem(storageKey, normalizeTo1Lot ? "true" : "false");
  }, [activeBlock?.id, normalizeTo1Lot]);

  // Handle date range changes
  const handleDateRangeChange = (newDateRange: DateRange | undefined) => {
    setDateRange(newDateRange);
  };

  // Fetch trades and daily logs when active block changes
  // Uses cached performance snapshot for instant load when available
  useEffect(() => {
    if (!activeBlock) {
      setTrades([]);
      setDailyLogs([]);
      setFilteredTrades([]);
      setPortfolioStats(null);
      setStrategyStats({});
      setPeakDailyExposurePercent(null);
      setDataError(null);
      return;
    }

    const fetchData = async () => {
      // Clear previous block data to avoid showing stale charts while loading
      setTrades([]);
      setDailyLogs([]);
      setFilteredTrades([]);
      setPortfolioStats(null);
      setStrategyStats({});
      setPeakDailyExposurePercent(null);
      setIsLoadingData(true);
      setDataError(null);

      try {
        const processedBlock = await getBlock(activeBlock.id);
        const combineLegGroups = processedBlock?.analysisConfig?.combineLegGroups ?? false;

        // Check for cached snapshot first (for instant load with default settings)
        // Only use cache if we're using default settings (no filters, no normalization)
        const isDefaultView =
          selectedStrategies.length === 0 && !normalizeTo1Lot && !dateRange?.from && !dateRange?.to;

        if (isDefaultView) {
          const cachedSnapshot = await getPerformanceSnapshotCache(activeBlock.id);
          if (cachedSnapshot) {
            // Use cached data directly - much faster!
            setTrades(cachedSnapshot.filteredTrades);
            setDailyLogs(cachedSnapshot.filteredDailyLogs);
            setFilteredTrades(cachedSnapshot.filteredTrades);
            setPortfolioStats(cachedSnapshot.portfolioStats);
            setPeakDailyExposurePercent(cachedSnapshot.chartData.peakDailyExposurePercent);

            // Calculate strategy stats from cached trades
            const calculator = new PortfolioStatsCalculator();
            const strategies = calculator.calculateStrategyStats(cachedSnapshot.filteredTrades);
            setStrategyStats(strategies);

            setIsLoadingData(false);
            return;
          }
        }

        // Cache miss or filters applied - fetch data normally
        const [blockTrades, blockDailyLogs] = await Promise.all([
          getTradesByBlockWithOptions(activeBlock.id, { combineLegGroups }),
          getDailyLogsByBlock(activeBlock.id),
        ]);

        setTrades(blockTrades);
        setDailyLogs(blockDailyLogs);
      } catch (error) {
        console.error("Failed to fetch block data:", error);
        setDataError(error instanceof Error ? error.message : "Failed to fetch data");
      } finally {
        setIsLoadingData(false);
      }
    };

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBlock?.id]);

  // Calculate metrics when data or risk-free rate changes
  useEffect(() => {
    if (trades.length === 0) {
      setPortfolioStats(null);
      setStrategyStats({});
      setFilteredTrades([]);
      setPeakDailyExposurePercent(null);
      return;
    }

    const calculateMetrics = async () => {
      setIsCalculating(true);

      try {
        const hasFilters = selectedStrategies.length > 0 || dateRange?.from || dateRange?.to;

        const snapshot = await buildPerformanceSnapshot({
          trades,
          dailyLogs,
          filters: hasFilters
            ? {
                ...(selectedStrategies.length > 0 && {
                  strategies: selectedStrategies,
                }),
                ...((dateRange?.from || dateRange?.to) && {
                  dateRange: { from: dateRange?.from, to: dateRange?.to },
                }),
              }
            : undefined,
          normalizeTo1Lot,
        });

        setFilteredTrades(snapshot.filteredTrades);
        setPortfolioStats(snapshot.portfolioStats);
        setPeakDailyExposurePercent(snapshot.chartData.peakDailyExposurePercent);

        const calculator = new PortfolioStatsCalculator();
        const strategies = calculator.calculateStrategyStats(snapshot.filteredTrades);
        setStrategyStats(strategies);
      } catch (error) {
        console.error("Failed to calculate metrics:", error);
        setDataError(error instanceof Error ? error.message : "Failed to calculate metrics");
      } finally {
        setIsCalculating(false);
      }
    };

    // Use a small delay to avoid closing the popover during selection
    const timeoutId = setTimeout(calculateMetrics, 0);
    return () => clearTimeout(timeoutId);
  }, [trades, dailyLogs, selectedStrategies, normalizeTo1Lot, dateRange]);

  // Helper functions
  const getDateRange = () => {
    if (filteredTrades.length === 0) return "No trades";

    const sortedTrades = [...filteredTrades].sort(
      (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
    );

    const startDate = new Date(sortedTrades[0].dateOpened).toLocaleDateString();
    const endDate = new Date(sortedTrades[sortedTrades.length - 1].dateOpened).toLocaleDateString();

    return `${startDate} to ${endDate}`;
  };

  const getInitialCapital = () => {
    // Use the initial capital from portfolioStats which properly accounts for daily logs
    if (!portfolioStats) return 0;
    return portfolioStats.initialCapital;
  };

  const getAvgReturnOnMargin = () => {
    if (!portfolioStats) return 0;

    // Calculate average return on margin from filtered trades
    const tradesWithMargin = filteredTrades.filter(
      (trade) => trade.marginReq && trade.marginReq > 0,
    );
    if (tradesWithMargin.length === 0) return 0;

    const totalReturnOnMargin = tradesWithMargin.reduce((sum, trade) => {
      const rom = (trade.pl / trade.marginReq!) * 100;
      return sum + rom;
    }, 0);

    return totalReturnOnMargin / tradesWithMargin.length;
  };

  const getStdDevOfRoM = () => {
    if (!portfolioStats) return 0;

    const tradesWithMargin = filteredTrades.filter(
      (trade) => trade.marginReq && trade.marginReq > 0,
    );
    if (tradesWithMargin.length === 0) return 0;

    const avgRoM = getAvgReturnOnMargin();
    const roms = tradesWithMargin.map((trade) => (trade.pl / trade.marginReq!) * 100);

    const variance = roms.reduce((sum, rom) => sum + Math.pow(rom - avgRoM, 2), 0) / roms.length;
    return Math.sqrt(variance);
  };

  const getBestTrade = () => {
    if (!portfolioStats || filteredTrades.length === 0) return 0;

    const bestTrade = Math.max(
      ...filteredTrades.map((trade) => {
        if (!trade.marginReq || trade.marginReq <= 0) return 0;
        return (trade.pl / trade.marginReq) * 100;
      }),
    );

    return bestTrade;
  };

  const getWorstTrade = () => {
    if (!portfolioStats || filteredTrades.length === 0) return 0;

    const worstTrade = Math.min(
      ...filteredTrades.map((trade) => {
        if (!trade.marginReq || trade.marginReq <= 0) return 0;
        return (trade.pl / trade.marginReq) * 100;
      }),
    );

    return worstTrade;
  };

  const getCommissionShareOfPremium = () => {
    if (filteredTrades.length === 0) return 0;

    const totals = filteredTrades.reduce(
      (acc, trade) => {
        const totalPremium = computeTotalPremium(trade) ?? 0;
        const commissions =
          (trade.openingCommissionsFees ?? 0) + (trade.closingCommissionsFees ?? 0);

        return {
          premium: acc.premium + totalPremium,
          commissions: acc.commissions + commissions,
        };
      },
      { premium: 0, commissions: 0 },
    );

    if (totals.premium === 0) return 0;

    return (totals.commissions / totals.premium) * 100;
  };

  const getAvgPremiumEfficiency = () => {
    if (filteredTrades.length === 0) return 0;

    const efficiencies = filteredTrades
      .map((trade) => calculatePremiumEfficiencyPercent(trade).percentage)
      .filter((value): value is number => typeof value === "number" && isFinite(value));

    if (efficiencies.length === 0) return 0;

    const total = efficiencies.reduce((sum, value) => sum + value, 0);
    return total / efficiencies.length;
  };

  const getAvgHoldingPeriodHours = () => {
    const tradesWithClose = filteredTrades.filter((trade) => trade.dateClosed);

    if (tradesWithClose.length === 0) return 0;

    const totalHours = tradesWithClose.reduce((sum, trade) => {
      const openDate = new Date(trade.dateOpened);
      const closeDate = trade.dateClosed ? new Date(trade.dateClosed) : openDate;
      if (isNaN(openDate.getTime()) || isNaN(closeDate.getTime())) {
        return sum;
      }
      const hours = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60);
      return sum + Math.max(0, hours);
    }, 0);

    return totalHours / tradesWithClose.length;
  };

  const getAvgContracts = () => {
    if (filteredTrades.length === 0) return 0;

    const totalContracts = filteredTrades.reduce(
      (sum, trade) => sum + (trade.numContracts ?? 0),
      0,
    );
    return totalContracts / filteredTrades.length;
  };

  const commissionShare = getCommissionShareOfPremium();
  const avgPremiumEfficiency = getAvgPremiumEfficiency();
  const avgHoldingHours = Number(getAvgHoldingPeriodHours().toFixed(1));
  const avgContracts = Number(getAvgContracts().toFixed(2));

  const getStrategyOptions = () => {
    if (trades.length === 0) return [];

    const uniqueStrategies = [...new Set(trades.map((trade) => trade.strategy || "Unknown"))];
    return uniqueStrategies.map((strategy) => ({
      label: strategy,
      value: strategy,
    }));
  };

  // Export functions
  const buildExportData = () => {
    if (!portfolioStats || !activeBlock) return null;

    return {
      exportedAt: new Date().toISOString(),
      block: {
        id: activeBlock.id,
        name: activeBlock.name,
      },
      filters: {
        dateRange:
          dateRange?.from || dateRange?.to
            ? {
                from: dateRange?.from?.toISOString(),
                to: dateRange?.to?.toISOString(),
              }
            : "all",
        selectedStrategies: selectedStrategies.length > 0 ? selectedStrategies : "all",
        normalizeTo1Lot,
      },
      tradeDateRange: getDateRange(),
      portfolioStats: {
        totalTrades: portfolioStats.totalTrades,
        totalPl: portfolioStats.totalPl,
        netPl: portfolioStats.netPl,
        winningTrades: portfolioStats.winningTrades,
        losingTrades: portfolioStats.losingTrades,
        breakEvenTrades: portfolioStats.breakEvenTrades,
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
        avgDailyPl: portfolioStats.avgDailyPl,
        totalCommissions: portfolioStats.totalCommissions,
        kellyPercentage: portfolioStats.kellyPercentage,
        maxWinStreak: portfolioStats.maxWinStreak,
        maxLossStreak: portfolioStats.maxLossStreak,
        monthlyWinRate: portfolioStats.monthlyWinRate,
        weeklyWinRate: portfolioStats.weeklyWinRate,
      },
      derivedMetrics: {
        avgReturnOnMargin: getAvgReturnOnMargin(),
        stdDevOfRoM: getStdDevOfRoM(),
        bestTradeRoM: getBestTrade(),
        worstTradeRoM: getWorstTrade(),
        commissionVsPremium: commissionShare,
        avgPremiumCapture: avgPremiumEfficiency,
        avgHoldingHours: avgHoldingHours,
        avgContracts: avgContracts,
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
    };
  };

  const exportAsJson = () => {
    const data = buildExportData();
    if (!data || !activeBlock) return;

    downloadJson(data, generateExportFilename(activeBlock.name, "block-stats", "json"));
  };

  const exportAsCsv = () => {
    if (!portfolioStats || !activeBlock) return;

    const lines: string[] = [];

    // Metadata section
    lines.push("# Block Stats Export");
    lines.push(toCsvRow(["Block", activeBlock.name]));
    lines.push(toCsvRow(["Exported At", new Date().toISOString()]));
    lines.push(toCsvRow(["Trade Date Range", getDateRange()]));
    lines.push(
      toCsvRow([
        "Date Range Filter",
        dateRange?.from || dateRange?.to
          ? `${dateRange?.from ? format(dateRange.from, "LLL dd, y") : "Start"} - ${dateRange?.to ? format(dateRange.to, "LLL dd, y") : "End"}`
          : "All time",
      ]),
    );
    lines.push(toCsvRow(["Normalize to 1-Lot", normalizeTo1Lot]));
    lines.push(
      toCsvRow([
        "Selected Strategies",
        selectedStrategies.length > 0 ? selectedStrategies.join("; ") : "All",
      ]),
    );
    lines.push("");

    // Portfolio Stats section
    lines.push("# Portfolio Statistics");
    lines.push("Metric,Value");
    lines.push(toCsvRow(["Total Trades", portfolioStats.totalTrades]));
    lines.push(toCsvRow(["Total P/L", `$${portfolioStats.totalPl.toFixed(2)}`]));
    lines.push(toCsvRow(["Net P/L", `$${portfolioStats.netPl.toFixed(2)}`]));
    lines.push(toCsvRow(["Win Rate", `${(portfolioStats.winRate * 100).toFixed(2)}%`]));
    lines.push(toCsvRow(["Profit Factor", portfolioStats.profitFactor.toFixed(2)]));
    lines.push(toCsvRow(["Initial Capital", `$${portfolioStats.initialCapital.toFixed(2)}`]));
    lines.push(toCsvRow(["CAGR", `${(portfolioStats.cagr || 0).toFixed(2)}%`]));
    lines.push(toCsvRow(["Sharpe Ratio", (portfolioStats.sharpeRatio || 0).toFixed(2)]));
    lines.push(toCsvRow(["Sortino Ratio", (portfolioStats.sortinoRatio || 0).toFixed(2)]));
    lines.push(toCsvRow(["Calmar Ratio", (portfolioStats.calmarRatio || 0).toFixed(2)]));
    lines.push(toCsvRow(["Max Drawdown", `${portfolioStats.maxDrawdown.toFixed(2)}%`]));
    lines.push(
      toCsvRow(["Time in Drawdown", `${(portfolioStats.timeInDrawdown || 0).toFixed(2)}%`]),
    );
    lines.push(toCsvRow(["Kelly %", `${(portfolioStats.kellyPercentage || 0).toFixed(2)}%`]));
    lines.push(toCsvRow(["Max Win Streak", portfolioStats.maxWinStreak || 0]));
    lines.push(toCsvRow(["Max Loss Streak", portfolioStats.maxLossStreak || 0]));
    lines.push(
      toCsvRow(["Monthly Win Rate", `${(portfolioStats.monthlyWinRate || 0).toFixed(2)}%`]),
    );
    lines.push(toCsvRow(["Weekly Win Rate", `${(portfolioStats.weeklyWinRate || 0).toFixed(2)}%`]));
    lines.push(toCsvRow(["Avg Return on Margin", `${getAvgReturnOnMargin().toFixed(2)}%`]));
    lines.push(toCsvRow(["Commission vs Premium", `${commissionShare.toFixed(2)}%`]));
    lines.push(toCsvRow(["Avg Premium Capture", `${avgPremiumEfficiency.toFixed(2)}%`]));
    lines.push(toCsvRow(["Avg Holding (hrs)", avgHoldingHours]));
    lines.push("");

    // Strategy Breakdown section
    lines.push("# Strategy Breakdown");
    lines.push("Strategy,Trades,Total P/L,Win Rate,Avg Win,Avg Loss,Profit Factor");
    Object.values(strategyStats).forEach((stat) => {
      lines.push(
        toCsvRow([
          stat.strategyName,
          stat.tradeCount,
          `$${stat.totalPl.toFixed(2)}`,
          `${(stat.winRate * 100).toFixed(2)}%`,
          `$${stat.avgWin.toFixed(2)}`,
          `$${stat.avgLoss.toFixed(2)}`,
          stat.profitFactor.toFixed(2),
        ]),
      );
    });

    downloadCsv(lines, generateExportFilename(activeBlock.name, "block-stats", "csv"));
  };

  // Show loading state
  if (!isInitialized || isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading blocks...</p>
        </div>
      </div>
    );
  }

  // Show message if no active block
  if (!activeBlock) {
    return (
      <NoActiveBlock description="Please select a block from the sidebar to view its statistics." />
    );
  }

  // Show loading state for data
  if (isLoadingData) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading {activeBlock.name} data...</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (dataError) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center max-w-md">
          <AlertTriangle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error Loading Data</h3>
          <p className="text-muted-foreground mb-4">{dataError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label>Date Range</Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-[280px] justify-start text-left font-normal",
                  !dateRange && "text-muted-foreground",
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {dateRange?.from ? (
                  dateRange.to ? (
                    <>
                      {format(dateRange.from, "LLL dd, y")} - {format(dateRange.to, "LLL dd, y")}
                    </>
                  ) : (
                    format(dateRange.from, "LLL dd, y")
                  )
                ) : (
                  <span>All time</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <DateRangePicker date={dateRange} onDateChange={handleDateRangeChange} />
            </PopoverContent>
          </Popover>
        </div>
        <div className="space-y-2 flex-1 min-w-[250px]">
          <Label>Strategies</Label>
          <MultiSelect
            options={getStrategyOptions()}
            onValueChange={setSelectedStrategies}
            defaultValue={selectedStrategies}
            placeholder="All strategies"
            maxCount={3}
            className="w-full"
          />
        </div>
        <SizingModeToggle
          id="block-stats-normalize"
          className="flex-1 min-w-[240px]"
          checked={normalizeTo1Lot}
          onCheckedChange={setNormalizeTo1Lot}
          title="Normalize to 1-lot"
        />
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={exportAsCsv} disabled={!portfolioStats}>
            <Download className="mr-2 h-4 w-4" />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={exportAsJson} disabled={!portfolioStats}>
            <Download className="mr-2 h-4 w-4" />
            JSON
          </Button>
        </div>
      </div>

      {/* Basic Overview */}
      <MetricSection
        title="Basic Overview"
        icon={<BarChart3 className="w-4 h-4" />}
        badge={
          <Badge variant="outline" className="text-xs">
            <Calendar className="w-3 h-3 mr-1" />
            {getDateRange()}
          </Badge>
        }
        gridCols={3}
      >
        <MetricCard
          title="Number of Trades"
          value={portfolioStats?.totalTrades || 0}
          format="number"
          tooltip={{
            flavor: "Building blocks completed - the total foundation you've laid so far.",
            detailed:
              "Total number of trades executed. More trades provide more data for analysis but don't necessarily mean better performance. This number helps contextualize other statistics - win rates from 10 trades are less reliable than from 100 trades.",
          }}
        />
        <MetricCard
          title="Starting Capital"
          value={getInitialCapital()}
          format="currency"
          tooltip={{
            flavor: "Foundation funds - the base capital you started building with.",
            detailed:
              "The initial account value when trading began. This serves as the baseline for calculating percentage returns and total growth. Essential for understanding the scale of gains and losses relative to your original investment.",
          }}
        />
        <MetricCard
          title="Avg Return on Margin"
          value={getAvgReturnOnMargin()}
          format="percentage"
          isPositive={getAvgReturnOnMargin() > 0}
          tooltip={{
            flavor:
              "Building efficiency - how much structure each margin block creates on average.",
            detailed:
              "Average return relative to margin required per trade. This is crucial for margin-based strategies like options trading. Higher values indicate more efficient use of buying power. Values vary significantly by strategy type and market conditions.",
          }}
        />
        <MetricCard
          title="Std Dev of RoM"
          value={getStdDevOfRoM()}
          format="percentage"
          tooltip={{
            flavor:
              "Construction consistency - how much your building efficiency varies between projects.",
            detailed:
              "Standard deviation of Return on Margin shows the variability in your capital efficiency. Lower values indicate more consistent performance, while higher values suggest more volatile results. Helps assess the reliability of your average returns.",
          }}
        />
        <MetricCard
          title="Best Trade"
          value={getBestTrade()}
          format="percentage"
          isPositive={getBestTrade() > 0}
          tooltip={{
            flavor: "Biggest building block - your most successful construction project to date.",
            detailed:
              "The highest return on margin achieved in a single trade. This represents your best-case scenario and shows the upside potential of your strategy. Extremely large best trades might indicate either great skill or significant risk-taking.",
          }}
        />
        <MetricCard
          title="Worst Trade"
          value={getWorstTrade()}
          format="percentage"
          isPositive={getWorstTrade() > 0}
          tooltip={{
            flavor: "Biggest tumble - when your construction project needed the most rebuilding.",
            detailed:
              "The largest loss on margin for a single trade. This represents your worst-case scenario and indicates the downside risk of your strategy. Understanding this helps assess whether your risk management aligns with your tolerance for losses.",
          }}
        />
      </MetricSection>

      {/* Return Metrics */}
      <MetricSection
        title="Return Metrics"
        icon={<TrendingUp className="w-4 h-4" />}
        badge="POSITION-SIZE DEPENDENT"
        badgeVariant="secondary"
        gridCols={5}
      >
        <MetricCard
          title="Total P/L"
          value={portfolioStats?.totalPl || 0}
          format="currency"
          isPositive={(portfolioStats?.totalPl || 0) > 0}
          size="lg"
          tooltip={{
            flavor:
              "Net construction value - total profit or loss from all your building projects.",
            detailed:
              "Sum of all trade profits and losses. This is the absolute dollar amount gained or lost from trading activities. While important, it should be considered alongside the capital required to generate these returns.",
          }}
        />
        <MetricCard
          title="CAGR"
          value={portfolioStats?.cagr || 0}
          format="percentage"
          isPositive={(portfolioStats?.cagr || 0) > 0}
          tooltip={{
            flavor: "Annual building rate - how fast your foundation grows each year.",
            detailed:
              "Compound Annual Growth Rate normalizes returns over time, showing the equivalent annual growth rate. This allows comparison across different time periods and strategies. Higher CAGR indicates faster wealth building, but consider it alongside risk metrics.",
          }}
        />
        <MetricCard
          title="Avg RoM"
          value={getAvgReturnOnMargin()}
          format="percentage"
          isPositive={getAvgReturnOnMargin() > 0}
          tooltip={{
            flavor: "Standard building efficiency - typical value created per margin block.",
            detailed:
              "Average Return on Margin across all trades. This metric is especially relevant for options and other margin-based strategies, showing how effectively you use borrowed buying power. Compare this to risk-free rates for context.",
          }}
        />
        <MetricCard
          title="Win Rate"
          value={(portfolioStats?.winRate || 0) * 100}
          format="percentage"
          isPositive={(portfolioStats?.winRate || 0) > 0.5}
          tooltip={{
            flavor: "Building success rate - percentage of projects that added value.",
            detailed:
              "Percentage of trades that were profitable. While higher win rates seem better, they don't tell the whole story. A strategy with 40% win rate but large winners can outperform a 80% win rate strategy with small winners.",
          }}
        />
        <MetricCard
          title="Loss Rate"
          value={(1 - (portfolioStats?.winRate || 0)) * 100}
          format="percentage"
          isPositive={false}
          tooltip={{
            flavor: "Rebuilding frequency - percentage of projects that required reconstruction.",
            detailed:
              "Percentage of trades that resulted in losses. This is simply the inverse of win rate. Understanding your loss frequency helps set expectations and plan for the psychological impact of inevitable losing trades.",
          }}
        />
      </MetricSection>

      {/* Risk & Drawdown */}
      <MetricSection
        title="Risk & Drawdown"
        icon={<AlertTriangle className="w-4 h-4" />}
        badge="POSITION-SIZE DEPENDENT"
        badgeVariant="secondary"
        gridCols={6}
      >
        <MetricCard
          title="Max Drawdown"
          value={portfolioStats?.maxDrawdown || 0}
          format="percentage"
          isPositive={false}
          tooltip={{
            flavor: "Biggest foundation crack - the deepest your structure has sunk.",
            detailed:
              "Maximum percentage decline from a peak to subsequent trough. This represents your worst-case scenario and is crucial for understanding the downside risk of your strategy. Most traders find drawdowns over 20-30% psychologically challenging.",
          }}
        />
        <MetricCard
          title="Peak Exposure"
          value={peakDailyExposurePercent?.exposurePercent || 0}
          format="percentage"
          subtitle={
            peakDailyExposurePercent
              ? `$${peakDailyExposurePercent.exposure.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
              : undefined
          }
          tooltip={{
            flavor: "Maximum daily risk - the most capital at risk on any single day.",
            detailed:
              "Peak daily exposure shows the highest sum of margin requirements across all open positions on any single day. This represents your maximum concurrent risk and helps assess position sizing discipline. High exposure relative to account size indicates aggressive positioning.",
          }}
        />
        <MetricCard
          title="Time in DD"
          value={portfolioStats?.timeInDrawdown || 0}
          format="percentage"
          tooltip={{
            flavor: "Rebuilding time - percentage of time spent repairing foundation damage.",
            detailed:
              "Percentage of time the account was below previous peak values. Long periods in drawdown can be psychologically taxing and may indicate recovery issues. Strategies with quick recovery tend to be more sustainable.",
          }}
        />
        <MetricCard
          title="Sharpe Ratio"
          value={portfolioStats?.sharpeRatio || 0}
          format="ratio"
          isPositive={(portfolioStats?.sharpeRatio || 0) > 0}
          tooltip={{
            flavor:
              "Risk-adjusted building score - how much extra return per unit of construction risk.",
            detailed:
              "Measures excess return per unit of volatility. Values above 1.0 are considered good, above 2.0 excellent. This helps compare strategies with different risk profiles by normalizing returns for the volatility experienced.",
          }}
        />
        <MetricCard
          title="Sortino Ratio"
          value={portfolioStats?.sortinoRatio || 0}
          format="ratio"
          isPositive={(portfolioStats?.sortinoRatio || 0) > 0}
          tooltip={{
            flavor:
              "Downside-focused building score - return efficiency when accounting only for foundation damage.",
            detailed:
              "Similar to Sharpe ratio but only considers downside volatility, ignoring upside volatility. This provides a more accurate risk assessment since investors typically don't mind positive volatility. Higher values indicate better downside risk management.",
          }}
        />
        <MetricCard
          title="Calmar Ratio"
          value={portfolioStats?.calmarRatio || 0}
          format="ratio"
          isPositive={(portfolioStats?.calmarRatio || 0) > 0}
          tooltip={{
            flavor: "Recovery building rate - annual growth compared to worst foundation damage.",
            detailed:
              "CAGR divided by maximum drawdown. This shows how much annual return you're getting relative to the worst decline experienced. Higher values indicate strategies that generate good returns without severe drawdowns.",
          }}
        />
      </MetricSection>

      {/* Consistency Metrics */}
      <MetricSection
        title="Consistency Metrics"
        icon={<Target className="w-4 h-4" />}
        badge="POSITION-SIZE INDEPENDENT"
        badgeVariant="outline"
        gridCols={5}
      >
        <MetricCard
          title="Win Streak"
          value={portfolioStats?.maxWinStreak || 0}
          format="number"
          isPositive={true}
          tooltip={{
            flavor: "Longest building run - most consecutive successful projects completed.",
            detailed:
              "Maximum number of consecutive winning trades. Long win streaks can indicate good strategy alignment with market conditions, but they can also lead to overconfidence. Understanding your typical streak length helps with psychological preparation.",
          }}
        />
        <MetricCard
          title="Loss Streak"
          value={portfolioStats?.maxLossStreak || 0}
          format="number"
          isPositive={false}
          tooltip={{
            flavor: "Longest rebuilding period - most consecutive projects that needed repairs.",
            detailed:
              "Maximum number of consecutive losing trades. Everyone experiences losing streaks, and knowing your worst helps with risk management and position sizing. Extended loss streaks might indicate strategy issues or unfavorable market conditions.",
          }}
        />
        <MetricCard
          title="Monthly WR"
          value={portfolioStats?.monthlyWinRate || 0}
          format="percentage"
          isPositive={(portfolioStats?.monthlyWinRate || 0) > 50}
          tooltip={{
            flavor:
              "Monthly building success - percentage of months that added to your foundation.",
            detailed:
              "Percentage of months that were profitable. Monthly win rate provides insight into consistency over longer time periods. Higher monthly win rates indicate more predictable income generation and smoother equity curves.",
          }}
        />
        <MetricCard
          title="Weekly WR"
          value={portfolioStats?.weeklyWinRate || 0}
          format="percentage"
          isPositive={(portfolioStats?.weeklyWinRate || 0) > 50}
          tooltip={{
            flavor:
              "Weekly building success - percentage of weeks that strengthened your structure.",
            detailed:
              "Percentage of weeks that were profitable. Weekly win rate shows shorter-term consistency and can help identify if your strategy works better in certain market conditions or time frames. Useful for weekly review cycles.",
          }}
        />
        <MetricCard
          title="Kelly %"
          value={portfolioStats?.kellyPercentage || 0}
          format="percentage"
          isPositive={(portfolioStats?.kellyPercentage || 0) > 0}
          tooltip={{
            flavor:
              "Optimal foundation size - theoretical best percentage of capital per building project.",
            detailed:
              "Kelly Criterion suggests the optimal position size based on your win rate and average win/loss sizes. Positive values suggest profitable strategies, while negative values indicate unprofitable ones. Most traders use a fraction of Kelly due to its aggressive nature.",
          }}
        />
      </MetricSection>

      {/* Execution Efficiency */}
      <MetricSection
        title="Execution Efficiency"
        icon={<Gauge className="w-4 h-4" />}
        badge="TRADE-LEVEL INSIGHTS"
        badgeVariant="outline"
        gridCols={4}
      >
        <MetricCard
          title="Commission vs Premium"
          value={commissionShare}
          format="percentage"
          isPositive={commissionShare < 20}
          tooltip={{
            flavor: "Fee drag relative to the premium collected.",
            detailed:
              "Tracks how much of the collected option premium gets consumed by commissions and fees. High values suggest scaling, broker, or strategy adjustments to regain edge.",
          }}
        />
        <MetricCard
          title="Avg Premium Capture"
          value={avgPremiumEfficiency}
          format="percentage"
          isPositive={avgPremiumEfficiency > 0}
          tooltip={{
            flavor: "Realized edge compared to max profit or collected credit.",
            detailed:
              "Measures how efficiently trades harvest their theoretical upside. Values near 100% show excellent execution, while negative values signal leaving gains on the table or overpaying to exit.",
          }}
        />
        <MetricCard
          title="Avg Holding (hrs)"
          value={avgHoldingHours}
          format="number"
          tooltip={{
            flavor: "Typical time capital stays tied up.",
            detailed:
              "Average hours from entry to close. Helps align expectations, monitor for drift in playbook cadence, and coordinate with capital allocation plans.",
          }}
        />
        <MetricCard
          title="Avg Contracts"
          value={avgContracts}
          format="number"
          tooltip={{
            flavor: "Standard position size deployed per trade.",
            detailed:
              "Average contract count gives quick feedback on sizing discipline and how it scales across wins and losses.",
          }}
        />
      </MetricSection>

      {/* Strategy Breakdown */}
      <StrategyBreakdownTable
        data={Object.values(strategyStats).map((stat) => ({
          strategy: stat.strategyName,
          trades: stat.tradeCount,
          totalPL: stat.totalPl,
          winRate: stat.winRate * 100, // Convert to percentage
          avgWin: stat.avgWin,
          avgLoss: stat.avgLoss,
          profitFactor: stat.profitFactor,
        }))}
      />
    </div>
  );
}
