import { useRef, useState, useCallback } from "react";

type ProgressState = { open: boolean; step: string; percent: number };

/**
 * Shared helper for long-running tasks that need a progress dialog and cancellation.
 * Manages AbortController lifecycle, clamping percent, and common state wiring.
 */
export function useProgressDialog() {
  const [state, setState] = useState<ProgressState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback((step: string = "Starting...", percent = 0) => {
    // Abort any in-flight work before starting a new one
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setState({ open: true, step, percent });
    return abortRef.current.signal;
  }, []);

  const update = useCallback((step: string, percent: number) => {
    const safePercent = Number.isFinite(percent)
      ? Math.min(100, Math.max(0, Math.round(percent)))
      : 0;
    setState({ open: true, step, percent: safePercent });
  }, []);

  const finish = useCallback(() => {
    abortRef.current = null;
    setState(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    finish();
  }, [finish]);

  return {
    state,
    start,
    update,
    finish,
    cancel,
    get signal(): AbortSignal | undefined {
      return abortRef.current?.signal;
    },
  };
}
