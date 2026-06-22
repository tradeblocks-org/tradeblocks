"use client";

/**
 * Bucket Editor
 *
 * UI component for defining bucket thresholds for table output.
 * Uses a tag/chip interface where each threshold is a removable badge.
 */

import { Label } from "@/components/ui/label";
import { NumericTagInput } from "@/components/ui/numeric-tag-input";
import { getDefaultBucketEdges } from "@tradeblocks/lib";

interface BucketEditorProps {
  field: string;
  value: number[];
  onChange: (buckets: number[]) => void;
  className?: string;
}

export function BucketEditor({ field, value, onChange, className }: BucketEditorProps) {
  // Load defaults for current field
  const handleLoadDefaults = () => {
    const defaults = getDefaultBucketEdges(field);
    onChange(defaults);
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <Label className="text-xs text-muted-foreground">Bucket Thresholds</Label>
        <button
          type="button"
          onClick={handleLoadDefaults}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Reset
        </button>
      </div>

      <NumericTagInput value={value} onChange={onChange} placeholder="Type a number, press Enter" />
    </div>
  );
}

export default BucketEditor;
