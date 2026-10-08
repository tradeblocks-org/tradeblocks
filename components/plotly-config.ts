import type { Config } from "plotly.js";

// Preserve local-only charts and the pre-v4 double-click window at every render site.
export const plotlyBaseConfig: Partial<Config> = {
  responsive: true,
  displayModeBar: true,
  displaylogo: false,
  doubleClickDelay: 300,
  modeBarButtonsToRemove: ["sendChartToCloud"],
};
