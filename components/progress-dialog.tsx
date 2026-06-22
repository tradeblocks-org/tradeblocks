"use client";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

interface ProgressDialogProps {
  open: boolean;
  title: string;
  step: string;
  percent: number;
  onCancel?: () => void;
  cancelLabel?: string;
  hideCancel?: boolean;
}

export function ProgressDialog({
  open,
  title,
  step,
  percent,
  onCancel,
  cancelLabel = "Cancel",
  hideCancel = false,
}: ProgressDialogProps) {
  // Clamp and normalize percent so we never render >100 or negatives
  const safePercent = Number.isFinite(percent)
    ? Math.min(100, Math.max(0, Math.round(percent)))
    : 0;

  const displayStep = step?.trim() ? step : "Working...";

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{displayStep}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Progress value={safePercent} aria-label={`${displayStep} (${safePercent}%)`} />
          <p className="text-sm text-muted-foreground text-center">{safePercent}%</p>
        </div>

        {!hideCancel && onCancel && (
          <AlertDialogFooter>
            <Button variant="outline" onClick={onCancel}>
              {cancelLabel}
            </Button>
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
