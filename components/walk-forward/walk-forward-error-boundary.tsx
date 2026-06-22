"use client";

import React, { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface WalkForwardErrorBoundaryProps {
  children: ReactNode;
}

interface WalkForwardErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary for the Walk-Forward Analysis results section.
 * Catches rendering errors in child components and displays a friendly
 * error state with a retry option, while keeping the configuration
 * card accessible.
 */
export class WalkForwardErrorBoundary extends Component<
  WalkForwardErrorBoundaryProps,
  WalkForwardErrorBoundaryState
> {
  constructor(props: WalkForwardErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): WalkForwardErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error for debugging (could be sent to error tracking service)
    console.error("WalkForwardErrorBoundary caught an error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <Card className="border-rose-500/30">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-rose-600" />
              <CardTitle className="text-rose-700 dark:text-rose-400">
                Something went wrong
              </CardTitle>
            </div>
            <CardDescription>
              An error occurred while displaying the analysis results.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This might be due to unexpected data in the analysis results. You can try again, or
              adjust your configuration and run a new analysis.
            </p>
            {this.state.error && (
              <div className="rounded-md bg-rose-500/5 border border-rose-500/20 p-3">
                <p className="text-xs font-mono text-rose-700 dark:text-rose-400">
                  {this.state.error.message}
                </p>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={this.handleReset} className="gap-2">
              <RotateCcw className="h-4 w-4" />
              Try Again
            </Button>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}
