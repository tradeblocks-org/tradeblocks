# Dataset analysis baselines and metadata

- Field-based `suggest_filters` now names its covered comparison population in `fieldBaselines`, with covered count/P&L and uncovered count/P&L. All-trade `currentStats` is unchanged. `filter_curve.baseline` exposes the same uncovered population, so the tools' baselines can be compared directly.
- Import, list and analysis catalogs display `knownBy: null` on close columns. Open columns retain the dataset's configured value; matching is unchanged.
- The MCP reference and README show host-to-container dataset CSV paths for Docker. Data-root containment is unchanged.
