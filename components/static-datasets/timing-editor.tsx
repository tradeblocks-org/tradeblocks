"use client";

import { useId } from "react";
import type { DatasetTiming, DatasetColumnTiming } from "@tradeblocks/lib";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TimingEditor({
  columns,
  value,
  onChange,
  legacy = false,
  disabled = false,
}: {
  columns: string[];
  value: DatasetTiming;
  onChange: (value: DatasetTiming) => void;
  legacy?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">When were these values known?</legend>
      <p className="text-xs text-muted-foreground">
        Date-only close values are available the following day (ET). Open values require a known-by
        time. Timestamped rows are available as-of their timestamp.
      </p>
      {legacy && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-precision`}>Original CSV precision</Label>
          <select
            id={`${id}-precision`}
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={value.dateOnly === undefined ? "" : String(value.dateOnly)}
            onChange={(e) =>
              onChange({
                ...value,
                dateOnly: e.target.value === "" ? undefined : e.target.value === "true",
              })
            }
          >
            <option value="">Choose original precision</option>
            <option value="true">Dates only</option>
            <option value="false">Per-row timestamps</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Older imports did not save precision. Mixed date-only and timestamped files must be
            re-imported.
          </p>
        </div>
      )}
      <div className="max-h-48 overflow-y-auto space-y-2">
        {columns.map((column, index) => (
          <div key={column} className="flex items-center justify-between gap-3">
            <Label className="min-w-0 break-words" htmlFor={`${id}-${index}`}>
              {column}
            </Label>
            <select
              id={`${id}-${index}`}
              className="rounded-md border bg-background p-2 text-sm"
              value={value.columnTiming[column] ?? "close"}
              onChange={(e) =>
                onChange({
                  ...value,
                  columnTiming: {
                    ...value.columnTiming,
                    [column]: e.target.value as DatasetColumnTiming,
                  },
                })
              }
            >
              <option value="close">Close</option>
              <option value="open">Open</option>
            </select>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-known`}>Known-by time (ET)</Label>
        <Input
          id={`${id}-known`}
          type="time"
          value={value.knownBy ?? ""}
          onChange={(e) => onChange({ ...value, knownBy: e.target.value || undefined })}
        />
        <p className="text-xs text-muted-foreground">
          Required for date-only open columns; ignored for timestamped rows and close columns.
        </p>
      </div>
    </fieldset>
  );
}
