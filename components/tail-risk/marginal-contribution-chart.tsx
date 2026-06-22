"use client";

import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { TailRiskAnalysisResult } from "@tradeblocks/lib";
import { truncateStrategyName } from "@tradeblocks/lib";
import { useTheme } from "next-themes";
import type { Data, Layout } from "plotly.js";
import { useMemo } from "react";

interface MarginalContributionChartProps {
  result: TailRiskAnalysisResult;
}

export function MarginalContributionChart({ result }: MarginalContributionChartProps) {
  const { theme } = useTheme();

  const { plotData, layout } = useMemo(() => {
    const { marginalContributions } = result;
    const isDark = theme === "dark";

    // Already sorted by contribution descending
    const topContributors = marginalContributions.slice(0, 15);

    const truncatedNames = topContributors.map((c) => truncateStrategyName(c.strategy, 35));

    // Color gradient based on contribution
    const maxContribution = Math.max(...topContributors.map((c) => c.tailRiskContribution));
    const colors = topContributors.map((c) => {
      const intensity = c.tailRiskContribution / maxContribution;
      if (isDark) {
        // Dark mode: orange to red gradient
        const r = Math.round(249 + (220 - 249) * intensity);
        const g = Math.round(115 - 115 * intensity);
        const b = Math.round(22 + (38 - 22) * intensity);
        return `rgb(${r}, ${g}, ${b})`;
      } else {
        // Light mode: yellow to red gradient
        const r = Math.round(253 - (253 - 185) * intensity);
        const g = Math.round(224 - 224 * intensity);
        const b = Math.round(71 - 43 * intensity);
        return `rgb(${r}, ${g}, ${b})`;
      }
    });

    const barTrace: Partial<Data> = {
      y: truncatedNames.reverse(), // Reverse for top-to-bottom display
      x: topContributors.map((c) => c.tailRiskContribution).reverse(),
      type: "bar",
      orientation: "h",
      marker: {
        color: colors.reverse(),
      },
      customdata: topContributors
        .map((c) => [c.strategy, c.concentrationScore * 100, c.avgTailDependence])
        .reverse(),
      hovertemplate:
        "<b>%{customdata[0]}</b><br>" +
        "Tail Risk Contribution: %{x:.1f}%<br>" +
        "Concentration Score: %{customdata[1]:.1f}%<br>" +
        "Avg Tail Dependence: %{customdata[2]:.2f}<extra></extra>",
    };

    const plotLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Tail Risk Contribution (%)" },
        range: [0, Math.max(maxContribution * 1.1, 10)],
      },
      yaxis: {
        automargin: true,
        tickfont: { size: 11 },
      },
      margin: {
        l: 200,
        r: 40,
        t: 40,
        b: 60,
      },
    };

    return {
      plotData: [barTrace as Data],
      layout: plotLayout,
    };
  }, [result, theme]);

  return (
    <ChartWrapper
      title="Marginal Contribution to Tail Risk"
      description="Which strategies contribute most to portfolio tail risk"
      tooltip={{
        flavor: "Shows how much each strategy contributes to portfolio-wide tail risk.",
        detailed:
          "Strategies with higher contribution scores are more aligned with the dominant sources of portfolio tail risk. This combines (1) how much the strategy loads on the first principal factor and (2) its average tail dependence with other strategies. Removing high-contribution strategies would most reduce portfolio tail risk.",
      }}
      data={plotData}
      layout={layout}
      style={{ height: "500px" }}
    />
  );
}
