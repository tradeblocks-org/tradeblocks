"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@tradeblocks/lib";
import { HelpCircle } from "lucide-react";
import { useTheme } from "next-themes";
import type { Config, Data, Layout, PlotlyHTMLElement } from "plotly.js";
import React, { Suspense, useCallback, useEffect, useRef } from "react";

declare global {
  interface Window {
    Plotly?: typeof import("plotly.js");
  }
}

// Dynamic import to optimize bundle size
const Plot = React.lazy(() => import("react-plotly.js"));

interface TooltipContent {
  flavor: string;
  detailed: string;
}

interface ChartWrapperProps {
  title: string;
  description?: string;
  tooltip?: TooltipContent;
  className?: string;
  actions?: React.ReactNode;
  headerAddon?: React.ReactNode;
  contentOverlay?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode; // deprecated; retained for backward compatibility
  data: Data[];
  layout: Partial<Layout>;
  config?: Partial<Config>;
  onInitialized?: (figure: unknown) => void;
  onUpdate?: (figure: unknown) => void;
  style?: React.CSSProperties;
}

const ChartSkeleton = () => (
  <div className="space-y-3">
    <div className="space-y-2">
      <Skeleton className="h-4 w-[200px]" />
      <Skeleton className="h-3 w-[300px]" />
    </div>
    <Skeleton className="h-[300px] w-full" />
  </div>
);

export function ChartWrapper({
  title,
  description,
  tooltip,
  actions,
  headerAddon,
  contentOverlay,
  footer,
  children,
  className,
  data,
  layout,
  config,
  onInitialized,
  onUpdate,
  style,
}: ChartWrapperProps) {
  const { theme } = useTheme();
  const plotRef = useRef<HTMLDivElement>(null);
  const graphDivRef = useRef<PlotlyHTMLElement | null>(null);
  const chartId = `chart-${title
    .toLowerCase()
    .replace(/\s+/g, "-")}-${Math.random().toString(36).substring(2, 11)}`;

  const triggerResize = useCallback(() => {
    const div = graphDivRef.current;
    if (
      typeof window === "undefined" ||
      !window.Plotly ||
      !div ||
      !div.isConnected ||
      // offsetParent will be null when hidden (e.g., inactive tab or collapsed)
      div.offsetParent === null
    ) {
      return;
    }

    try {
      // Plotly.resize may return void or a promise depending on version; we safely ignore the return.
      void window.Plotly.Plots.resize(div);
    } catch (error) {
      console.warn("Failed to resize chart:", error);
    }
  }, []);

  const mergedStyle = React.useMemo<React.CSSProperties>(() => {
    return {
      width: "100%",
      height: 360,
      maxWidth: "100%",
      ...style,
    };
  }, [style]);

  const containerStyle = React.useMemo<React.CSSProperties>(() => {
    const height = mergedStyle.height;

    return {
      minHeight: typeof height === "number" || typeof height === "string" ? height : 320,
    };
  }, [mergedStyle.height]);

  // Handle manual resize when container changes
  useEffect(() => {
    const handleResize = () => {
      // Debounce resize calls to avoid thrashing Plotly resize
      setTimeout(triggerResize, 50);
    };

    // Set up ResizeObserver to detect container size changes
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    if (plotRef.current) {
      resizeObserver.observe(plotRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [triggerResize]);

  // Also resize when theme changes (can affect layout)
  useEffect(() => {
    // Small delay to ensure theme changes are applied
    const timeoutId = setTimeout(triggerResize, 150);
    return () => clearTimeout(timeoutId);
  }, [theme, triggerResize]);

  // Force a resize whenever the upstream data/layout objects change.
  // This catches cases like switching run history, where the container size
  // stays the same but Plotly needs to recompute its internal view box.
  useEffect(() => {
    const timeoutId = setTimeout(triggerResize, 0);
    return () => clearTimeout(timeoutId);
  }, [data, layout, triggerResize]);

  const handleInitialized = useCallback(
    (figure: Readonly<unknown>, graphDiv: Readonly<HTMLElement>) => {
      graphDivRef.current = graphDiv as PlotlyHTMLElement | null;
      triggerResize();
      onInitialized?.(figure);
    },
    [onInitialized, triggerResize],
  );

  const handleUpdate = useCallback(
    (figure: Readonly<unknown>, graphDiv: Readonly<HTMLElement>) => {
      graphDivRef.current = graphDiv as PlotlyHTMLElement | null;
      triggerResize();
      onUpdate?.(figure);
    },
    [onUpdate, triggerResize],
  );

  // Enhanced layout with theme support
  const themedLayout = React.useMemo(() => {
    const isDark = theme === "dark";

    return {
      ...layout,
      paper_bgcolor: isDark ? "#020817" : "#ffffff",
      plot_bgcolor: isDark ? "#020817" : "#ffffff",
      font: {
        family:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        size: 12,
        color: isDark ? "#f8fafc" : "#0f172a",
        ...layout.font,
      },
      colorway: isDark
        ? ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#84cc16", "#f97316"]
        : ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#65a30d", "#ea580c"],
      xaxis: {
        gridcolor: isDark ? "#334155" : "#e2e8f0",
        linecolor: isDark ? "#475569" : "#cbd5e1",
        tickcolor: isDark ? "#475569" : "#cbd5e1",
        zerolinecolor: isDark ? "#475569" : "#cbd5e1",
        ...layout.xaxis,
        // Ensure automargin is applied after layout.xaxis spread
        automargin: true,
      },
      yaxis: {
        gridcolor: isDark ? "#334155" : "#e2e8f0",
        linecolor: isDark ? "#475569" : "#cbd5e1",
        tickcolor: isDark ? "#475569" : "#cbd5e1",
        zerolinecolor: isDark ? "#475569" : "#cbd5e1",
        title: {
          standoff: 40,
          ...layout.yaxis?.title,
        },
        ...layout.yaxis,
        // Ensure automargin is applied after layout.yaxis spread
        automargin: true,
      },
      // Provide fallback margins in case automargin has issues
      margin: {
        t: 60, // Increased top margin to give Plotly toolbar more space
        r: 30,
        b: 50,
        l: 90, // Larger left margin as fallback for automargin issues
        ...layout.margin,
      },
      autosize: true,
      ...layout,
    };
  }, [layout, theme]);

  // Enhanced config with responsive behavior
  const enhancedConfig = React.useMemo(
    (): Partial<Config> => ({
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: [],
      toImageButtonOptions: {
        format: "png" as const,
        filename: `tradeblocks-${title.toLowerCase().replace(/\s+/g, "-")}`,
        height: 600,
        width: 1000,
        scale: 2,
      },
      ...config,
    }),
    [config, title],
  );

  const headerActions = actions ?? children;

  // Only render CardHeader if there's content to show
  const hasHeader = title || description || tooltip || headerAddon || headerActions;

  return (
    <Card className={cn("h-full", className)}>
      {hasHeader && (
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              {title && (
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg font-semibold">{title}</CardTitle>
                  {tooltip && (
                    <HoverCard>
                      <HoverCardTrigger asChild>
                        <HelpCircle className="w-4 h-4 text-muted-foreground/60 cursor-help" />
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80 p-0 overflow-hidden">
                        <div className="space-y-3">
                          {/* Header with title */}
                          <div className="bg-primary/5 border-b px-4 py-3">
                            <h4 className="text-sm font-semibold text-primary">{title}</h4>
                          </div>

                          {/* Content */}
                          <div className="px-4 pb-4 space-y-3">
                            {/* Flavor text */}
                            <p className="text-sm font-medium text-foreground leading-relaxed">
                              {tooltip.flavor}
                            </p>

                            {/* Detailed explanation */}
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {tooltip.detailed}
                            </p>
                          </div>
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  )}
                </div>
              )}
              {description && (
                <CardDescription className="text-sm text-muted-foreground">
                  {description}
                </CardDescription>
              )}
              {headerAddon}
            </div>
            {headerActions}
          </div>
        </CardHeader>
      )}
      <CardContent className={hasHeader ? "pt-0" : "pt-4"}>
        <div ref={plotRef} className="relative" style={containerStyle}>
          {contentOverlay && (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
              <div className="pointer-events-auto">{contentOverlay}</div>
            </div>
          )}
          <Suspense fallback={<ChartSkeleton />}>
            <Plot
              divId={chartId}
              data={data}
              layout={themedLayout}
              config={enhancedConfig as unknown as Parameters<typeof Plot>[0]["config"]}
              onInitialized={handleInitialized}
              onUpdate={handleUpdate}
              style={mergedStyle}
              className="w-full h-full"
              useResizeHandler={true}
            />
          </Suspense>
        </div>
        {footer && <div className="mt-4">{footer}</div>}
      </CardContent>
    </Card>
  );
}

// Utility function to create common chart configurations
export const createChartConfig = (overrides?: Partial<Config>): Partial<Config> => ({
  showTips: false,
  showAxisDragHandles: false,
  showAxisRangeEntryBoxes: false,
  showLink: false,
  ...overrides,
});

// Common layout configurations
export const createLineChartLayout = (
  title?: string,
  xTitle?: string,
  yTitle?: string,
): Partial<Layout> => ({
  title: title ? { text: title, x: 0.05 } : undefined,
  xaxis: {
    title: { text: xTitle || "" },
    showgrid: true,
    zeroline: false,
  },
  yaxis: {
    title: { text: yTitle || "" },
    showgrid: true,
    zeroline: false,
  },
  hovermode: "closest",
  showlegend: true,
  legend: {
    x: 1,
    xanchor: "right",
    y: 1,
    yanchor: "top",
  },
});

export const createBarChartLayout = (
  title?: string,
  xTitle?: string,
  yTitle?: string,
): Partial<Layout> => ({
  title: title ? { text: title, x: 0.05 } : undefined,
  xaxis: {
    title: { text: xTitle || "" },
    showgrid: false,
  },
  yaxis: {
    title: { text: yTitle || "" },
    showgrid: true,
    zeroline: true,
  },
  hovermode: "closest",
  showlegend: false,
});

export const createHistogramLayout = (
  title?: string,
  xTitle?: string,
  yTitle?: string,
): Partial<Layout> => ({
  title: title ? { text: title, x: 0.05 } : undefined,
  xaxis: {
    title: { text: xTitle || "" },
    showgrid: true,
  },
  yaxis: {
    title: { text: yTitle || "" },
    showgrid: true,
  },
  hovermode: "closest",
  showlegend: true,
  bargap: 0.1,
});
