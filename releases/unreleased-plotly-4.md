# Unreleased — Plotly 4

**Dependency upgrade, no interface change.** The web app's charts move from `plotly.js` 3.7 to 4.1.1. Charts show the same data with the same interactions:

- Overlay axes keep their own automatic ticks; Plotly 4 now syncs them to the base axis by default.
- Two clicks within 300 ms still count as a double-click, which resets the zoom; Plotly 4's default window is 500 ms.
- Plotly 4 adds a cloud-upload button to the chart toolbar by default. It stays hidden: charts and trading data never leave the browser.
- Plotly 4 removed its Chart Studio link option, `showLink`. It was already off here.

The shared `components/plotly-config.ts` defaults apply both through ChartWrapper and to direct Plotly renders in risk simulation and position sizing.

`@types/react-plotly.js` is removed; `plotly.js` 4 and `react-plotly.js` ship their own types. The MCP server and the library exports are unchanged.
