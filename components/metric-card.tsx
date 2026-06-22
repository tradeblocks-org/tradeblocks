"use client";

import { Card, CardContent } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@tradeblocks/lib";
import { HelpCircle, TrendingDown, TrendingUp } from "lucide-react";

interface TooltipContent {
  flavor: string;
  detailed: string;
}

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down" | "neutral";
  tooltip?: TooltipContent;
  format?: "currency" | "percentage" | "number" | "ratio" | "decimal";
  decimalPlaces?: number;
  isPositive?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function MetricCard({
  title,
  value,
  subtitle,
  trend,
  tooltip,
  format = "number",
  decimalPlaces = 2,
  isPositive,
  size = "md",
  className,
}: MetricCardProps) {
  const formatValue = (val: string | number): string => {
    if (typeof val === "string") return val;

    switch (format) {
      case "currency":
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }).format(val);
      case "percentage":
        return `${val.toFixed(decimalPlaces)}%`;
      case "ratio":
        return val.toFixed(decimalPlaces);
      case "decimal":
        return val.toFixed(decimalPlaces);
      default:
        return val.toLocaleString();
    }
  };

  const getValueColor = () => {
    if (isPositive === undefined) return "text-foreground";
    return isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  };

  const getTrendIcon = () => {
    if (!trend || trend === "neutral") return null;
    return trend === "up" ? (
      <TrendingUp className="w-3 h-3 text-green-500" />
    ) : (
      <TrendingDown className="w-3 h-3 text-red-500" />
    );
  };

  const sizeClasses = {
    sm: "p-2",
    md: "p-2.5",
    lg: "p-2",
  };

  const valueSizeClasses = {
    sm: "text-base font-semibold",
    md: "text-lg font-semibold",
    lg: "text-xl font-bold",
  };

  return (
    <Card
      className={cn(
        "relative backdrop-blur-sm bg-background/50 border-border/50 transition-all duration-200 hover:shadow-md hover:bg-background/80 py-0",
        className,
      )}
    >
      <CardContent
        className={cn("px-0 flex flex-col justify-center min-h-[80px]", sizeClasses[size])}
      >
        <div className="space-y-1 text-center">
          {/* Title Row */}
          <div className="flex items-center justify-center gap-1">
            <span className="text-xs font-medium text-muted-foreground">{title}</span>
            {tooltip && (
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="w-3 h-3 text-muted-foreground/60 cursor-help" />
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
                        {tooltip?.flavor}
                      </p>

                      {/* Detailed explanation */}
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {tooltip?.detailed}
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            )}
            {getTrendIcon()}
          </div>

          {/* Value */}
          <div className={cn(valueSizeClasses[size], getValueColor())}>{formatValue(value)}</div>

          {/* Subtitle */}
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
