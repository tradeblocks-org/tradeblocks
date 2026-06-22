"use client";

import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { TailRiskAnalysisResult } from "@tradeblocks/lib";
import { truncateStrategyName } from "@tradeblocks/lib";
import { useTheme } from "next-themes";
import type { Data, Layout } from "plotly.js";
import { useMemo } from "react";

interface TailDependenceHeatmapProps {
  result: TailRiskAnalysisResult;
  actions?: React.ReactNode;
}

export function TailDependenceHeatmap({ result, actions }: TailDependenceHeatmapProps) {
  const { theme } = useTheme();

  const { plotData, layout } = useMemo(() => {
    const { strategies, jointTailRiskMatrix } = result;
    const isDark = theme === "dark";

    // Truncate strategy names for axis labels
    const truncatedStrategies = strategies.map((s) => truncateStrategyName(s, 40));

    // Symmetrize the matrix for display (average of both directions)
    // NaN values indicate insufficient data for that pair
    const symmetricMatrix = jointTailRiskMatrix.map((row, i) =>
      row.map((val, j) => {
        if (i === j) return 1.0;
        const valIJ = jointTailRiskMatrix[i][j];
        const valJI = jointTailRiskMatrix[j][i];
        // If either direction has insufficient data, mark the pair as NaN
        if (Number.isNaN(valIJ) || Number.isNaN(valJI)) return NaN;
        return (valIJ + valJI) / 2;
      }),
    );

    // Color scale: 0 (low joint tail risk) to 1 (high joint tail risk)
    // Using a different scale than correlation since values are always positive
    const colorscale = isDark
      ? [
          [0, "#1e3a5f"], // Dark blue for low dependence
          [0.25, "#2563eb"], // Blue
          [0.5, "#fbbf24"], // Yellow/amber for medium
          [0.75, "#f97316"], // Orange
          [1, "#dc2626"], // Red for high dependence
        ]
      : [
          [0, "#dbeafe"], // Light blue for low dependence
          [0.25, "#60a5fa"], // Blue
          [0.5, "#fde68a"], // Yellow for medium
          [0.75, "#fb923c"], // Orange
          [1, "#b91c1c"], // Dark red for high dependence
        ];

    // For display, replace NaN with null so Plotly shows empty cells
    // and prepare text labels
    const displayMatrix = symmetricMatrix.map((row) =>
      row.map((val) => (Number.isNaN(val) ? null : val)),
    );

    const textLabels = symmetricMatrix.map((row) =>
      row.map((val) => (Number.isNaN(val) ? "N/A" : `${Math.round(val * 100)}%`)),
    );

    const textColors = symmetricMatrix.map((row) =>
      row.map((val) => {
        if (Number.isNaN(val)) {
          // Grey text for N/A cells
          return isDark ? "#6b7280" : "#9ca3af";
        }
        // Dynamic text color based on value and theme
        if (isDark) {
          return val > 0.5 ? "#ffffff" : "#e2e8f0";
        } else {
          return val > 0.6 ? "#ffffff" : "#000000";
        }
      }),
    );

    const heatmapData = {
      z: displayMatrix,
      x: truncatedStrategies,
      y: truncatedStrategies,
      type: "heatmap" as const,
      colorscale,
      zmin: 0,
      zmax: 1,
      text: textLabels as unknown as string,
      texttemplate: "%{text}",
      textfont: {
        size: 10,
        color: textColors as unknown as string,
      },
      // Use full strategy names in hover tooltip
      // Note: cells with null z-values (N/A) won't show hover, so single template works
      hovertemplate:
        "<b>%{customdata[0]} ↔ %{customdata[1]}</b><br>Joint Tail Risk: %{customdata[2]}<extra></extra>",
      customdata: symmetricMatrix.map((row, yIndex) =>
        row.map((val, xIndex) => [
          strategies[yIndex],
          strategies[xIndex],
          Number.isNaN(val) ? "N/A" : `${(val * 100).toFixed(1)}%`,
        ]),
      ),
      colorbar: {
        title: { text: "Joint Risk", side: "right" as const },
        tickmode: "array" as const,
        tickvals: [0, 0.25, 0.5, 0.75, 1],
        ticktext: ["0%", "25%", "50%", "75%", "100%"],
      },
    };

    const heatmapLayout: Partial<Layout> = {
      xaxis: {
        side: "bottom",
        tickangle: -45,
        tickmode: "linear",
        automargin: true,
      },
      yaxis: {
        autorange: "reversed",
        tickmode: "linear",
        automargin: true,
      },
      margin: {
        l: 200,
        r: 100,
        t: 40,
        b: 200,
      },
    };

    return {
      plotData: [heatmapData as unknown as Data],
      layout: heatmapLayout,
    };
  }, [result, theme]);

  return (
    <ChartWrapper
      title="Joint Tail Risk Heatmap"
      description="How likely strategies are to have extreme losses together"
      tooltip={{
        flavor:
          "Shows the probability that one strategy is in its worst days when another strategy is also having its worst days.",
        detailed:
          "Unlike regular correlation which measures average co-movement, joint tail risk specifically captures extreme co-movement. A value of 0.7 means when Strategy A has a bad day (bottom 10%), there's a 70% chance Strategy B is also having a bad day. High joint tail risk (red) indicates strategies that blow up together on market stress days, even if their day-to-day correlation appears low.",
      }}
      data={plotData}
      layout={layout}
      style={{ height: "600px" }}
      actions={actions}
    />
  );
}
